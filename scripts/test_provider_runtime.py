import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "provider_runtime", ROOT / "scripts" / "agent-mesh-provider-runtime.py")
provider_runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provider_runtime)
sys.path.insert(0, str(ROOT / "adapters"))
from runtime_protocol import read_frame, write_frame


def wake():
    return {"type": "wake", "v": "1.0", "wake_id": "wake-1",
            "channel_id": "development", "message_ids": ["message-1", "message-2"],
            "envelope": {"sender_id": "peer-agent", "channel_id": "development",
                         "message_count": 2}, "generation": 1, "epoch": 1}


class ProviderRuntimeTests(unittest.TestCase):
    def test_privilege_escalation_flags_are_refused(self):
        for runtime, flag in (("claude", "--dangerously-skip-permissions"),
                              ("claude", "--allowedTools"),
                              ("claude", "--allowed-tools=Bash"),
                              ("claude", "--permission-prompt-tool"),
                              ("codex", "--full-auto"),
                              ("codex", "--dangerously-bypass-approvals-and-sandbox")):
            with self.assertRaises(provider_runtime.ProtocolError):
                provider_runtime.provider_cli_args(runtime, "fresh", None, [flag])
        # Legitimate tighteners remain allowed (operator-tunable by contract).
        self.assertIn("--sandbox=read-only",
                      provider_runtime.provider_cli_args("codex", "fresh", None, ["--sandbox=read-only"]))
        self.assertIn("--permission-mode=manual",
                      provider_runtime.provider_cli_args("claude", "fresh", None, ["--permission-mode=manual"]))

    def test_provider_grammar_is_fixed_and_resume_is_local(self):
        self.assertEqual(provider_runtime.provider_cli_args(
            "codex", "fresh", None, ["--sandbox=workspace-write"]),
            ["exec", "--sandbox=workspace-write", "-"])
        self.assertEqual(provider_runtime.provider_cli_args(
            "codex", "resume", "session-1", []),
            ["exec", "resume", "session-1", "-"])
        self.assertEqual(provider_runtime.provider_cli_args(
            "claude", "resume", "session-1", ["--permission-mode=manual"]),
            ["-p", "--output-format", "json", "--resume", "session-1",
             "--permission-mode=manual"])
        for runtime, argument in (("codex", "--cd=/tmp"), ("codex", "resume"),
                                  ("claude", "--mcp-config=x"), ("claude", "-p")):
            with self.subTest(runtime=runtime, argument=argument), self.assertRaises(Exception):
                provider_runtime.provider_cli_args(runtime, "fresh", None, [argument])

    def test_wake_prompt_contains_only_validated_routing_not_peer_body(self):
        prompt = provider_runtime.wake_prompt(wake())
        self.assertIn("message-1", prompt)
        self.assertIn("development", prompt)
        self.assertIn("untrusted project input", prompt)
        self.assertNotIn("command", json.dumps(wake()))

    def test_typed_wake_prompt_is_explicitly_service_attributed(self):
        value = wake()
        value["v"] = "1.1"
        value["envelope"].update({
            "source_kind": "agent", "event_kind": "message",
            "source_agent_id": "peer-agent", "target_agent_id": "agent-1",
            "project_id": "project-1", "object_ids": value["message_ids"],
            "correlation_id": value["wake_id"],
        })
        prompt = provider_runtime.wake_prompt(value)
        self.assertIn("AUTOMATED SERVICE WAKE, not an operator/user message", prompt)
        self.assertIn("Source agent: peer-agent", prompt)
        self.assertIn("Target agent: agent-1", prompt)
        self.assertIn("Project: project-1", prompt)
        self.assertIn("Correlation: wake-1", prompt)

    def test_provider_args_are_bounded_json_strings(self):
        self.assertEqual(provider_runtime._provider_args('["--model=example"]'),
                         ["--model=example"])
        for raw in ('{"x":1}', '[1]', 'NaN', '["positional"]', '["-"]',
                    '["' + ('x' * 5000) + '"]'):
            with self.subTest(raw=raw[:20]), self.assertRaises(Exception):
                provider_runtime._provider_args(raw)

    def _fixture(self, runtime):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        workspace = root / "workspace"
        state = root / "state"
        private = root / "private"
        workspace.mkdir()
        state.mkdir(mode=0o700)
        private.mkdir(mode=0o700)
        key = private / "agent.key"
        key.write_text("a" * 64, encoding="ascii")
        key.chmod(0o600)
        ca = private / "ca.crt"
        ca.write_text("test public certificate fixture", encoding="ascii")
        config = private / "config.json"
        config.write_text(json.dumps({
            "version": 1, "url": "https://mesh.example:8766", "runtime": runtime,
            "ca_file": str(ca), "key_file": str(key), "agent_id": "agent-1",
            "project_id": "project-1", "channel_ids": ["development"],
            "workspace_root": str(workspace), "state_dir": str(state),
        }), encoding="utf-8")
        config.chmod(0o600)
        capture = root / "capture.json"
        fake = root / "fake-provider"
        fake.write_text("#!" + os.path.realpath(sys.executable) + "\n"
                        "import json,os,sys,time\n"
                        "open(os.environ['PROVIDER_CAPTURE'],'w').write(json.dumps({"
                        "'argv':sys.argv[1:],'prompt':sys.stdin.read(),'pid':os.getpid()}))\n"
                        "if os.environ.get('PROVIDER_SLEEP'): time.sleep(30)\n",
                        encoding="utf-8")
        fake.chmod(0o700)
        return config, fake, capture

    def test_real_amrp_transcript_launches_both_provider_drivers(self):
        script = ROOT / "scripts" / "agent-mesh-provider-runtime.py"
        for runtime in ("codex", "claude"):
            with self.subTest(runtime=runtime):
                config, fake, capture = self._fixture(runtime)
                env = dict(os.environ)
                env["PROVIDER_CAPTURE"] = str(capture)
                child = subprocess.Popen([
                    sys.executable, str(script), "--config", str(config),
                    "--agent-id", "agent-1", "--runtime", runtime,
                    "--provider-executable", str(fake), "--mode", "fresh",
                ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
                try:
                    hello = read_frame(child.stdout)
                    self.assertEqual((hello["agent_id"], hello["runtime"]), ("agent-1", runtime))
                    write_frame(child.stdin, {"type": "welcome", "v": "1.0",
                                              "accepted_version": "1.0", "host_id": "route-1",
                                              "policy": {"max_turn_seconds": 30}})
                    write_frame(child.stdin, wake())
                    self.assertEqual(read_frame(child.stdout)["state"], "accepted")
                    result = read_frame(child.stdout)
                    self.assertEqual(result["state"], "done")
                    self.assertEqual(child.wait(timeout=5), 0, child.stderr.read().decode())
                    captured = json.loads(capture.read_text("utf-8"))
                    self.assertIn("message-1", captured["prompt"])
                    self.assertIn("agent_link_native", captured["prompt"])
                    self.assertNotIn("peer supplied command", captured["prompt"])
                    if runtime == "codex":
                        self.assertEqual(captured["argv"][0], "exec")
                        self.assertEqual(captured["argv"][-1], "-")
                    else:
                        self.assertIn("--mcp-config", captured["argv"])
                        self.assertIn("-p", captured["argv"])
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()
                    child.stdin.close()
                    child.stdout.close()
                    child.stderr.close()

    def test_sigterm_cancels_and_reaps_provider_child(self):
        config, fake, capture = self._fixture("codex")
        script = ROOT / "scripts" / "agent-mesh-provider-runtime.py"
        env = dict(os.environ)
        env.update(PROVIDER_CAPTURE=str(capture), PROVIDER_SLEEP="1")
        child = subprocess.Popen([
            sys.executable, str(script), "--config", str(config), "--agent-id", "agent-1",
            "--runtime", "codex", "--provider-executable", str(fake),
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        try:
            self.assertEqual(read_frame(child.stdout)["type"], "hello")
            write_frame(child.stdin, {"type": "welcome", "v": "1.0",
                                      "accepted_version": "1.0", "host_id": "route-1",
                                      "policy": {"max_turn_seconds": 30}})
            write_frame(child.stdin, wake())
            self.assertEqual(read_frame(child.stdout)["state"], "accepted")
            for _ in range(50):
                if capture.exists():
                    break
                time.sleep(0.02)
            provider_pid = json.loads(capture.read_text("utf-8"))["pid"]
            os.kill(child.pid, signal.SIGTERM)
            result = read_frame(child.stdout)
            self.assertEqual(result["state"], "cancelled")
            self.assertEqual(child.wait(timeout=5), 2)
            with self.assertRaises(ProcessLookupError):
                os.kill(provider_pid, 0)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            child.stdin.close()
            child.stdout.close()
            child.stderr.close()


if __name__ == "__main__":
    unittest.main()
