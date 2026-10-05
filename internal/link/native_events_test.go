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
	for _, kind := range []string{"session.started", "session.ended", "turn.started", "turn.completed", "tool.started", "tool.completed", "tool.failed", "agent.waiting", "inbox.offered", "inbox.seen", "inbox.accepted"} {
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

func TestNativeActivitySeenMigrationPreservesHistory(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	message := f.message("seen-upgrade", "claude-pilot")
	messageID := message["id"].(string)
	offered := nativeInput("before-upgrade", "inbox.offered")
	offered.MessageID = &messageID
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", offered, 201)
	const snapshot = `SELECT json_build_object('activity',(SELECT json_agg(n ORDER BY id) FROM native_activity n),'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r))::text`
	before := f.snapshot(snapshot)
	// Restore the old checks with different names to cover PostgreSQL-generated
	// names as well as renamed constraints on an existing installation.
	_, err := f.s.Pool.Exec(ctx, `DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='native_activity'::regclass
 AND contype='c' AND pg_get_constraintdef(oid) LIKE '%inbox.offered%' LOOP
 EXECUTE format('ALTER TABLE native_activity DROP CONSTRAINT %I', c.conname);
 END LOOP; END $$;
 ALTER TABLE native_activity ADD CONSTRAINT old_native_enum CHECK(event_type IN
 ('session.started','session.ended','turn.started','turn.completed','tool.started','tool.completed','tool.failed','agent.waiting','inbox.offered','inbox.accepted'));
 ALTER TABLE native_activity ADD CONSTRAINT old_native_message CHECK((event_type IN ('inbox.offered','inbox.accepted')) = (message_id IS NOT NULL));`)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := f.s.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if after := f.snapshot(snapshot); after != before {
		t.Fatal("seen migration changed native history or legacy receipts")
	}
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", offered, 200)
	seen := nativeInput("after-upgrade", "inbox.seen")
	seen.MessageID = &messageID
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", seen, 201)
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", seen, 200)
	f.expect("POST", "/v1/channels/general/activity", "claude-pilot", seen, 404)
	if _, err := f.s.Pool.Exec(ctx, `UPDATE native_activity SET message_id=NULL WHERE event_type='inbox.seen'`); err == nil {
		t.Fatal("migration lost inbox message binding constraint")
	}
	if _, err := f.s.Pool.Exec(ctx, `UPDATE native_activity SET event_type='unknown' WHERE event_type='inbox.seen'`); err == nil {
		t.Fatal("migration lost event type constraint")
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
	for _, kind := range []string{"inbox.offered", "inbox.seen", "inbox.accepted"} {
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

func TestNativeDeliveryEvidenceHasItsOwnReserveWhenTelemetryQuotaIsFull(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	messageID := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", map[string]any{"client_id": "evidence-reserve", "body": "peer message", "recipient_ids": []string{"codex-pilot"}}, 201)["message"].(map[string]any)["id"].(string)
	fill := func(kind string, from, to int, withMessage bool) {
		t.Helper()
		message := "NULL"
		if withMessage {
			message = "'" + messageID + "'"
		}
		query := fmt.Sprintf(`INSERT INTO native_activity(id,channel_id,seq,actor_id,client_id,session_id,runtime,event_type,message_id,request_hash)
 SELECT '%[1]s-'||n,'general',n,'codex-pilot','%[1]s-'||n,'session','codex','%[1]s',%[4]s,decode('00','hex') FROM generate_series(%[2]d,%[3]d) n;
 UPDATE channels SET cursor=%[3]d WHERE id='general'`, kind, from, to, message)
		if _, err := f.s.Pool.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	// A telemetry flood fills its whole quota: further telemetry is refused...
	fill("agent.waiting", 1, 10000, false)
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", nativeInput("telemetry-over", "turn.started"), 409)
	// ...but delivery evidence is still recorded, so receipts and alerts keep working.
	for _, kind := range []string{"inbox.offered", "inbox.seen", "inbox.accepted"} {
		in := nativeInput("evidence-"+kind, kind)
		in.MessageID = &messageID
		f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 201)
	}
	receipts := f.expect("GET", "/v1/channels/general/native-receipts?message_id="+messageID, "viewer-pilot", nil, 200)["receipts"].([]any)
	if len(receipts) != 1 {
		t.Fatalf("expected one recipient receipt, got %d", len(receipts))
	}
	for _, field := range []string{"offered_at", "seen_at", "accepted_at"} {
		if receipts[0].(map[string]any)[field] == nil {
			t.Fatalf("receipt %s missing although its evidence was accepted", field)
		}
	}
	// Evidence has its own bound: once it is full, new evidence is refused too, replays still work.
	fill("inbox.offered", 10004, 20000, true) // 3 real + 9997 = the evidence quota
	over := nativeInput("evidence-over", "inbox.seen")
	over.MessageID = &messageID
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", over, 409)
	replay := nativeInput("evidence-inbox.seen", "inbox.seen")
	replay.MessageID = &messageID
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", replay, 200)
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", nativeInput("telemetry-still-over", "session.ended"), 409)
	var telemetry, evidence int
	if err := f.s.Pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE message_id IS NULL), count(*) FILTER (WHERE message_id IS NOT NULL) FROM native_activity WHERE channel_id='general'`).Scan(&telemetry, &evidence); err != nil {
		t.Fatal(err)
	}
	if telemetry != nativeActivityQuota || evidence != nativeEvidenceQuota {
		t.Fatalf("each class must stop exactly at its own quota, got telemetry=%d evidence=%d", telemetry, evidence)
	}
}
