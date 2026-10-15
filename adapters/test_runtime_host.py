import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import time
import unittest

from runtime_host import HostError, RuntimeHost, load_policy


CHILD = r'''import json,sys
mode=sys.argv[1]
def send(v):
 print(json.dumps(v,separators=(",",":")),flush=True)
send({"type":"hello","v":"1.0","agent_id":"adapter","caps":["wake","result"],"runtime":"fixture","proto":["1.0"]})
welcome=json.loads(sys.stdin.readline())
wake=json.loads(sys.stdin.readline())
if mode == "eof": sys.exit(0)
if mode == "partial":
 sys.stdout.write('{'); sys.stdout.flush(); __import__('time').sleep(10)
ack_version="9.9" if mode == "wrong-version" else "1.0"
send({"type":"ack","v":ack_version,"wake_id":wake["wake_id"],"state":"accepted"})
if mode == "uncertain": sys.exit(0)
if mode == "partial-result":
 sys.stdout.write('{'); sys.stdout.flush(); __import__('time').sleep(10)
send({"type":"result","v":"1.0","wake_id":wake["wake_id"],"state":"done","summary":"ok"})
'''


class RuntimeHostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.state = root / "state"
        self.state.mkdir(mode=0o700)
        self.policy_path = root / "policy.json"

    def tearDown(self):
        self.temp.cleanup()

    def policy(self, mode="done", route="agent-route"):
        value = {"version": 1, "connector_config": str(Path(self.temp.name) / "connector.json"),
                 "server_origin": "https://mesh.example:8766", "project_id": "project-1",
                 "state_dir": str(self.state), "route_id": route, "agent_id": "adapter", "runtime": "fixture",
                 "argv": [os.path.realpath(sys.executable), "-c", CHILD, mode],
                 "working_directory": str(Path(self.temp.name)), "env_allowlist": [], "poll_seconds": 1,
                 "handshake_seconds": 2, "turn_seconds": 2}
        self.policy_path.write_text(json.dumps(value), encoding="utf-8")
        os.chmod(self.policy_path, 0o600)
        return load_policy(str(self.policy_path))

    def test_policy_is_private_and_command_is_fixed_local_argv(self):
        policy = self.policy()
        self.assertEqual(policy["argv"][0], os.path.realpath(sys.executable))
        os.chmod(self.policy_path, 0o644)
        with self.assertRaisesRegex(HostError, "private"):
            load_policy(str(self.policy_path))

    def test_policy_rejects_duplicate_nonfinite_and_unbounded_input(self):
        self.policy()
        base = self.policy_path.read_text("utf-8")
        self.policy_path.write_text(base[:-1] + ',"version":1}', encoding="utf-8")
        with self.assertRaisesRegex(HostError, "duplicate"):
            load_policy(str(self.policy_path))
        self.policy_path.write_text(base.replace('"poll_seconds": 1', '"poll_seconds": NaN'), encoding="utf-8")
        with self.assertRaisesRegex(HostError, "non-finite"):
            load_policy(str(self.policy_path))
        self.policy_path.write_bytes(b" " * (128 * 1024 + 1))
        with self.assertRaisesRegex(HostError, "private|large"):
            load_policy(str(self.policy_path))

    def test_successful_protocol_turn_and_content_free_envelope(self):
        host = RuntimeHost(self.policy())
        try:
            wake = host.enqueue("development", ["message-1"], "peer-agent")
            self.assertEqual(host.dispatch(wake), "done")
            self.assertEqual(host.status()["wakes"][0]["state"], "done")
        finally:
            host.close()

    def test_failure_after_wake_submission_is_uncertain(self):
        host = RuntimeHost(self.policy("eof"))
        try:
            wake = host.enqueue("development", ["message-1"], "peer-agent")
            self.assertEqual(host.dispatch(wake), "uncertain")
            self.assertEqual(host.status()["wakes"][0]["detail"], "ambiguous_after_submission")
        finally:
            host.close()

    def test_partial_frame_cannot_bypass_deadline(self):
        policy = self.policy("partial")
        policy["handshake_seconds"] = 1
        host = RuntimeHost(policy)
        try:
            wake = host.enqueue("development", ["message-1"], "peer-agent")
            started = time.monotonic()
            self.assertEqual(host.dispatch(wake), "uncertain")
            self.assertLess(time.monotonic() - started, 4)
        finally:
            host.close()

    def test_frames_must_use_negotiated_version(self):
        host = RuntimeHost(self.policy("wrong-version"))
        try:
            wake = host.enqueue("development", ["message-1"], "peer-agent")
            self.assertEqual(host.dispatch(wake), "uncertain")
            self.assertEqual(host.status()["wakes"][0]["detail"], "ambiguous_after_submission")
        finally:
            host.close()

    def test_stop_request_interrupts_running_turn_and_reaps_child(self):
        policy = self.policy("partial-result")
        policy["turn_seconds"] = 30
        host = RuntimeHost(policy)
        started = time.monotonic()
        try:
            wake = host.enqueue("development", ["message-1"], "peer-agent")
            self.assertEqual(host.dispatch(
                wake, should_stop=lambda: time.monotonic() - started > 0.5), "uncertain")
            self.assertLess(time.monotonic() - started, 3)
            self.assertEqual(host.status()["wakes"][0]["detail"], "ambiguous_after_submission")
        finally:
            host.close()

    def test_reference_echo_accepts_local_connector_identity(self):
        policy = self.policy()
        script = Path(__file__).resolve().parents[1] / "scripts" / "agent-mesh-echo-runtime.py"
        policy["agent_id"] = "connector-agent"
        policy["runtime"] = "codex"
        policy["argv"] = [os.path.realpath(sys.executable), str(script),
                          "--agent-id", "connector-agent", "--runtime", "codex"]
        host = RuntimeHost(policy)
        try:
            wake = host.enqueue("development", ["message-1"], "peer-agent")
            self.assertEqual(host.dispatch(wake), "done")
        finally:
            host.close()

    def test_runtime_identity_and_state_transitions_fail_closed(self):
        policy = self.policy()
        policy["agent_id"] = "different-agent"
        host = RuntimeHost(policy)
        try:
            wake = host.enqueue("development", ["message-1"], "peer-agent")
            self.assertEqual(host.dispatch(wake), "queued")
            with self.assertRaisesRegex(HostError, "transition"):
                host._transition(wake, "done")
        finally:
            host.close()

    def test_overlapping_message_sets_have_per_message_claims(self):
        host = RuntimeHost(self.policy())
        try:
            first = host.enqueue("development", ["m1", "m2"], "peer")
            second = host.enqueue("development", ["m2", "m3"], "peer")
            rows = {r["wake_id"]: json.loads(r["message_ids"]) for r in host.status()["wakes"]}
            self.assertEqual(rows[first], ["m1", "m2"])
            self.assertEqual(rows[second], ["m3"])
        finally:
            host.close()

    def test_enrollment_baseline_suppresses_old_ids_without_wake_evidence(self):
        host = RuntimeHost(self.policy())
        try:
            self.assertEqual(host.baseline(["old-1", "old-2"]), 2)
            self.assertEqual(host.baseline(["old-1", "old-2"]), 0)
            wake = host.enqueue("development", ["old-1", "new-1"], "peer")
            rows = {r["wake_id"]: json.loads(r["message_ids"]) for r in host.status()["wakes"]}
            self.assertEqual(rows[wake], ["new-1"])
            self.assertEqual(host.status()["baseline_messages"], 2)
            self.assertEqual(host.db.execute("SELECT count(*) FROM claims").fetchone()[0], 1)
        finally:
            host.close()

    def test_enrollment_baseline_rejects_invalid_or_duplicate_ids(self):
        host = RuntimeHost(self.policy())
        try:
            for values in (["duplicate", "duplicate"], ["bad id"], "not-a-list"):
                with self.subTest(values=values), self.assertRaisesRegex(HostError, "baseline"):
                    host.baseline(values)
        finally:
            host.close()

    def test_restart_fences_old_epoch_and_marks_ambiguous_state(self):
        first = RuntimeHost(self.policy())
        wake = first.enqueue("development", ["m1"], "peer")
        old_epoch = first.epoch
        first._transition(wake, "submitted")
        first._transition(wake, "running")
        first.close()
        second = RuntimeHost(self.policy())
        try:
            self.assertGreater(second.epoch, old_epoch)
            self.assertEqual(second.status()["wakes"][0]["state"], "uncertain")
            with self.assertRaisesRegex(HostError, "stale"):
                second._transition(wake, "done", epoch=old_epoch)
        finally:
            second.close()

    def test_changed_local_binding_increments_generation(self):
        first = RuntimeHost(self.policy("done"))
        generation = first.generation
        first.close()
        second = RuntimeHost(self.policy("uncertain"))
        try:
            self.assertEqual(second.generation, generation + 1)
        finally:
            second.close()

    def test_new_controller_fences_still_running_old_controller(self):
        first = RuntimeHost(self.policy())
        wake = first.enqueue("development", ["m1"], "peer")
        second = RuntimeHost(self.policy())
        try:
            with self.assertRaisesRegex(HostError, "fenced"):
                first.dispatch(wake)
            self.assertIn(wake, second.recoverable())
        finally:
            first.close()
            second.close()


if __name__ == "__main__":
    unittest.main()
