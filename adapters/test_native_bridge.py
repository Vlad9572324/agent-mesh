"""Bounded NativeBridge recovery/ACL tests. No HTTP, provider, shell or real key."""

import base64
import copy
import hashlib
import json
import queue
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import native_bridge as native
import test_native_hooks as hook_tests


class FakeAPI(hook_tests.FakeNativeAPI):
    def __init__(self):
        super().__init__()
        self.channels = {"c": True, "d": True}
        self.calls = []
        self.published = {}
        self.artifacts = {}
        self.lose_next_ack = False
        self.corrupt_receipt = None
        self.identity = "a"

    def request(self, method, path, body=None, **kwargs):
        self.calls.append((method, path, copy.deepcopy(body)))
        if self.offline:
            raise native.NativeError("offline_fixture")
        if method == "GET" and path == "/v1/me":
            return {"agent": {"id": self.identity, "kind": "agent"}}
        if method == "GET" and path == "/v1/projects/p/channels":
            return {"channels": [{"id": channel, "project_id": "p", "can_write": write}
                                 for channel, write in self.channels.items()] if self.allowed else []}
        if method == "GET" and path.startswith("/v1/channels/") and "/messages?" in path:
            channel = path.split("/")[3]
            query = parse_qs(urlsplit(path).query)
            after, limit = int(query["after_seq"][0]), int(query["limit"][0])
            return {"messages": [copy.deepcopy(m) for m in self.messages
                                 if m["channel_id"] == channel and m["seq"] > after][:limit]}
        if method == "GET" and path.startswith("/v1/messages/"):
            return {"message": copy.deepcopy(next(m for m in self.messages if m["id"] == path.split("/")[-1]))}
        if method == "GET" and path.startswith("/v1/artifacts/"):
            artifact = self.artifacts[path.split("/")[3]]
            return artifact["content"] if path.endswith("/content") else {"artifact": copy.deepcopy(artifact["metadata"])}
        if method == "POST" and path.endswith("/activity"):
            response = super().request(method, path, body, **kwargs)
            return self.receipt(response)
        if ((method == "POST" and path.endswith(("/messages", "/artifacts", "/events", "/tasks", "/memory")))
                or (method == "PUT" and "/memory/" in path)):
            key = (path, body["client_id"])
            previous = self.published.get(key)
            if previous is not None:
                if previous[0] != body:
                    raise native.NativeHTTPError(409)
                return self.receipt({**copy.deepcopy(previous[1]), "replayed": True})
            if path.endswith("/messages"):
                record = {"id": "sent-" + path.split("/")[3] + "-" + body["client_id"], "channel_id": path.split("/")[3],
                          "author_id": "a", "seq": len(self.published) + 1, **copy.deepcopy(body)}
                record.pop("client_id")
                record.pop("channel_only", None)
                response = {"message": record, "replayed": False}
            elif path.endswith("/artifacts"):
                record = {"id": "artifact-" + body["client_id"], "project_id": "p", "author_id": "a",
                          "role": body["role"], "base_revision": body["base_revision"],
                          "sha256": body["sha256"], "size_bytes": len(base64.b64decode(body["content_base64"]))}
                if "title" in body:
                    record["title"] = body["title"]
                response = {"artifact": record, "replayed": False}
            elif path.endswith("/events"):
                record = {"id": "event-" + body["client_id"], "task_id": path.split("/")[-2],
                          "actor_id": "a", "version": body["expected_version"] + 1, **copy.deepcopy(body)}
                record.pop("expected_version")
                response = {"event": record, "replayed": False}
            elif path.endswith("/tasks"):
                record = {"id": "task-" + body["client_id"], "project_id": "p", "created_by": "a", **copy.deepcopy(body)}
                response = {"task": record, "replayed": False}
            else:
                record = {"id": "memory-" + body["client_id"] if method == "POST" else path.split("/")[-1],
                          "project_id": "p", "author_id": "a", "updated_by": "a",
                          "version": body.get("expected_version", 0) + 1, **copy.deepcopy(body)}
                response = {"memory": record, "replayed": False}
            self.published[key] = (copy.deepcopy(body), copy.deepcopy(response))
            return self.receipt(response)
        raise AssertionError("unexpected bounded fixture request")

    def receipt(self, response):
        if self.lose_next_ack:
            self.lose_next_ack = False
            raise native.NativeError("lost_ack_after_commit")
        result = copy.deepcopy(response)
        if self.corrupt_receipt is not None:
            self.corrupt_receipt(result)
        return result


class NativeBridgeTests(unittest.TestCase):
    def setUp(self):
        hook_tests.RealBridgeHookTests.setUp(self)
        self.api = FakeAPI()

    def bridge(self, session=hook_tests.SESSION):
        result = self.factory(str(self.config_path), session)
        self.addCleanup(result.close)
        return result

    def config(self, **changes):
        value = json.loads(self.config_path.read_text())
        value.update(changes)
        self.config_path.write_text(json.dumps(value))

    def message(self, identifier="m1", channel="c", seq=1, recipient="a", **fields):
        return {"id": identifier, "channel_id": channel, "seq": seq, "author_id": "b",
                "recipient_ids": [recipient], "reply_to": None, "body": "bounded peer text", **fields}

    def test_activity_lost_ack_reopen_replay_preserves_one_server_event(self):
        bridge = self.bridge()
        bridge.observe("tool.started", tool_name="Bash", event_id="native-tool-1")
        self.api.lose_next_ack = True
        with self.assertRaises(native.NativeError):
            bridge.flush()
        self.assertEqual(len(self.api.activity), 1)
        bridge.close()
        reopened = self.bridge()
        self.assertEqual(reopened.flush()["sent"], 1)
        self.assertEqual(len(self.api.activity), 1)
        self.assertEqual(reopened.status()["pending_publications"], 0)

    def test_message_lost_ack_exact_payload_retry_and_changed_id_conflict(self):
        bridge = self.bridge()
        self.api.lose_next_ack = True
        with self.assertRaises(native.NativeError):
            bridge.send("c", ["b"], "hello", client_id="send-1")
        self.assertEqual(len(self.api.published), 1)
        bridge.close()
        resumed = self.bridge()
        result = resumed.send("c", ["b"], "hello", client_id="send-1")
        self.assertEqual(result["publication_state"], "sent")
        with self.assertRaisesRegex(native.NativeError, "conflict"):
            resumed.send("c", ["b"], "different", client_id="send-1")
        self.assertEqual(len(self.api.published), 1)

    def test_new_send_requires_addressees_before_network_or_outbox(self):
        bridge = self.bridge()
        for recipients in (None, []):
            with self.subTest(recipients=recipients):
                with self.assertRaisesRegex(native.NativeError, "recipient_ids_required_use_link_broadcast"):
                    bridge.send("c", recipients, "hello")
        self.assertEqual(self.api.calls, [])
        self.assertEqual(bridge.db.execute("SELECT count(*) FROM outbox").fetchone()[0], 0)

    def test_reply_infers_only_author_without_local_offer_or_acknowledgement(self):
        self.api.messages = [self.message(recipient_ids=["a", "other-peer"])]
        bridge = self.bridge()
        for identity, recipients in (("omitted", None), ("empty", [])):
            result = bridge.send("c", recipients, "reply", reply_to="m1", client_id=identity)
            self.assertEqual(result["publication_state"], "sent")
            self.assertEqual(result["result"]["message"]["recipient_ids"], ["b"])
        self.assertEqual(len([call for call in self.api.calls if call[:2] == ("GET", "/v1/messages/m1")]), 2)
        self.assertEqual(bridge.db.execute("SELECT count(*) FROM inbox").fetchone()[0], 0)
        self.assertEqual(self.api.activity, {})

    def test_reply_inference_validates_identity_channel_author_and_current_access(self):
        bridge = self.bridge()
        for changes in ({"id": "other"}, {"channel_id": "d"}, {"author_id": None}, {"author_id": "a"}):
            with self.subTest(changes=changes):
                original = self.api.request
                def request(method, path, body=None, **kwargs):
                    if (method, path) == ("GET", "/v1/messages/m1"):
                        return {"message": self.message(**changes)}
                    return original(method, path, body, **kwargs)
                with patch.object(self.api, "request", side_effect=request), self.assertRaises(native.NativeError):
                    bridge.send("c", body="reply", reply_to="m1")
        self.api.channels["c"] = False
        self.api.calls.clear()
        with self.assertRaisesRegex(native.NativeError, "not_authorized"):
            bridge.send("c", body="reply", reply_to="m1")
        self.assertFalse(any(path == "/v1/messages/m1" for _, path, _ in self.api.calls))
        self.assertEqual(bridge.db.execute("SELECT count(*) FROM outbox").fetchone()[0], 0)
        self.assertEqual(self.api.published, {})

    def test_explicit_reply_preserves_addressees_and_broadcast_never_infers(self):
        bridge = self.bridge()
        result = bridge.send("c", ["chosen"], "reply", reply_to="m1", client_id="explicit")
        self.assertEqual(result["result"]["message"]["recipient_ids"], ["chosen"])
        result = bridge.broadcast("c", "channel note", reply_to="m1", client_id="channel-only")
        self.assertEqual(result["result"]["message"]["recipient_ids"], [])
        self.assertNotIn("channel_only", result["result"]["message"])
        self.assertFalse(any(path == "/v1/messages/m1" for _, path, _ in self.api.calls))
        posted = self.api.published[("/v1/channels/c/messages", "channel-only")][0]
        self.assertTrue(posted["channel_only"])
        self.assertEqual(posted["reply_to"], "m1")

    def test_inferred_reply_lost_ack_keeps_original_author_across_restart(self):
        self.api.messages = [self.message()]
        bridge = self.bridge()
        self.api.lose_next_ack = True
        with self.assertRaises(native.NativeError):
            bridge.send("c", body="reply", reply_to="m1", client_id="reply-1")
        bridge.close()
        resumed = self.bridge()
        # Even a contradictory remote response cannot retarget an already queued reply.
        self.api.messages[0]["author_id"] = "different"
        with self.assertRaisesRegex(native.NativeError, "conflict"):
            resumed.send("c", body="reply", reply_to="m1", client_id="reply-1")
        self.assertEqual(resumed.flush()["sent"], 1)
        posted = [body for method, path, body in self.api.calls if method == "POST" and path.endswith("/messages")]
        self.assertEqual(len(posted), 2)
        self.assertEqual(posted[0], posted[1])
        self.assertEqual(posted[0]["recipient_ids"], ["b"])
        self.assertEqual(len(self.api.published), 1)

    def test_broadcast_lost_ack_exact_retry_and_receipt_binding(self):
        bridge = self.bridge()
        self.api.lose_next_ack = True
        with self.assertRaises(native.NativeError):
            bridge.broadcast("c", "channel note", client_id="broadcast-1")
        bridge.close()
        resumed = self.bridge()
        result = resumed.broadcast("c", "channel note", client_id="broadcast-1")
        self.assertEqual(result["publication_state"], "sent")
        with self.assertRaisesRegex(native.NativeError, "conflict"):
            resumed.send("c", ["b"], "channel note", client_id="broadcast-1")
        self.assertEqual(len(self.api.published), 1)
        self.api.corrupt_receipt = lambda value: value["message"].update(recipient_ids=["b"])
        with self.assertRaisesRegex(native.NativeError, "receipt"):
            resumed.broadcast("c", "bad receipt", client_id="broadcast-2")
        self.assertEqual(resumed.db.execute("SELECT count(*) FROM outbox WHERE state='pending'").fetchone()[0], 1)

    def test_legacy_pending_channel_only_payload_replays_without_rewriting_intent(self):
        bridge = self.bridge()
        # Seed the unchanged payload that an earlier connector committed before losing its ACK.
        old = {"body": "historical note", "recipient_ids": [], "reply_to": None, "client_id": "old-send"}
        self.api.lose_next_ack = True
        with self.assertRaises(native.NativeError):
            bridge._publish("message", "/v1/channels/c/messages", old, channel="c")
        bridge.close()
        resumed = self.bridge()
        self.assertEqual(resumed.flush()["sent"], 1)
        posted = [body for method, path, body in self.api.calls if method == "POST" and path.endswith("/messages")]
        self.assertEqual(posted, [old, old])
        self.assertEqual(len(self.api.published), 1)

    def test_same_client_id_in_two_paths_preserves_distinct_outbox_records(self):
        self.config(channel_ids=["c", "d"])
        bridge = self.bridge()
        self.api.lose_next_ack = True
        with self.assertRaises(native.NativeError):
            bridge.send("c", ["b"], "hello-c", client_id="same")
        bridge.send("d", ["b"], "hello-d", client_id="same")
        rows = bridge.db.execute("SELECT id,path,payload,state FROM outbox ORDER BY path").fetchall()
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0]["id"], rows[1]["id"])
        self.assertEqual([row["path"] for row in rows], ["/v1/channels/c/messages", "/v1/channels/d/messages"])
        self.assertEqual([json.loads(row["payload"])["body"] for row in rows], ["hello-c", "hello-d"])
        self.assertTrue(all(row["state"] == "sent" for row in rows))
        self.assertEqual(len(self.api.published), 2)

    def test_revoked_pending_channel_does_not_starve_allowed_publication(self):
        self.config(channel_ids=["c", "d"])
        bridge = self.bridge()
        bridge.observe("session.started", event_id="start")
        self.api.channels = {"d": True}
        result = bridge.send("d", ["b"], "allowed", client_id="allowed-1")
        self.assertEqual(result["publication_state"], "sent")
        self.assertEqual(bridge.status()["blocked_publications"], 1)
        self.assertFalse(any(method == "POST" and path == "/v1/channels/c/activity" for method, path, _ in self.api.calls))

    def test_reauth_identity_and_transport_origin_before_request(self):
        bridge = self.bridge()
        self.api.identity = "different-account"
        with self.assertRaisesRegex(native.NativeError, "principal_mismatch"):
            bridge.poll_inbox()
        self.api.identity = "a"
        self.api.url = "http://127.0.0.1:19999"
        previous = len(self.api.calls)
        with self.assertRaisesRegex(native.NativeError, "origin_changed"):
            bridge.status()
        self.assertEqual(len(self.api.calls), previous)

    def test_state_rebind_different_origin_refused_without_network(self):
        self.bridge().close()
        self.config(url="http://127.0.0.1:19999")
        with self.assertRaisesRegex(native.NativeError, "different_binding"):
            self.bridge()
        self.assertEqual(self.api.calls, [])

    def test_cached_inbox_respects_readonly_revoke_and_never_autoaccepts(self):
        self.api.messages = [self.message()]
        bridge = self.bridge()
        bridge.poll_inbox()
        self.api.channels["c"] = False
        self.assertEqual(len(bridge.offer_inbox()["messages"]), 1)
        with self.assertRaisesRegex(native.NativeError, "not_authorized"):
            bridge.accept_message("m1")
        self.api.channels = {}
        self.assertEqual(bridge.offer_inbox()["messages"], [])
        self.assertIsNone(bridge.db.execute("SELECT accepted_at FROM inbox").fetchone()[0])

    def test_inaccessible_old_backlog_does_not_hide_accessible_channel(self):
        self.config(channel_ids=["c", "d"])
        self.api.messages = [self.message("c" + str(i), seq=i) for i in range(1, 202)]
        self.api.messages.append(self.message("d1", channel="d", seq=300))
        bridge = self.bridge()
        bridge.poll_inbox(limit=200)
        bridge.poll_inbox(limit=200)
        self.api.channels = {"d": True}
        self.assertEqual([m["id"] for m in bridge.offer_inbox()["messages"]], ["d1"])

    def test_requested_two_hundred_uses_actual_api_page_cap_and_more_flag(self):
        self.api.messages = [self.message("m" + str(i), seq=i) for i in range(1, 102)]
        bridge = self.bridge()
        result = bridge.poll_inbox(limit=200)
        self.assertEqual(result["fetched"], 100)
        self.assertTrue(result["has_more"])
        page_paths = [path for method, path, _ in self.api.calls if method == "GET" and "/messages?" in path]
        self.assertEqual(parse_qs(urlsplit(page_paths[0]).query)["limit"], ["100"])
        self.assertEqual(bridge.poll_inbox(limit=200)["fetched"], 1)

    def test_reoffers_across_repeats_and_new_sessions_record_one_offered_event_per_message(self):
        self.api.messages = [self.message("m1"), self.message("m2", seq=2)]
        first = self.bridge("session-one")
        first.poll_inbox()
        for _ in range(3):  # explicit re-offers, e.g. repeated link_inbox / hook cooldown expiry
            self.assertEqual(len(first.offer_inbox()["messages"]), 2)
        first.flush(limit=50)
        # A fresh CLI session starts with an empty cooldown and re-shows its unseen backlog.
        for name in ("session-two", "session-three"):
            later = self.bridge(name)
            self.assertEqual(len(later.offer_inbox()["messages"]), 2)
            later.flush(limit=50)
        offered = [v["message_id"] for v in self.api.activity.values() if v["event_type"] == "inbox.offered"]
        self.assertEqual(sorted(offered), ["m1", "m2"])
        # A message that arrives later is still reported on its own first offer.
        self.api.messages.append(self.message("m3", seq=3))
        later.poll_inbox()
        later.offer_inbox()
        later.flush(limit=50)
        offered = [v["message_id"] for v in self.api.activity.values() if v["event_type"] == "inbox.offered"]
        self.assertEqual(sorted(offered), ["m1", "m2", "m3"])

    def test_addressed_reply_inbox_and_explicit_accept_idempotency(self):
        self.api.messages = [self.message(reply_to="parent"), self.message("hidden", seq=2, recipient="other")]
        bridge = self.bridge()
        bridge.poll_inbox()
        self.assertEqual([m["id"] for m in bridge.offer_inbox()["messages"]], ["m1"])
        self.assertFalse(bridge.accept_message("m1")["replayed"])
        self.assertTrue(bridge.accept_message("m1")["replayed"])
        self.assertEqual(bridge.offer_inbox()["messages"], [])
        self.assertFalse(any(path.endswith("/receipts") or path == "/v1/heartbeat" for _, path, _ in self.api.calls))

    def test_seen_survives_new_session_without_acceptance_and_can_be_reviewed(self):
        self.api.messages = [self.message()]
        bridge = self.bridge()
        bridge.poll_inbox()
        bridge.offer_inbox()
        self.assertFalse(bridge.seen_message("m1")["accepted"])
        bridge.close()
        reopened = self.bridge(session="another-native-session")
        self.assertTrue(reopened.seen_message("m1")["replayed"])
        self.assertEqual(reopened.offer_inbox()["messages"], [])
        self.assertFalse(reopened.offer_inbox()["has_more"])
        self.assertEqual([m["id"] for m in reopened.offer_inbox(include_seen=True)["messages"]], ["m1"])
        self.assertEqual(reopened.status()["pending_messages"], 1)
        self.assertEqual(reopened.status()["unseen_messages"], 0)
        self.assertIsNone(reopened.db.execute("SELECT accepted_at FROM inbox").fetchone()[0])
        self.assertEqual(reopened.db.execute("SELECT count(*) FROM outbox WHERE payload LIKE '%inbox.seen%'").fetchone()[0], 1)
        self.assertFalse(reopened.accept_message("m1")["replayed"])
        self.assertEqual(reopened.offer_inbox(include_seen=True)["messages"], [])
        self.assertFalse(any('/receipt' in path or '/heartbeat' in path for _, path, _ in self.api.calls))

    def test_old_sqlite_migration_preserves_inbox_acceptance_cursors_offers_and_outbox(self):
        self.api.messages = [self.message(), self.message("m2", seq=2)]
        bridge = self.bridge()
        bridge.poll_inbox()
        bridge.offer_inbox()
        bridge.accept_message("m1")
        snapshots = {table: [tuple(row) for row in bridge.db.execute('SELECT * FROM ' + table)]
                     for table in ("meta", "cursors", "offers", "outbox")}
        # Recreate the original inbox schema, including an already accepted row.
        bridge.db.execute("ALTER TABLE inbox DROP COLUMN seen_at")
        bridge.db.execute("ALTER TABLE inbox DROP COLUMN seen_session")
        bridge.db.execute("DROP INDEX inbox_offer_order")
        bridge.db.execute("ALTER TABLE inbox DROP COLUMN offer_order")
        inbox = [tuple(row) for row in bridge.db.execute("SELECT * FROM inbox")]
        bridge.close()
        for session in ("migration-one", "migration-two"):
            reopened = self.bridge(session=session)
            for table, before in snapshots.items():
                self.assertEqual([tuple(row) for row in reopened.db.execute('SELECT * FROM ' + table)], before)
            self.assertEqual([tuple(row)[:6] for row in reopened.db.execute("SELECT * FROM inbox")], inbox)
            self.assertTrue(all(row[0] is None and row[1] is None for row in reopened.db.execute("SELECT seen_at,seen_session FROM inbox")))
            reopened.close()
        self.assertEqual([m["id"] for m in self.bridge().offer_inbox()["messages"]], ["m2"])

    def test_full_message_is_bounded_redacted_and_does_not_mark_seen_or_accepted(self):
        body = "Ж" * 8192
        self.api.messages = [self.message(body=body)]
        bridge = self.bridge()
        bridge.poll_inbox()
        self.assertTrue(bridge.offer_inbox()["messages"][0]["truncated"])
        full = bridge.message("m1")
        self.assertEqual(full["message"]["body"], body)
        self.assertFalse(full["seen"] or full["accepted"])
        self.assertIsNone(bridge.db.execute("SELECT seen_at FROM inbox").fetchone()[0])
        self.api.messages[0]["body"] = "credential " + bridge.key
        self.assertEqual(bridge.message("m1")["message"]["body"], "credential [REDACTED]")
        for invalid in ("x" * 16385, "\x00", ""):
            self.api.messages[0]["body"] = invalid
            with self.assertRaisesRegex(native.NativeError, "invalid_inbox_message"):
                bridge.message("m1")

    def test_message_and_seen_recheck_acl_binding_and_never_use_cached_data_offline(self):
        self.api.messages = [self.message()]
        bridge = self.bridge()
        bridge.poll_inbox()
        self.api.channels["c"] = False
        self.assertEqual(bridge.message("m1")["message"]["id"], "m1")
        with self.assertRaisesRegex(native.NativeError, "not_authorized"):
            bridge.seen_message("m1")
        self.api.channels = {}
        for operation in (bridge.message, bridge.seen_message):
            with self.assertRaisesRegex(native.NativeError, "not_authorized"):
                operation("m1")
        self.api.channels = {"c": True}
        for fields in ({"recipient_ids": ["other"]}, {"channel_id": "d"}, {"id": "wrong"}, {"author_id": "a"}):
            # Return a wrong record for the known ID to exercise response binding.
            original = self.api.request
            self.api.request = lambda method, path, body=None, **kwargs: ({"message": self.message(**fields)}
                if path == '/v1/messages/m1' else original(method, path, body, **kwargs))
            for operation in (bridge.message, bridge.seen_message):
                with self.assertRaisesRegex(native.NativeError, "message_no_longer_addressed"):
                    operation("m1")
            self.api.request = original
        self.api.offline = True
        for operation in (bridge.message, bridge.seen_message):
            with self.assertRaisesRegex(native.NativeError, "offline"):
                operation("m1")
        self.assertEqual(tuple(bridge.db.execute("SELECT seen_at,accepted_at FROM inbox").fetchone()), (None, None))

    def test_seen_publication_lost_ack_recovers_once_after_reopen(self):
        self.api.messages = [self.message()]
        bridge = self.bridge()
        bridge.poll_inbox()
        bridge.seen_message("m1")
        self.api.lose_next_ack = True
        with self.assertRaises(native.NativeError):
            bridge.flush()
        bridge.close()
        reopened = self.bridge(session="recovery-session")
        self.assertTrue(reopened.seen_message("m1")["replayed"])
        reopened.flush()
        self.assertEqual([v["event_type"] for v in self.api.activity.values()], ["inbox.seen"])
        self.assertEqual(reopened.offer_inbox()["messages"], [])
        self.assertIsNone(reopened.db.execute("SELECT accepted_at FROM inbox").fetchone()[0])

    def test_invalid_message_page_does_not_advance_cursor_or_partially_persist(self):
        self.api.messages = [self.message(), self.message("bad", seq=True)]
        bridge = self.bridge()
        with self.assertRaises(native.NativeError):
            bridge.poll_inbox()
        self.assertEqual(bridge.db.execute("SELECT seq FROM cursors").fetchone()[0], 0)
        self.assertEqual(bridge.db.execute("SELECT count(*) FROM inbox").fetchone()[0], 0)

    def test_valid_whitespace_only_server_message_does_not_block_cursor(self):
        self.api.messages = [self.message(body=" \n\t")]
        bridge = self.bridge()
        self.assertEqual(bridge.poll_inbox()["fetched"], 1)
        self.assertEqual(bridge.offer_inbox()["messages"][0]["body_preview"], " \n\t")

    def test_concurrent_independent_sqlite_connections_deduplicate_event_ids(self):
        # Initialize schema first; the two actual worker connections remain
        # separately constructed/owned by their threads (no shared connection).
        self.bridge().close()
        start = threading.Barrier(2)
        errors = queue.Queue()
        def producer(number):
            bridge = None
            try:
                bridge = self.factory(str(self.config_path), hook_tests.SESSION)
                start.wait(timeout=2)
                for i in range(10):
                    bridge.observe("tool.started", tool_name="Bash", event_id="shared")
                    bridge.observe("tool.started", tool_name="Bash", event_id=f"owned-{number}-{i}")
            except BaseException as error:
                errors.put(type(error).__name__)
            finally:
                if bridge is not None:
                    bridge.close()
        threads = [threading.Thread(target=producer, args=(i,)) for i in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertTrue(errors.empty(), list(errors.queue))
        self.assertEqual(self.bridge().db.execute("SELECT count(*) FROM outbox").fetchone()[0], 21)
        self.assertEqual(self.api.calls, [])

    def test_known_key_and_oversize_artifact_rejected_before_post(self):
        bridge = self.bridge()
        for content in ("a" * 64, "x" * 24577):
            with self.assertRaises(native.NativeError):
                bridge.publish_artifact("artifact-1", "implementation", "base-1", content)
        self.assertFalse(any(method == "POST" for method, _, _ in self.api.calls))

    def test_artifact_lost_ack_exact_bytes_recover_once(self):
        bridge = self.bridge()
        self.api.lose_next_ack = True
        with self.assertRaises(native.NativeError):
            bridge.publish_artifact("artifact-1", "implementation", "base-1", "selected text")
        bridge.close()
        reopened = self.bridge()
        self.assertEqual(reopened.flush()["sent"], 1)
        self.assertEqual(len(self.api.published), 1)
        payload = next(iter(self.api.published.values()))[0]
        self.assertEqual(base64.b64decode(payload["content_base64"]), b"selected text")

    def test_document_title_survives_lost_ack_restart_and_exact_replay(self):
        bridge = self.bridge()
        self.api.lose_next_ack = True
        with self.assertRaises(native.NativeError):
            bridge.publish_artifact("doc", "document", "requirements-v1", "Selected requirements", title="Требования <b>literal</b>")
        bridge.close()
        reopened = self.bridge()
        self.assertEqual(reopened.flush()["sent"], 1)
        payload = next(iter(self.api.published.values()))[0]
        self.assertEqual(payload["title"], "Требования <b>literal</b>")
        self.assertEqual(payload["role"], "document")
        self.assertEqual(base64.b64decode(payload["content_base64"]), b"Selected requirements")
        reopened.publish_artifact("doc", "document", "requirements-v1", "Selected requirements", title=payload["title"])
        with self.assertRaisesRegex(native.NativeError, "client_id_payload_conflict"):
            reopened.publish_artifact("doc", "document", "requirements-v1", "Selected requirements", title="Changed")
        self.assertEqual(len(self.api.published), 1)

    def test_artifact_title_validation_before_publication(self):
        bridge = self.bridge()
        for title in (None, 3, " ", "line\nbreak", "line\u2028break", "a\x7f", "x" * 201, "я" * 101, "\ud800", "a" * 64):
            with self.subTest(title=repr(title)), self.assertRaises(native.NativeError):
                bridge.publish_artifact("invalid", "document", "requirements-v1", "text", title=title)
        self.assertFalse(any(method == "POST" for method, _, _ in self.api.calls))
        self.assertEqual(bridge.db.execute("SELECT count(*) FROM outbox").fetchone()[0], 0)

    def test_titled_artifact_receipt_must_echo_title_before_marked_sent(self):
        bridge = self.bridge()
        self.api.corrupt_receipt = lambda response: response["artifact"].pop("title", None)
        with self.assertRaisesRegex(native.NativeError, "receipt_mismatch"):
            bridge.publish_artifact("doc", "document", "requirements-v1", "text", title="Exact title")
        self.assertEqual(bridge.status()["pending_publications"], 1)
        self.api.corrupt_receipt = None
        self.assertEqual(bridge.flush()["sent"], 1)

    def test_malformed_artifact_metadata_leaves_publication_pending(self):
        bridge = self.bridge()
        for index, value in enumerate((None, [], "not metadata", 4)):
            self.api.corrupt_receipt = lambda response, value=value: response.__setitem__("artifact", value)
            with self.assertRaisesRegex(native.NativeError, "invalid_publication_receipt"):
                bridge.publish_artifact("bad-receipt-" + str(index), "document", "requirements-v1", "text", title="Title")
        self.assertEqual(bridge.status()["pending_publications"], 4)
        self.api.corrupt_receipt = None
        self.assertEqual(bridge.flush()["sent"], 4)

    def test_untitled_artifact_retains_old_wire_shape_and_receipt_compatibility(self):
        bridge = self.bridge()
        bridge.publish_artifact("legacy", "test", "base-1", "text")
        bridge.publish_artifact("legacy", "test", "base-1", "text", title="")
        self.assertEqual(len(self.api.published), 1)
        payload, result = next(iter(self.api.published.values()))
        self.assertNotIn("title", payload)
        self.assertNotIn("title", result["artifact"])
        self.assertEqual(bridge.status()["pending_publications"], 0)

    def test_artifact_receipt_wrong_hash_or_missing_id_not_marked_sent(self):
        for field, bad in (("sha256", "b" * 64), ("id", ""), ("project_id", "other"), ("size_bytes", 99)):
            with self.subTest(field=field):
                bridge = self.bridge()
                self.api.corrupt_receipt = lambda response, f=field, v=bad: response["artifact"].__setitem__(f, v)
                with self.assertRaisesRegex(native.NativeError, "receipt_mismatch"):
                    bridge.publish_artifact("artifact-" + field, "test", "base-1", "text")
                self.assertGreater(bridge.status()["pending_publications"], 0)
                self.api.corrupt_receipt = None
                bridge.flush()

    def test_task_event_receipt_must_match_exact_artifact_pins(self):
        bridge = self.bridge()
        event = {"client_id": "review-1", "expected_version": 2, "type": "review_result", "run_id": "run-1",
                 "summary": "Reviewed exact supplied bytes", "review_request_id": "request-1", "verdict": "approved",
                 "artifacts": [{"artifact_id": "artifact-1", "sha256": "1" * 64, "role": "implementation"}]}
        self.api.corrupt_receipt = lambda response: response["event"]["artifacts"][0].__setitem__("sha256", "2" * 64)
        with self.assertRaisesRegex(native.NativeError, "receipt_mismatch"):
            bridge.task_event("task-1", event)
        self.assertEqual(bridge.status()["pending_publications"], 1)
        self.api.corrupt_receipt = None
        self.assertEqual(bridge.flush()["sent"], 1)

    def test_task_create_receipt_wrong_immutable_title_is_not_accepted(self):
        bridge = self.bridge()
        self.api.corrupt_receipt = lambda response: response["task"].__setitem__("title", "unrelated task")
        with self.assertRaisesRegex(native.NativeError, "receipt_mismatch"):
            bridge.create_task(client_id="create-1", title="Selected task", owner_id="a", reviewer_id="b",
                               scope=["source.py"], acceptance=["specific outcome"])
        self.assertEqual(bridge.status()["pending_publications"], 1)
        self.api.corrupt_receipt = None
        self.assertEqual(bridge.flush()["sent"], 1)

    def test_memory_receipt_wrong_title_or_cas_version_is_not_accepted(self):
        bridge = self.bridge()
        for field, value in (("title", "unrelated memory"), ("version", 999)):
            with self.subTest(field=field):
                self.api.corrupt_receipt = lambda response, f=field, v=value: response["memory"].__setitem__(f, v)
                with self.assertRaisesRegex(native.NativeError, "receipt_mismatch"):
                    bridge.write_memory("memory-" + field, "Selected memory", "Public project context",
                                        memory_id="memory-existing", expected_version=3)
                self.assertEqual(bridge.status()["pending_publications"], 1)
                self.api.corrupt_receipt = None
                self.assertEqual(bridge.flush()["sent"], 1)

    def test_artifact_content_requires_project_hash_base_and_actual_bytes(self):
        bridge = self.bridge()
        content = b"selected published text"
        digest = hashlib.sha256(content).hexdigest()
        metadata = {"id": "artifact-1", "project_id": "p", "base_revision": "base-1", "sha256": digest,
                    "size_bytes": len(content)}
        self.api.artifacts["artifact-1"] = {"metadata": metadata, "content": content}
        result = bridge.artifacts("content", "artifact-1", digest, "base-1")
        self.assertEqual(result["text"], content.decode())
        self.assertTrue(result["untrusted_content"])
        for name, bad in (("project_id", "other"), ("base_revision", "different"), ("sha256", "f" * 64)):
            old = metadata[name]
            metadata[name] = bad
            with self.assertRaises(native.NativeError):
                bridge.artifacts("content", "artifact-1", digest, "base-1")
            metadata[name] = old
        self.api.artifacts["artifact-1"]["content"] = b"tampered bytes"
        with self.assertRaisesRegex(native.NativeError, "integrity_failure"):
            bridge.artifacts("content", "artifact-1", digest, "base-1")

    def test_private_config_key_and_state_cannot_be_inside_workspace(self):
        for name in ("key_file", "state_dir"):
            original = json.loads(self.config_path.read_text())
            self.config(**{name: str(self.work / "private")})
            with self.assertRaisesRegex(native.NativeError, "outside_workspace"):
                native.load_config(self.config_path)
            self.config_path.write_text(json.dumps(original))


if __name__ == "__main__":
    unittest.main()
