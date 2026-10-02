package link

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func mapNodes(t *testing.T, response map[string]any) map[string]map[string]any {
	t.Helper()
	result := map[string]map[string]any{}
	for _, entry := range response["nodes"].([]any) {
		node := entry.(map[string]any)
		key := node["key"].(string)
		if _, found := result[key]; found || key == "" {
			t.Fatal("map node identity collision")
		}
		result[key] = node
	}
	for _, entry := range response["edges"].([]any) {
		edge := entry.(map[string]any)
		if result[edge["source"].(string)] == nil || result[edge["target"].(string)] == nil {
			t.Fatal("dangling map edge")
		}
	}
	return result
}

func mapGroups(t *testing.T, response map[string]any) map[string]map[string]any {
	t.Helper()
	result := map[string]map[string]any{}
	for _, entry := range response["groups"].([]any) {
		group := entry.(map[string]any)
		kind := group["type"].(string)
		if result[kind] != nil {
			t.Fatal("duplicate map group")
		}
		result[kind] = group
		shown := 0
		for _, node := range response["nodes"].([]any) {
			if node.(map[string]any)["type"] == kind {
				shown++
			}
		}
		if group["shown"] != float64(shown) || group["total"].(float64) < float64(shown) || group["truncated"] != (group["total"].(float64) > float64(shown)) {
			t.Fatal("incorrect map coverage")
		}
	}
	if len(result) != 14 {
		t.Fatal("map must include coverage for all entity kinds")
	}
	return result
}

func TestProjectMapScopeReferencesAndMetadataOnly(t *testing.T) {
	v := newTaskScenario(t)
	f := v.f
	f.owner("owner")
	const privateBody = "PRIVATE_BODY_CANARY_not_for_map"
	const privateActivity = "PRIVATE_ACTIVITY_CANARY_not_for_map"
	const title = `<img src=x onerror=alert(1)> plain untrusted title`
	_, err := f.s.Pool.Exec(context.Background(), `UPDATE link_tasks SET title=$1 WHERE id=$2`, title, v.task["id"])
	if err != nil {
		t.Fatal(err)
	}
	message := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", map[string]any{"client_id": "map-message", "body": privateBody, "recipient_ids": []string{"codex-pilot"}}, 201)["message"].(map[string]any)
	messageID := message["id"].(string)
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", map[string]any{"client_id": "map-reply", "body": privateBody, "recipient_ids": []string{"codex-pilot"}, "reply_to": messageID}, 201)
	f.heartbeat("codex-pilot", "same-session")
	for _, status := range []string{"delivered", "accepted"} {
		f.expect("POST", "/v1/messages/"+messageID+"/receipts", "codex-pilot", map[string]any{"status": status, "session_id": "same-session"}, 200)
	}
	v.run = "same-run-correlation"
	v.emit("codex-pilot", "run_started", nil, 201)
	refs := v.refs()
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": refs}, 201)
	review := v.emit("codex-pilot", "review_requested", map[string]any{"artifacts": refs}, 201)["event"].(map[string]any)["id"].(string)
	v.emit("claude-pilot", "review_result", map[string]any{"artifacts": refs, "review_request_id": review, "verdict": "approved"}, 201)
	v.emit("codex-pilot", "verification_reported", map[string]any{"artifacts": refs, "evidence": map[string]any{"status": "passed", "command": privateBody, "exit_code": 0, "artifact": refs[2]}}, 201)
	for _, actor := range []string{"codex-pilot", "claude-pilot"} {
		in := coordinationSessionInput("same-session", "general")
		in["run_id"], in["activity"] = v.run, privateActivity
		f.expect("POST", "/v1/projects/pilot/sessions", actor, in, 201)
	}
	native := nativeInput("map-native", "inbox.accepted")
	native.SessionID, native.MessageID = "same-session", &messageID
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", native, 201)
	memory := f.expect("POST", "/v1/projects/pilot/memory", "codex-pilot", map[string]any{"client_id": "map-memory", "title": title, "body": privateBody}, 201)["memory"].(map[string]any)
	f.expect("PUT", "/v1/projects/pilot/memory/"+memory["id"].(string), "claude-pilot", map[string]any{"client_id": "map-memory-2", "expected_version": 1, "title": "Latest title", "body": privateBody}, 200)
	f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", map[string]any{"client_id": "map-public-note", "title": "Public note", "body": privateBody, "source_message_id": messageID}, 201)
	note := f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", map[string]any{"client_id": "map-legacy-note", "title": "Legacy note", "body": privateBody}, 201)["note"].(map[string]any)
	f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": "map-private", "name": "Private channel", "project_id": "pilot"}, 201)
	f.access("claude-pilot", "channel", "map-private", "write", 200)
	f.expect("POST", "/v1/admin/principals", "owner", map[string]any{"id": "map-private-agent", "name": "Hidden account", "kind": "agent", "runtime": "fixture"}, 201)
	f.access("map-private-agent", "project", "pilot", "read", 200)
	f.access("map-private-agent", "channel", "map-private", "read", 200)
	hiddenMessage := f.expect("POST", "/v1/channels/map-private/messages", "claude-pilot", map[string]any{"client_id": "map-hidden-message", "body": privateBody, "recipient_ids": []string{}}, 201)["message"].(map[string]any)
	hiddenNative := f.expect("POST", "/v1/channels/map-private/activity", "claude-pilot", nativeInput("map-private-event", "turn.started"), 201)["activity"].(map[string]any)
	f.expect("POST", "/v1/projects/pilot/sessions", "claude-pilot", coordinationSessionInput("map-private-session", "map-private"), 201)
	// Simulate a historical note reference whose source channel is now hidden.
	_, err = f.s.Pool.Exec(context.Background(), `UPDATE notes SET source_message_id=$1 WHERE id=$2`, hiddenMessage["id"], note["id"])
	if err != nil {
		t.Fatal(err)
	}
	foreign := f.expect("POST", "/v1/channels/isolated/activity", "deny-pilot", nativeInput("foreign-map-event", "turn.started"), 201)["activity"].(map[string]any)
	snapshot := `SELECT json_build_object('principals',(SELECT json_agg(p ORDER BY id) FROM principals p),'channels',(SELECT json_agg(c ORDER BY id) FROM channels c),'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r),'events',(SELECT json_agg(e ORDER BY channel_id,seq) FROM events e),'audit',(SELECT json_agg(a ORDER BY id) FROM admin_audit a))::text`
	before := f.snapshot(snapshot)
	response := f.expect("GET", "/v1/projects/pilot/map", "viewer-pilot", nil, 200)
	if response["read_only"] != true || response["project"].(map[string]any)["id"] != "pilot" || response["generated_at"] == nil {
		t.Fatal("invalid map envelope")
	}
	nodes, groups := mapNodes(t, response), mapGroups(t, response)
	for kind, group := range groups {
		if group["total"].(float64) == 0 {
			t.Fatalf("fixture missing entity kind %s", kind)
		}
	}
	if groups["agent"]["total"] != float64(3) || groups["channel"]["total"] != float64(1) || groups["message"]["total"] != float64(2) || groups["native"]["total"] != float64(1) || groups["session"]["total"] != float64(2) {
		t.Fatal("map counts leaked hidden entities")
	}
	encoded, _ := json.Marshal(response)
	for _, forbidden := range []string{privateBody, privateActivity, "map-private", hiddenMessage["id"].(string), hiddenNative["id"].(string), foreign["id"].(string), refs[0].SHA256, `"body":`, `"payload":`, `"summary":`, `"command":`, `"activity":`, `"key_hash":`, `"sha256":`} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatal("map leaked hidden ID, body, activity or hash")
		}
	}
	var sessions int
	for _, node := range nodes {
		if node["type"] == "task" && node["label"] != title {
			t.Fatal("map altered or interpreted untrusted title")
		}
		if node["type"] == "session" {
			sessions++
		}
		if node["id"] == note["id"] && node["meta"].(map[string]any)["source_message_id"] != nil {
			t.Fatal("hidden note source exposed")
		}
	}
	if sessions != 2 {
		t.Fatal("same session ID owned by different agents collided")
	}
	kinds := map[string]bool{}
	for _, entry := range response["edges"].([]any) {
		edge := entry.(map[string]any)
		kinds[edge["kind"].(string)] = true
		a, b := nodes[edge["source"].(string)]["type"], nodes[edge["target"].(string)]["type"]
		if (a == "session" && (b == "run" || b == "native")) || (b == "session" && (a == "run" || a == "native")) {
			t.Fatal("invented session/task/native linkage from matching strings")
		}
	}
	for _, kind := range []string{"channel_member", "reply_to", "recipient", "receipt_for", "reported_message", "task_run", "current_run", "task_owner", "task_reviewer", "review_request", "artifact_ref", "evidence_ref", "memory_version", "source_message"} {
		if !kinds[kind] {
			t.Fatalf("missing explicit relation %s", kind)
		}
	}
	owner := f.expect("GET", "/v1/projects/pilot/map", "owner", nil, 200)
	ownerGroups := mapGroups(t, owner)
	if ownerGroups["channel"]["total"] != float64(2) || ownerGroups["agent"]["total"] != float64(4) {
		t.Fatal("owner scope missing project history/members")
	}
	if strings.Contains(string(mustMapJSON(t, owner)), foreign["id"].(string)) {
		t.Fatal("owner map crossed project scope")
	}
	if f.snapshot(snapshot) != before {
		t.Fatal("GET map changed counters, presence, receipts, events or audit")
	}
}

func mustMapJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestProjectMapSuppressesMalformedReferences(t *testing.T) {
	v := newTaskScenario(t)
	f := v.f
	f.owner("owner")
	started := v.emit("codex-pilot", "run_started", nil, 201)["event"].(map[string]any)["id"].(string)
	refs := v.refs()
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": refs}, 201)
	request := v.emit("codex-pilot", "review_requested", map[string]any{"artifacts": refs}, 201)["event"].(map[string]any)["id"].(string)
	result := v.emit("claude-pilot", "review_result", map[string]any{"artifacts": refs, "review_request_id": request, "verdict": "approved"}, 201)["event"].(map[string]any)["id"].(string)
	verification := v.emit("codex-pilot", "verification_reported", map[string]any{"artifacts": refs, "evidence": map[string]any{"status": "passed", "command": "fixture", "exit_code": 0, "artifact": refs[2]}}, 201)["event"].(map[string]any)["id"].(string)
	other := &taskTestScenario{f: f, task: taskTestCreate(f, "pilot", "map-other-task"), project: "pilot", run: "map-other-task-run"}
	other.emit("codex-pilot", "run_started", nil, 201)
	other.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": refs}, 201)
	otherRequest := other.emit("codex-pilot", "review_requested", map[string]any{"artifacts": refs}, 201)["event"].(map[string]any)["id"].(string)
	ctx := context.Background()
	if _, err := f.s.Pool.Exec(ctx, `INSERT INTO link_task_runs(id,task_id,state,version) VALUES('map-other-run',$1,'running',1)`, v.task["id"]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Pool.Exec(ctx, `INSERT INTO link_task_events(id,task_id,run_id,actor_id,client_id,version,type,payload,payload_hash)
 VALUES('map-other-run-request',$1,'map-other-run','codex-pilot','other-run-request',100,'review_requested','{}','x'::bytea)`, v.task["id"]); err != nil {
		t.Fatal(err)
	}
	message := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", map[string]any{"client_id": "map-native-message", "body": "fixture", "recipient_ids": []string{"codex-pilot"}}, 201)["message"].(map[string]any)["id"].(string)
	input := nativeInput("map-native-reference", "inbox.accepted")
	input.MessageID = &message
	native := f.expect("POST", "/v1/channels/general/activity", "codex-pilot", input, 201)["activity"].(map[string]any)["id"].(string)
	f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": "map-other-visible", "name": "Other visible channel", "project_id": "pilot"}, 201)
	f.access("codex-pilot", "channel", "map-other-visible", "write", 200)
	f.access("viewer-pilot", "channel", "map-other-visible", "read", 200)
	otherMessage := f.expect("POST", "/v1/channels/map-other-visible/messages", "codex-pilot", map[string]any{"client_id": "map-other-visible-message", "body": "fixture", "recipient_ids": []string{}}, 201)["message"].(map[string]any)["id"]
	// These malformed references are injected only into this test's owned schema.
	// Both endpoints remain visible, so sampling/ACL filtering cannot mask a false relation.
	if _, err := f.s.Pool.Exec(ctx, `UPDATE native_activity SET message_id=$2 WHERE id=$1`, native, otherMessage); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Pool.Exec(ctx, `UPDATE link_task_events SET payload=jsonb_set(payload,'{evidence,artifact,artifact_id}',to_jsonb($2::text)) WHERE id=$1`, verification, refs[0].ArtifactID); err != nil {
		t.Fatal(err)
	}
	for name, invalidRequest := range map[string]string{"cross-task": otherRequest, "wrong-type": started, "wrong-run": "map-other-run-request"} {
		t.Run(name, func(t *testing.T) {
			if _, err := f.s.Pool.Exec(ctx, `UPDATE link_task_runs SET review_request_id=$2 WHERE id=$1`, v.run, invalidRequest); err != nil {
				t.Fatal(err)
			}
			if _, err := f.s.Pool.Exec(ctx, `UPDATE link_task_events SET payload=jsonb_set(payload,'{review_request_id}',to_jsonb($2::text)) WHERE id=$1`, result, invalidRequest); err != nil {
				t.Fatal(err)
			}
			response := f.expect("GET", "/v1/projects/pilot/map?limit=50", "viewer-pilot", nil, 200)
			nodes := mapNodes(t, response)
			checks := []struct{ kind, id, field string }{
				{"run", v.run, "review_request_id"}, {"task-event", result, "review_request_id"},
				{"task-event", verification, "evidence_artifact_id"}, {"native", native, "message_id"},
			}
			for _, check := range checks {
				node := nodes[projectMapKey(check.kind, check.id)]
				if node == nil || node["meta"].(map[string]any)[check.field] != nil {
					t.Fatalf("malformed %s.%s reference was exposed", check.kind, check.field)
				}
			}
			for _, edge := range response["edges"].([]any) {
				e := edge.(map[string]any)
				source, kind := e["source"], e["kind"]
				if (kind == "review_request" && (source == projectMapKey("run", v.run) || source == projectMapKey("task-event", result))) ||
					(kind == "evidence_ref" && source == projectMapKey("task-event", verification)) ||
					(kind == "reported_message" && source == projectMapKey("native", native)) {
					t.Fatal("malformed reference produced a relation")
				}
			}
		})
	}
}

func TestProjectMapLimitsTiesCompositeIDsAndEmptyCoverage(t *testing.T) {
	f := newFixture(t)
	initial := f.expect("GET", "/v1/projects/pilot/map?limit=1", "viewer-pilot", nil, 200)
	groups := mapGroups(t, initial)
	mapNodes(t, initial)
	if groups["agent"]["total"] != float64(3) || groups["agent"]["shown"] != float64(1) || groups["native"]["total"] != float64(0) {
		t.Fatal("wrong bounded/empty coverage")
	}
	_, err := f.s.Pool.Exec(context.Background(), `INSERT INTO notes(id,project_id,author_id,client_id,title,body,payload_hash,created_at)
 SELECT 'bounded-'||lpad(g::text,4,'0'),'pilot','codex-pilot','map-'||g,'Title '||g,'private-body','x'::bytea,'2020-01-01T00:00:00Z'::timestamptz FROM generate_series(1,55) g`)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		query string
		shown int
	}{{"", 25}, {"?limit=1", 1}, {"?limit=50", 50}} {
		response := f.expect("GET", "/v1/projects/pilot/map"+test.query, "viewer-pilot", nil, 200)
		mapNodes(t, response)
		group := mapGroups(t, response)["note"]
		if group["total"] != float64(55) || group["shown"] != float64(test.shown) || group["truncated"] != true {
			t.Fatal("per-kind limit/count incorrect")
		}
		last := "z"
		for _, entry := range response["nodes"].([]any) {
			node := entry.(map[string]any)
			if node["type"] == "note" {
				if node["id"].(string) >= last {
					t.Fatal("timestamp tie order unstable")
				}
				last = node["id"].(string)
			}
		}
	}
	for _, query := range []string{"?limit=0", "?limit=51", "?limit=-1", "?limit=no", "?limit=", "?limit=1&limit=2", "?other=1", "?channel_id=general", "?limit=%XX"} {
		f.expect("GET", "/v1/projects/pilot/map"+query, "viewer-pilot", nil, 400)
	}
	memory := memoryTestCreate(f, "map-large-versions")
	_, err = f.s.Pool.Exec(context.Background(), `INSERT INTO link_memory_versions(memory_id,project_id,version,author_id,client_id,title,body,payload_hash)
 SELECT $1,'pilot',v,'codex-pilot','large-'||v,'Version','private','x'::bytea FROM unnest(ARRAY[9007199254740992,9007199254740993]::bigint[]) v`, memory["id"])
	if err != nil {
		t.Fatal(err)
	}
	large := f.expect("GET", "/v1/projects/pilot/map", "viewer-pilot", nil, 200)
	mapNodes(t, large)
	if mapGroups(t, large)["memory-version"]["shown"] != float64(3) {
		t.Fatal("large version composite identities collided")
	}
}

func TestProjectMapRevocationArchiveAndKeyRecheck(t *testing.T) {
	f, _ := lifecycleFixture(t)
	base := "/v1/projects/" + lifecycleID + "/map"
	f.expect("GET", base, "viewer-pilot", nil, 200)
	f.expect("GET", base, "deny-pilot", nil, 404)
	f.expect("GET", "/v1/projects/missing/map", "owner", nil, 404)
	f.expect("GET", base, "", nil, 401)
	f.lifecycle("archive", 200)
	f.expect("GET", base, "viewer-pilot", nil, 404)
	archived := f.expect("GET", base, "owner", nil, 200)
	if archived["project"].(map[string]any)["archived_at"] == nil {
		t.Fatal("owner archive context missing")
	}
	f.lifecycle("restore", 200)
	f.access("viewer-pilot", "channel", lifecycleChannel, "none", 200)
	response := f.expect("GET", base, "viewer-pilot", nil, 200)
	groups := mapGroups(t, response)
	if groups["channel"]["total"] != float64(0) || groups["message"]["total"] != float64(0) || groups["receipt"]["total"] != float64(0) || groups["agent"]["total"] != float64(0) {
		t.Fatal("map cache/visibility survived channel revocation")
	}
	f.access("viewer-pilot", "project", lifecycleID, "none", 200)
	f.expect("GET", base, "viewer-pilot", nil, 404)
	oldKey := f.keys["codex-pilot"]
	f.expect("POST", "/v1/admin/principals/codex-pilot/revoke-key", "owner", map[string]any{}, 200)
	f.expect("GET", base, "codex-pilot", nil, 401)
	req := httptest.NewRequest(http.MethodGet, base, nil)
	req.Header.Set("Authorization", "Bearer "+oldKey)
	req.SetPathValue("project", lifecycleID)
	req = req.WithContext(context.WithValue(req.Context(), contextKey{}, Principal{ID: "codex-pilot", Kind: "owner"}))
	recorder := httptest.NewRecorder()
	(&Server{Store: f.s}).projectMap(recorder, req)
	if recorder.Code != 401 {
		t.Fatal("map trusted stale middleware identity/key")
	}
}
