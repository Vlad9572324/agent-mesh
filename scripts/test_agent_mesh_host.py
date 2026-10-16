"""Fail-fast on terminal Mesh auth errors in the Runtime Host foreground runner."""
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "adapters"))
from native_bridge import NativeError, NativeHTTPError  # noqa: E402

SPEC = importlib.util.spec_from_file_location(
    "agent_mesh_host", ROOT / "scripts" / "agent-mesh-host.py")
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)

POLICY = {"connector_config": "/x/config.json", "agent_id": "a", "project_id": "1",
          "runtime": "claude", "server_origin": "https://agent-mesh.example", "poll_seconds": 0}


class FakeHost:
    def __init__(self, *a, **k):
        pass

    def recoverable(self):
        return []

    def status(self):
        return {}

    def close(self):
        pass


class FakeBridge:
    last = None

    def __init__(self, config_path, session_id, timeout=5):
        self.config = {"agent_id": "a", "project_id": "1", "runtime": "claude",
                       "url": "https://agent-mesh.example"}
        self.polls = 0
        FakeBridge.last = self

    def offer_inbox(self, **kwargs):
        return {"messages": []}

    def close(self):
        pass


class AgentMeshHostTests(unittest.TestCase):
    def test_is_fatal_auth_only_flags_401_403(self):
        self.assertTrue(host._is_fatal_auth(NativeHTTPError(401, "key_rejected")))
        self.assertTrue(host._is_fatal_auth(NativeHTTPError(403)))
        self.assertFalse(host._is_fatal_auth(NativeHTTPError(500)))
        self.assertFalse(host._is_fatal_auth(NativeError("network_unavailable")))

    def test_terminal_401_fails_fast_without_retry(self):
        class Bridge(FakeBridge):
            def poll_inbox(self, limit=100):
                self.polls += 1
                raise NativeHTTPError(401, "key_rejected")
        with patch.object(host, "load_policy", return_value=dict(POLICY)), \
                patch.object(host, "RuntimeHost", FakeHost), \
                patch.object(host, "NativeBridge", Bridge), \
                patch.object(host, "origin_identity", lambda url: url):
            rc = host.main(["--policy", "/x/policy.json"])
        self.assertEqual(rc, 2)
        self.assertEqual(FakeBridge.last.polls, 1)  # polled once, then stopped — no retry loop

    def test_queued_recoverable_dispatch_backs_off_instead_of_hot_looping(self):
        waits = []

        class FakeEvent:
            def __init__(self):
                self._set = False

            def is_set(self):
                return self._set

            def set(self):
                self._set = True

            def wait(self, timeout):
                waits.append(timeout)
                self._set = True  # one backoff, then let the loop exit deterministically

        class QueuedHost(FakeHost):
            def __init__(self, *a, **k):
                self.n = 0

            def recoverable(self):
                self.n += 1
                return ["wake-1"] if self.n == 1 else []

            def dispatch(self, wake_id, should_stop=None):
                return "queued"  # pre-submission failure: must back off, not hot-loop

        with patch.object(host, "load_policy", return_value={**POLICY, "poll_seconds": 7}), \
                patch.object(host, "RuntimeHost", QueuedHost), \
                patch.object(host, "NativeBridge", FakeBridge), \
                patch.object(host, "origin_identity", lambda url: url), \
                patch.object(host.threading, "Event", FakeEvent):
            rc = host.main(["--policy", "/x/policy.json"])
        self.assertEqual(rc, 0)
        self.assertEqual(waits, [7])  # backed off once at poll_seconds; no zero-delay relaunch storm


if __name__ == "__main__":
    unittest.main()
