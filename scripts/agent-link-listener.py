#!/usr/bin/env python3
"""Explicit local listener for policy-authorized ready tasks; no server scheduler."""
import argparse
import json
from pathlib import Path
import signal
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "adapters"))
from artifact_client import ArtifactClient, read_regular
from dev_trial_runtimes import run_job
from native_bridge import NativeHTTP
from task_listener import TaskListener, load_policy, retryable, task_inventory


def stop(_signal, _frame):
    raise KeyboardInterrupt("listener termination requested")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "status", "run"))
    parser.add_argument("--policy", required=True, help="private explicit local JSON policy")
    parser.add_argument("--allow-model", action="store_true", help="authorize bounded CLI dispatch under the policy")
    parser.add_argument("--once", action="store_true", help="one polling/dispatch or durable retry pass")
    args = parser.parse_args(argv)
    listener = None
    previous = {}
    try:
        policy, config = load_policy(args.policy)
        if args.action == "run" and not args.allow_model:
            raise ValueError("run requires explicit --allow-model")
        key = read_regular(config["key_file"], 128, private=True).decode().strip()
        client = NativeHTTP(config, key, 8)
        artifacts = ArtifactClient(config["url"], config["key_file"], config["ca_file"],
                                   allow_loopback_http=config["url"].startswith("http:"))
        if args.action == "check":
            # Validation only: no journals, workspace markers, provider or writes.
            from coordination import snapshot
            task_inventory(client, config, policy["channel_id"])
            if snapshot(config["workspace_root"]) != policy["workspace_pins"]:
                raise ValueError("initial workspace pins differ")
            print(json.dumps({"valid": True, "initial_workspace_matches": True,
                              "model_started": False, "agent_id": config["agent_id"]}))
            return 0
        if args.action == "status":
            # Read existing state without taking its workspace lock or writing it.
            import sqlite3
            from urllib.parse import quote
            path = Path(policy["state_dir"]) / "listener.sqlite3"
            if not path.exists():
                print(json.dumps({"initialized": False, "agent_id": config["agent_id"], "jobs": []}))
                return 0
            read_regular(path, 32 * 1024 * 1024, private=True)
            connection = sqlite3.connect("file:" + quote(str(path)) + "?mode=ro", uri=True)
            try:
                rows = connection.execute("SELECT task_id,phase,data FROM jobs ORDER BY rowid").fetchall()
                print(json.dumps({"agent_id": config["agent_id"], "jobs": [
                    {"task_id": r[0], "phase": r[1], "run_id": json.loads(r[2])["run_id"],
                     "error_category": json.loads(r[2]).get("error_category")} for r in rows]}))
            finally:
                connection.close()
            return 0
        previous = {number: signal.signal(number, stop) for number in (signal.SIGINT, signal.SIGTERM)}

        def runner(*arguments, **options):
            return run_job(*arguments, **options, inherited_lock_fd=listener.workspace_fd)

        listener = TaskListener(policy, config, client, artifacts, runner)
        deadline = time.monotonic() + policy["max_run_seconds"]
        while time.monotonic() < deadline:
            try:
                status = listener.step()
                print(json.dumps(status), flush=True)
                if any(job["phase"] in ("uncertain", "blocked") for job in status["jobs"]):
                    return 2
                if len(status["jobs"]) >= policy["max_jobs"] and all(job["phase"] == "done" for job in status["jobs"]):
                    return 0
            except Exception as error:
                if not retryable(error):
                    raise
                print(json.dumps({"retry_pending": True, "error_category": type(error).__name__}), flush=True)
                if args.once:
                    return 2
            if args.once:
                break
            time.sleep(min(policy["poll_seconds"], max(0, deadline - time.monotonic())))
        return 0
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({"success": False, "error_category": type(error).__name__}), file=sys.stderr)
        return 2
    finally:
        if listener is not None:
            listener.close()
        for number, handler in previous.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    raise SystemExit(main())
