package link

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func taskTestCreate(f *fixture, project, client string) map[string]any {
	f.t.Helper()
	return f.expect("POST", "/v1/projects/"+project+"/tasks", "codex-pilot", map[string]any{
		"client_id": client, "title": "Deterministic offline change", "owner_id": "codex-pilot", "reviewer_id": "claude-pilot", "scope": []string{"src/example.go", "src/example_test.go"}, "acceptance": []string{"Negative regression fails on baseline", "Fixed package tests pass"},
	}, 201)["task"].(map[string]any)
}

func taskTestArtifact(f *fixture, project, actor, role, client string) TaskArtifactRef {
	return taskTestArtifactBase(f, project, actor, role, client, "baseline-1")
}

func taskTestArtifactBase(f *fixture, project, actor, role, client, base string) TaskArtifactRef {
	f.t.Helper()
	payload := []byte("bounded immutable artifact " + client)
	v := f.expect("POST", "/v1/projects/"+project+"/artifacts", actor, map[string]any{"client_id": client, "role": role, "base_revision": base, "sha256": hex.EncodeToString(digest(string(payload))), "content_base64": base64.StdEncoding.EncodeToString(payload)}, 201)["artifact"].(map[string]any)
	return TaskArtifactRef{ArtifactID: v["id"].(string), SHA256: v["sha256"].(string), Role: role}
}

type taskTestScenario struct {
	f            *fixture
	task         map[string]any
	project, run string
	serial       int
}

func newTaskScenario(t *testing.T) *taskTestScenario {
	t.Helper()
	f := newFixture(t)
	return &taskTestScenario{f: f, task: taskTestCreate(f, "pilot", "task-1"), project: "pilot", run: "test-run-1"}
}
func (v *taskTestScenario) endpoint() string {
	return "/v1/projects/" + v.project + "/tasks/" + v.task["id"].(string)
}
func (v *taskTestScenario) input(kind string) map[string]any {
	v.serial++
	return map[string]any{"client_id": fmt.Sprintf("event-%d", v.serial), "expected_version": v.task["version"], "type": kind, "run_id": v.run, "summary": "Attributed test report, not server execution"}
}
func (v *taskTestScenario) post(actor string, in map[string]any, status int) map[string]any {
	v.f.t.Helper()
	out := v.f.expect("POST", v.endpoint()+"/events", actor, in, status)
	if status == 201 || status == 200 {
		v.task = out["task"].(map[string]any)
		if out["server_verified"] != false {
			v.f.t.Fatal("external report represented as server verification")
		}
	}
	return out
}
func (v *taskTestScenario) emit(actor, kind string, extra map[string]any, status int) map[string]any {
	in := v.input(kind)
	for k, value := range extra {
		in[k] = value
	}
	return v.post(actor, in, status)
}
func (v *taskTestScenario) refs() []TaskArtifactRef {
	return []TaskArtifactRef{taskTestArtifact(v.f, v.project, "codex-pilot", "implementation", "impl-1"), taskTestArtifact(v.f, v.project, "claude-pilot", "test", "test-1"), taskTestArtifact(v.f, v.project, "codex-pilot", "evidence", "evidence-1")}
}

func TestTaskInputAndNestedStrictness(t *testing.T) {
	for _, scope := range [][]string{nil, {"../secret"}, {"/absolute"}, {"a/../b"}, {"."}, {"a\\b"}, {"a", "a"}, {"a", "a/"}, {"C:relative"}, {"a\nfile"}, {"a\tfile"}, {"a\x7ffile"}} {
		if taskScopeValid(scope) {
			t.Errorf("unsafe scope accepted: %q", scope)
		}
	}
	if !taskScopeValid([]string{"src/file.go", "tests/"}) {
		t.Fatal("valid relative scope rejected")
	}
	ref := TaskArtifactRef{ArtifactID: "immutable-1", SHA256: strings.Repeat("a", 64), Role: "evidence"}
	base := TaskEventInput{ClientID: "event", ExpectedVersion: 1, Type: "run_started", RunID: "run", Summary: "Run reported"}
	if !taskEventValid(base) {
		t.Fatal("valid event rejected")
	}
	for _, bad := range []TaskEventInput{
		{ClientID: "event", ExpectedVersion: 0, Type: "run_started", RunID: "run", Summary: "Run"},
		{ClientID: "event", ExpectedVersion: 1, Type: "execute", RunID: "run", Summary: "Run"},
		{ClientID: "event", ExpectedVersion: 1, Type: "run_started", RunID: "run", Summary: " "},
		{ClientID: "event", ExpectedVersion: 1, Type: "run_started", RunID: "run", Summary: "Run", Artifacts: []TaskArtifactRef{ref}},
		{ClientID: "event", ExpectedVersion: 1, Type: "artifacts_ready", RunID: "run", Summary: "Run", Artifacts: []TaskArtifactRef{ref, ref}},
	} {
		if taskEventValid(bad) {
			t.Errorf("invalid event accepted: %s", bad.Type)
		}
	}
	for _, raw := range []string{
		`{"artifact_id":"a","artifact_id":"b","sha256":"x","role":"test"}`,
		`{"artifact_id":"a","SHA256":"x","role":"test"}`,
		`{"artifact_id":"a","sha256":"x","role":"test","unknown":true}`,
		`null`,
	} {
		var v TaskArtifactRef
		if json.Unmarshal([]byte(raw), &v) == nil {
			t.Error("noncanonical nested object accepted")
		}
	}
	for _, raw := range []string{`{"status":"passed","status":"failed"}`, `{"Status":"passed"}`, `{"status":"passed","findings":[]}`, `{"status":"failed","command":"test","artifact":{}}`} {
		var v TaskEvidence
		if json.Unmarshal([]byte(raw), &v) == nil {
			t.Error("noncanonical evidence accepted")
		}
	}
}

func TestTaskFullPinnedReviewLifecycleAndReplay(t *testing.T) {
	v := newTaskScenario(t)
	f := v.f
	start := v.input("run_started")
	started := v.post("codex-pilot", start, 201)
	v.post("codex-pilot", start, 200)
	changed := map[string]any{}
	for k, x := range start {
		changed[k] = x
	}
	changed["summary"] = "Different payload"
	v.post("codex-pilot", changed, 409)
	v.emit("codex-pilot", "uncertain", map[string]any{"expected_version": 1}, 409)
	refs := v.refs()
	v.emit("claude-pilot", "artifacts_ready", map[string]any{"artifacts": refs}, 403)
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": refs}, 201)
	review := v.emit("codex-pilot", "review_requested", map[string]any{"artifacts": refs}, 201)
	requestID := review["event"].(map[string]any)["id"].(string)
	approval := v.input("review_result")
	approval["artifacts"] = refs
	approval["review_request_id"] = requestID
	approval["verdict"] = "approved"
	v.post("codex-pilot", approval, 403)
	approval["review_request_id"] = "wrong-request"
	v.post("claude-pilot", approval, 409)
	approval["review_request_id"] = requestID
	approval["artifacts"] = refs[:2]
	v.post("claude-pilot", approval, 409)
	approval["artifacts"] = []TaskArtifactRef{refs[2], refs[1], refs[0]}
	v.post("claude-pilot", approval, 201)
	if v.task["state"] != "approved" {
		t.Fatal("review did not change state")
	}
	v.emit("codex-pilot", "completion_reported", map[string]any{"artifacts": refs, "review_request_id": requestID}, 409)
	zero, nonzero := 0, 1
	for _, status := range []string{"failed", "passed"} {
		exit := &nonzero
		if status == "passed" {
			exit = &zero
		}
		v.emit("codex-pilot", "verification_reported", map[string]any{"artifacts": refs, "evidence": TaskEvidence{Status: status, Command: "go test ./offline", ExitCode: exit, Artifact: refs[2]}}, 201)
		if status == "failed" {
			v.emit("codex-pilot", "completion_reported", map[string]any{"artifacts": refs, "review_request_id": requestID}, 409)
		}
	}
	completed := v.emit("codex-pilot", "completion_reported", map[string]any{"artifacts": refs, "review_request_id": requestID}, 201)
	if completed["task"].(map[string]any)["state"] != "completion_reported" {
		t.Fatal("completion claim not recorded")
	}
	v.run = "test-run-2"
	v.emit("codex-pilot", "run_started", nil, 201)
	oldVersion := v.task["version"]
	replayed := v.post("claude-pilot", approval, 200)
	if replayed["task"].(map[string]any)["state"] != "running" || v.task["version"] != oldVersion {
		t.Fatal("old approval replay mutated new run")
	}
	v.emit("claude-pilot", "review_result", map[string]any{"artifacts": refs, "review_request_id": requestID, "verdict": "approved", "run_id": "test-run-1"}, 409)
	v.emit("claude-pilot", "uncertain", nil, 201)
	v.emit("codex-pilot", "run_started", nil, 409)
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": refs}, 409)
	v.emit("claude-pilot", "recovery_decided", map[string]any{"recovery_action": "resume"}, 403)
	v.emit("codex-pilot", "recovery_decided", map[string]any{"recovery_action": "resume"}, 201)
	detail := f.expect("GET", v.endpoint(), "viewer-pilot", nil, 200)
	run := detail["runs"].([]any)[0].(map[string]any)
	if run["state"] != "running" || len(run["artifacts"].([]any)) != 0 || run["review_request_id"] != nil || run["verification_status"] != nil {
		t.Fatal("recovery retained approval/evidence authority")
	}
	v.emit("codex-pilot", "cancelled", nil, 201)
	if started["event"].(map[string]any)["version"] != float64(2) {
		t.Fatal("initial event version must follow task definition")
	}
	page := f.expect("GET", v.endpoint()+"/events?after_version=0&limit=2", "viewer-pilot", nil, 200)
	if page["truncated"] != true || len(page["events"].([]any)) != 2 {
		t.Fatal("event page not bounded")
	}
	all := []any{}
	after := 0
	for {
		page = f.expect("GET", fmt.Sprintf("%s/events?after_version=%d&limit=2", v.endpoint(), after), "codex-pilot", nil, 200)
		items := page["events"].([]any)
		all = append(all, items...)
		for _, x := range items {
			after = int(x.(map[string]any)["version"].(float64))
		}
		if page["truncated"] == false {
			break
		}
	}
	if len(all) != int(v.task["version"].(float64))-1 {
		t.Fatal("durable events missing or duplicated")
	}
	for i, x := range all {
		if x.(map[string]any)["version"] != float64(i+2) {
			t.Fatal("event versions not contiguous")
		}
	}
}

func TestTaskStaleRequestAndSetInvalidateApproval(t *testing.T) {
	v := newTaskScenario(t)
	refs := v.refs()
	v.emit("codex-pilot", "run_started", nil, 201)
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": refs}, 201)
	first := v.emit("codex-pilot", "review_requested", map[string]any{"artifacts": refs}, 201)["event"].(map[string]any)["id"].(string)
	newRef := taskTestArtifact(v.f, "pilot", "codex-pilot", "implementation", "impl-2")
	newRefs := []TaskArtifactRef{newRef, refs[1], refs[2]}
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": newRefs}, 201)
	v.emit("claude-pilot", "review_result", map[string]any{"artifacts": refs, "review_request_id": first, "verdict": "approved"}, 409)
	second := v.emit("codex-pilot", "review_requested", map[string]any{"artifacts": newRefs}, 201)["event"].(map[string]any)["id"].(string)
	v.emit("claude-pilot", "review_result", map[string]any{"artifacts": newRefs, "review_request_id": first, "verdict": "approved"}, 409)
	v.emit("claude-pilot", "review_result", map[string]any{"artifacts": refs, "review_request_id": second, "verdict": "approved"}, 409)
	v.emit("claude-pilot", "review_result", map[string]any{"artifacts": newRefs, "review_request_id": second, "verdict": "changes_requested"}, 201)
	v.emit("codex-pilot", "completion_reported", map[string]any{"artifacts": newRefs, "review_request_id": second}, 409)
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": newRefs}, 201)
	v.emit("claude-pilot", "uncertain", nil, 201)
	v.emit("codex-pilot", "recovery_decided", map[string]any{"recovery_action": "cancel"}, 201)
	v.run = "next-after-recovery"
	v.emit("codex-pilot", "run_started", nil, 201)
}

func TestTaskACLArtifactProvenanceAndArchive(t *testing.T) {
	v := newTaskScenario(t)
	f := v.f
	f.owner("owner")
	for _, actor := range []string{"owner", "viewer-pilot"} {
		got := f.expect("GET", "/v1/projects/pilot/tasks", actor, nil, 200)
		if got["can_write"] != false {
			t.Fatal("read-only principal advertised writable")
		}
		v.emit(actor, "run_started", nil, 403)
	}
	for _, suffix := range []string{"/tasks", "/tasks/" + v.task["id"].(string), "/tasks/" + v.task["id"].(string) + "/events"} {
		f.expect("GET", "/v1/projects/pilot"+suffix, "deny-pilot", nil, 404)
	}
	f.expect("GET", "/v1/projects/isolated/tasks/"+v.task["id"].(string), "owner", nil, 404)
	v.emit("codex-pilot", "run_started", nil, 201)
	refs := v.refs()
	foreign := taskTestArtifact(f, "isolated", "deny-pilot", "test", "foreign-artifact")
	wrongAuthor := taskTestArtifact(f, "pilot", "claude-pilot", "implementation", "wrong-author")
	wrongHash := refs[0]
	wrongHash.SHA256 = strings.Repeat("0", 64)
	wrongRole := refs[0]
	wrongRole.Role = "test"
	wrongBase := taskTestArtifactBase(f, "pilot", "claude-pilot", "test", "mixed-base", "baseline-2")
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": []TaskArtifactRef{refs[0], wrongBase}}, 409)
	for _, ref := range []TaskArtifactRef{foreign, wrongAuthor, wrongHash, wrongRole} {
		v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": []TaskArtifactRef{ref}}, 409)
	}
	// Immutable uploads remain attributable after upload rights are downgraded;
	// this does not permit the downgraded author to publish a new review.
	f.access("claude-pilot", "project", "pilot", "read", 200)
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": refs}, 201)
	request := v.emit("codex-pilot", "review_requested", map[string]any{"artifacts": refs}, 201)["event"].(map[string]any)["id"].(string)
	v.emit("claude-pilot", "review_result", map[string]any{"artifacts": refs, "review_request_id": request, "verdict": "approved"}, 404)
	f.access("claude-pilot", "project", "pilot", "none", 200)
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": refs}, 409)
	f.access("claude-pilot", "project", "pilot", "write", 200)
	f.expect("POST", "/v1/admin/projects/pilot/archive", "owner", map[string]any{}, 200)
	f.expect("GET", v.endpoint(), "codex-pilot", nil, 404)
	got := f.expect("GET", v.endpoint(), "owner", nil, 200)
	if got["can_write"] != false {
		t.Fatal("archived history writable")
	}
	v.emit("codex-pilot", "uncertain", nil, 404)
	f.expect("POST", "/v1/admin/projects/pilot/restore", "owner", map[string]any{}, 200)
	v.emit("claude-pilot", "review_result", map[string]any{"artifacts": refs, "review_request_id": request, "verdict": "approved"}, 201)
}

func TestTaskCreateIdempotencyAndRoleValidation(t *testing.T) {
	f := newFixture(t)
	in := map[string]any{"client_id": "create-1", "title": "Task", "owner_id": "codex-pilot", "reviewer_id": "claude-pilot", "scope": []string{"source.go"}, "acceptance": []string{"Offline regression passes"}}
	first := f.expect("POST", "/v1/projects/pilot/tasks", "codex-pilot", in, 201)
	replay := f.expect("POST", "/v1/projects/pilot/tasks", "codex-pilot", in, 200)
	if first["task"].(map[string]any)["id"] != replay["task"].(map[string]any)["id"] || replay["replayed"] != true {
		t.Fatal("task creation not idempotent")
	}
	in["title"] = "Changed"
	f.expect("POST", "/v1/projects/pilot/tasks", "codex-pilot", in, 409)
	in["client_id"] = "create-2"
	in["reviewer_id"] = "codex-pilot"
	f.expect("POST", "/v1/projects/pilot/tasks", "codex-pilot", in, 400)
	for _, reviewer := range []string{"deny-pilot", "viewer-pilot", "missing"} {
		in["reviewer_id"] = reviewer
		f.expect("POST", "/v1/projects/pilot/tasks", "codex-pilot", in, 409)
	}
	in["reviewer_id"] = "claude-pilot"
	f.expect("POST", "/v1/projects/pilot/tasks", "viewer-pilot", in, 403)
}

func TestTaskConcurrentCASAndIdempotentReplay(t *testing.T) {
	for _, same := range []bool{false, true} {
		t.Run(fmt.Sprintf("same_payload_%t", same), func(t *testing.T) {
			v := newTaskScenario(t)
			base := v.input("run_started")
			var wg sync.WaitGroup
			status := make(chan int, 12)
			ids := make(chan string, 12)
			for i := 0; i < 12; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					in := map[string]any{}
					for k, x := range base {
						in[k] = x
					}
					if !same {
						in["client_id"] = fmt.Sprintf("concurrent-%d", i)
						in["run_id"] = fmt.Sprintf("concurrent-run-%d", i)
					}
					code, out := v.f.request("POST", v.endpoint()+"/events", "codex-pilot", in)
					status <- code
					if event, ok := out["event"].(map[string]any); ok {
						ids <- event["id"].(string)
					}
				}(i)
			}
			wg.Wait()
			close(status)
			close(ids)
			created, other := 0, 0
			for code := range status {
				if code == 201 {
					created++
				} else if (same && code == 200) || (!same && code == 409) {
					other++
				} else {
					t.Errorf("unexpected concurrent status %d", code)
				}
			}
			if created != 1 || other != 11 {
				t.Fatal("CAS did not serialize exactly one mutation")
			}
			unique := map[string]bool{}
			for id := range ids {
				unique[id] = true
			}
			if len(unique) != 1 {
				t.Fatal("replay returned a different immutable event")
			}
			var count int
			if err := v.f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM link_task_events`).Scan(&count); err != nil || count != 1 {
				t.Fatal("concurrency inserted duplicate events")
			}
		})
	}
}

func TestTaskEventFailureRollsBackRunAndVersion(t *testing.T) {
	v := newTaskScenario(t)
	ctx := context.Background()
	_, err := v.f.s.Pool.Exec(ctx, `CREATE FUNCTION task_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER fail_event BEFORE INSERT ON link_task_events FOR EACH ROW EXECUTE FUNCTION task_event_failure()`)
	if err != nil {
		t.Fatal(err)
	}
	in := v.input("run_started")
	v.post("codex-pilot", in, 500)
	var version, runs int
	if err = v.f.s.Pool.QueryRow(ctx, `SELECT version,(SELECT count(*) FROM link_task_runs) FROM link_tasks WHERE id=$1`, v.task["id"]).Scan(&version, &runs); err != nil || version != 1 || runs != 0 {
		t.Fatal("event failure left partial state")
	}
	if _, err = v.f.s.Pool.Exec(ctx, `DROP TRIGGER fail_event ON link_task_events`); err != nil {
		t.Fatal(err)
	}
	v.post("codex-pilot", in, 201)
}

func TestTaskHTTPRejectsNestedDuplicateFields(t *testing.T) {
	v := newTaskScenario(t)
	body := fmt.Sprintf(`{"client_id":"bad","expected_version":1,"type":"artifacts_ready","run_id":"r","summary":"report","artifacts":[{"artifact_id":"a","artifact_id":"b","sha256":"%s","role":"test"}]}`, strings.Repeat("a", 64))
	req, err := http.NewRequest("POST", v.f.server.URL+v.endpoint()+"/events", bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+v.f.keys["codex-pilot"])
	resp, err := v.f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("nested duplicate returned %d", resp.StatusCode)
	}
}

func TestTaskDetailSnapshotAndScopedForeignKeys(t *testing.T) {
	v := newTaskScenario(t)
	v.emit("codex-pilot", "run_started", nil, 201)
	refs := v.refs()
	endpoint := v.endpoint()
	taskID := v.task["id"].(string)
	runID := v.run
	// A task snapshot must never show an event/run newer than its task version.
	done := make(chan struct{})
	failures := make(chan int, 1)
	go func() {
		defer close(done)
		for i := 0; i < 30; i++ {
			code, _ := v.f.request("POST", endpoint+"/events", "codex-pilot", map[string]any{"client_id": fmt.Sprintf("snapshot-%d", i), "expected_version": i + 2, "type": "artifacts_ready", "run_id": runID, "summary": "Snapshot consistency", "artifacts": refs})
			if code != 201 {
				failures <- code
				return
			}
		}
	}()
	for i := 0; i < 45; i++ {
		out := v.f.expect("GET", endpoint, "viewer-pilot", nil, 200)
		task := out["task"].(map[string]any)
		runs := out["runs"].([]any)
		events := out["events"].([]any)
		if runs[0].(map[string]any)["version"] != task["version"] || events[len(events)-1].(map[string]any)["version"] != task["version"] {
			t.Error("detail mixed different committed snapshots")
			break
		}
	}
	<-done
	select {
	case status := <-failures:
		t.Fatalf("snapshot writer failed: %d", status)
	default:
	}
	other := taskTestCreate(v.f, "pilot", "other-task")
	ctx := context.Background()
	if _, err := v.f.s.Pool.Exec(ctx, `UPDATE link_tasks SET current_run_id=$1 WHERE id=$2`, runID, other["id"]); err == nil {
		t.Fatal("cross-task current run was accepted")
	}
	if _, err := v.f.s.Pool.Exec(ctx, `UPDATE link_task_events SET task_id=$1 WHERE task_id=$2 AND version=2`, other["id"], taskID); err == nil {
		t.Fatal("event linked to another task's run")
	}
	// Reapplying additive migrations keeps the records and scoped FKs intact.
	if err := v.f.s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	v.f.expect("GET", endpoint, "codex-pilot", nil, 200)
}

func TestTaskRevokedUploaderHistoryDoesNotAuthorizeNewAction(t *testing.T) {
	v := newTaskScenario(t)
	v.f.owner("owner")
	refs := v.refs()
	v.emit("codex-pilot", "run_started", nil, 201)
	v.f.expect("POST", "/v1/admin/principals/claude-pilot/revoke-key", "owner", map[string]any{}, 200)
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": refs}, 201)
	request := v.emit("codex-pilot", "review_requested", map[string]any{"artifacts": refs}, 201)["event"].(map[string]any)["id"].(string)
	v.emit("claude-pilot", "review_result", map[string]any{"artifacts": refs, "review_request_id": request, "verdict": "approved"}, 401)
	if v.task["state"] != "review_pending" {
		t.Fatal("revoked reviewer altered state")
	}
}
