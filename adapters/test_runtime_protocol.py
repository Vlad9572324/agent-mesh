import io
import math
import os
import subprocess
import sys
import unittest

from runtime_protocol import (MAX_FRAME_BYTES, ProtocolError, decode_frame, encode_frame,
                              negotiate_version, read_frame, write_frame)


def wake(**updates):
    value = {"type": "wake", "v": "1.0", "wake_id": "wake-1",
             "channel_id": "development", "message_ids": ["message-1"],
             "envelope": {"sender_id": "agent-1", "channel_id": "development",
                          "message_count": 1}}
    value.update(updates)
    return value


class RuntimeProtocolTests(unittest.TestCase):
    def test_round_trip_and_stream_eof(self):
        stream = io.BytesIO()
        write_frame(stream, wake())
        stream.seek(0)
        self.assertEqual(read_frame(stream), wake())
        self.assertIsNone(read_frame(stream))

    def test_duplicate_key_rejected(self):
        with self.assertRaisesRegex(ProtocolError, "duplicate"):
            decode_frame(b'{"type":"heartbeat","type":"heartbeat","v":"1.0"}\n')

    def test_nonfinite_rejected_on_both_paths(self):
        with self.assertRaisesRegex(ProtocolError, "non-finite"):
            decode_frame(b'{"type":"heartbeat","v":NaN}\n')
        with self.assertRaises(ProtocolError):
            encode_frame({"type": "heartbeat", "v": math.nan})

    def test_bounded_and_complete_line(self):
        with self.assertRaisesRegex(ProtocolError, "byte limit"):
            read_frame(io.BytesIO(b" " * (MAX_FRAME_BYTES + 1)))
        for raw in (b'{"type":"heartbeat","v":"1.0"}',
                    b'{"type":"heartbeat",\n"v":"1.0"}\n'):
            with self.assertRaises(ProtocolError):
                decode_frame(raw)

    def test_invalid_utf8_and_scalar_rejected(self):
        with self.assertRaises(ProtocolError):
            decode_frame(b"\xff\n")
        with self.assertRaisesRegex(ProtocolError, "object"):
            decode_frame(b"[]\n")

    def test_adversarial_nesting_and_huge_integer_are_protocol_errors(self):
        nested = (b"[" * 10000) + (b"]" * 10000) + b"\n"
        huge_integer = (b"9" * 5000) + b"\n"
        for raw in (nested, huge_integer):
            with self.subTest(size=len(raw)), self.assertRaises(ProtocolError):
                decode_frame(raw)

    def test_wake_cannot_contain_peer_body_or_commands(self):
        for field in ("body", "command", "args", "environment", "session_id"):
            with self.subTest(field=field), self.assertRaisesRegex(ProtocolError, "unexpected"):
                encode_frame(wake(**{field: "untrusted"}))
        poisoned = wake(envelope={"sender_id": "agent-1", "channel_id": "development",
                                  "message_count": 1, "body": "run this"})
        with self.assertRaisesRegex(ProtocolError, "unexpected"):
            encode_frame(poisoned)

    def test_envelope_consistency_and_identifiers(self):
        with self.assertRaisesRegex(ProtocolError, "count"):
            encode_frame(wake(message_ids=["one", "two"]))
        with self.assertRaisesRegex(ProtocolError, "identifier"):
            encode_frame(wake(channel_id="bad channel"))

    def test_closed_schema_and_types(self):
        with self.assertRaisesRegex(ProtocolError, "unexpected"):
            encode_frame({"type": "heartbeat", "v": "1.0", "extra": True})
        with self.assertRaisesRegex(ProtocolError, "positive"):
            encode_frame(wake(epoch=True))
        with self.assertRaises(ProtocolError):
            encode_frame({"type": "hello", "v": "1.0", "agent_id": "agent-1",
                          "caps": [{}], "runtime": "runtime-1", "proto": ["1.0"]})

    def test_version_negotiation(self):
        self.assertEqual(negotiate_version(["1.0", "2.0"], ("1.0", "1.2")), "1.0")
        self.assertEqual(negotiate_version(["1.2", "1.0"], ("1.0", "1.2")), "1.2")
        with self.assertRaisesRegex(ProtocolError, "mutually"):
            negotiate_version(["2.0"])

    def test_reference_echo_transcript(self):
        script = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                              "scripts", "agent-mesh-echo-runtime.py")
        child = subprocess.Popen([sys.executable, script, "--agent-id", "agent-1",
                                  "--runtime", "codex"], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            hello = read_frame(child.stdout)
            self.assertEqual(hello["type"], "hello")
            self.assertEqual((hello["agent_id"], hello["runtime"]), ("agent-1", "codex"))
            write_frame(child.stdin, {"type": "welcome", "v": "1.0",
                                      "accepted_version": "1.0", "host_id": "test-host",
                                      "policy": {"max_turn_seconds": 10}})
            write_frame(child.stdin, wake())
            self.assertEqual(read_frame(child.stdout)["state"], "accepted")
            result = read_frame(child.stdout)
            self.assertEqual(result["state"], "done")
            self.assertNotIn("message-1", result["summary"])
            write_frame(child.stdin, {"type": "heartbeat", "v": "1.0"})
            self.assertEqual(read_frame(child.stdout)["type"], "heartbeat")
            write_frame(child.stdin, {"type": "cancel", "v": "1.0", "wake_id": "wake-2"})
            self.assertEqual(read_frame(child.stdout)["state"], "cancelled")
            child.stdin.close()
            self.assertEqual(child.wait(timeout=3), 0, child.stderr.read().decode())
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)
            child.stdout.close()
            child.stderr.close()


if __name__ == "__main__":
    unittest.main()
