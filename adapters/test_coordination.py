"""Isolated durable coordination tests; no real models, network, keys or git."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock,patch

from coordination import (CoordinationError,CoordinationWorker,Journal,RESULT_SCHEMA,
                          artifact_refs,snapshot,validate_plan)


class FakeClient:
    def __init__(self,plan):
        self.plan=plan
        self.url="https://offline.example:8766"
        self.calls=[]
        self.sessions={}
        self.publications={}
        self.fail_publication_once=False
        self.memory={}
        self.task={"id":plan["task_id"],"project_id":plan["project_id"],"current_run_id":plan["run_id"],
                   "owner_id":plan["agent_id"] if plan["task_role"]!="reviewer" else "other-owner",
                   "reviewer_id":plan["agent_id"] if plan["task_role"]=="reviewer" else "other-reviewer",
                   "state":"review_pending" if plan["task_role"]=="reviewer" else "running",
                   "scope":plan["scope"],"acceptance":["Only change the assigned file"],"version":2}

    def request(self,method,path,body=None):
        self.calls.append((method,path,copy.deepcopy(body)))
        prefix="/v1/projects/"+self.plan["project_id"]
        if method=="GET" and path=="/v1/me":
            return {"agent":{"id":self.plan["agent_id"],"kind":"agent"}}
        if method=="GET" and path==prefix+"/tasks/"+self.plan["task_id"]:
            return {"task":copy.deepcopy(self.task),"runs":[{"id":self.plan["run_id"],
                    "review_request_id":self.plan.get("review_request_id"),"artifacts":self.plan.get("artifacts",[])}]}
        if method=="GET" and path.startswith(prefix+"/memory/"):
            return {"memory":copy.deepcopy(self.memory[path.rsplit("/",1)[1]])}
        if method=="POST" and path==prefix+"/sessions":
            session={**body,"agent_id":self.plan["agent_id"],"project_id":self.plan["project_id"],"freshness":"fresh"}
            self.sessions[body["session_id"]]=session
            return {"session":copy.deepcopy(session),"replayed":False}
        if method=="POST" and path.startswith(prefix+"/sessions/"):
            identifier,action=path.rsplit("/",2)[1:]
            session=self.sessions[identifier]
            if action=="close":
                session["freshness"]="closed"
            elif action!="renew":
                raise AssertionError("unknown session operation")
            return {"session":copy.deepcopy(session)}
        if method=="POST" and path==prefix+"/tasks/"+self.plan["task_id"]+"/events":
            key=body["client_id"]
            if key in self.publications:
                old,reply=self.publications[key]
                if old!=body:
                    raise AssertionError("idempotency payload changed")
                return {**copy.deepcopy(reply),"replayed":True}
            event={**copy.deepcopy(body),"id":"event-1","task_id":self.plan["task_id"],"actor_id":self.plan["agent_id"],"version":body["expected_version"]+1}
            reply={"event":event,"task":copy.deepcopy(self.task),"replayed":False,"server_verified":False}
            self.publications[key]=(copy.deepcopy(body),copy.deepcopy(reply))
            if self.fail_publication_once:
                self.fail_publication_once=False
                raise OSError("simulated lost reply after server commit")
            return reply
        raise AssertionError("undeclared offline request: "+method+" "+path)


class FakeArtifactClient:
    def __init__(self,plan):
        self.origin="https://offline.example:8766"
        self.plan=plan
        self.calls=[]
        self.data={}
        self.metadata={}
        contents={hashlib.sha256((Path(plan["cwd"])/name).read_bytes()).hexdigest():(Path(plan["cwd"])/name).read_bytes() for name in plan["scope"]}
        refs=plan.get("artifacts") or [{"artifact_id":"artifact-1","role":"implementation","sha256":next(iter(contents))}]
        for ref in refs:
            self.data[ref["artifact_id"]]=contents.get(ref["sha256"],b"unrelated artifact")
            self.metadata[ref["artifact_id"]]={"id":ref["artifact_id"],"role":ref["role"],"sha256":ref["sha256"],
                "project_id":plan["project_id"],"base_revision":plan["base_revision"]}

    def request(self,path):
        self.calls.append(path)
        return {"artifact":copy.deepcopy(self.metadata[path.rsplit("/",1)[1]])}

    def download(self,artifact,expected_sha256,expected_base,*,expected_project):
        self.calls.append("download:"+artifact)
        meta=self.metadata[artifact]
        if meta["project_id"]!=expected_project or meta["sha256"]!=expected_sha256 or meta["base_revision"]!=expected_base:
            raise CoordinationError("download metadata mismatch")
        return self.data[artifact]


class CoordinationTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix="coordination-offline-")
        self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name)
        self.cwd=self.root/"work"
        self.cwd.mkdir()
        (self.cwd/"source.txt").write_text("baseline\n")
        (self.cwd/"protected.txt").write_text("do not change\n")
        self.private=self.root/"private"
        self.private.mkdir(mode=0o700)
        self.plan={"version":1,"agent_id":"writer-a","project_id":"project-a","channel_id":"channel-a",
                   "task_id":"task-a","run_id":"run-a","job_id":"job-a","runtime":"codex","task_role":"writer",
                   "cwd":str(self.cwd),"scope":["source.txt"],"prompt":"Modify only source.txt; no network.","base_revision":"base-1"}
        self.journals=[]
        self.addCleanup(self.close_journals)

    def close_journals(self):
        while self.journals:
            self.journals.pop().close()

    def journal(self,plan=None):
        value=Journal(self.private/"job.sqlite3",plan or self.plan)
        self.journals.append(value)
        return value

    def reopen(self,journal):
        journal.close()
        self.journals.remove(journal)
        return self.journal()

    def runtime_result(self,summary="Observed local change",verdict=None):
        return {"success":True,"session_id":"model-session","final_text":json.dumps({
            "summary":summary,"findings":[],"verdict":verdict})}

    def worker(self,journal=None,client=None,runner=None):
        journal=journal or self.journal()
        client=client or FakeClient(journal.plan)
        runner=runner or Mock(return_value=self.runtime_result())
        return CoordinationWorker(journal,client,runner,self.private/"evidence",artifact_client=FakeArtifactClient(journal.plan))

    def publication(self):
        return {"type":"artifacts_ready","expected_version":2,"artifacts":[{
            "artifact_id":"artifact-1","sha256":snapshot(self.cwd)["source.txt"],"role":"implementation"}]}

    def test_writer_dispatch_once_with_independent_session_and_native_profile(self):
        worker=self.worker()
        self.assertEqual(worker.execute()["state"],"completed")
        worker.runner.assert_called_once()
        self.assertFalse(worker.runner.call_args.kwargs["read_only"])
        self.assertIsNone(worker.runner.call_args.kwargs["model"])
        self.assertIsNone(worker.runner.call_args.kwargs["json_schema"])
        self.assertEqual([item["state"] for item in worker.journal.status()["sessions"]],["created","closed"])
        self.assertTrue(all(item["freshness"]=="closed" for item in worker.client.sessions.values()))
        self.assertFalse(any(path=="/v1/heartbeat" for _,path,_ in worker.client.calls))
        with self.assertRaisesRegex(CoordinationError,"again"):
            worker.execute()
        worker.runner.assert_called_once()

    def test_startup_interrupted_dispatch_is_uncertain_never_repeated(self):
        journal=self.journal()
        journal.begin(snapshot(self.cwd),False)
        journal=self.reopen(journal)
        self.assertEqual(journal.status()["state"],"uncertain")
        self.assertEqual(journal.status()["error_category"],"InterruptedDispatch")
        worker=self.worker(journal)
        with self.assertRaises(CoordinationError):
            worker.execute()
        worker.runner.assert_not_called()
        self.assertEqual(worker.client.calls,[])

    def test_parse_failure_preserves_artifacts_and_recovery_is_read_only_and_pinned(self):
        worker=self.worker()
        def wrote_but_bad_format(*_args,**_kwargs):
            (self.cwd/"source.txt").write_text("writer side effect\n")
            return {"success":True,"session_id":"writer-session","final_text":"Apology ```json {} ```"}
        worker.runner.side_effect=wrote_but_bad_format
        with self.assertRaises(CoordinationError):
            worker.execute()
        self.assertEqual(worker.journal.status()["state"],"uncertain")
        self.assertEqual((self.cwd/"source.txt").read_text(),"writer side effect\n")
        pins={"source.txt":snapshot(self.cwd)["source.txt"]}
        worker.runner.side_effect=None
        worker.runner.return_value=self.runtime_result("Readonly observed the existing file")
        self.assertEqual(worker.recover_report(pins)["state"],"completed")
        self.assertTrue(worker.runner.call_args.kwargs["read_only"])
        self.assertIn("READ ONLY report recovery",worker.runner.call_args.args[2])
        self.assertEqual(worker.runner.call_count,2)
        self.assertEqual(worker.journal.status()["model_turns"],2)
        with self.assertRaises(CoordinationError):
            worker.execute()

    def test_recovery_rejects_changed_hash_and_protected_side_effect(self):
        journal=self.journal()
        journal.begin(snapshot(self.cwd),False)
        journal.uncertain("AmbiguousFailure")
        worker=self.worker(journal)
        with self.assertRaises(CoordinationError):
            worker.recover_report({"source.txt":"0"*64})
        (self.cwd/"protected.txt").write_text("unauthorized side effect")
        pins={"source.txt":snapshot(self.cwd)["source.txt"]}
        with self.assertRaisesRegex(CoordinationError,"outside"):
            worker.recover_report(pins)
        worker.runner.assert_not_called()

    def test_runtime_and_post_runtime_failures_mark_uncertain_and_close_session(self):
        worker=self.worker()
        worker.runner.side_effect=RuntimeError("PRIVATE provider error")
        with self.assertRaises(RuntimeError):
            worker.execute()
        status=worker.journal.status()
        self.assertEqual(status["state"],"uncertain")
        self.assertNotIn("PRIVATE",json.dumps(status))
        self.assertEqual(status["sessions"][-1]["state"],"closed")
        self.assertTrue(all(value["freshness"]=="closed" for value in worker.client.sessions.values()))

    def test_scope_escape_after_writer_is_not_reportable(self):
        worker=self.worker()
        def escaped(*_args,**_kwargs):
            (self.cwd/"other.txt").write_text("outside scope")
            return self.runtime_result()
        worker.runner.side_effect=escaped
        with self.assertRaisesRegex(CoordinationError,"outside"):
            worker.execute()
        self.assertEqual(worker.journal.status()["state"],"uncertain")
        with self.assertRaises(CoordinationError):
            worker.publish_report(self.publication())
        self.assertEqual(worker.client.publications,{})

    def test_lost_publication_response_retries_only_same_durable_payload(self):
        worker=self.worker()
        worker.execute()
        worker.client.fail_publication_once=True
        with self.assertRaises(OSError):
            worker.publish_report(self.publication())
        self.assertEqual(worker.journal.status()["state"],"report_pending")
        self.assertEqual(len(worker.client.publications),1)
        journal=self.reopen(worker.journal)
        resumed=self.worker(journal,worker.client,worker.runner)
        self.assertEqual(resumed.publish_report(self.publication())["state"],"reported")
        self.assertEqual(len(worker.client.publications),1)
        self.assertEqual(resumed.publish_report(self.publication())["state"],"reported")
        worker.runner.assert_called_once()
        posts=[call for call in worker.client.calls if call[0]=="POST" and call[1].endswith("/events")]
        self.assertEqual(len(posts),2)
        self.assertEqual(posts[0][2],posts[1][2])

    def test_publication_cannot_change_pins_or_report_identity(self):
        worker=self.worker()
        worker.execute()
        worker.publish_report(self.publication())
        altered=self.publication()
        altered["expected_version"]=3
        with self.assertRaisesRegex(CoordinationError,"publication version"):
            worker.publish_report(altered)
        (self.cwd/"source.txt").write_text("changed after completion")
        with self.assertRaisesRegex(CoordinationError,"hash mismatch"):
            worker.publish_report(self.publication())
        self.assertEqual(len(worker.client.publications),1)

    def test_model_and_wall_clock_budgets_are_durable(self):
        self.plan["max_model_turns"]=1
        journal=self.journal()
        journal.begin(snapshot(self.cwd),False)
        journal.uncertain("Interrupted")
        worker=self.worker(journal)
        pins={"source.txt":snapshot(self.cwd)["source.txt"]}
        with self.assertRaisesRegex(CoordinationError,"budget"):
            worker.recover_report(pins)
        worker.runner.assert_not_called()
        with journal.db:
            journal.db.execute("UPDATE job SET created=created-4000")
        with self.assertRaisesRegex(CoordinationError,"budget"):
            worker.recover_report(pins)

    def test_reviewer_pins_full_set_request_and_readonly_profile(self):
        (self.cwd/"test.txt").write_text("independent tests\n")
        current=snapshot(self.cwd)
        self.plan.update(task_role="reviewer",runtime="claude",model="opus",review_request_id="request-1",
                         scope=["source.txt","test.txt"],
                         artifacts=[{"artifact_id":"artifact-1","sha256":current["source.txt"],"role":"implementation"},
                                    {"artifact_id":"artifact-2","sha256":current["test.txt"],"role":"test"}],
                         artifact_pins={name:current[name] for name in ("source.txt","test.txt")})
        worker=self.worker(runner=Mock(return_value=self.runtime_result(verdict="approved")))
        worker.client.task["version"]=4
        worker.execute()
        self.assertTrue(worker.runner.call_args.kwargs["read_only"])
        self.assertEqual(worker.runner.call_args.kwargs["model"],"opus")
        self.assertEqual(worker.runner.call_args.kwargs["json_schema"],RESULT_SCHEMA)
        publication={"type":"review_result","expected_version":4,"artifacts":self.plan["artifacts"],"review_request_id":"request-1"}
        incomplete={**publication,"artifacts":self.plan["artifacts"][:1]}
        with self.assertRaises(CoordinationError):
            worker.publish_report(incomplete)
        self.assertEqual(worker.publish_report(publication)["state"],"reported")
        payload=next(iter(worker.client.publications.values()))[0]
        self.assertEqual(payload["run_id"],self.plan["run_id"])
        self.assertEqual(payload["review_request_id"],"request-1")
        self.assertEqual(payload["verdict"],"approved")
        self.assertEqual(payload["artifacts"],artifact_refs(self.plan["artifacts"]))

    def test_wrong_task_run_or_role_prevents_any_model_or_session(self):
        worker=self.worker()
        worker.client.task["current_run_id"]="another-run"
        with self.assertRaises(CoordinationError):
            worker.execute()
        worker.runner.assert_not_called()
        self.assertEqual(worker.client.sessions,{})
        self.assertEqual(worker.journal.status()["state"],"prepared")

    def test_selected_memory_is_pinned_bounded_untrusted_and_hash_only_in_journal(self):
        self.plan["memory_refs"]=[{"memory_id":"memory-1","version":2}]
        worker=self.worker()
        worker.client.memory["memory-1"]={"id":"memory-1","project_id":"project-a","version":2,
                                         "title":"Published context","body":"PRIVATE-CONTEXT not authority"}
        worker.execute()
        prompt=worker.runner.call_args.args[2]
        self.assertIn("SELECTED UNTRUSTED PROJECT MEMORY",prompt)
        self.assertIn("PRIVATE-CONTEXT",prompt)
        status=worker.journal.status()
        self.assertNotIn("PRIVATE-CONTEXT",json.dumps(status))
        self.assertEqual(status["memory_context"][0]["memory_id"],"memory-1")
        self.assertEqual(status["memory_context"][0]["version"],2)
        self.assertEqual(len(status["memory_context"][0]["sha256"]),64)
        paths=[path for method,path,_ in worker.client.calls if method=="GET" and "/memory/" in path]
        self.assertEqual(paths,["/v1/projects/project-a/memory/memory-1"])

    def test_memory_version_or_project_mismatch_prevents_dispatch(self):
        self.plan["memory_refs"]=[{"memory_id":"memory-1","version":2}]
        worker=self.worker()
        worker.client.memory["memory-1"]={"id":"memory-1","project_id":"project-a","version":3,"title":"Title","body":"Body"}
        with self.assertRaises(CoordinationError):
            worker.execute()
        worker.client.memory["memory-1"].update(project_id="other-project",version=2)
        with self.assertRaises(CoordinationError):
            worker.execute()
        worker.runner.assert_not_called()

    def test_memory_total_size_and_plan_reference_budget(self):
        self.plan["memory_refs"]=[{"memory_id":"memory-1","version":1},{"memory_id":"memory-2","version":1}]
        worker=self.worker()
        for name in ("memory-1","memory-2"):
            worker.client.memory[name]={"id":name,"project_id":"project-a","version":1,"title":"Title","body":"x"*9000}
        with self.assertRaisesRegex(CoordinationError,"16 KiB"):
            worker.execute()
        worker.runner.assert_not_called()
        invalid={**self.plan,"memory_refs":[{"memory_id":"memory-"+str(i),"version":1} for i in range(5)]}
        with self.assertRaises(CoordinationError):
            validate_plan(invalid)

    def test_journal_lock_private_paths_and_immutable_plan(self):
        journal=self.journal()
        with self.assertRaises((BlockingIOError,CoordinationError)):
            self.journal()
        self.assertEqual((self.private/"job.sqlite3").stat().st_mode&0o777,0o600)
        with self.assertRaises(CoordinationError):
            Journal(self.cwd/"unsafe.sqlite3",self.plan)
        journal.close()
        self.journals.remove(journal)
        with self.assertRaises(CoordinationError):
            self.journal({**self.plan,"job_id":"another-job"})

    def test_prepared_never_dispatches_on_import_or_status(self):
        worker=self.worker()
        self.assertEqual(worker.journal.status()["state"],"prepared")
        self.assertEqual(worker.client.calls,[])
        worker.runner.assert_not_called()

    def test_origin_is_durable_and_rejects_other_server_before_requests(self):
        worker=self.worker()
        self.assertEqual(worker.journal.status()["origin"],"https://offline.example:8766")
        journal=self.reopen(worker.journal)
        other=FakeClient(journal.plan)
        other.url="https://other.example:8766"
        with self.assertRaisesRegex(CoordinationError,"different API origin"):
            self.worker(journal,other)
        self.assertEqual(other.calls,[])
        rotated=FakeClient(journal.plan)
        rotated.key="different credential on the same origin"
        resumed=self.worker(journal,rotated)
        resumed.execute()
        self.assertEqual(resumed.journal.status()["state"],"completed")
        resumed.client.url="https://other.example:8766"
        calls=len(resumed.client.calls)
        with self.assertRaises(CoordinationError):
            resumed.journal.flush(resumed.client)
        self.assertEqual(len(resumed.client.calls),calls)

    def test_git_pointer_is_audited_and_git_directory_refused(self):
        (self.cwd/".git").write_text("gitdir: /external/never/read\n")
        before=snapshot(self.cwd)
        self.assertIn(".git",before)
        worker=self.worker()
        def changed_pointer(*_args,**_kwargs):
            (self.cwd/".git").write_text("gitdir: /different\n")
            return self.runtime_result()
        worker.runner.side_effect=changed_pointer
        with self.assertRaisesRegex(CoordinationError,"outside"):
            worker.execute()
        other=self.root/"directory-git-work"
        other.mkdir()
        (other/".git").mkdir()
        with self.assertRaisesRegex(CoordinationError,".git directory"):
            snapshot(other)

    def test_unrelated_artifact_ref_cannot_be_published(self):
        worker=self.worker()
        worker.execute()
        unrelated=b"unrelated uploaded implementation"
        sha=hashlib.sha256(unrelated).hexdigest()
        worker.artifact_client.data["artifact-1"]=unrelated
        worker.artifact_client.metadata["artifact-1"]["sha256"]=sha
        publication=self.publication()
        publication["artifacts"][0]["sha256"]=sha
        with self.assertRaisesRegex(CoordinationError,"pinned local files"):
            worker.publish_report(publication)
        self.assertEqual(worker.client.publications,{})
        self.assertEqual(worker.journal.status()["state"],"completed")

    def test_portable_bundle_manifest_is_bound_to_local_output(self):
        spec=importlib.util.spec_from_file_location("artifact_format_test",Path(__file__).resolve().parents[1]/"scripts"/"artifact_client.py")
        helper=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        worker=self.worker()
        worker.execute()
        data=helper.pack(self.cwd,["source.txt"],"base-1")
        sha=hashlib.sha256(data).hexdigest()
        worker.artifact_client.data["artifact-1"]=data
        worker.artifact_client.metadata["artifact-1"]["sha256"]=sha
        publication=self.publication()
        publication["artifacts"][0]["sha256"]=sha
        self.assertEqual(worker.publish_report(publication)["state"],"reported")
        verified=worker.journal.status()["artifact_verification"][0]
        self.assertEqual(verified["sha256"],sha)
        self.assertEqual(verified["files"],{"source.txt":snapshot(self.cwd)["source.txt"]})

    def test_bundle_cannot_include_matching_but_unassigned_private_file(self):
        spec=importlib.util.spec_from_file_location("artifact_format_scope_test",Path(__file__).resolve().parents[1]/"scripts"/"artifact_client.py")
        helper=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        worker=self.worker()
        worker.execute()
        data=helper.pack(self.cwd,["source.txt","protected.txt"],"base-1")
        sha=hashlib.sha256(data).hexdigest()
        worker.artifact_client.data["artifact-1"]=data
        worker.artifact_client.metadata["artifact-1"]["sha256"]=sha
        publication=self.publication()
        publication["artifacts"][0]["sha256"]=sha
        with self.assertRaisesRegex(CoordinationError,"file manifest"):
            worker.publish_report(publication)
        self.assertEqual(worker.client.publications,{})

    def test_local_spec_json_duplicate_keys_are_rejected(self):
        scripts=Path(__file__).resolve().parents[1]/"scripts"
        import sys
        sys.path.insert(0,str(scripts))
        self.addCleanup(lambda:sys.path.remove(str(scripts)))
        spec=importlib.util.spec_from_file_location("coordination_cli_test",scripts/"coordination-worker.py")
        cli=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        path=self.private/"duplicate.json"
        path.write_text('{"run_id":"one","run_id":"two"}')
        with self.assertRaises(ValueError):
            cli.local_json(path)

    def test_known_keys_never_enter_public_report_or_completed_result(self):
        worker=self.worker()
        worker.client.key="private-api-key-fixture-not-a-real-credential"
        worker.runner.return_value=self.runtime_result("Found "+worker.client.key)
        with self.assertRaisesRegex(CoordinationError,"credential"):
            worker.execute()
        self.assertEqual(worker.journal.status()["state"],"uncertain")
        self.assertEqual(worker.client.publications,{})
        self.assertNotIn(worker.client.key,json.dumps(worker.journal.status()))

    def test_pending_outbox_known_key_is_blocked_before_any_post(self):
        worker=self.worker()
        worker.execute()
        worker.client.key="private-api-key-fixture-not-a-real-credential"
        payload={"client_id":"unsafe-old-report","expected_version":2,"type":"artifacts_ready","run_id":"run-a",
                 "summary":worker.client.key,"artifacts":self.publication()["artifacts"]}
        worker.journal.queue("/v1/projects/project-a/tasks/task-a/events",payload)
        previous=len(worker.client.calls)
        with self.assertRaisesRegex(CoordinationError,"credential"):
            worker.journal.flush(worker.client)
        self.assertEqual(len(worker.client.calls),previous)
        self.assertEqual(worker.journal.status()["state"],"report_pending")

    def test_late_lease_failure_prevents_reportable_completion(self):
        import coordination
        real_lease=coordination.SessionLease
        leases=[]
        def lease_factory(*args,**kwargs):
            value=real_lease(*args,**kwargs)
            leases.append(value)
            return value
        worker=self.worker()
        original=worker.server_context
        reads=0
        def late_failure(recovery):
            nonlocal reads
            result=original(recovery)
            reads+=1
            if reads==2:
                leases[-1].fatal="SimulatedLateRenewalFailure"
            return result
        worker.server_context=late_failure
        with patch.object(coordination,"SessionLease",side_effect=lease_factory):
            with self.assertRaisesRegex(CoordinationError,"session health"):
                worker.execute()
        self.assertEqual(worker.journal.status()["state"],"uncertain")
        self.assertEqual(worker.journal.status()["sessions"][-1]["state"],"closed")
        self.assertIsNone(worker.journal.row()["result"])

    def test_session_is_closed_before_completion_is_persisted(self):
        worker=self.worker()
        completed=worker.journal.completed
        def confirm(result,pins):
            self.assertTrue(worker.client.sessions)
            self.assertTrue(all(session["freshness"]=="closed" for session in worker.client.sessions.values()))
            return completed(result,pins)
        worker.journal.completed=confirm
        worker.execute()

    def test_same_run_state_cycle_cannot_validate_old_writer(self):
        worker=self.worker()
        def other_actor_recovered(*_args,**_kwargs):
            worker.client.task["version"]+=2
            return self.runtime_result()
        worker.runner.side_effect=other_actor_recovered
        with self.assertRaisesRegex(CoordinationError,"version changed"):
            worker.execute()
        self.assertEqual(worker.journal.status()["state"],"uncertain")
        self.assertIsNone(worker.journal.row()["result"])

    def test_malformed_server_event_receipt_does_not_mark_reported(self):
        worker=self.worker()
        worker.execute()
        real_request=worker.client._client.request
        def malformed(method,path,body=None):
            response=real_request(method,path,body)
            if method=="POST" and path.endswith("/events"):
                response["event"]["id"]=""
            return response
        worker.client._client.request=malformed
        with self.assertRaisesRegex(CoordinationError,"durable event identity"):
            worker.publish_report(self.publication())
        self.assertEqual(worker.journal.status()["state"],"report_pending")
        worker.runner.assert_called_once()

    def test_runtime_callback_failure_is_recorded_without_automatic_reexecution(self):
        worker=self.worker()
        worker.runner.return_value={**self.runtime_result(),"callback_errors":1}
        worker.execute()
        result=json.loads(worker.journal.row()["result"])
        self.assertEqual(result["runtime"]["callback_errors"],1)
        with self.assertRaises(CoordinationError):
            worker.execute()
        worker.runner.assert_called_once()

    def test_sigterm_unwinds_owned_fake_python_runtime_and_marks_uncertain(self):
        # A bounded Python sleep is the only actual child, never a provider CLI.
        import os
        import signal
        import subprocess
        import sys
        import threading
        scripts=Path(__file__).resolve().parents[1]/"scripts"
        sys.path.insert(0,str(scripts))
        self.addCleanup(lambda:sys.path.remove(str(scripts)))
        spec=importlib.util.spec_from_file_location("coordination_signal_cli_test",scripts/"coordination-worker.py")
        cli=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        from dev_trial_runtimes import run_job
        real_popen=subprocess.Popen
        children,timers=[],[]
        def fake_provider(_command,**kwargs):
            child=real_popen([sys.executable,"-u","-c",
                "import json,time;print(json.dumps({'type':'thread.started','thread_id':'fake-session'}),flush=True);time.sleep(20)"],**kwargs)
            children.append(child)
            timer=threading.Timer(0.2,lambda:os.kill(os.getpid(),signal.SIGTERM))
            timers.append(timer)
            timer.start()
            return child
        worker=self.worker(runner=run_job)
        previous=signal.signal(signal.SIGTERM,cli.controlled_stop)
        try:
            with patch("dev_trial_runtimes.subprocess.Popen",side_effect=fake_provider):
                with self.assertRaises(CoordinationError):
                    worker.execute()
            self.assertEqual(worker.journal.status()["state"],"uncertain")
            self.assertEqual(worker.journal.status()["sessions"][-1]["state"],"closed")
            self.assertEqual(len(children),1)
            self.assertIsNotNone(children[0].poll())
        finally:
            for timer in timers:
                timer.cancel()
                timer.join(timeout=1)
            signal.signal(signal.SIGTERM,previous)
            for child in children:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=3)


if __name__=="__main__":
    unittest.main()
