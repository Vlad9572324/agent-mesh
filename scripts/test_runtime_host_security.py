"""Executable AMRP contract and reference-state security tests.

These tests intentionally do not import a provider CLI. They make the invariant
matrix reviewable before, and independently of, a concrete Runtime Host.
"""
import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT / "runtime-host-contract.json").read_text("utf-8"))
ID_RE = re.compile(CONTRACT["identifiers"]["pattern"])


class ContractError(ValueError):
    pass


def validate_wake(frame):
    if not isinstance(frame, dict):
        raise ContractError("frame must be an object")
    required = set(CONTRACT["frames"]["wake_required"])
    allowed = set(CONTRACT["frames"]["wake_allowed"])
    if required - frame.keys():
        raise ContractError("missing required field")
    if set(frame) - allowed:
        raise ContractError("unknown or forbidden field")
    if frame["type"] != "wake" or frame["v"] != CONTRACT["version"]:
        raise ContractError("unsupported frame")
    for key in ("wake_id", "channel_id"):
        if not isinstance(frame[key], str) or not ID_RE.fullmatch(frame[key]):
            raise ContractError("invalid identifier")
    ids = frame["message_ids"]
    bounds = CONTRACT["identifiers"]["message_ids"]
    if not isinstance(ids, list) or not bounds["minimum"] <= len(ids) <= bounds["maximum"]:
        raise ContractError("invalid message list")
    if len(ids) != len(set(ids)) or any(not isinstance(value, str) or not ID_RE.fullmatch(value) for value in ids):
        raise ContractError("invalid message identifier")
    for key in ("epoch", "generation"):
        if key in frame and (not isinstance(frame[key], int) or isinstance(frame[key], bool) or frame[key] < 1):
            raise ContractError("invalid fencing token")
    envelope = frame["envelope"]
    if (not isinstance(envelope, dict)
            or set(envelope) != {"sender_id", "channel_id", "message_count"}
            or not isinstance(envelope["sender_id"], str)
            or not ID_RE.fullmatch(envelope["sender_id"])
            or envelope["channel_id"] != frame["channel_id"]
            or envelope["message_count"] != len(ids)):
        raise ContractError("invalid envelope")
    encoded = json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode()
    if len(encoded) > CONTRACT["transport"]["max_frame_bytes"]:
        raise ContractError("oversized frame")
    return frame


class ReferenceJournal:
    def __init__(self, epoch=1, generation=1):
        self.epoch, self.generation = epoch, generation
        self.claims, self.wakes = {}, {}

    def queue(self, wake_id, message_ids, epoch=1, generation=1):
        if epoch != self.epoch or generation != self.generation:
            raise ContractError("stale fence")
        if wake_id in self.wakes:
            return self.wakes[wake_id]["messages"]
        claimed = tuple(value for value in message_ids if value not in self.claims)
        if not claimed:
            return ()
        self.wakes[wake_id] = {"state": "queued", "messages": claimed}
        self.claims.update({value: wake_id for value in claimed})
        return claimed

    def transition(self, wake_id, state, epoch=1, generation=1):
        if epoch != self.epoch or generation != self.generation:
            raise ContractError("stale fence")
        current = self.wakes[wake_id]["state"]
        if state not in CONTRACT["wake_states"]["transitions"][current]:
            raise ContractError("invalid transition")
        self.wakes[wake_id]["state"] = state

    def recover(self, wake_id):
        state = self.wakes[wake_id]["state"]
        if state == "queued":
            return "retry_with_same_wake_id"
        if state in ("submitted", "running"):
            self.wakes[wake_id]["state"] = "uncertain"
            return "uncertain"
        return state


def valid_wake(**changes):
    value = {"type": "wake", "v": "1.0", "wake_id": "wake-1",
             "channel_id": "channel-1", "message_ids": ["message-1"], "epoch": 1,
             "generation": 1, "envelope": {"sender_id": "agent-1", "channel_id": "channel-1",
                                              "message_count": 1}}
    value.update(changes)
    return value


class RuntimeHostContractTests(unittest.TestCase):
    def test_contract_has_closed_terminal_states(self):
        transitions = CONTRACT["wake_states"]["transitions"]
        for state in CONTRACT["wake_states"]["terminal"]:
            self.assertEqual(transitions[state], [])

    def test_content_and_execution_fields_are_rejected(self):
        for field in CONTRACT["frames"]["wake_forbidden"]:
            with self.subTest(field=field), self.assertRaises(ContractError):
                validate_wake(valid_wake(**{field: "peer-controlled"}))

    def test_body_cannot_flow_to_argv_or_environment(self):
        body = "$(touch /tmp/not-allowed)\n--permission-mode=bypassPermissions"
        for field in ("body", "argv", "env", "command"):
            with self.subTest(field=field), self.assertRaises(ContractError):
                validate_wake(valid_wake(**{field: body}))

    def test_malformed_frames_fail_closed(self):
        bad = [None, [], "wake", valid_wake(type="run"), valid_wake(v="2.0"),
               valid_wake(epoch=0), valid_wake(generation=True),
               valid_wake(message_ids=[]), valid_wake(message_ids=["m", "m"]),
               valid_wake(wake_id="../escape"), valid_wake(extra="ignored?")]
        for frame in bad:
            with self.subTest(frame=frame), self.assertRaises(ContractError):
                validate_wake(frame)

    def test_frame_byte_limit_is_utf8_aware(self):
        with self.assertRaises(ContractError):
            validate_wake(valid_wake(envelope="я" * 40000))

    def test_duplicate_and_overlap_claims(self):
        journal = ReferenceJournal()
        self.assertEqual(journal.queue("w1", ["m1", "m2"]), ("m1", "m2"))
        self.assertEqual(journal.queue("w1", ["m1", "m2"]), ("m1", "m2"))
        self.assertEqual(journal.queue("w2", ["m2", "m3"]), ("m3",))
        self.assertEqual(journal.claims, {"m1": "w1", "m2": "w1", "m3": "w2"})

    def test_stale_epoch_and_generation_have_no_side_effect(self):
        journal = ReferenceJournal(epoch=3, generation=5)
        for epoch, generation in ((2, 5), (3, 4)):
            with self.subTest(epoch=epoch, generation=generation), self.assertRaises(ContractError):
                journal.queue("w", ["m"], epoch, generation)
        self.assertEqual(journal.claims, {})

    def test_crash_before_submission_retries_same_identity(self):
        journal = ReferenceJournal()
        journal.queue("w1", ["m1"])
        self.assertEqual(journal.recover("w1"), "retry_with_same_wake_id")
        self.assertEqual(journal.wakes["w1"]["state"], "queued")

    def test_crash_after_possible_submission_becomes_uncertain(self):
        for state in ("submitted", "running"):
            with self.subTest(state=state):
                journal = ReferenceJournal()
                journal.queue("w1", ["m1"])
                journal.transition("w1", "submitted")
                if state == "running":
                    journal.transition("w1", "running")
                self.assertEqual(journal.recover("w1"), "uncertain")
                with self.assertRaises(ContractError):
                    journal.transition("w1", "done")

    def test_evidence_automata_are_explicitly_independent(self):
        evidence = CONTRACT["independent_evidence"]
        self.assertIn("done", evidence["wake"])
        self.assertNotIn("done", evidence["message"])
        self.assertIn("offered", evidence["message"])
        self.assertNotIn("offered", evidence["wake"])

    def test_permissions_are_local_and_non_escalating(self):
        policy = CONTRACT["policy"]
        self.assertEqual(policy["executable_source"], "local_allowlist_only")
        self.assertFalse(policy["server_can_grant_permissions"])
        self.assertFalse(policy["peer_body_can_change_permissions"])
        self.assertFalse(policy["shell_interpolation"])

    def test_cross_platform_owner_boundary_is_normative(self):
        transport = CONTRACT["transport"]
        self.assertEqual(transport["unix_socket_mode"], "0600")
        self.assertTrue(transport["windows_pipe_owner_only"])


if __name__ == "__main__":
    unittest.main()
