package link

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func newSessionFixture(t *testing.T) *fixture {
	t.Helper()
	f := newFixture(t)
	if _, err := f.s.Pool.Exec(context.Background(), sessionsSchema); err != nil {
		t.Fatal(err)
	}
	s := &Server{Store: f.s}
	mux := http.NewServeMux()
	s.sessionRoutes(mux)
	mux.Handle("/", s.Handler())
	srv := httptest.NewServer(s.authenticate(mux))
	f.server.Close()
	f.server = srv
	t.Cleanup(srv.Close)
	return f
}

func sessionInput(id string) map[string]any {
	return map[string]any{"session_id": id, "channel_id": "general", "run_id": "run-1", "task_role": "writer",
		"runtime": "codex", "model": "", "activity": "bounded task", "ttl_seconds": 30, "max_duration_seconds": 300}
}

func sessionItems(f *fixture, agent string) []any {
	return f.expect("GET", "/v1/projects/pilot/sessions", agent, nil, 200)["sessions"].([]any)
}

func TestSessionsIndependentLegacyLeaseAndReceipts(t *testing.T) {
	f := newSessionFixture(t)
	f.heartbeat("codex-pilot", "legacy-listener")
	var before, after string
	query := `SELECT row_to_json(p)::text FROM principals p WHERE id='codex-pilot'`
	if err := f.s.Pool.QueryRow(context.Background(), query).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"writer-session", "review-session"} {
		f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", sessionInput(id), 201)
	}
	f.expect("POST", "/v1/projects/pilot/sessions/writer-session/renew", "codex-pilot", map[string]any{"activity": "still bounded"}, 200)
	f.expect("POST", "/v1/projects/pilot/sessions/review-session/close", "codex-pilot", map[string]any{}, 200)
	if err := f.s.Pool.QueryRow(context.Background(), query).Scan(&after); err != nil || before != after {
		t.Fatal("execution presence changed legacy principal lease")
	}
	m := f.message("legacy-with-execution-sessions", "claude-pilot")
	path := "/v1/messages/" + m["id"].(string) + "/receipts"
	f.expect("POST", path, "codex-pilot", map[string]any{"session_id": "writer-session", "status": "delivered"}, 409)
	f.expect("POST", path, "codex-pilot", map[string]any{"session_id": "legacy-listener", "status": "delivered"}, 200)
	f.expect("POST", path, "codex-pilot", map[string]any{"session_id": "legacy-listener", "status": "accepted"}, 200)
	if len(sessionItems(f, "viewer-pilot")) != 2 {
		t.Fatal("independent sessions not visible")
	}
}

func TestSessionsIdempotencyCannotExtendOrResurrect(t *testing.T) {
	f := newSessionFixture(t)
	input := sessionInput("stable-session")
	first := f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", input, 201)
	second := f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", input, 200)
	if second["replayed"] != true || !reflect.DeepEqual(first["session"], second["session"]) {
		t.Fatal("exact replay changed session")
	}
	input["task_role"] = "reviewer"
	f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", input, 409)
	input["task_role"] = "writer"
	closed := f.expect("POST", "/v1/projects/pilot/sessions/stable-session/close", "codex-pilot", map[string]any{}, 200)
	again := f.expect("POST", "/v1/projects/pilot/sessions/stable-session/close", "codex-pilot", map[string]any{}, 200)
	if !reflect.DeepEqual(closed, again) {
		t.Fatal("close is not idempotent")
	}
	replay := f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", input, 200)["session"].(map[string]any)
	if replay["freshness"] != "closed" || replay["closed_at"] == nil {
		t.Fatal("create replay resurrected closed session")
	}
	f.expect("POST", "/v1/projects/pilot/sessions/stable-session/renew", "codex-pilot", map[string]any{}, 409)
}

func TestSessionsVisibilityAndCurrentACL(t *testing.T) {
	f := newSessionFixture(t)
	f.owner("owner")
	ctx := context.Background()
	_, err := f.s.Pool.Exec(ctx, `INSERT INTO channels(id,project_id,name) VALUES('secret','pilot','private');
 INSERT INTO channel_members(channel_id,agent_id,can_write) VALUES('secret','codex-pilot',true)`)
	if err != nil {
		t.Fatal(err)
	}
	input := sessionInput("private-session")
	input["channel_id"] = "secret"
	f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", input, 201)
	if len(sessionItems(f, "viewer-pilot")) != 0 || len(sessionItems(f, "claude-pilot")) != 0 {
		t.Fatal("hidden channel session leaked")
	}
	if len(sessionItems(f, "codex-pilot")) != 1 || len(sessionItems(f, "owner")) != 1 {
		t.Fatal("authorized session missing")
	}
	f.expect("GET", "/v1/projects/pilot/sessions", "deny-pilot", nil, 404)
	f.expect("POST", "/v1/projects/pilot/sessions", "viewer-pilot", input, 404)
	f.expect("POST", "/v1/projects/pilot/sessions", "owner", input, 404)
	f.expect("POST", "/v1/projects/isolated/sessions", "codex-pilot", input, 404)
	f.expect("POST", "/v1/projects/pilot/sessions/private-session/close", "claude-pilot", map[string]any{}, 404)
	f.access("codex-pilot", "channel", "secret", "none", 200)
	f.expect("POST", "/v1/projects/pilot/sessions/private-session/renew", "codex-pilot", map[string]any{}, 404)
	if sessionItems(f, "owner")[0].(map[string]any)["freshness"] != "stale" {
		t.Fatal("revoked channel did not invalidate presence")
	}
}

func TestSessionsExpiryDeadlineAndRevocation(t *testing.T) {
	f := newSessionFixture(t)
	ctx := context.Background()
	f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", sessionInput("expiring"), 201)
	if !sessionLive(ctx, f.s.Pool, "pilot", "general", "codex-pilot", "expiring") {
		t.Fatal("fresh session not live")
	}
	if _, err := f.s.Pool.Exec(ctx, `UPDATE execution_sessions SET deadline_at=clock_timestamp()+interval '5 seconds',expires_at=clock_timestamp()+interval '4 seconds' WHERE session_id='expiring'`); err != nil {
		t.Fatal(err)
	}
	value := f.expect("POST", "/v1/projects/pilot/sessions/expiring/renew", "codex-pilot", map[string]any{}, 200)["session"].(map[string]any)
	expires, err := time.Parse(time.RFC3339Nano, value["expires_at"].(string))
	if err != nil {
		t.Fatal(err)
	}
	deadline, err := time.Parse(time.RFC3339Nano, value["deadline_at"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if expires.After(deadline) {
		t.Fatal("renewal escaped hard deadline")
	}
	if _, err := f.s.Pool.Exec(ctx, `UPDATE execution_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id='expiring'`); err != nil {
		t.Fatal(err)
	}
	f.expect("POST", "/v1/projects/pilot/sessions/expiring/renew", "codex-pilot", map[string]any{}, 409)
	if sessionLive(ctx, f.s.Pool, "pilot", "general", "codex-pilot", "expiring") {
		t.Fatal("expired session still live")
	}
	f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", sessionInput("revoked"), 201)
	if err := f.s.Revoke(ctx, "codex-pilot"); err != nil {
		t.Fatal(err)
	}
	f.expect("POST", "/v1/projects/pilot/sessions/revoked/renew", "codex-pilot", map[string]any{}, 401)
	if sessionLive(ctx, f.s.Pool, "pilot", "general", "codex-pilot", "revoked") {
		t.Fatal("revoked account session live")
	}
}

func TestSessionsActiveBudgetAndMigration(t *testing.T) {
	f := newSessionFixture(t)
	for i := 0; i < 8; i++ {
		f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", sessionInput(fmt.Sprintf("session-%d", i)), 201)
	}
	f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", sessionInput("session-8"), 409)
	f.expect("POST", "/v1/projects/pilot/sessions/session-0/close", "codex-pilot", map[string]any{}, 200)
	f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", sessionInput("session-8"), 201)
	before := sessionItems(f, "viewer-pilot")
	for i := 0; i < 2; i++ {
		if _, err := f.s.Pool.Exec(context.Background(), sessionsSchema); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(before, sessionItems(f, "viewer-pilot")) {
		t.Fatal("migration changed session records")
	}
}

func TestSessionInputValidation(t *testing.T) {
	valid := sessionCreateInput{SessionID: "session-1", ChannelID: "general", RunID: "run-1", TaskRole: "writer", Runtime: "codex", TTLSeconds: 30, MaxDurationSeconds: 300}
	if !validSessionCreate(valid) {
		t.Fatal("valid session rejected")
	}
	for _, mutate := range []func(*sessionCreateInput){
		func(in *sessionCreateInput) { in.TaskRole = "owner" }, func(in *sessionCreateInput) { in.TTLSeconds = 9 },
		func(in *sessionCreateInput) { in.TTLSeconds = 121 }, func(in *sessionCreateInput) { in.MaxDurationSeconds = 3601 },
		func(in *sessionCreateInput) { in.SessionID = "../x" }, func(in *sessionCreateInput) { in.RunID = "" },
		func(in *sessionCreateInput) { in.Model = "\x00" }, func(in *sessionCreateInput) { in.Activity = "\xff" },
	} {
		in := valid
		mutate(&in)
		if validSessionCreate(in) {
			t.Fatal("invalid session accepted")
		}
	}
}
