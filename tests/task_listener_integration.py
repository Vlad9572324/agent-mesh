#!/usr/bin/env python3
"""Real HTTP listener contract test with a deterministic injected file writer.

Invoked by TestTaskListenerRealHTTPDurableHandoff against its isolated database
schema. No provider/CLI execution, production Mesh or existing workspace.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys


BASELINE = b"def add(a, b):\n    return a - b\n"
FIXED = b"def add(a, b):\n    return a + b\n"
BASE_REVISION = "listener-contract-baseline-v1"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class LostEventAcknowledgements:
    """Commit real events, then lose one acknowledgement per lifecycle step."""

    def __init__(self, client):
        self.client = client
        self.receipts = {}
        self.payloads = {}
        self.attempts = {}

    def __getattr__(self, name):
        return getattr(self.client, name)

    def request(self, method, path, body=None):
        response = self.client.request(method, path, body)
        kind = body.get("type") if body else None
        if (method == "POST" and path.endswith("/events")
                and kind in ("run_started", "artifacts_ready", "review_requested")):
            self.attempts[kind] = self.attempts.get(kind, 0) + 1
            if kind not in self.receipts:
                self.receipts[kind] = response["event"]["id"]
                self.payloads[kind] = json.dumps(body, sort_keys=True)
                require(response["replayed"] is False, "first event must be newly committed")
                raise ConnectionError("intentional lost post-commit acknowledgement")
            require(response["replayed"] is True, "lost acknowledgement must replay the accepted event")
            require(response["event"]["id"] == self.receipts[kind], "retry changed immutable event identity")
            require(json.dumps(body, sort_keys=True) == self.payloads[kind], "retry changed durable event payload")
        return response


class LostArtifactAcknowledgement:
    """Lose one real upload ACK and check immutable-byte idempotency on retry."""

    def __init__(self, client):
        self.client = client
        self.receipts = {}
        self.attempts = {}

    def __getattr__(self, name):
        return getattr(self.client, name)

    def upload(self, *args, **kwargs):
        response = self.client.upload(*args, **kwargs)
        artifact = response["artifact"]
        role = artifact["role"]
        self.attempts[role] = self.attempts.get(role, 0) + 1
        if role == "implementation" and role not in self.receipts:
            self.receipts[role] = artifact
            raise ConnectionError("intentional lost artifact acknowledgement")
        if role in self.receipts:
            require(artifact == self.receipts[role], "artifact retry changed immutable upload")
        self.receipts[role] = artifact
        return response


class DeterministicWriter:
    def __init__(self, workspace):
        self.workspace = workspace
        self.calls = 0

    def __call__(self, runtime, cwd, prompt, evidence_dir, event_callback, **kwargs):
        self.calls += 1
        require(self.calls == 1, "writer was dispatched more than once")
        require(runtime == "codex" and Path(cwd) == self.workspace, "unexpected runtime workspace")
        require(kwargs.get("read_only") is False, "writer profile must allow its one local edit")
        require(0 < kwargs.get("timeout", 9999) <= 60, "runtime timeout exceeds fixture budget")
        require((self.workspace / "calc.py").read_bytes() == BASELINE, "writer baseline changed")
        (self.workspace / "calc.py").write_bytes(FIXED)
        return {"success": True, "session_id": "deterministic-listener-test",
                "exit_code": 0, "final_text": json.dumps({
                    "summary": "Changed the bounded fixture to return the sum.",
                    "findings": [], "verdict": None})}


def verify_handoff(client, artifact_client, task_id, losses, artifact_loss, writer):
    from artifact_client import validate_bundle

    detail = client.request("GET", "/v1/projects/pilot/tasks/" + task_id)
    task = detail["task"]
    require(task["state"] == "review_pending", "listener must leave the result for independent review")
    require(task["version"] == 4, "exactly three task transitions must be committed")
    require(writer.calls == 1, "exactly one injected writer must run")
    events = detail["events"]
    expected = ["run_started", "artifacts_ready", "review_requested"]
    require([event["type"] for event in events] == expected, "unexpected task lifecycle or duplicate event")
    require([event["version"] for event in events] == [2, 3, 4], "nonsequential task event versions")
    require(all(event["actor_id"] == "codex-pilot" for event in events), "listener changed event author")
    require(len(detail["runs"]) == 1, "repeated polling created another run")
    run = detail["runs"][0]
    require(run["review_request_id"] == events[-1]["id"], "review request must pin the actual event")
    require(run["verification_status"] is None, "fake writer must not claim verification")
    refs = run["artifacts"]
    require(len(refs) == 2 and {ref["role"] for ref in refs} == {"implementation", "evidence"},
            "handoff needs an implementation bundle and attributed evidence")
    require(events[1]["artifacts"] == refs == events[2]["artifacts"], "review must pin the full artifact set")
    ref = next(ref for ref in refs if ref["role"] == "implementation")
    data = artifact_client.download(ref["artifact_id"], ref["sha256"], BASE_REVISION, expected_project="pilot")
    require(hashlib.sha256(data).hexdigest() == ref["sha256"], "downloaded bundle digest differs")
    require(validate_bundle(data, BASE_REVISION) == [("calc.py", FIXED)], "bundle does not contain exact writer bytes")
    evidence_ref = next(ref for ref in refs if ref["role"] == "evidence")
    evidence = json.loads(artifact_client.download(evidence_ref["artifact_id"], evidence_ref["sha256"],
                                                 BASE_REVISION, expected_project="pilot"))
    require(evidence["provenance"] == "client_reported" and evidence["independent_verification"] == "not_performed",
            "writer evidence must identify its verification limits")
    require(set(losses.receipts) == set(expected), "not all task-event lost acknowledgements were exercised")
    require(all(losses.attempts[kind] == 2 for kind in expected), "event retry count differs from one exact replay")
    require(artifact_loss.attempts == {"implementation": 2, "evidence": 1},
            "implementation upload was not retried exactly once")
    return {"success": True, "runner_calls": writer.calls, "task_id": task_id,
            "state": task["state"], "lost_acknowledgements": 4,
            "artifact_sha256": ref["sha256"]}


def exercise(args):
    from adapter import Client, read_key
    from artifact_client import ArtifactClient
    from task_listener import TaskListener

    os.umask(0o077)
    directory = Path(args.directory).resolve()
    require(directory.is_dir(), "fixture needs an existing private directory")
    directory.chmod(0o700)
    workspace = directory / "workspace"
    workspace.mkdir(mode=0o700)
    (workspace / "calc.py").write_bytes(BASELINE)
    clients, artifacts = {}, {}
    for actor in ("codex-pilot", "claude-pilot"):
        key = read_key(args.credentials, actor)
        key_file = directory / (actor + ".key")
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(key)
        clients[actor] = Client(args.origin, key)
        artifacts[actor] = ArtifactClient(args.origin, key_file, allow_loopback_http=True)
    creator = clients["claude-pilot"]
    task_input = {"client_id": "listener-contract-task", "title": "Correct the local addition fixture",
                  "owner_id": "codex-pilot", "reviewer_id": "claude-pilot", "scope": ["calc.py"],
                  "acceptance": ["The add function returns a + b. Independent review remains required."]}
    task = creator.request("POST", "/v1/projects/pilot/tasks", task_input)["task"]
    require(task["state"] == "ready" and task["created_by"] == "claude-pilot", "sender must create a ready task")
    # A second otherwise eligible task from an unapproved creator must remain
    # untouched even after the accepted task has consumed its one writer call.
    excluded = clients["codex-pilot"].request("POST", "/v1/projects/pilot/tasks",
                                            {**task_input, "client_id": "unapproved-creator"})["task"]
    config = {"url": args.origin, "agent_id": "codex-pilot", "project_id": "pilot", "runtime": "codex",
              "workspace_root": str(workspace), "channel_ids": ["general"]}
    policy = {"version": 1, "connector_config": str(directory / "connector.json"), "channel_id": "general",
              "state_dir": str(directory / "listener-state"), "allowed_creators": ["claude-pilot"],
              "allowed_files": ["calc.py"], "workspace_pins": {"calc.py": hashlib.sha256(BASELINE).hexdigest()},
              "base_revision": BASE_REVISION, "prompt": "Apply the small authorized correction to calc.py.",
              "max_jobs": 2, "poll_seconds": 1, "max_run_seconds": 300, "timeout_seconds": 60,
              "publish_artifacts": True, "request_review": True}
    lost_events = LostEventAcknowledgements(clients["codex-pilot"])
    lost_artifact = LostArtifactAcknowledgement(artifacts["codex-pilot"])
    writer = DeterministicWriter(workspace)
    lost_count = 0
    # Reopen durable state after every iteration, including every lost ACK.
    # Successful replay must need neither a model call nor an in-memory result.
    for _attempt in range(10):
        listener = TaskListener(policy, config, lost_events, lost_artifact, writer)
        try:
            try:
                listener.step()
            except ConnectionError:
                lost_count += 1
            status = listener.status()
        finally:
            listener.close()
        if status["jobs"] and all(job["phase"] == "done" for job in status["jobs"]):
            break
    else:
        raise AssertionError("durable handoff did not finish within bounded recovery polls")
    require(lost_count == 4, "all four transport failures must be recovered after restart")
    listener = TaskListener(policy, config, lost_events, lost_artifact, writer)
    try:
        before = listener.status()
        for _repeat in range(2):
            listener.step()
        require(listener.status() == before, "repeated polling changed a completed local handoff")
    finally:
        listener.close()
    require(creator.request("GET", "/v1/projects/pilot/tasks/" + excluded["id"])["task"]["state"] == "ready",
            "an unapproved creator triggered execution")
    # Both the owner and the sender/reviewer must fetch and verify actual bytes.
    owner_result = verify_handoff(clients["codex-pilot"], artifacts["codex-pilot"], task["id"],
                                  lost_events, lost_artifact, writer)
    reviewer_result = verify_handoff(creator, artifacts["claude-pilot"], task["id"],
                                     lost_events, lost_artifact, writer)
    require(owner_result == reviewer_result, "owner and independent reviewer saw different handoff bytes")
    return reviewer_result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--credentials", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    sys.path[:0] = [str(args.repo / "adapters"), str(args.repo / "scripts")]
    return exercise(args)


if __name__ == "__main__":
    try:
        print(json.dumps(main(), sort_keys=True))
    except Exception as error:
        # Static assertions explain contract failures without echoing remote
        # bodies, credentials, prompts or raw provider output.
        result = {"success": False, "error_category": type(error).__name__}
        if isinstance(error, AssertionError):
            result["assertion"] = str(error)
        print(json.dumps(result, sort_keys=True))
        raise SystemExit(1)
