#!/usr/bin/env python3
"""Non-model recovery check, isolated E2E PostgreSQL + owned loopback HTTP child."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import uuid

from adapter import Adapter, APIError, Client, Store, read_key
from runtimes import EchoRuntime

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from operator_config import runtime_dir


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", type=Path)
    parser.add_argument("--binary", default=str(ROOT / "bin/agent-link"))
    args = parser.parse_args()
    settings = dict(os.environ)
    if args.runtime_dir is not None:
        settings["AGENT_LINK_RUNTIME_DIR"] = str(args.runtime_dir)
    runtime = runtime_dir(settings)
    run_id = uuid.uuid4().hex[:12]
    evidence_dir = runtime / "evidence" / ("adapter-recovery-" + run_id)
    evidence_dir.mkdir(mode=0o700)
    credentials = runtime / "secrets/e2e-credentials.json"
    clients = {name: Client("http://127.0.0.1:18767", read_key(credentials, name + "-pilot")) for name in ("claude", "codex")}
    report = {"scope": "Isolated agentlink_e2e database; no models, no LAN key changes", "passed": False}
    log_file = open(evidence_dir / "server.log", "x")
    server = subprocess.Popen([args.binary, "serve", "--database-url-file", str(runtime / "secrets/agentlink_e2e-dsn"),
                               "--listen", "127.0.0.1:18767", "--web-dir", str(ROOT / "web")], stdout=log_file, stderr=log_file)
    store = None
    try:
        deadline = time.monotonic() + 15
        while True:
            if server.poll() is not None:
                raise RuntimeError("owned test server exited")
            try:
                clients["codex"].request("GET", "/v1/me")
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.1)
        old_session = "recovery-old-" + run_id
        def heartbeat(session):
            return clients["codex"].request("POST", "/v1/heartbeat", {
                "session_id": session, "activity": "isolated recovery test; no model", "runtime": "echo"})
        deadline = time.monotonic() + 35
        while True:
            try:
                heartbeat(old_session)
                break
            except APIError as exc:
                if exc.code != 409 or time.monotonic() > deadline:
                    raise
                time.sleep(1)
        messages = [clients["claude"].request("POST", "/v1/channels/general/messages", {
            "client_id": "recovery-" + run_id + "-" + str(index),
            "body": "Isolated operator recovery fixture " + str(index) + "; not model-authored",
            "recipient_ids": ["codex-pilot"]})["message"] for index in (1, 2, 3)]
        path = evidence_dir / "queue.sqlite3"
        store = Store(path, "isolated-recovery")
        store.ingest(messages, "codex-pilot")
        store.flush(clients["codex"], old_session)
        first_before = clients["codex"].request("GET", "/v1/messages/" + messages[0]["id"])["message"]["receipts"][0]
        store.dispatch(messages[1]["id"])
        store.accept(messages[1]["id"], "synthetic-old-runtime")
        store.dispatch(messages[2]["id"])
        store.accept(messages[2]["id"], "synthetic-old-runtime")
        store.complete(messages[2], "Durable fixture reply; not model-generated", "codex-pilot")
        store.close()
        store = None
        print(json.dumps({"event": "recovery_waiting_for_old_lease_expiry", "seconds": 31}), flush=True)
        time.sleep(31)
        store = Store(path, "isolated-recovery")
        adapter = Adapter(clients["codex"], store, "codex-pilot", "general", "echo", max_turns=1)
        adapter.runtime = EchoRuntime()
        adapter.heartbeat()
        adapter.step()
        states = [dict(row) for row in store.db.execute("SELECT id,state,accepted,runtime_session FROM inbox WHERE id IN (?,?,?) ORDER BY seq", tuple(m["id"] for m in messages))]
        assert [s["state"] for s in states] == ["completed", "uncertain", "completed"], states
        assert adapter.turns == 1, "interrupted/completed input was incorrectly re-executed"
        final = [clients["codex"].request("GET", "/v1/messages/" + m["id"])["message"] for m in messages]
        receipts = [m["receipts"][0] for m in final]
        assert receipts[0]["delivered_at"] == first_before["delivered_at"]
        assert receipts[0]["accepted_at"] and receipts[0]["session_id"] == adapter.session_id
        assert receipts[1]["uncertain_at"] and not receipts[1]["accepted_at"]
        assert not receipts[2]["accepted_at"], "old runtime acceptance was fabricated under new lease"
        replies = clients["codex"].request("GET", "/v1/channels/general/messages?after_seq=" + str(messages[2]["seq"]) + "&limit=100")["messages"]
        assert {r.get("reply_to") for r in replies} >= {messages[0]["id"], messages[2]["id"]}
        assert not any(r.get("reply_to") == messages[1]["id"] for r in replies)
        assert store.db.execute("SELECT COUNT(*) FROM outbox WHERE sent=0").fetchone()[0] == 0
        report.update({"passed": True, "old_session": old_session, "new_session": adapter.session_id,
                       "states": states, "messages": final, "replies": replies, "runtime_calls": adapter.turns,
                       "superseded_old_acceptance_rows": store.db.execute("SELECT COUNT(*) FROM outbox WHERE sent=2").fetchone()[0]})
        print(json.dumps({"event": "recovery_smoke_pass", "evidence": str(evidence_dir / "evidence.json")}), flush=True)
    except BaseException as exc:
        report["error"] = str(exc)
        raise
    finally:
        if store:
            store.close()
        if server.poll() is None:
            server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
        log_file.close()
        (evidence_dir / "evidence.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
