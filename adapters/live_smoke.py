#!/usr/bin/env python3
"""Explicit operator-seeded, two-turn real Claude/Codex pilot proof. Costs model usage."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import uuid

from adapter import Client, read_key


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--ca-file", required=True)
    parser.add_argument("--secrets-dir", required=True)
    parser.add_argument("--evidence-dir", required=True)
    args = parser.parse_args()
    output = Path(args.evidence_dir).absolute()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    secrets = Path(args.secrets_dir)
    clients = {name: Client(args.url, read_key(secrets / (name + "-pilot.key"), name + "-pilot"), args.ca_file)
               for name in ("claude", "codex")}
    processes, handles = {}, {}
    messages, evidence = {}, {"started_at": datetime.now(timezone.utc).isoformat(),
        "scope": "Two owned fresh CLI processes on one machine; not a different-VM proof",
        "stimulus": "Explicit operator-seeded top-level messages using agent service keys; replies are model-generated",
        "transport": "HTTPS ordered REST polling; not SSE runtime delivery", "turns": []}

    def logs(name):
        result = []
        for line in (output / (name + ".log")).read_text().splitlines():
            try:
                result.append(json.loads(line))
            except ValueError:
                pass
        return result

    def wait_for(check, description, timeout=140):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = check()
            if result:
                return result
            for name, process in processes.items():
                if process.poll() is not None:
                    raise RuntimeError(name + " adapter stopped; see private log")
            time.sleep(0.25)
        raise TimeoutError(description)

    def send(source, target, body):
        result = clients[source].request("POST", "/v1/channels/general/messages", {
            "client_id": "operator-smoke-" + str(uuid.uuid4()), "body": body,
            "recipient_ids": [target + "-pilot"],
        })["message"]
        messages[result["id"]] = result
        return result

    def reply_for(target, request):
        rows = clients[target].request("GET", "/v1/channels/general/messages?after_seq=" + str(request["seq"]) + "&limit=100")["messages"]
        return next((r for r in rows if r.get("reply_to") == request["id"] and r["author_id"] == target + "-pilot"), None)

    try:
        for name in clients:
            handles[name] = open(output / (name + ".log"), "x", encoding="utf-8")
            command = [sys.executable, str(Path(__file__).with_name("adapter.py")), "--url", args.url,
                "--ca-file", args.ca_file, "--key-file", str(secrets / (name + "-pilot.key")),
                "--agent-id", name + "-pilot", "--runtime", name, "--db", str(output / (name + ".sqlite3")),
                "--max-turns", "2", "--run-seconds", "240", "--runtime-timeout", "110", "--poll-interval", "0.5"]
            processes[name] = subprocess.Popen(command, stdout=handles[name], stderr=subprocess.STDOUT)
        ready = {name: wait_for(lambda n=name: next((x for x in logs(n) if x["event"] == "adapter_ready"), None), name + " ready", 40)
                 for name in clients}
        evidence["ready"] = ready
        print(json.dumps({"event": "both_owned_runtimes_ready", "sessions": {n: r["runtime_session"] for n, r in ready.items()}}), flush=True)
        markers = {name: "PILOT-" + name.upper() + "-" + uuid.uuid4().hex[:8] for name in clients}
        first_requests = {}
        for target in clients:
            peer = "codex" if target == "claude" else "claude"
            first_requests[target] = send(peer, target,
                "Operator communication test, turn 1. This message was explicitly sent by the operator through the API, "
                "not as an autonomous agent action. Remember this code within the conversation: " + markers[target] +
                ". Briefly greet the other agent, repeat the code and suggest one reliable-communication principle. No tools.")
        first_replies = {}
        for target in clients:
            request = first_requests[target]
            reply = wait_for(lambda t=target, q=request: reply_for(t, q), target + " first model reply")
            first_replies[target] = reply
            evidence["turns"].append({"runtime": target, "turn": 1, "request": request, "reply": reply})
            print(json.dumps({"event": "first_real_model_reply", "runtime": target, "reply_id": reply["id"], "body": reply["body"]}, ensure_ascii=False), flush=True)
        second_requests = {}
        for target in clients:
            peer = "codex" if target == "claude" else "claude"
            other = first_replies[peer]
            second_requests[target] = send(peer, target,
                "Operator communication test, turn 2 in the same conversation. Recall YOUR original code from the first request "
                "using conversation context (the code below belongs to the OTHER agent; do not confuse them). Then briefly respond to "
                "its communication principle. The following peer reply was explicitly forwarded by the operator, source " + other["id"] +
                ": " + json.dumps(other["body"], ensure_ascii=False) + ". No tools.")
        for target in clients:
            request = second_requests[target]
            reply = wait_for(lambda t=target, q=request: reply_for(t, q), target + " second model reply")
            if markers[target] not in reply["body"]:
                raise AssertionError(target + " did not recall its prior unique marker")
            if markers[target] in request["body"]:
                raise AssertionError("recall proof accidentally leaked the target marker into second input")
            evidence["turns"].append({"runtime": target, "turn": 2, "request": request, "reply": reply, "recall_pass": True})
            print(json.dumps({"event": "second_real_model_reply", "runtime": target, "reply_id": reply["id"], "body": reply["body"]}, ensure_ascii=False), flush=True)
        # Wait for directed model-generated replies to reach the other adapter's durable inbox.
        def inbox_check():
            snapshots = {}
            for name in clients:
                with sqlite3.connect(output / (name + ".sqlite3")) as db:
                    db.row_factory = sqlite3.Row
                    snapshots[name] = [dict(row) for row in db.execute("SELECT id,seq,state,accepted,runtime_session FROM inbox ORDER BY seq")]
                peer = "codex" if name == "claude" else "claude"
                required = {turn["reply"]["id"] for turn in evidence["turns"] if turn["runtime"] == peer}
                found = {row["id"] for row in snapshots[name] if row["state"] == "observed"}
                if not required <= found:
                    return None
            return snapshots
        evidence["inbox"] = wait_for(inbox_check, "both peer replies durable without auto-wake", 20)
        for name in clients:
            own = logs(name)
            completed = [event for event in own if event["event"] == "runtime_completed"]
            if len(completed) != 2 or {e["runtime_session"] for e in completed} != {ready[name]["runtime_session"]}:
                raise AssertionError(name + " did not complete exactly two turns in its same owned session")
            if any(e.get("capabilities", {}).get("observed_tool_items") != 0 for e in completed):
                raise AssertionError("unexpected observed tool invocation")
            evidence[name + "_lifecycle"] = own
        for turn in evidence["turns"]:
            target = turn["runtime"]
            turn["request_final"] = clients[target].request("GET", "/v1/messages/" + turn["request"]["id"])["message"]
            turn["reply_final"] = clients[target].request("GET", "/v1/messages/" + turn["reply"]["id"])["message"]
            receipt = next((r for r in turn["request_final"]["receipts"] if r["agent_id"] == target + "-pilot"), {})
            if not receipt.get("delivered_at") or not receipt.get("accepted_at") or receipt.get("uncertain_at"):
                raise AssertionError("request delivery/acceptance receipt incomplete")
        evidence["passed"] = True
        print(json.dumps({"event": "live_smoke_pass", "turns": 4, "same_session_recall": True,
                          "peer_replies_persisted_without_autowake": True, "evidence": str(output / "evidence.json")}), flush=True)
    except BaseException as exc:
        evidence["passed"] = False
        evidence["error"] = str(exc)
        print(json.dumps({"event": "live_smoke_failed", "reason": str(exc)}), flush=True)
        raise
    finally:
        for process in processes.values():
            if process.poll() is None:
                process.terminate()
        for process in processes.values():
            try:
                process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        for handle in handles.values():
            handle.close()
        evidence["finished_at"] = datetime.now(timezone.utc).isoformat()
        (output / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
