package link

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func nativeInput(client, kind string) nativeActivityInput {
	return nativeActivityInput{ClientID: client, SessionID: "native-session", Runtime: "codex", EventType: kind}
}

func TestNativeActivityValidation(t *testing.T) {
	for _, kind := range []string{"session.started", "session.ended", "turn.started", "turn.completed", "tool.started", "tool.completed", "tool.failed", "agent.waiting", "inbox.offered", "inbox.accepted"} {
		in := nativeInput("client", kind)
		if strings.HasPrefix(kind, "inbox.") {
			message := "message-id"
			in.MessageID = &message
		}
		if !validNativeActivity(in) {
			t.Fatalf("valid event %s rejected", kind)
		}
	}
	for label, change := range map[string]func(*nativeActivityInput){
		"client path":           func(in *nativeActivityInput) { in.ClientID = "../../key" },
		"session missing":       func(in *nativeActivityInput) { in.SessionID = "" },
		"session oversized":     func(in *nativeActivityInput) { in.SessionID = strings.Repeat("s", 129) },
		"runtime":               func(in *nativeActivityInput) { in.Runtime = "shell" },
		"event":                 func(in *nativeActivityInput) { in.EventType = "task.succeeded" },
		"raw tool":              func(in *nativeActivityInput) { value := "cat /private/key"; in.ToolName = &value },
		"empty tool":            func(in *nativeActivityInput) { value := ""; in.ToolName = &value },
		"tool on turn":          func(in *nativeActivityInput) { value := "Read"; in.ToolName = &value; in.EventType = "turn.started" },
		"unrelated message":     func(in *nativeActivityInput) { value := "message"; in.MessageID = &value },
		"inbox without message": func(in *nativeActivityInput) { in.EventType = "inbox.accepted" },
	} {
		t.Run(label, func(t *testing.T) {
			in := nativeInput("client", "tool.started")
			change(&in)
			if validNativeActivity(in) {
				t.Fatal("invalid native activity accepted")
			}
		})
	}
}

func TestNativeActivityACLReplayCursorAndNoLegacyMutation(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	f.heartbeat("codex-pilot", "legacy-lease")
	message := f.message("native-inbox", "claude-pilot")
	before := f.snapshot(`SELECT json_build_object('principals',(SELECT json_agg(p ORDER BY id) FROM principals p),'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r))::text`)
	viewerRevision := workspaceTestRevision(t, f, "viewer-pilot")
	hiddenRevision := workspaceTestRevision(t, f, "deny-pilot")
	in := nativeInput("first", "session.started")
	first := f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 201)["activity"].(map[string]any)
	if first["actor_id"] != "codex-pilot" || first["provenance"] != "client_reported" || first["server_verified"] != false || first["seq"] != float64(2) {
		t.Fatal("native activity attribution/cursor/provenance incorrect")
	}
	replayed := f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 200)
	if replayed["replayed"] != true || replayed["activity"].(map[string]any)["id"] != first["id"] {
		t.Fatal("activity replay duplicated immutable record")
	}
	in.EventType = "session.ended"
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 409)
	for _, actor := range []string{"viewer-pilot", "owner"} {
		f.expect("GET", "/v1/channels/general/activity", actor, nil, 200)
		f.expect("POST", "/v1/channels/general/activity", actor, in, 404)
	}
	for _, method := range []string{"GET", "POST"} {
		var body any
		if method == "POST" {
			body = in
		}
		f.expect(method, "/v1/channels/general/activity", "deny-pilot", body, 404)
		f.expect(method, "/v1/channels/general/activity", "", body, 401)
	}
	messageID := message["id"].(string)
	for _, kind := range []string{"inbox.offered", "inbox.accepted"} {
		in := nativeInput(kind, kind)
		in.MessageID = &messageID
		f.expect("POST", "/v1/channels/general/activity", "claude-pilot", in, 404) // author is not recipient
		f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 201)
	}
	if after := f.snapshot(`SELECT json_build_object('principals',(SELECT json_agg(p ORDER BY id) FROM principals p),'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r))::text`); after != before {
		t.Fatal("native activity altered heartbeat/lease/legacy delivery receipts")
	}
	workspaceExpectChanged(t, viewerRevision, workspaceTestRevision(t, f, "viewer-pilot"), "native activity")
	workspaceExpectSame(t, hiddenRevision, workspaceTestRevision(t, f, "deny-pilot"), "hidden native activity")
	events := f.expect("GET", "/v1/channels/general/events", "viewer-pilot", nil, 200)["events"].([]any)
	if events[len(events)-1].(map[string]any)["kind"] != "native.activity" {
		t.Fatal("no channel event pointer")
	}
}

func TestNativeActivityStrictBodyAndInboxChannelBinding(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	base := `{"client_id":"strict","session_id":"session","runtime":"codex","event_type":"turn.started"}`
	for _, body := range []string{
		strings.TrimSuffix(base, "}") + `,"prompt":"private"}`,
		strings.TrimSuffix(base, "}") + `,"actor_id":"codex-pilot"}`,
		strings.TrimSuffix(base, "}") + `,"client_id":"duplicate"}`,
		strings.Replace(base, `"runtime"`, `"Runtime"`, 1),
		strings.TrimSuffix(base, "}") + `,"payload":{"command":"private"}}`,
		`[]`, base + base,
	} {
		req, _ := http.NewRequest("POST", f.server.URL+"/v1/channels/general/activity", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+f.keys["codex-pilot"])
		req.Header.Set("Content-Type", "application/json")
		response, err := f.server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 400 {
			t.Fatalf("strict body accepted status %d", response.StatusCode)
		}
	}
	f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": "native-side", "project_id": "pilot", "name": "side"}, 201)
	for _, actor := range []string{"codex-pilot", "claude-pilot"} {
		f.access(actor, "channel", "native-side", "write", 200)
	}
	message := f.expect("POST", "/v1/channels/native-side/messages", "claude-pilot", map[string]any{"client_id": "other-channel", "body": "private", "recipient_ids": []string{"codex-pilot"}}, 201)["message"].(map[string]any)["id"].(string)
	in := nativeInput("wrong-channel", "inbox.accepted")
	in.MessageID = &message
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 404)
	f.expect("POST", "/v1/channels/native-side/activity", "codex-pilot", in, 201)
	f.expect("GET", "/v1/channels/native-side/activity", "viewer-pilot", nil, 404)
	for _, query := range []string{"?after_seq=-1", "?after_seq=invalid", "?limit=0", "?limit=no"} {
		f.expect("GET", "/v1/channels/general/activity"+query, "viewer-pilot", nil, 400)
	}
}

func TestNativeActivityConcurrentReplayPagingAndQuota(t *testing.T) {
	f := newFixture(t)
	in := nativeInput("concurrent", "turn.started")
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, result := f.request("POST", "/v1/channels/general/activity", "codex-pilot", in)
			if status != 200 && status != 201 {
				t.Errorf("concurrent status %d", status)
				return
			}
			ids <- result["activity"].(map[string]any)["id"].(string)
		}()
	}
	wg.Wait()
	close(ids)
	first := ""
	for id := range ids {
		if first != "" && first != id {
			t.Fatal("concurrent duplicate records")
		}
		first = id
	}
	f.expect("POST", "/v1/channels/general/activity", "claude-pilot", in, 201) // actor-scoped idempotency
	f.expect("POST", "/v1/channels/isolated/activity", "deny-pilot", in, 201)
	page := f.expect("GET", "/v1/channels/general/activity?limit=1", "viewer-pilot", nil, 200)
	if len(page["activity"].([]any)) != 1 || page["has_more"] != true || page["next_after_seq"] != float64(1) {
		t.Fatal("first activity page invalid")
	}
	page = f.expect("GET", "/v1/channels/general/activity?after_seq=1&limit=1", "viewer-pilot", nil, 200)
	if len(page["activity"].([]any)) != 1 || page["has_more"] != false || page["next_after_seq"] != float64(2) {
		t.Fatal("local cursor leaked other channel sequence")
	}
	empty := f.expect("GET", "/v1/channels/general/activity?after_seq=2", "viewer-pilot", nil, 200)
	if len(empty["activity"].([]any)) != 0 || empty["next_after_seq"] != float64(2) {
		t.Fatal("empty cursor incorrect")
	}
	// Test-only SQL avoids 10k HTTP requests; canonical first replay remains valid.
	_, err := f.s.Pool.Exec(context.Background(), `INSERT INTO native_activity(id,channel_id,seq,actor_id,client_id,session_id,runtime,event_type,request_hash)
 SELECT 'quota-'||n,'general',n,'codex-pilot','quota-'||n,'session','codex','agent.waiting',decode('00','hex') FROM generate_series(3,10000) n;
 UPDATE channels SET cursor=10000 WHERE id='general'`)
	if err != nil {
		t.Fatal(err)
	}
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", nativeInput("over-quota", "agent.waiting"), 409)
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 200)
	page = f.expect("GET", "/v1/channels/general/activity?limit=500", "viewer-pilot", nil, 200)
	if len(page["activity"].([]any)) != 100 || page["has_more"] != true {
		t.Fatal("page cap not enforced")
	}
}

func TestNativeActivityFreshACLRevocationAndMigration(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	in := nativeInput("preserve", "tool.completed")
	tool := "Read"
	in.ToolName = &tool
	created := f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 201)["activity"]
	for i := 0; i < 2; i++ {
		if err := f.s.Migrate(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	page := f.expect("GET", "/v1/channels/general/activity", "owner", nil, 200)
	a, _ := json.Marshal(created)
	b, _ := json.Marshal(page["activity"].([]any)[0])
	if string(a) != string(b) {
		t.Fatal("migration changed activity")
	}
	f.access("codex-pilot", "channel", "general", "read", 200)
	f.expect("GET", "/v1/channels/general/activity", "codex-pilot", nil, 200)
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 404) // even identical replay needs current write ACL
	f.access("codex-pilot", "channel", "general", "none", 200)
	f.expect("GET", "/v1/channels/general/activity", "codex-pilot", nil, 404)
	f.access("codex-pilot", "channel", "general", "write", 200)
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 200)
	f.expect("POST", "/v1/admin/principals/codex-pilot/revoke-key", "owner", map[string]any{}, 200)
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 401)
	f.expect("GET", "/v1/channels/general/activity", "codex-pilot", nil, 401)
}

func TestNativeActivityArchiveRestoreAndHardDelete(t *testing.T) {
	f, message := lifecycleFixture(t)
	in := nativeInput("lifecycle", "inbox.accepted")
	in.MessageID = &message
	f.expect("POST", "/v1/channels/"+lifecycleChannel+"/activity", "codex-pilot", in, 201)
	before := f.snapshot(`SELECT json_agg(n ORDER BY id)::text FROM native_activity n`)
	f.lifecycle("archive", 200)
	for _, actor := range []string{"codex-pilot", "viewer-pilot"} {
		f.expect("GET", "/v1/channels/"+lifecycleChannel+"/activity", actor, nil, 404)
	}
	f.expect("GET", "/v1/channels/"+lifecycleChannel+"/activity", "owner", nil, 200)
	f.expect("POST", "/v1/channels/"+lifecycleChannel+"/activity", "codex-pilot", in, 404)
	f.lifecycle("restore", 200)
	if before != f.snapshot(`SELECT json_agg(n ORDER BY id)::text FROM native_activity n`) {
		t.Fatal("archive changed activity")
	}
	f.expect("POST", "/v1/channels/"+lifecycleChannel+"/activity", "codex-pilot", in, 200)
	f.lifecycle("archive", 200)
	preview := f.preview()
	if preview["counts"].(map[string]any)["native_activity"] != float64(1) {
		t.Fatal("deletion preview omitted native activity")
	}
	version := preview["project"].(map[string]any)["lifecycle_version"]
	f.deletion(version, 200)
	var count int
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM native_activity`).Scan(&count); err != nil || count != 0 {
		t.Fatal("project deletion retained native activity")
	}
	f.expect("GET", fmt.Sprintf("/v1/channels/%s/activity", lifecycleChannel), "owner", nil, 404)
}
