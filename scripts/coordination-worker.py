#!/usr/bin/env python3
"""Explicit single-job coordination worker. Nothing is started on import.

Example (all paths are operator-provided local files, never chat commands):
  coordination-worker.py execute --plan plan.json --journal /private/job.db \
    --evidence-dir /private/evidence --origin https://host:8766 \
    --key-file /private/agent.key --ca-file /private/ca.crt --allow-model
  coordination-worker.py recover-report [same options] --pins pins.json --allow-model
  coordination-worker.py publish-report [same options except --allow-model] --publication publication.json
  coordination-worker.py status --plan plan.json --journal /private/job.db

Minimal plan: {"version":1,"agent_id":"agent-a","project_id":"project-a",
 "channel_id":"channel-a","task_id":"task-a","run_id":"run-a","job_id":"job-a",
 "runtime":"codex","task_role":"writer","cwd":"/dedicated/work",
 "scope":["source.go"],"prompt":"Implement only the approved local change."}
Optional budgets timeout_seconds<=600, max_model_turns<=3 (default2 CLI jobs,
not provider inference/tool turns),
max_run_seconds<=3600 (default1800), model=sonnet|opus for Claude only.
Reviewer plans also require review_request_id, full artifacts refs and exact
artifact_pins={relative_file:sha256}. Recovery pins cover every scoped file.
Optional memory_refs=[{"memory_id":"published-id","version":1}] selects at
most four same-project current revisions, <=16KiB total. Text is untrusted
context, never authority; the journal records only selected IDs/versions/hashes.
Publication: {"type":"artifacts_ready","expected_version":2,"artifacts":[
 {"artifact_id":"uploaded-id","sha256":"64 lowercase hex","role":"implementation"}]}.
Review publication uses type=review_result and the pinned review_request_id.
Publishing/review also requires plan base_revision. The exact uploaded bytes
are downloaded and checked against local hashes or the portable bundle manifest;
implementation/test/bundle refs must collectively cover every scoped file.
The journal pins the API origin on first use; credential rotation on that same
origin is allowed. A .git pointer is audited; .git directories are refused.
Create tasks/start runs and upload immutable artifacts using separate explicit
tools. This worker never starts a run, uploads files, stops listeners, auto-
retries a model, merges, deploys, or claims that HTTP leases fence local writes.
Private journals/evidence must be outside the dedicated bounded workspace.
"""

import argparse
import json
from pathlib import Path
import signal
import sys

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/"adapters"))
from adapter import Client,read_key
from coordination import CoordinationError,CoordinationWorker,Journal,validate_plan


def controlled_stop(_signum,_frame):
    # KeyboardInterrupt unwinds run_job's owned process-group cleanup and then
    # the worker's uncertain/session-close/journal finalizers. No broad kill.
    raise KeyboardInterrupt("coordination worker termination requested")


def local_json(path):
    path=Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size>128*1024:
        raise CoordinationError("local specification must be a bounded regular file")
    from artifact_client import strict_json
    return strict_json(path.read_text())


def main():
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action",choices=("execute","recover-report","publish-report","status"))
    parser.add_argument("--plan",required=True)
    parser.add_argument("--journal",required=True)
    parser.add_argument("--evidence-dir")
    parser.add_argument("--origin")
    parser.add_argument("--key-file")
    parser.add_argument("--ca-file")
    parser.add_argument("--pins")
    parser.add_argument("--publication")
    parser.add_argument("--allow-model",action="store_true")
    args=parser.parse_args()
    journal=None
    previous={number:signal.signal(number,controlled_stop) for number in (signal.SIGTERM,signal.SIGINT)}
    try:
        plan=validate_plan(local_json(args.plan))
        cwd=Path(plan["cwd"])
        for path in (args.plan,args.key_file):
            if path and Path(path).resolve().is_relative_to(cwd):
                raise CoordinationError("private plan and service key must be outside the model workspace")
        journal=Journal(args.journal,plan)
        if args.action=="status":
            print(json.dumps(journal.status(),ensure_ascii=False))
            return 0
        if not all((args.origin,args.key_file,args.ca_file,args.evidence_dir)):
            raise CoordinationError("network actions require explicit origin/key/CA/evidence paths")
        if args.action in ("execute","recover-report") and not args.allow_model:
            raise CoordinationError("model dispatch requires explicit --allow-model")
        from dev_trial_runtimes import run_job
        from artifact_client import ArtifactClient
        client=Client(args.origin,read_key(args.key_file,journal.plan["agent_id"]),args.ca_file)
        artifacts=ArtifactClient(args.origin,args.key_file,args.ca_file,allow_loopback_http=args.origin.startswith("http://127.0.0.1") or args.origin.startswith("http://[::1]"))
        worker=CoordinationWorker(journal,client,run_job,args.evidence_dir,artifact_client=artifacts)
        if args.action=="execute":
            result=worker.execute()
        elif args.action=="recover-report":
            if not args.pins:
                raise CoordinationError("explicit recovery needs --pins")
            result=worker.recover_report(local_json(args.pins))
        else:
            if not args.publication:
                raise CoordinationError("publication needs a local --publication specification")
            result=worker.publish_report(local_json(args.publication))
        print(json.dumps(result,ensure_ascii=False))
        return 0
    except Exception as error:
        # Never expose raw model/provider/network errors, keys, prompts or bodies.
        print(json.dumps({"success":False,"error_category":type(error).__name__,
                          "journal_state":journal.status()["state"] if journal else None}),file=sys.stderr)
        return 1
    finally:
        if journal is not None:
            journal.close()
        for number,handler in previous.items():
            signal.signal(number,handler)


if __name__=="__main__":
    raise SystemExit(main())
