import contextlib
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from adapter import Adapter, APIError, Client, Store, read_key
from runtimes import EchoRuntime, RuntimeFailure


def message(number=1, **changes):
    result = {"id": "m" + str(number), "seq": number, "channel_id": "general", "body": "hello",
              "author_id": "peer", "recipient_ids": ["test-agent"], "reply_to": None}
    result.update(changes)
    return result


class FakeClient:
    def __init__(self):
        self.messages = []
        self.posts = []
        self.saved = {}
        self.fail_response_once = False
        self.heartbeats = 0

    def request(self, method, path, body=None):
        if path == "/v1/heartbeat":
            self.heartbeats += 1
            return {}
        if method == "GET":
            after = int(path.split("after_seq=")[1].split("&")[0])
            return {"messages": [m for m in self.messages if m["seq"] > after]}
        self.posts.append((path, dict(body)))
        if path.endswith("/messages"):
            replayed = body["client_id"] in self.saved
            self.saved.setdefault(body["client_id"], dict(body))
            if self.fail_response_once:
                self.fail_response_once = False
                raise OSError("lost response")
            return {"message": {"id": "reply"}, "replayed": replayed}
        return {}


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="agent-link-test-")
        self.path = str(Path(self.directory.name) / "queue.sqlite3")
        self.store = Store(self.path, "test")
        self.client = FakeClient()
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()

    def tearDown(self):
        self.output.__exit__(None, None, None)
        self.store.close()
        self.directory.cleanup()

    def adapter(self, runtime=None, max_turns=2):
        adapter = Adapter(self.client, self.store, "test-agent", "general", "echo", max_turns=max_turns)
        adapter.runtime = runtime or EchoRuntime()
        return adapter

    def test_echo_receipt_order_and_dedup(self):
        self.client.messages = [message()]
        adapter = self.adapter()
        adapter.step()
        adapter.step()
        self.assertEqual(adapter.turns, 1)
        self.assertEqual([b.get("status", "message") for _, b in self.client.posts], ["delivered", "accepted", "message"])
        reply = next(iter(self.client.saved.values()))
        self.assertEqual(reply["reply_to"], "m1")
        self.assertEqual(reply["recipient_ids"], ["peer"])
        self.assertIn("not a model", reply["body"])

    def test_ingest_is_durable_before_receipt(self):
        self.store.ingest([message()], "test-agent")
        self.store.close()
        self.store = Store(self.path, "test")
        self.assertEqual(self.store.cursor, 1)
        self.assertEqual(self.store.next_message()["id"], "m1")
        self.store.flush(self.client, "session")
        self.assertEqual(self.client.posts[0][1]["status"], "delivered")

    def test_replies_broadcast_and_own_messages_never_wake(self):
        self.client.messages = [message(1, reply_to="parent"), message(2, recipient_ids=[]),
                                message(3, author_id="test-agent")]
        adapter = self.adapter()
        adapter.step()
        self.assertEqual(adapter.turns, 0)
        self.assertEqual(self.store.cursor, 3)
        self.assertEqual(len(self.client.posts), 2)

    def test_new_database_does_not_replay_server_accepted_or_uncertain(self):
        self.client.messages = [
            message(1, receipts=[{"agent_id": "test-agent", "accepted_at": "prior-time"}]),
            message(2, receipts=[{"agent_id": "test-agent", "uncertain_at": "prior-time"}]),
        ]
        adapter = self.adapter()
        adapter.step()
        self.assertEqual(adapter.turns, 0)
        self.assertEqual(self.client.posts, [])
        self.assertEqual([r[0] for r in self.store.db.execute("SELECT state FROM inbox ORDER BY seq")], ["previously_accepted", "uncertain"])

    def test_crash_dispatch_is_uncertain_never_replayed(self):
        self.store.ingest([message()], "test-agent")
        self.store.dispatch("m1")
        self.store.close()
        self.store = Store(self.path, "test")
        adapter = self.adapter()
        adapter.step()
        self.assertEqual(adapter.turns, 0)
        self.assertEqual(self.store.db.execute("SELECT state FROM inbox").fetchone()[0], "uncertain")
        self.assertEqual([b["status"] for _, b in self.client.posts], ["delivered", "uncertain"])

    def test_outbox_retries_same_client_id_after_lost_response(self):
        self.client.messages = [message()]
        self.client.fail_response_once = True
        adapter = self.adapter()
        with self.assertRaises(OSError):
            adapter.step()
        self.store.close()
        self.store = Store(self.path, "test")
        self.adapter().step()
        posts = [b for path, b in self.client.posts if path.endswith("/messages")]
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0], posts[1])
        self.assertEqual(len(self.client.saved), 1)

    def test_restart_rebinds_delivered_for_queued_input(self):
        self.store.ingest([message()], "test-agent")
        self.store.flush(self.client, "old-lease")
        self.store.close()
        self.store = Store(self.path, "test")
        self.store.flush(self.client, "new-lease")
        delivered = [b for _, b in self.client.posts if b.get("status") == "delivered"]
        self.assertEqual([b["session_id"] for b in delivered], ["old-lease", "new-lease"])

    def test_restart_never_relabels_old_runtime_acceptance(self):
        self.store.ingest([message()], "test-agent")
        self.store.flush(self.client, "old-lease")
        self.store.dispatch("m1")
        self.store.accept("m1", "old-runtime")
        self.store.close()
        self.store = Store(self.path, "test")
        self.store.flush(self.client, "new-lease")
        self.assertEqual([b["status"] for _, b in self.client.posts], ["delivered", "uncertain"])
        old_receipt = self.store.db.execute("SELECT sent FROM outbox WHERE unique_key='m1:accepted'").fetchone()[0]
        self.assertEqual(old_receipt, 2)

    def test_completed_reply_survives_old_pending_acceptance(self):
        self.store.ingest([message()], "test-agent")
        self.store.flush(self.client, "old-lease")
        self.store.dispatch("m1")
        self.store.accept("m1", "old-runtime")
        self.store.complete(message(), "old-runtime completed this", "test-agent")
        self.store.close()
        self.store = Store(self.path, "test")
        self.store.flush(self.client, "new-lease")
        self.assertEqual([b.get("status", "message") for _, b in self.client.posts], ["delivered", "message"])
        self.assertEqual(next(iter(self.client.saved.values()))["body"], "old-runtime completed this")

    def test_runtime_error_never_claims_accepted(self):
        class Broken(EchoRuntime):
            def reply(self, message, accepted):
                raise RuntimeFailure("not acknowledged")
        self.client.messages = [message()]
        with self.assertRaises(RuntimeFailure):
            self.adapter(Broken()).step()
        self.store.flush(self.client, "s")
        self.assertEqual([b["status"] for _, b in self.client.posts], ["delivered", "uncertain"])
        self.assertIsNone(self.store.next_message())

    def test_runtime_accept_then_error_preserves_uncertainty(self):
        class Broken(EchoRuntime):
            def reply(self, message, accepted):
                accepted(self.session_id)
                raise RuntimeFailure("interrupted after acceptance")
        self.client.messages = [message()]
        with self.assertRaises(RuntimeFailure):
            self.adapter(Broken()).step()
        self.store.flush(self.client, "s")
        self.assertEqual([b["status"] for _, b in self.client.posts], ["delivered", "accepted", "uncertain"])

    def test_transient_acceptance_post_error_does_not_interrupt_runtime(self):
        class Transient(FakeClient):
            failed = False
            def request(self, method, path, body=None):
                if body and body.get("status") == "accepted" and not self.failed:
                    self.failed = True
                    raise APIError(503)
                return super().request(method, path, body)
        self.client = Transient()
        self.client.messages = [message()]
        adapter = self.adapter()
        adapter.step()
        self.assertEqual(adapter.turns, 1)
        self.assertEqual(self.store.db.execute("SELECT state FROM inbox WHERE id='m1'").fetchone()[0], "completed")
        self.assertEqual(len(self.client.saved), 1)

    def test_runtime_pipe_error_is_terminal_not_a_transport_retry(self):
        class Broken(EchoRuntime):
            def reply(self, message, accepted):
                raise OSError("pipe failed after dispatch")
        self.client.messages = [message()]
        with self.assertRaisesRegex(RuntimeFailure, "uncertain"):
            self.adapter(Broken()).step()
        self.assertIsNone(self.store.next_message())

    def test_turn_budget_does_not_discard_queued_messages(self):
        self.client.messages = [message(1), message(2)]
        adapter = self.adapter(max_turns=1)
        adapter.step()
        adapter.step()
        self.assertEqual(adapter.turns, 1)
        self.assertEqual(self.store.next_message()["id"], "m2")

    def test_reply_truncates_utf8_bytes_and_outbox_progresses(self):
        class ByteLimitedClient(FakeClient):
            def request(self, method, path, body=None):
                if body and "body" in body and len(body["body"].encode("utf-8")) > 16384:
                    raise APIError(400)
                return super().request(method, path, body)
        self.client = ByteLimitedClient()
        for index, long_reply in enumerate(("Я" * 9000, "😀" * 5000, "x" + "😀" * 5000), start=1):
            msg = message(index)
            self.store.ingest([msg], "test-agent")
            self.store.dispatch(msg["id"])
            self.store.complete(msg, long_reply, "test-agent")
        self.store.flush(self.client, "s")
        self.assertEqual(len(self.client.saved), 3)
        self.assertTrue(all(len(b["body"].encode("utf-8")) <= 12000 for b in self.client.saved.values()))
        self.assertFalse(any("\ufffd" in b["body"] for b in self.client.saved.values()))
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM outbox WHERE sent=0").fetchone()[0], 0)

    def test_session_fence_before_dispatch(self):
        class Fenced(FakeClient):
            def request(self, method, path, body=None):
                if path == "/v1/heartbeat":
                    raise APIError(409)
                return super().request(method, path, body)
        self.client = Fenced()
        self.client.messages = [message()]
        with self.assertRaises(APIError):
            self.adapter().step()
        self.assertEqual(self.store.next_message()["id"], "m1")

    def test_heartbeat_independent_of_runtime(self):
        adapter = self.adapter()
        adapter.heartbeat_interval = 0.02
        adapter.heartbeat()
        worker = threading.Thread(target=adapter._heartbeats)
        worker.start()
        try:
            time.sleep(0.12)
            self.assertGreaterEqual(self.client.heartbeats, 3)
        finally:
            adapter.stop.set()
            worker.join()

    def test_database_exclusive_owner(self):
        with self.assertRaisesRegex(ValueError, "another adapter"):
            Store(self.path, "test")

    def test_database_identity_bound(self):
        self.store.close()
        with self.assertRaisesRegex(ValueError, "different server"):
            Store(self.path, "other-agent")
        self.store = Store(self.path, "test")

    def test_tls_and_origin_requirements(self):
        for url in ("http://example.com", "http://localhost", "https://u:p@example.com", "https://example.com/?key=secret"):
            with self.assertRaises(ValueError):
                Client(url, "unused")
        Client("https://example.com", "unused")
        Client("http://127.0.0.1:1234", "unused")

    def test_private_individual_keys(self):
        key_file = Path(self.directory.name) / "key.json"
        key_file.write_text(json.dumps({"keys": {"test-agent": "x" * 48}}))
        key_file.chmod(0o600)
        self.assertEqual(read_key(key_file, "test-agent"), "x" * 48)
        key_file.chmod(0o644)
        with self.assertRaises(ValueError):
            read_key(key_file, "test-agent")

    def test_rotated_key_json_requires_matching_agent(self):
        key_file = Path(self.directory.name) / "rotated.json"
        key_file.write_text(json.dumps({"agent_id": "test-agent", "key": "k" * 48}))
        key_file.chmod(0o600)
        self.assertEqual(read_key(key_file, "test-agent"), "k" * 48)
        with self.assertRaises(ValueError):
            read_key(key_file, "different-agent")


if __name__ == "__main__":
    unittest.main()
