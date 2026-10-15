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
          "runtime": "claude", "server_origin": "https://10.0.0.1:1", "poll_seconds": 0}


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
                       "url": "https://10.0.0.1:1"}
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


if __name__ == "__main__":
    unittest.main()
