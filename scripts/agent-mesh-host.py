#!/usr/bin/env python3
"""Run the opt-in provider-neutral Agent Mesh Runtime Host in foreground."""
import argparse
import json
from pathlib import Path
import signal
import sys
import threading
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "adapters"))
from native_bridge import NativeBridge
from coordination import origin_identity
from runtime_host import RuntimeHost, load_policy


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--once", action="store_true", help="poll and dispatch at most one wake")
    parser.add_argument("--baseline-current", action="store_true",
                        help="record all currently pending IDs without dispatch, then exit")
    args = parser.parse_args(argv)
    host = bridge = None
    stop_event = threading.Event()
    def stop(_sig, _frame):
        stop_event.set()
    previous = {}
    try:
        policy = load_policy(args.policy)
        host = RuntimeHost(policy)
        bridge = NativeBridge(policy["connector_config"], "runtime-host-" + uuid.uuid4().hex[:12], timeout=5)
        if (bridge.config["agent_id"] != policy["agent_id"]
                or bridge.config["project_id"] != policy["project_id"]
                or bridge.config["runtime"] != policy["runtime"]
                or origin_identity(bridge.config["url"]) != origin_identity(policy["server_origin"])):
            raise ValueError("host policy identity differs from connector identity")
        if args.baseline_current:
            for _page in range(1000):
                fetched = bridge.poll_inbox(limit=100)
                if not fetched["has_more"]:
                    break
            else:
                raise ValueError("inbox did not reach a bounded enrollment cutoff")
            identifiers = bridge.pending_message_ids(include_seen=True)
            added = host.baseline(identifiers)
            print(json.dumps({"success": True, "baseline_added": added,
                              "baseline_total": host.status()["baseline_messages"],
                              "messages_dispatched": 0}, sort_keys=True), flush=True)
            return 0
        previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
        while not stop_event.is_set():
            recoverable = host.recoverable()
            if recoverable:
                host.dispatch(recoverable[0], should_stop=stop_event.is_set)
                print(json.dumps(host.status(), sort_keys=True), flush=True)
                if args.once:
                    break
                continue
            bridge.poll_inbox(limit=100)
            offered = bridge.offer_inbox(context_budget=16000, minimum_interval=0, full_text=False)
            grouped = {}
            for message in offered["messages"]:
                key = (message.get("channel_id"), message.get("author_id"))
                grouped.setdefault(key, []).append(message["id"])
            dispatched = False
            for (channel, sender), ids in grouped.items():
                if channel is None or sender is None:
                    continue
                wake_id = host.enqueue(channel, ids, sender)
                if wake_id:
                    host.dispatch(wake_id, should_stop=stop_event.is_set)
                    dispatched = True
                    break
            print(json.dumps(host.status(), sort_keys=True), flush=True)
            if args.once:
                break
            stop_event.wait(policy["poll_seconds"])
        return 0
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({"success": False, "error_category": type(error).__name__}), file=sys.stderr)
        return 2
    finally:
        if bridge is not None:
            bridge.close()
        if host is not None:
            host.close()
        for sig, old in previous.items():
            signal.signal(sig, old)


if __name__ == "__main__":
    raise SystemExit(main())
