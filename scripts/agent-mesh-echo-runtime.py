#!/usr/bin/env python3
"""Reference AMRP/1 runtime: protocol exerciser only, never a model."""

import os
import argparse
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "adapters"))
from runtime_protocol import ProtocolError, negotiate_version, read_frame, write_frame  # noqa: E402


VERSION = "1.0"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-id", required=True)
    parser.add_argument("--runtime", required=True)
    args = parser.parse_args()
    output = sys.stdout.buffer
    input_stream = sys.stdin.buffer
    write_frame(output, {
        "type": "hello", "v": VERSION, "agent_id": args.agent_id,
        "caps": ["wake", "cancel", "result", "idempotent_wake"],
        "runtime": args.runtime, "proto": [VERSION],
    })
    welcome = read_frame(input_stream)
    if welcome is None or welcome["type"] != "welcome":
        raise ProtocolError("expected welcome")
    if negotiate_version([welcome["accepted_version"]]) != welcome["accepted_version"]:
        raise ProtocolError("unsupported welcome version")
    if welcome["v"] != welcome["accepted_version"]:
        raise ProtocolError("welcome version differs from accepted version")
    version = welcome["accepted_version"]
    while True:
        message = read_frame(input_stream)
        if message is None:
            return 0
        kind = message["type"]
        if message["v"] != version:
            raise ProtocolError("message version differs from accepted version")
        if kind == "wake":
            write_frame(output, {"type": "ack", "v": version,
                                 "wake_id": message["wake_id"], "state": "accepted"})
            write_frame(output, {"type": "result", "v": version,
                                 "wake_id": message["wake_id"], "state": "done",
                                 "summary": "reference echo completed without reading peer content"})
        elif kind == "cancel":
            write_frame(output, {"type": "result", "v": version,
                                 "wake_id": message["wake_id"], "state": "cancelled"})
        elif kind == "heartbeat":
            write_frame(output, {"type": "heartbeat", "v": version,
                                 "runtime": args.runtime})
        else:
            raise ProtocolError("unexpected host message")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ProtocolError, BrokenPipeError) as exc:
        print("AMRP protocol failure: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
