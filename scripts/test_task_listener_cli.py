"""CLI preflight and explicit dispatch guard without models or network."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("listener_cli_test", Path(__file__).with_name("agent-link-listener.py"))
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class ListenerCLITests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.policy = {"state_dir": str(self.root / "missing"), "workspace_pins": {"a": "b"}, "channel_id": "channel"}
        self.config = {"agent_id": "writer", "project_id": "project", "workspace_root": str(self.root),
                       "key_file": str(self.root / "key"), "url": "http://127.0.0.1:8766", "ca_file": None}
        self.channel_write = True
        def request(method, path):
            self.assertEqual(method, "GET")
            if path == "/v1/me":
                return {"agent": {"id": "writer", "kind": "agent"}}
            if path.endswith("/channels"):
                return {"channels": [{"id": "channel", "can_write": self.channel_write}]}
            return {"tasks": [], "truncated": False, "can_write": True}
        self.client = Mock(request=request)

    def invoke(self, action):
        output = io.StringIO()
        with patch.object(cli, "load_policy", return_value=(self.policy, self.config)), \
                patch.object(cli, "read_regular", return_value=b"f" * 64), \
                patch.object(cli, "NativeHTTP", return_value=self.client), \
                patch.object(cli, "ArtifactClient"), patch.object(cli, "run_job", side_effect=AssertionError("model started")), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = cli.main([action, "--policy", "synthetic-policy.json"])
        return code, json.loads(output.getvalue())

    def test_run_requires_allow_model_before_clients_or_runtime(self):
        code, result = self.invoke("run")
        self.assertEqual(code, 2)
        self.assertEqual(result["error_category"], "ValueError")

    def test_status_uninitialized_is_readable_without_network(self):
        code, result = self.invoke("status")
        self.assertEqual(code, 0)
        self.assertEqual(result, {"initialized": False, "agent_id": "writer", "jobs": []})

    def test_check_rejects_pin_mismatch_and_read_only_channel(self):
        with patch("coordination.snapshot", return_value={"a": "different"}):
            self.assertEqual(self.invoke("check")[0], 2)
        self.channel_write = False
        with patch("coordination.snapshot", return_value=self.policy["workspace_pins"]):
            self.assertEqual(self.invoke("check")[0], 2)

    def test_check_validates_without_creating_listener_state(self):
        with patch("coordination.snapshot", return_value=self.policy["workspace_pins"]):
            code, result = self.invoke("check")
        self.assertEqual(code, 0)
        self.assertTrue(result["valid"])
        self.assertFalse(result["model_started"])
        self.assertFalse(Path(self.policy["state_dir"]).exists())


if __name__ == "__main__":
    unittest.main()
