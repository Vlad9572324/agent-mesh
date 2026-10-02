"""Offline profiles and owned Python fake-process cleanup; no provider CLIs/network."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from dev_trial_runtimes import FILE_TOOLS, READ_ONLY_TOOLS, _command, _Events, _stop_owned_group, run_job


SCHEMA = {"type": "object", "properties": {"summary": {"type": "string"}},
          "required": ["summary"], "additionalProperties": False}


class CommandProfileTests(unittest.TestCase):
    def test_json_schema_flag_is_claude_only_and_keeps_file_tools(self):
        for read_only in (False, True):
            command = _command("claude", "/work", read_only=read_only, json_schema=SCHEMA)
            self.assertEqual(json.loads(command[command.index("--json-schema") + 1]), SCHEMA)
            self.assertEqual(command[:-2], _command("claude", "/work", read_only=read_only))
        self.assertNotIn("--json-schema", _command("claude", "/work"))
        for runtime, schema in (("codex", SCHEMA), ("claude", "{}"), ("claude", []),
                                ("claude", True), ("claude", {"invalid": float("nan")})):
            with self.subTest(runtime=runtime, schema_type=type(schema).__name__), self.assertRaises(ValueError):
                _command(runtime, "/work", json_schema=schema)
            with self.assertRaises(ValueError):
                _Events(runtime, None, json_schema=schema)

    def test_codex_profiles_preserve_noninteractive_safety(self):
        for read_only, sandbox in ((False, "workspace-write"), (True, "read-only")):
            with self.subTest(read_only=read_only):
                command = _command("codex", "/specific/work", read_only=read_only)
                self.assertEqual(command[command.index("--sandbox") + 1], sandbox)
                self.assertEqual(command[command.index("-C") + 1], "/specific/work")
                for flag in ("--json", "--ephemeral", "--ignore-user-config"):
                    self.assertIn(flag, command)
                for setting in ('approval_policy="never"', 'web_search="disabled"',
                                "sandbox_workspace_write.network_access=false",
                                "mcp_servers={}", "features.apps=false", "features.plugins=false",
                                "features.hooks=false", "features.multi_agent=false"):
                    self.assertIn(setting, command)
                self.assertEqual(command[-1], "-")

    def test_claude_profiles_exact_tool_lists(self):
        for read_only, tools in ((False, FILE_TOOLS), (True, READ_ONLY_TOOLS)):
            with self.subTest(read_only=read_only):
                command = _command("claude", "/specific/work", read_only=read_only)
                for flag in ("--tools", "--allowedTools"):
                    self.assertEqual(command[command.index(flag) + 1], ",".join(tools))
                self.assertEqual(command[command.index("--permission-mode") + 1], "dontAsk")
                self.assertEqual(command[command.index("--mcp-config") + 1], '{"mcpServers":{}}')
                self.assertIn("--restricted", command)
                self.assertIn("--safe-mode", command)
                self.assertIn("--no-session-persistence", command)
                self.assertNotIn("Bash", ",".join(command))

    def test_default_profile_is_unchanged(self):
        for runtime in ("codex", "claude"):
            self.assertEqual(_command(runtime, "/work"), _command(runtime, "/work", read_only=False))

    def test_profile_requires_boolean(self):
        for invalid in (None, 0, 1, "false", [], {}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                _command("codex", "/work", read_only=invalid)
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                _Events("claude", None, read_only=invalid)

    def test_claude_model_aliases_preserve_tools_and_defaults(self):
        for read_only in (False, True):
            default = _command("claude", "/work", read_only=read_only)
            self.assertEqual(default, _command("claude", "/work", read_only=read_only, model="sonnet"))
            for model in ("sonnet", "opus"):
                command = _command("claude", "/work", read_only=read_only, model=model)
                self.assertEqual(command[command.index("--model") + 1], model)
                normalized = list(command)
                normalized[normalized.index("--model") + 1] = "sonnet"
                self.assertEqual(normalized, default)

    def test_invalid_models_rejected_without_guessing_codex_names(self):
        for model in ("", "haiku", "Opus", "opus --tools Bash", 1, False, [], {}):
            with self.subTest(runtime="claude", model=model), self.assertRaises(ValueError):
                _command("claude", "/work", model=model)
        for model in ("sonnet", "opus", "gpt-unknown", "", 1, False, [], {}):
            with self.subTest(runtime="codex", model=model), self.assertRaises(ValueError):
                _command("codex", "/work", model=model)
        self.assertNotIn("--model", _command("codex", "/work", model=None))


class EventProfileTests(unittest.TestCase):
    def test_native_structured_output_serializes_without_using_prose(self):
        published = []
        events = _Events("claude", published.append, read_only=True, json_schema=SCHEMA)
        expected = {"summary": "PRIVATE итог", "nested": {"value": [True, None, 3]}}
        events.accept({"type": "result", "subtype": "success", "structured_output": expected,
                       "result": "PRIVATE apology\n```json\n{}\n```"})
        self.assertEqual(json.loads(events.final_text), expected)
        self.assertNotIn("apology", events.final_text)
        self.assertTrue(events.structured_output_used)
        self.assertTrue(events.terminal_success)
        self.assertEqual(published, [])

    def test_structured_output_requires_object_without_fallback_or_coercion(self):
        for value in (None, "{\"summary\":\"valid-looking\"}", [], True, 1, 1.5):
            events = _Events("claude", None, json_schema=SCHEMA)
            with self.subTest(value_type=type(value).__name__), self.assertRaises(ValueError):
                events.accept({"type": "result", "subtype": "success", "structured_output": value,
                               "result": '{"summary":"prose must not be fallback"}'})
            self.assertFalse(events.structured_output_used)
            self.assertEqual(events.final_text, "")
        events = _Events("claude", None, json_schema=SCHEMA)
        with self.assertRaises(ValueError):
            events.accept({"type": "result", "subtype": "success", "result": "```json\n{}\n```"})

    def test_structured_pseudo_tool_is_schema_gated_and_callbacks_stay_sanitized(self):
        inventory = {"type": "system", "subtype": "init", "tools": ["Read", "StructuredOutput"]}
        tool = {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "output-1",
                "name": "StructuredOutput", "input": {"PRIVATE-FIELD": {"private": True}}}]}}
        for event in (inventory, tool):
            with self.assertRaises(ValueError):
                _Events("claude", None, read_only=True).accept(event)
        published = []
        events = _Events("claude", published.append, read_only=True, json_schema=SCHEMA)
        events.accept(inventory)
        events.accept(tool)
        events.accept({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "output-1", "content": "PRIVATE RESULT"}]}})
        self.assertEqual([event["tool_type"] for event in published], ["StructuredOutput", "StructuredOutput"])
        for event in published:
            self.assertEqual(set(event), {"event", "runtime", "started_count", "ended_count", "tool_type"})
            self.assertIs(type(event["started_count"]), int)
            self.assertIs(type(event["ended_count"]), int)
        self.assertNotIn("PRIVATE", json.dumps(published))
        for name in ("Edit", "Write", "Bash", "WebFetch", "StructuredOutputOther"):
            with self.subTest(tool=name), self.assertRaises(ValueError):
                events.accept({"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "id": "forbidden", "name": name, "input": {}}]}})
            with self.assertRaises(ValueError):
                _Events("claude", None, read_only=True, json_schema=SCHEMA).accept(
                    {"type": "system", "subtype": "init", "tools": [name]})

    def test_default_final_text_is_unchanged_and_ignores_unsolicited_structured_data(self):
        events = _Events("claude", None)
        events.accept({"type": "result", "subtype": "success", "result": "PRIVATE normal prose",
                       "structured_output": {"summary": "not requested"}})
        self.assertEqual(events.final_text, "PRIVATE normal prose")
        self.assertFalse(events.structured_output_used)

    def test_claude_observed_models_preserve_resolved_ids_and_deduplicate(self):
        published = []
        events = _Events("claude", published.append)
        events.accept({"type": "system", "subtype": "init", "model": "claude-opus-fixture-1", "tools": []})
        for model in ("claude-opus-fixture-1", "claude-opus-fixture-2"):
            events.accept({"type": "assistant", "message": {"model": model, "content": []}})
        # Caller-written user message metadata is not model identity evidence.
        events.accept({"type": "user", "message": {"model": "NOT-EVIDENCE", "content": []}})
        self.assertEqual(events.observed_models, ["claude-opus-fixture-1", "claude-opus-fixture-2"])
        self.assertEqual(published, [])

    def test_codex_observed_models_require_explicit_event_metadata(self):
        events = _Events("codex", None)
        events.accept({"type": "thread.started", "thread_id": "session-1"})
        events.accept({"type": "item.completed", "item": {"type": "agent_message", "text": "I am model guessed"}})
        self.assertEqual(events.observed_models, [])
        events.accept({"type": "turn.started", "model": "codex-model-fixture"})
        events.accept({"type": "item.completed", "item": {
            "type": "agent_message", "model": "codex-model-fixture", "text": "PRIVATE FINAL"}})
        self.assertEqual(events.observed_models, ["codex-model-fixture"])

    def test_invalid_model_metadata_rejected_without_echoing_value(self):
        for model in ("", [], {}, True, "PRIVATE\nINVALID", "x" * 257):
            with self.subTest(model_type=type(model).__name__), self.assertRaises(ValueError) as caught:
                _Events("claude", None).accept({"type": "system", "subtype": "init", "model": model})
            self.assertNotIn("PRIVATE", str(caught.exception))

    def test_codex_read_only_rejects_every_file_change_lifecycle_event(self):
        for kind in ("item.started", "item.updated", "item.completed"):
            events, published = None, []
            events = _Events("codex", published.append, read_only=True)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                events.accept({"type": kind, "item": {"id": "edit-1", "type": "file_change",
                                                      "changes": "PRIVATE PATCH"}})
            self.assertEqual(published, [])
            self.assertEqual(events.started, {})

    def test_codex_default_allows_file_change(self):
        published = []
        events = _Events("codex", published.append)
        events.accept({"type": "item.completed", "item": {"id": "edit-1", "type": "file_change"}})
        self.assertEqual(events.counts["file_change.ended"], 1)
        self.assertEqual(published[0]["tool_type"], "file_change")

    def test_codex_read_only_retains_command_tool_without_exposing_arguments(self):
        published = []
        events = _Events("codex", published.append, read_only=True)
        for kind in ("item.started", "item.completed"):
            events.accept({"type": kind, "item": {"id": "read-1", "type": "command_execution",
                                                  "command": "PRIVATE ARGUMENT", "output": "PRIVATE RESULT"}})
        self.assertEqual(events.counts["command_execution.started"], 1)
        self.assertEqual(events.counts["command_execution.ended"], 1)
        self.assertNotIn("PRIVATE", json.dumps(published))

    def test_claude_init_is_subset_of_selected_profile(self):
        for read_only, tools in ((False, FILE_TOOLS), (True, READ_ONLY_TOOLS)):
            for inventory in ([], ["Read"], list(tools)):
                with self.subTest(read_only=read_only, inventory=inventory):
                    _Events("claude", None, read_only=read_only).accept(
                        {"type": "system", "subtype": "init", "tools": inventory})
        for inventory in (["Edit"], ["Write"], ["Read", "Edit"], ["Bash"], ["command_execution"], "Read"):
            with self.subTest(inventory=inventory), self.assertRaises(ValueError):
                _Events("claude", None, read_only=True).accept(
                    {"type": "system", "subtype": "init", "tools": inventory})

    def test_claude_read_only_rejects_mutating_and_unconfigured_tools(self):
        for tool in ("Edit", "Write", "Bash", "WebFetch", "command_execution", "file_change"):
            published = []
            events = _Events("claude", published.append, read_only=True)
            with self.subTest(tool=tool), self.assertRaises(ValueError):
                events.accept({"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "id": "tool-1", "name": tool, "input": "PRIVATE INPUT"}]}})
            self.assertEqual(published, [])

    def test_claude_allowed_tools_complete_and_stay_sanitized(self):
        for read_only, tools in ((False, FILE_TOOLS), (True, READ_ONLY_TOOLS)):
            published = []
            events = _Events("claude", published.append, read_only=read_only)
            for tool in tools:
                events.accept({"type": "assistant", "message": {"content": [
                    {"type": "tool_use", "id": tool, "name": tool, "input": "PRIVATE INPUT"}]}})
                events.accept({"type": "user", "message": {"content": [
                    {"type": "tool_result", "tool_use_id": tool, "content": "PRIVATE RESULT"}]}})
            self.assertEqual(len(events.started), len(tools))
            self.assertEqual(len(events.ended), len(tools))
            self.assertNotIn("PRIVATE", json.dumps(published))


class _ExitedChild:
    """OS pipes only, never a subprocess; sufficient for the real selector loop."""
    pid = 987654321

    def __init__(self, events):
        self.returncode = None
        self.stdout = self._pipe(b"".join((json.dumps(event) + "\n").encode() for event in events))
        self.stderr = self._pipe(b"")

    @staticmethod
    def _pipe(payload):
        reader, writer = os.pipe()
        try:
            os.write(writer, payload)
        finally:
            os.close(writer)
        return os.fdopen(reader, "rb")

    def poll(self):
        self.returncode = 0
        return 0

    def wait(self, timeout=None):
        self.returncode = 0
        return 0


class _ExitedGroup:
    """Ownership substitute only for the pipe-only parser fixtures."""
    def __init__(self, child):
        self.child = child

    def _prove(self):
        return True

    def exited(self):
        return True

    def live_members(self):
        return []


@mock.patch("dev_trial_runtimes._OwnedGroup", _ExitedGroup)
class RunJobProfileTests(unittest.TestCase):
    def test_run_job_native_structured_output_success_and_missing_fail_closed(self):
        for has_object in (False, True):
            with self.subTest(has_object=has_object), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                final = {"type": "result", "subtype": "success", "session_id": "session-1",
                         "result": "PRIVATE apology\n```json\n{}\n```"}
                if has_object:
                    final["structured_output"] = {"summary": "PRIVATE native result"}
                child = _ExitedChild([
                    {"type": "system", "subtype": "init", "session_id": "session-1", "tools": ["Read", "StructuredOutput"]},
                    final,
                ])
                published = []
                with mock.patch("dev_trial_runtimes.subprocess.Popen", return_value=child) as spawn, \
                        mock.patch("dev_trial_runtimes.os.killpg", side_effect=AssertionError("unexpected kill")):
                    report = run_job("claude", str(root), "PRIVATE PROMPT", str(root / "evidence"),
                                     published.append, read_only=True, model="sonnet", json_schema=SCHEMA)
                self.assertIs(report["success"], has_object)
                self.assertIs(report["structured_output_used"], has_object)
                self.assertEqual(report["error_category"], None if has_object else "ValueError")
                self.assertIn("--json-schema", spawn.call_args.args[0])
                self.assertNotIn("PRIVATE", json.dumps(published))
                if has_object:
                    self.assertEqual(json.loads(report["final_text"]), final["structured_output"])
                else:
                    self.assertEqual(report["final_text"], "")
                saved = json.loads(Path(report["logs"]["report.json"]).read_text())
                self.assertIs(saved["structured_output_used"], has_object)

    def test_reports_profiles_and_passes_them_to_runtime_without_real_execution(self):
        for runtime in ("codex", "claude"):
            for read_only in (False, True):
                with self.subTest(runtime=runtime, read_only=read_only), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    work = root / "work"
                    work.mkdir()
                    events = ([{"type": "thread.started", "thread_id": "session-1"},
                               {"type": "turn.completed"}] if runtime == "codex" else [
                               {"type": "system", "subtype": "init", "session_id": "session-1", "tools": ["Read"]},
                               {"type": "result", "subtype": "success", "session_id": "session-1", "result": "PRIVATE FINAL"}])
                    child = _ExitedChild(events)
                    published = []
                    with mock.patch("dev_trial_runtimes.subprocess.Popen", return_value=child) as spawn, \
                            mock.patch("dev_trial_runtimes.os.killpg", side_effect=AssertionError("unexpected kill")):
                        report = run_job(runtime, str(work), "PRIVATE PROMPT", str(root / "evidence"),
                                         published.append, read_only=read_only)
                    self.assertTrue(report["success"])
                    self.assertIs(report["read_only"], read_only)
                    self.assertEqual(report["requested_model"], "sonnet" if runtime == "claude" else None)
                    self.assertEqual(report["observed_models"], [])
                    self.assertEqual(report["command"], _command(runtime, work, read_only=read_only))
                    spawn.assert_called_once()
                    self.assertEqual(spawn.call_args.args[0], report["command"])
                    self.assertNotIn("PRIVATE", json.dumps(published))
                    self.assertNotIn("PRIVATE PROMPT", json.dumps(report["command"]))
                    for path in report["logs"].values():
                        self.assertEqual(Path(path).stat().st_mode & 0o777, 0o600)
                    saved = json.loads(Path(report["logs"]["report.json"]).read_text())
                    self.assertIs(saved["read_only"], read_only)

    def test_run_job_records_opus_alias_and_resolved_model_privately(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            child = _ExitedChild([
                {"type": "system", "subtype": "init", "session_id": "session-1",
                 "model": "claude-opus-resolved-fixture", "tools": ["Read"]},
                {"type": "assistant", "message": {"model": "claude-opus-resolved-fixture", "content": []}},
                {"type": "result", "subtype": "success", "session_id": "session-1", "result": "PRIVATE FINAL"},
            ])
            published = []
            with mock.patch("dev_trial_runtimes.subprocess.Popen", return_value=child) as spawn, \
                    mock.patch("dev_trial_runtimes.os.killpg", side_effect=AssertionError("unexpected kill")):
                report = run_job("claude", str(root), "PRIVATE PROMPT", str(root / "evidence"),
                                 published.append, read_only=True, model="opus")
            self.assertTrue(report["success"])
            self.assertEqual(report["requested_model"], "opus")
            self.assertEqual(report["observed_models"], ["claude-opus-resolved-fixture"])
            command = spawn.call_args.args[0]
            self.assertEqual(command[command.index("--model") + 1], "opus")
            self.assertNotIn("resolved-fixture", json.dumps(published))
            saved = json.loads(Path(report["logs"]["report.json"]).read_text())
            self.assertEqual(saved["observed_models"], report["observed_models"])

    def test_read_only_policy_violation_fails_even_with_successful_terminal_and_exit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            child = _ExitedChild([
                {"type": "thread.started", "thread_id": "session-1"},
                {"type": "turn.completed"},
                {"type": "item.completed", "item": {"id": "write-1", "type": "file_change"}},
            ])
            with mock.patch("dev_trial_runtimes.subprocess.Popen", return_value=child), \
                    mock.patch("dev_trial_runtimes.os.killpg", side_effect=AssertionError("unexpected kill")):
                report = run_job("codex", str(root), "Read only", str(root / "evidence"),
                                 None, read_only=True)
            self.assertFalse(report["success"])
            self.assertEqual(report["error_category"], "ValueError")
            self.assertTrue(report["terminal_success"])
            self.assertEqual(report["exit_code"], 0)


@unittest.skipUnless(sys.platform == "linux" and hasattr(os, "WNOWAIT"), "Linux pinned-group cleanup")
class OwnedGroupCleanupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Adopt/reap only our deliberately orphaned fixture grandchildren, so
        # tests do not leave zombies to a container's possibly minimal PID 1.
        import ctypes
        cls.libc = ctypes.CDLL(None, use_errno=True)
        old = ctypes.c_int()
        if cls.libc.prctl(37, ctypes.byref(old), 0, 0, 0) != 0 or cls.libc.prctl(36, 1, 0, 0, 0) != 0:
            raise unittest.SkipTest("test subreaper unavailable")
        cls.previous_subreaper = old.value

    @classmethod
    def tearDownClass(cls):
        cls.libc.prctl(36, cls.previous_subreaper, 0, 0, 0)

    def fake_tree(self, *, close_pipes=False, ignore_term=False):
        with tempfile.TemporaryDirectory(prefix="owned-group-offline-") as temporary:
            root = Path(temporary)
            marker = root / "descendant.pid"
            script = '''import json,os,signal,sys,time
from pathlib import Path
marker=Path(sys.argv[1])
if os.fork()==0:
    signal.signal(signal.SIGTERM,signal.SIG_IGN if sys.argv[3]=='yes' else signal.SIG_DFL)
    marker.write_text(str(os.getpid()))
    if sys.argv[2]=='yes':
        os.close(1);os.close(2)
    time.sleep(30)
    os._exit(0)
while not marker.exists():time.sleep(.01)
os.write(1,(json.dumps({'type':'thread.started','thread_id':'fake-session'})+'\\n'+json.dumps({'type':'turn.completed'})+'\\n').encode())
os._exit(0)
'''
            command = [sys.executable, "-c", script, str(marker), "yes" if close_pipes else "no", "yes" if ignore_term else "no"]
            started = time.monotonic()
            try:
                with mock.patch("dev_trial_runtimes._command", return_value=command):
                    report = run_job("codex", root, "Offline fixture", root / "evidence", None, timeout=.4)
                self.assertTrue(marker.exists(), "owned fixture descendant never started")
                pid = int(marker.read_text())
                # Only wait for this fixture PID; never broad waitpid(-1).
                observed, _status = os.waitpid(pid, os.WNOHANG)
                self.assertEqual(observed, pid, "owned descendant survived cleanup")
                self.assertTrue(report["cleanup"]["leader_reaped"])
                self.assertTrue(report["cleanup"]["group_stopped"])
                self.assertTrue(report["cleanup"]["live_descendants_found"])
                self.assertFalse(report["success"])
                self.assertLess(time.monotonic() - started, 10)
                return report
            finally:
                # Failure hygiene: child ownership is proven by waitpid before
                # any pidfd signal. No stale numeric PID/PGID is ever signalled.
                if marker.exists():
                    pid = int(marker.read_text())
                    try:
                        observed, _status = os.waitpid(pid, os.WNOHANG)
                        if observed == 0:
                            fd = os.pidfd_open(pid)
                            try:
                                signal.pidfd_send_signal(fd, signal.SIGKILL)
                            finally:
                                os.close(fd)
                            deadline = time.monotonic() + 2
                            while time.monotonic() < deadline and os.waitpid(pid, os.WNOHANG)[0] == 0:
                                time.sleep(.01)
                    except (ChildProcessError, ProcessLookupError):
                        pass

    def test_exited_leader_pipe_holding_descendant_is_terminated_and_reaped(self):
        report = self.fake_tree()
        self.assertTrue(report["timed_out"])
        self.assertEqual(report["error_category"], "TimeoutError")
        self.assertEqual(report["cleanup"]["group_signals"], ["SIGTERM"])

    def test_exited_leader_term_resistant_descendant_escalates_to_kill(self):
        report = self.fake_tree(ignore_term=True)
        self.assertEqual(report["cleanup"]["group_signals"], ["SIGTERM", "SIGKILL"])

    def test_successful_terminal_with_closed_pipes_but_live_descendant_is_not_success(self):
        report = self.fake_tree(close_pipes=True)
        self.assertTrue(report["terminal_success"])
        self.assertFalse(report["timed_out"])
        self.assertEqual(report["error_category"], "ChildProcessError")

    def test_clean_normal_python_exit_is_reaped_without_group_signal(self):
        with tempfile.TemporaryDirectory() as temporary:
            command = [sys.executable, "-c", "print('{\"type\":\"thread.started\",\"thread_id\":\"fake\"}'); print('{\"type\":\"turn.completed\"}')"]
            with mock.patch("dev_trial_runtimes._command", return_value=command):
                report = run_job("codex", temporary, "Offline fixture", Path(temporary) / "evidence", None, timeout=2)
            self.assertTrue(report["success"])
            self.assertTrue(report["cleanup"]["leader_reaped"])
            self.assertEqual(report["cleanup"]["group_signals"], [])

    def test_already_reaped_leader_never_signals_its_reusable_pgid(self):
        child = mock.Mock(pid=987654321, returncode=0)
        child.poll.return_value = 0
        with mock.patch("dev_trial_runtimes.os.killpg") as kill:
            result = _stop_owned_group(child)
        kill.assert_not_called()
        self.assertTrue(result["ownership_refused"])
        self.assertFalse(result["group_stopped"])

    def test_nonprivate_process_group_is_refused_without_signalling_other_members(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=False)
        try:
            with mock.patch("dev_trial_runtimes.os.killpg") as kill:
                result = _stop_owned_group(child)
            kill.assert_not_called()
            self.assertTrue(result["ownership_refused"])
            self.assertIsNone(child.poll())
        finally:
            child.kill()
            child.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()
