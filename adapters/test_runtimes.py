import unittest

from runtimes import ClaudeRuntime, CodexRuntime, RuntimeFailure


class RuntimeProtocolTests(unittest.TestCase):
    def claude(self, events):
        runtime = ClaudeRuntime.__new__(ClaudeRuntime)
        runtime.session_id = "owned-claude"
        runtime.timeout = 1
        runtime.capabilities = {"observed_tool_items": 0}
        runtime.sent = []
        runtime.send = runtime.sent.append
        runtime.event = lambda _: events.pop(0)
        return runtime

    def test_claude_init_is_not_acceptance(self):
        events = [{"type": "system", "subtype": "init", "session_id": "owned-claude", "tools": []},
                  {"type": "result", "subtype": "error", "is_error": True}]
        accepted = []
        with self.assertRaises(RuntimeFailure):
            self.claude(events).reply({"body": "hello"}, accepted.append)
        self.assertEqual(accepted, [])

    def test_claude_assistant_proves_acceptance(self):
        events = [{"type": "assistant", "session_id": "owned-claude", "message": {"content": [{"type": "text", "text": "hello"}]}},
                  {"type": "result", "subtype": "success", "result": "hello"}]
        accepted = []
        runtime = self.claude(events)
        self.assertEqual(runtime.reply({"body": "hello"}, accepted.append), "hello")
        self.assertEqual(accepted, ["owned-claude"])
        self.assertEqual(runtime.sent[0]["type"], "user")

    def test_claude_rejects_exposed_tools(self):
        runtime = self.claude([{"type": "system", "subtype": "init", "tools": ["Bash"]}])
        with self.assertRaisesRegex(RuntimeFailure, "unexpected tools"):
            runtime.reply({"body": "hello"}, lambda _: None)

    def test_claude_rejects_foreign_session(self):
        runtime = self.claude([{"type": "assistant", "session_id": "not-owned"}])
        with self.assertRaisesRegex(RuntimeFailure, "identity"):
            runtime.reply({"body": "hello"}, lambda _: None)

    def codex(self, events):
        runtime = CodexRuntime.__new__(CodexRuntime)
        runtime.session_id = "owned-codex"
        runtime.timeout = 1
        runtime.capabilities = {"observed_tool_items": 0}
        runtime.pending = []
        runtime.rpc = lambda method, params: {"turn": {"id": "t1"}}
        runtime.event = lambda _: events.pop(0)
        return runtime

    def test_codex_acceptance_after_turn_start_and_completion(self):
        runtime = self.codex([
            {"method": "item/completed", "params": {"threadId": "owned-codex", "item": {"type": "agentMessage", "text": "hello"}}},
            {"method": "turn/completed", "params": {"threadId": "owned-codex", "turn": {"id": "t1", "status": "completed"}}},
        ])
        accepted = []
        self.assertEqual(runtime.reply({"body": "hello"}, accepted.append), "hello")
        self.assertEqual(accepted, ["owned-codex"])

    def test_codex_no_success_claim_for_failed_turn(self):
        runtime = self.codex([
            {"method": "turn/completed", "params": {"turn": {"id": "t1", "status": "failed"}}},
        ])
        accepted = []
        with self.assertRaises(RuntimeFailure):
            runtime.reply({"body": "hello"}, accepted.append)
        self.assertEqual(accepted, ["owned-codex"])

    def test_codex_rejects_tool_item(self):
        runtime = self.codex([
            {"method": "item/started", "params": {"item": {"type": "commandExecution"}}},
        ])
        with self.assertRaisesRegex(RuntimeFailure, "tool"):
            runtime.reply({"body": "hello"}, lambda _: None)


if __name__ == "__main__":
    unittest.main()
