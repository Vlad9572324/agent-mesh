"""Offline listener dispatch and recovery; no providers, network, or service keys."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from task_listener import ListenerError, TaskListener, WORKSPACE_MARKER, load_policy
from artifact_client import digest, validate_bundle
from coordination import snapshot
from native_bridge import NativeHTTPError


class Service:
    def __init__(self):
        self.url = self.origin = "https://offline.example:8766"
        self.key = "f" * 64
        self.agent = "writer"
        self.tasks, self.events, self.objects, self.uploads, self.sessions = {}, {}, {}, {}, {}
        self.fail = None
        self.revoked = False
        self.posts = []

    def add(self, name="task-a", **changes):
        task = {"id": name, "project_id": "project", "created_by": "peer", "owner_id": "writer",
                "reviewer_id": "peer", "title": "Update source", "acceptance": ["Keep edits in scope"],
                "scope": ["source.txt"], "version": 1, "state": "ready", "current_run_id": None}
        task.update(changes)
        self.tasks[name] = task
        return task

    def request(self, method, path=None, body=None):
        if path is None:  # ArtifactClient metadata boundary.
            path, method = method, "GET"
        if self.revoked:
            raise NativeHTTPError(401)
        if path == "/v1/me":
            return {"agent": {"id": self.agent, "kind": "agent"}}
        if path == "/v1/projects/project/channels":
            return {"channels": [{"id": "channel", "can_write": True}]}
        if path == "/v1/projects/project/tasks":
            return {"tasks": copy.deepcopy(list(self.tasks.values())[::-1]), "can_write": True, "truncated": False}
        if path.startswith("/v1/artifacts/"):
            return {"artifact": copy.deepcopy(self.objects[path.rsplit("/", 1)[1]][0])}
        if "/sessions" in path:
            if path.endswith("/sessions"):
                self.sessions[body["session_id"]] = {**body, "agent_id": self.agent, "freshness": "fresh"}
                return {"session": self.sessions[body["session_id"]].copy()}
            identity, action = path.rsplit("/", 2)[1:]
            self.sessions[identity]["freshness"] = "closed" if action == "close" else "fresh"
            return {"session": self.sessions[identity].copy()}
        task_id = path.split("/tasks/")[1].split("/")[0]
        task = self.tasks[task_id]
        if method == "GET":
            return {"task": copy.deepcopy(task), "can_write": True, "runs": []}
        self.posts.append(copy.deepcopy(body))
        identity = body["client_id"]
        if identity in self.events:
            old, result = self.events[identity]
            if old != body:
                raise NativeHTTPError(409)
            return {**copy.deepcopy(result), "task": copy.deepcopy(task), "replayed": True}
        if task["version"] != body["expected_version"]:
            raise NativeHTTPError(409)
        kind = body["type"]
        if kind == "run_started":
            if task["state"] != "ready":
                raise NativeHTTPError(409)
            task["current_run_id"] = body["run_id"]
        elif task["current_run_id"] != body["run_id"]:
            raise NativeHTTPError(409)
        task["state"] = {"run_started": "running", "artifacts_ready": "artifacts_ready",
                         "review_requested": "review_pending", "uncertain": "uncertain"}[kind]
        task["version"] += 1
        event = {**copy.deepcopy(body), "id": "event-" + str(len(self.events)), "version": task["version"],
                 "task_id": task_id, "actor_id": self.agent}
        result = {"task": copy.deepcopy(task), "event": event, "replayed": False}
        self.events[identity] = (copy.deepcopy(body), copy.deepcopy(result))
        if self.fail == kind:
            self.fail = None
            raise OSError("lost acknowledgement after commit")
        return result

    def upload(self, project, client_id, role, base, content):
        if self.revoked:
            raise NativeHTTPError(401)
        identity = self.uploads.get(client_id)
        if identity:
            meta, old = self.objects[identity]
            if old != content:
                raise NativeHTTPError(409)
        else:
            identity = "artifact-" + str(len(self.objects))
            meta = {"id": identity, "project_id": project, "author_id": self.agent,
                    "role": role, "base_revision": base, "sha256": digest(content), "size_bytes": len(content)}
            self.objects[identity] = (meta, content)
            self.uploads[client_id] = identity
        if self.fail == "upload":
            self.fail = None
            raise OSError("lost upload acknowledgement")
        return {"artifact": meta.copy()}

    def download(self, artifact, sha, base, *, expected_project):
        meta, content = self.objects[artifact]
        assert meta["sha256"] == sha and meta["base_revision"] == base and meta["project_id"] == expected_project
        return content


class TaskListenerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="listener-offline-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cwd = self.root / "work"
        self.cwd.mkdir()
        (self.cwd / "source.txt").write_text("baseline\n")
        (self.cwd / "protected.txt").write_text("keep\n")
        self.private = self.root / "private"
        self.private.mkdir(mode=0o700)
        self.config = {"version": 1, "url": "https://offline.example:8766", "agent_id": "writer",
                       "project_id": "project", "runtime": "codex", "workspace_root": str(self.cwd),
                       "channel_ids": ["channel"], "state_dir": str(self.private / "native"),
                       "key_file": str(self.private / "agent.key"), "ca_file": None}
        self.policy = {"version": 1, "connector_config": str(self.private / "connector.json"),
                       "channel_id": "channel", "state_dir": str(self.private / "listener"),
                       "allowed_creators": ["peer"], "allowed_files": ["source.txt"],
                       "workspace_pins": snapshot(self.cwd), "base_revision": "base-1", "prompt": "Update authorized source",
                       "max_jobs": 2, "poll_seconds": 1, "max_run_seconds": 60, "timeout_seconds": 30,
                       "publish_artifacts": True, "request_review": True}
        self.service = Service()
        self.calls = 0
        self.listeners = []
        self.addCleanup(self.cleanup_listeners)

    def cleanup_listeners(self):
        for listener in self.listeners:
            listener.close()

    def runner(self, *args, **kwargs):
        self.calls += 1
        (self.cwd / "source.txt").write_text("change " + str(self.calls) + "\n")
        return {"success": True, "session_id": "test-model", "final_text": json.dumps({
            "summary": "Source updated; independent verification pending", "findings": [], "verdict": None})}

    def listener(self, runner=None, policy=None):
        listener = TaskListener(policy or self.policy, self.config, self.service, self.service, runner or self.runner)
        self.listeners.append(listener)
        return listener

    def reopen(self, listener):
        listener.close()
        return self.listener()

    def test_peer_task_handoff_preserves_independent_review(self):
        self.service.add()
        listener = self.listener()
        self.assertEqual(listener.step()["jobs"][0]["phase"], "done")
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.service.tasks["task-a"]["state"], "review_pending")
        publications = [p[0] for p in self.service.events.values()]
        self.assertEqual([p["type"] for p in publications], ["run_started", "artifacts_ready", "review_requested"])
        self.assertEqual(publications[1]["artifacts"], publications[2]["artifacts"])
        bundle = next(content for metadata, content in self.service.objects.values() if metadata["role"] == "implementation")
        self.assertEqual(validate_bundle(bundle, "base-1"), [("source.txt", b"change 1\n")])
        self.assertEqual((self.cwd / "protected.txt").read_text(), "keep\n")
        listener.step()
        self.assertEqual(self.calls, 1)

    def test_lost_ack_at_every_publication_restarts_without_writer_replay(self):
        for failure in ("run_started", "upload", "artifacts_ready", "review_requested"):
            with self.subTest(failure=failure):
                self.setUp()
                self.service.add()
                self.service.fail = failure
                listener = self.listener()
                with self.assertRaises(OSError):
                    listener.step()
                listener = self.reopen(listener)
                listener.step()
                self.assertEqual(self.calls, 1)
                self.assertEqual(listener.status()["jobs"][0]["phase"], "done")
                self.assertEqual(len(self.service.events), 3)
                self.assertEqual(len(self.service.objects), 2)
                listener.close()

    def test_next_distinct_task_uses_last_successful_workspace_pins(self):
        self.service.add()
        listener = self.listener()
        listener.step()
        first_pins = snapshot(self.cwd)
        self.service.add("task-b")
        listener = self.reopen(listener)
        listener.step()
        self.assertEqual(self.calls, 2)
        self.assertTrue(all(job["phase"] == "done" for job in listener.status()["jobs"]))
        evidence = [json.loads(content) for meta, content in self.service.objects.values() if meta["role"] == "evidence"][-1]
        from coordination import canonical
        self.assertEqual(evidence["baseline_workspace_sha256"], digest(canonical(first_pins).encode()))
        self.assertEqual(evidence["prior_handoffs"][0]["task_id"], "task-a")

    def test_authorized_new_file_is_created_and_handed_off(self):
        self.policy["allowed_files"] = ["new-test.txt"]
        self.service.add(scope=["new-test.txt"])
        def create(*args, **kwargs):
            self.calls += 1
            (self.cwd / "new-test.txt").write_text("new\n")
            return {"success": True, "session_id": "model", "final_text": json.dumps({
                "summary": "New test file created", "findings": [], "verdict": None})}
        listener = self.listener(create)
        self.assertEqual(listener.step()["jobs"][0]["phase"], "done")
        self.assertEqual(self.calls, 1)

    def test_oversized_task_context_stays_ready_and_does_not_block_next_task(self):
        self.service.add("too-long", acceptance=["x" * 1200] * 32)
        self.service.add("valid")
        listener = self.listener()
        status = listener.step()
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.service.tasks["too-long"]["state"], "ready")
        self.assertEqual(self.service.tasks["valid"]["state"], "review_pending")
        self.assertEqual(status["rejected_tasks"][0]["task_id"], "too-long")

    def test_runtime_timeout_clamped_to_invocation_budget(self):
        self.service.add()
        observed = []
        def capture(*args, **kwargs):
            observed.append(kwargs["timeout"])
            return self.runner(*args, **kwargs)
        listener = self.listener(capture)
        listener.started -= 57
        listener.step()
        self.assertEqual(self.calls, 1)
        self.assertLessEqual(observed[0], 3)

    def test_expired_claimed_job_waits_without_dispatch(self):
        self.service.add()
        listener = self.listener()
        data = {"task": copy.deepcopy(self.service.tasks["task-a"]), "run_id": "listen-expired"}
        listener._event(data, "run_started", 1, "Accepted by local policy")
        listener._save("task-a", "claimed", data)
        listener.started -= 61
        self.assertEqual(listener.step()["jobs"][0]["phase"], "claimed")
        self.assertEqual(self.calls, 0)

    def test_untrusted_creator_directory_scope_and_other_owner_never_dispatch(self):
        self.service.add("evil", created_by="stranger")
        self.service.add("directory", scope=["source"])
        self.service.add("other", owner_id="peer")
        listener = self.listener()
        listener.step()
        self.assertEqual(self.calls, 0)
        self.assertEqual(self.service.events, {})

    def test_uncertain_dispatch_blocks_other_tasks_and_restart(self):
        self.service.add()
        def interrupted(*args, **kwargs):
            self.calls += 1
            (self.cwd / "source.txt").write_text("partial\n")
            raise KeyboardInterrupt()
        listener = self.listener(interrupted)
        with self.assertRaises(KeyboardInterrupt):
            listener.step()
        self.service.add("task-b")
        listener = self.reopen(listener)
        listener.step()
        listener.step()
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.service.tasks["task-a"]["state"], "uncertain")
        self.assertEqual(self.service.tasks["task-b"]["state"], "ready")

    def test_cancel_after_lost_start_ack_blocks_without_model(self):
        task = self.service.add()
        self.service.fail = "run_started"
        listener = self.listener()
        with self.assertRaises(OSError):
            listener.step()
        task["state"] = "cancelled"
        task["version"] += 1
        listener = self.reopen(listener)
        with self.assertRaises(Exception):
            listener.step()
        self.assertEqual(self.calls, 0)
        self.assertEqual(listener.status()["jobs"][0]["phase"], "blocked")

    def test_revocation_before_poll_cannot_dispatch(self):
        self.service.add()
        listener = self.listener()
        self.service.revoked = True
        with self.assertRaises(NativeHTTPError):
            listener.step()
        self.assertEqual(self.calls, 0)

    def test_cancellation_during_job_never_reports_artifacts(self):
        task = self.service.add()
        def cancel(*args, **kwargs):
            result = self.runner(*args, **kwargs)
            task["state"] = "cancelled"
            task["version"] += 1
            return result
        listener = self.listener(cancel)
        self.assertEqual(listener.step()["jobs"][0]["phase"], "uncertain")
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.service.objects, {})
        self.assertEqual(task["state"], "cancelled")

    def test_two_listeners_and_alternate_state_binding_are_refused(self):
        listener = self.listener()
        with self.assertRaises(BlockingIOError):
            self.listener()
        different = {**self.policy, "state_dir": str(self.private / "alternate")}
        with self.assertRaises(BlockingIOError):
            self.listener(policy=different)
        listener.close()
        with self.assertRaisesRegex(ListenerError, "bound to another"):
            self.listener(policy=different)

    def test_out_of_scope_write_is_uncertain_and_blocks_queue(self):
        self.service.add()
        def bad(*args, **kwargs):
            result = self.runner(*args, **kwargs)
            (self.cwd / "protected.txt").write_text("unauthorized\n")
            return result
        listener = self.listener(bad)
        self.assertEqual(listener.step()["jobs"][0]["phase"], "uncertain")
        self.assertEqual(self.service.objects, {})

    def test_uncertain_report_lost_ack_replays_exact_event(self):
        self.service.add()
        self.service.fail = "uncertain"
        def failure(*args, **kwargs):
            self.calls += 1
            raise ValueError("synthetic runtime failure")
        listener = self.listener(failure)
        with self.assertRaises(OSError):
            listener.step()
        listener = self.reopen(listener)
        status = listener.step()
        self.assertEqual(status["jobs"][0]["phase"], "uncertain")
        self.assertEqual(status["pending_events"], 0)
        self.assertEqual(self.calls, 1)

    def test_stale_initial_snapshot_refused(self):
        (self.cwd / "protected.txt").write_text("changed externally\n")
        with self.assertRaisesRegex(ListenerError, "initial full"):
            self.listener()

    def test_load_private_policy_rejects_broad_scope_and_unknown_fields(self):
        self.config["url"] = "http://127.0.0.1:8766"
        for path, value in ((Path(self.config["key_file"]), "f" * 64),
                            (Path(self.policy["connector_config"]), json.dumps(self.config))):
            path.write_text(value)
            path.chmod(0o600)
        path = self.private / "policy.json"
        path.write_text(json.dumps(self.policy))
        path.chmod(0o600)
        self.assertEqual(load_policy(path)[0], self.policy)
        (self.cwd / ".git").write_text("gitdir: /synthetic/worktree\n")
        self.policy["workspace_pins"] = snapshot(self.cwd)
        self.policy["allowed_files"].append("future.txt")
        path.write_text(json.dumps(self.policy))
        self.assertIn(".git", load_policy(path)[0]["workspace_pins"])
        invalid = {**self.policy, "allowed_files": ["../escape"]}
        path.write_text(json.dumps(invalid))
        with self.assertRaises(ListenerError):
            load_policy(path)
        path.write_text(json.dumps({**self.policy, "remote_prompt_authority": True}))
        with self.assertRaises(ListenerError):
            load_policy(path)


if __name__ == "__main__":
    unittest.main()
