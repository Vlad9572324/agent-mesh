package link

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type fixture struct {
	t           *testing.T
	s           *Store
	server      *httptest.Server
	keys        map[string]string
	credentials string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dsn := os.Getenv("AGENT_LINK_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("AGENT_LINK_TEST_DATABASE_URL not set; isolated real PostgreSQL integration test skipped")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal("cannot connect to test database")
	}
	suffix, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	schemaName := "agent_link_test_" + suffix
	quoted := pgx.Identifier{schemaName}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		admin.Close(ctx)
		t.Fatal("cannot create isolated test schema")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid test database configuration")
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schemaName
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "5000"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("test pool failed")
	}
	s := &Store{Pool: pool}
	t.Cleanup(func() { pool.Close(); _, _ = admin.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE"); _ = admin.Close(ctx) })
	if err = s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	credsPath := filepath.Join(t.TempDir(), "credentials.json")
	if err = s.Bootstrap(ctx, credsPath); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(credsPath)
	if err != nil {
		t.Fatal(err)
	}
	var creds Credentials
	if json.Unmarshal(b, &creds) != nil {
		t.Fatal("invalid credentials JSON")
	}
	srv := httptest.NewServer((&Server{Store: s}).Handler())
	t.Cleanup(srv.Close)
	return &fixture{t: t, s: s, server: srv, keys: creds.Keys, credentials: credsPath}
}
func (f *fixture) request(method, path, agent string, body any) (int, map[string]any) {
	f.t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, f.server.URL+path, bytes.NewReader(data))
	if err != nil {
		f.t.Fatal(err)
	}
	if agent != "" {
		req.Header.Set("Authorization", "Bearer "+f.keys[agent])
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := f.server.Client().Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	var decoded map[string]any
	if err = json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		f.t.Fatalf("response status %d is not JSON: %v", resp.StatusCode, err)
	}
	return resp.StatusCode, decoded
}
func (f *fixture) expect(method, path, agent string, body any, want int) map[string]any {
	f.t.Helper()
	status, result := f.request(method, path, agent, body)
	if status != want {
		f.t.Fatalf("%s %s: status %d want %d: %v", method, path, status, want, result)
	}
	return result
}
func (f *fixture) heartbeat(agent, session string) {
	f.t.Helper()
	f.expect("POST", "/v1/heartbeat", agent, map[string]any{"session_id": session, "activity": "test", "runtime": "test"}, 200)
}
func (f *fixture) message(client, author string) map[string]any {
	f.t.Helper()
	return f.expect("POST", "/v1/channels/general/messages", author, map[string]any{"client_id": client, "body": "hello", "recipient_ids": []string{"codex-pilot"}}, 201)["message"].(map[string]any)
}

func TestValidation(t *testing.T) {
	for _, id := range []string{"general", "a:b_1.2-c", "A"} {
		if !validID(id) {
			t.Errorf("valid id rejected: %s", id)
		}
	}
	for _, id := range []string{"", "../x", "a/b", "a b", strings.Repeat("a", 129), "x\n"} {
		if validID(id) {
			t.Errorf("invalid id accepted: %q", id)
		}
	}
	if validText("\x00", 20) || validText("", 20) || validText("123", 2) || validText("\xff", 10) {
		t.Error("invalid text accepted")
	}
	if fresh(nil, time.Now()) != "unknown" {
		t.Error("missing heartbeat must remain unknown")
	}
	now := time.Now()
	old := now.Add(-31 * time.Second)
	if fresh(&old, now) != "stale" {
		t.Error("old heartbeat must be stale")
	}
}
func TestStrictJSON(t *testing.T) {
	for _, body := range []string{`{"field":"ok","extra":1}`, `{"field":"ok"} {}`, `{"field":"first","field":"second"}`, `{"Field":"case alias"}`, `null`, `{broken`, strings.Repeat("x", maxBody+1)} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		var v struct {
			Field string `json:"field"`
		}
		if decode(w, r, &v) {
			t.Errorf("invalid JSON accepted: %.50s", body)
		}
	}
}
func TestPrivateJSONNoOverwrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key.json")
	if err := AtomicPrivateJSON(path, map[string]string{"key": "first"}, false); err != nil {
		t.Fatal(err)
	}
	if err := AtomicPrivateJSON(path, map[string]string{"key": "second"}, false); err == nil {
		t.Fatal("existing credential file was overwritten")
	}
	b, _ := os.ReadFile(path)
	if !bytes.Contains(b, []byte("first")) {
		t.Fatal("credential content changed")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("credential file is not 0600")
	}
}
func TestAuthAndAccess(t *testing.T) {
	f := newFixture(t)
	f.expect("GET", "/healthz", "", nil, 200)
	f.expect("GET", "/v1/me", "", nil, 401)
	f.expect("GET", "/v1/projects/pilot/channels", "deny-pilot", nil, 404)
	f.expect("GET", "/v1/channels/general/messages", "deny-pilot", nil, 404)
	projects := f.expect("GET", "/v1/projects", "deny-pilot", nil, 200)["projects"].([]any)
	if len(projects) != 1 || projects[0].(map[string]any)["id"] != "isolated" {
		t.Fatal("project visibility leak")
	}
	f.expect("POST", "/v1/channels/general/messages", "viewer-pilot", map[string]any{}, 404)
	f.expect("POST", "/v1/heartbeat", "viewer-pilot", map[string]any{}, 404)
	channels := f.expect("GET", "/v1/projects/pilot/channels", "viewer-pilot", nil, 200)["channels"].([]any)
	if channels[0].(map[string]any)["can_write"] != false {
		t.Fatal("viewer has write access")
	}
	agents := f.expect("GET", "/v1/projects/pilot/agents", "claude-pilot", nil, 200)["agents"].([]any)
	if len(agents) != 3 {
		t.Fatal("agent visibility mismatch")
	}
	for _, a := range agents {
		if a.(map[string]any)["freshness"] != "unknown" {
			t.Fatal("invented heartbeat freshness")
		}
	}
	f.expect("GET", "/v1/channels/general/messages?after_seq=-1", "viewer-pilot", nil, 400)
	f.expect("GET", "/v1/channels/general/events?after=broken", "viewer-pilot", nil, 400)
}
func TestMessageIdempotencyAndBoundaries(t *testing.T) {
	f := newFixture(t)
	in := map[string]any{"client_id": "one", "body": "hello", "recipient_ids": []string{"codex-pilot"}}
	first := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", in, 201)
	m := first["message"].(map[string]any)
	id := m["id"].(string)
	receipt := m["receipts"].([]any)[0].(map[string]any)
	if receipt["delivered_at"] != nil || receipt["accepted_at"] != nil || receipt["uncertain_at"] != nil {
		t.Fatal("invented receipts")
	}
	retry := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", in, 200)
	if retry["replayed"] != true || retry["message"].(map[string]any)["id"] != id {
		t.Fatal("idempotent replay mismatch")
	}
	in["body"] = "different"
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", in, 409)
	in["client_id"] = "cross-recipient"
	in["recipient_ids"] = []string{"deny-pilot"}
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", in, 404)
	in["recipient_ids"] = []string{"codex-pilot", "codex-pilot"}
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", in, 400)
	in["recipient_ids"] = []string{"viewer-pilot"}
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", in, 400)
	in["recipient_ids"] = []string{}
	in["channel_only"] = true
	in["reply_to"] = "nonexistent"
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", in, 404)
	f.expect("GET", "/v1/messages/"+id, "deny-pilot", nil, 404)
	f.expect("GET", "/v1/messages/"+id, "viewer-pilot", nil, 200)
	events := f.expect("GET", "/v1/channels/general/events", "viewer-pilot", nil, 200)["events"].([]any)
	if len(events) != 1 {
		t.Fatal("failed writes or duplicates emitted events")
	}
	if _, ok := events[0].(map[string]any)["body"]; ok {
		t.Fatal("event must contain pointer only")
	}
}
func TestReceiptSessionFencing(t *testing.T) {
	f := newFixture(t)
	id := f.message("receipt", "claude-pilot")["id"].(string)
	path := "/v1/messages/" + id + "/receipts"
	ack := map[string]any{"status": "delivered", "session_id": "codex-one"}
	f.expect("POST", path, "codex-pilot", ack, 409)
	f.heartbeat("codex-pilot", "codex-one")
	f.expect("POST", "/v1/heartbeat", "codex-pilot", map[string]any{"session_id": "codex-two", "activity": "", "runtime": "test"}, 409)
	ack["status"] = "accepted"
	f.expect("POST", path, "codex-pilot", ack, 409)
	ack["status"] = "delivered"
	first := f.expect("POST", path, "codex-pilot", ack, 200)
	again := f.expect("POST", path, "codex-pilot", ack, 200)
	getReceipt := func(v map[string]any) map[string]any {
		return v["message"].(map[string]any)["receipts"].([]any)[0].(map[string]any)
	}
	if getReceipt(first)["delivered_at"] != getReceipt(again)["delivered_at"] {
		t.Fatal("duplicate ack changed timestamp")
	}
	ack["session_id"] = "codex-two"
	f.expect("POST", path, "codex-pilot", ack, 409)
	ack["session_id"] = "codex-one"
	ack["status"] = "accepted"
	f.expect("POST", path, "codex-pilot", ack, 200)
	ack["status"] = "uncertain"
	f.expect("POST", path, "codex-pilot", ack, 200)
	f.expect("POST", path, "codex-pilot", ack, 200)
	ack["status"] = "accepted"
	f.expect("POST", path, "codex-pilot", ack, 409)
	f.heartbeat("claude-pilot", "claude-one")
	ack["session_id"] = "claude-one"
	f.expect("POST", path, "claude-pilot", ack, 404)
	if _, err := f.s.Pool.Exec(context.Background(), "UPDATE principals SET last_seen_at=clock_timestamp()-interval '31 seconds' WHERE id='codex-pilot'"); err != nil {
		t.Fatal(err)
	}
	f.heartbeat("codex-pilot", "codex-two")
	ack["session_id"] = "codex-one"
	ack["status"] = "uncertain"
	f.expect("POST", path, "codex-pilot", ack, 409)
	events := f.expect("GET", "/v1/channels/general/events", "viewer-pilot", nil, 200)["events"].([]any)
	if len(events) != 4 {
		t.Fatalf("expected message plus 3 state changes, got %d", len(events))
	}
}
func TestNotesAndRestrictedSources(t *testing.T) {
	f := newFixture(t)
	if empty := f.expect("GET", "/v1/projects/pilot/notes", "viewer-pilot", nil, 200); empty["truncated"] != false {
		t.Fatal("empty notes window must not be truncated")
	}
	message := f.message("note-source", "claude-pilot")
	in := map[string]any{"client_id": "note-one", "title": "Решение", "body": "Published context", "source_message_id": message["id"]}
	n := f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", in, 201)["note"].(map[string]any)
	if n["version"] != float64(1) {
		t.Fatal("wrong note version")
	}
	f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", in, 200)
	in["body"] = "changed"
	f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", in, 409)
	f.expect("GET", "/v1/projects/pilot/notes", "deny-pilot", nil, 404)
	f.expect("POST", "/v1/projects/pilot/notes", "viewer-pilot", in, 404)
	_, err := f.s.Pool.Exec(context.Background(), `INSERT INTO channels(id,project_id,name) VALUES('restricted','pilot','restricted'); INSERT INTO channel_members VALUES('restricted','claude-pilot',true)`)
	if err != nil {
		t.Fatal(err)
	}
	private := f.expect("POST", "/v1/channels/restricted/messages", "claude-pilot", map[string]any{"client_id": "restricted-source", "body": "private", "recipient_ids": []string{}, "channel_only": true}, 201)["message"].(map[string]any)
	in["client_id"] = "note-restricted"
	in["source_message_id"] = private["id"]
	f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", in, 400)
	f.expect("GET", "/v1/messages/"+private["id"].(string), "viewer-pilot", nil, 404)
	events := f.expect("GET", "/v1/channels/general/events", "viewer-pilot", nil, 200)["events"].([]any)
	if len(events) != 1 {
		t.Fatal("notes incorrectly mixed with channel events")
	}
}

func TestLatestNotesWindowIncludesPublication1001(t *testing.T) {
	f := newFixture(t)
	_, err := f.s.Pool.Exec(context.Background(), `
		INSERT INTO notes(id,project_id,author_id,client_id,title,body,payload_hash,created_at)
		SELECT md5(n::text),'pilot','claude-pilot','seed-' || n::text,'Seed note','fixture',$1,
		       '2020-01-01T00:00:00Z'::timestamptz + n * interval '1 second'
		FROM generate_series(1,1000) AS n`, digest("fixture"))
	if err != nil {
		t.Fatal(err)
	}
	before := f.expect("GET", "/v1/projects/pilot/notes", "viewer-pilot", nil, 200)
	if before["truncated"] != false || len(before["notes"].([]any)) != 1000 {
		t.Fatal("exactly 1,000 notes must fit without truncation")
	}
	oldestID := before["notes"].([]any)[0].(map[string]any)["id"]
	secondID := before["notes"].([]any)[1].(map[string]any)["id"]
	latest := f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", map[string]any{
		"client_id": "publication-1001", "title": "Newest publication", "body": "Must remain visible",
	}, 201)["note"].(map[string]any)
	after := f.expect("GET", "/v1/projects/pilot/notes", "viewer-pilot", nil, 200)
	notes := after["notes"].([]any)
	if after["truncated"] != true || len(notes) != 1000 {
		t.Fatal("notes window must be bounded and report truncation")
	}
	if notes[0].(map[string]any)["id"] != secondID || notes[len(notes)-1].(map[string]any)["id"] != latest["id"] {
		t.Fatal("latest window must omit oldest and retain newest in chronological order")
	}
	for _, note := range notes {
		if note.(map[string]any)["id"] == oldestID {
			t.Fatal("oldest note leaked into newest window")
		}
	}
	var count int
	if err := f.s.Pool.QueryRow(context.Background(), "SELECT count(*) FROM notes WHERE project_id='pilot'").Scan(&count); err != nil || count != 1001 {
		t.Fatal("window must preserve all persisted notes")
	}
}

func TestPendingDeliveryRecoversAcrossSessions(t *testing.T) {
	f := newFixture(t)
	id := f.message("recover-delivery", "claude-pilot")["id"].(string)
	path := "/v1/messages/" + id + "/receipts"
	f.heartbeat("codex-pilot", "before-restart")
	ack := map[string]any{"status": "delivered", "session_id": "before-restart"}
	first := f.expect("POST", path, "codex-pilot", ack, 200)["message"].(map[string]any)["receipts"].([]any)[0].(map[string]any)
	expire := func() {
		if _, err := f.s.Pool.Exec(context.Background(), "UPDATE principals SET last_seen_at=clock_timestamp()-interval '31 seconds' WHERE id='codex-pilot'"); err != nil {
			t.Fatal(err)
		}
	}
	expire()
	f.heartbeat("codex-pilot", "after-restart")
	ack["session_id"] = "after-restart"
	ack["status"] = "accepted"
	f.expect("POST", path, "codex-pilot", ack, 409)
	ack["status"] = "delivered"
	recovered := f.expect("POST", path, "codex-pilot", ack, 200)["message"].(map[string]any)["receipts"].([]any)[0].(map[string]any)
	if recovered["delivered_at"] != first["delivered_at"] || recovered["session_id"] != "after-restart" {
		t.Fatal("queued recovery must preserve first delivery and rebind the session")
	}
	ack["status"] = "accepted"
	f.expect("POST", path, "codex-pilot", ack, 200)
	expire()
	f.heartbeat("codex-pilot", "third-session")
	ack["session_id"] = "third-session"
	ack["status"] = "delivered"
	f.expect("POST", path, "codex-pilot", ack, 409)
	ack["status"] = "uncertain"
	f.expect("POST", path, "codex-pilot", ack, 200)
	ack["status"] = "accepted"
	f.expect("POST", path, "codex-pilot", ack, 409)
}
func TestConcurrentOrderedJournal(t *testing.T) {
	f := newFixture(t)
	const n = 24
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body, _ := json.Marshal(map[string]any{"client_id": fmt.Sprintf("concurrent-%d", i), "body": "concurrent", "recipient_ids": []string{"codex-pilot"}})
			req, _ := http.NewRequest("POST", f.server.URL+"/v1/channels/general/messages", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+f.keys["claude-pilot"])
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				errs <- err
				return
			}
			defer resp.Body.Close()
			io.Copy(io.Discard, resp.Body)
			if resp.StatusCode != 201 {
				errs <- fmt.Errorf("concurrent post status %d", resp.StatusCode)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	events := f.expect("GET", "/v1/channels/general/events?limit=10000", "viewer-pilot", nil, 200)["events"].([]any)
	if len(events) != n {
		t.Fatalf("got %d events", len(events))
	}
	for i, e := range events {
		if e.(map[string]any)["seq"] != float64(i+1) {
			t.Fatal("journal order has gap")
		}
	}
	cursor := float64(0)
	count := 0
	for {
		result := f.expect("GET", fmt.Sprintf("/v1/channels/general/events?after=%.0f&limit=5", cursor), "viewer-pilot", nil, 200)
		batch := result["events"].([]any)
		if len(batch) == 0 {
			break
		}
		cursor = result["cursor"].(float64)
		count += len(batch)
	}
	if count != n {
		t.Fatal("cursor pagination lost events")
	}
}
func TestBootstrapAndKeyLifecycle(t *testing.T) {
	f := newFixture(t)
	m := f.message("persistent", "claude-pilot")
	before, _ := os.ReadFile(f.credentials)
	if err := f.s.Bootstrap(context.Background(), f.credentials); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(f.credentials)
	if !bytes.Equal(before, after) {
		t.Fatal("bootstrap rotated keys")
	}
	f.expect("GET", "/v1/messages/"+m["id"].(string), "viewer-pilot", nil, 200)
	var hash []byte
	if err := f.s.Pool.QueryRow(context.Background(), "SELECT key_hash FROM principals WHERE id='codex-pilot'").Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if len(hash) != 32 || bytes.Contains(hash, []byte(f.keys["codex-pilot"])) {
		t.Fatal("key not hashed")
	}
	out := filepath.Join(t.TempDir(), "rotated.json")
	if err := f.s.Rotate(context.Background(), "codex-pilot", out); err != nil {
		t.Fatal(err)
	}
	f.expect("GET", "/v1/me", "codex-pilot", nil, 401)
	b, _ := os.ReadFile(out)
	var creds map[string]string
	if json.Unmarshal(b, &creds) != nil {
		t.Fatal("invalid rotated credentials")
	}
	f.keys["codex-pilot"] = creds["key"]
	f.expect("GET", "/v1/me", "codex-pilot", nil, 200)
	if err := f.s.Revoke(context.Background(), "codex-pilot"); err != nil {
		t.Fatal(err)
	}
	f.expect("GET", "/v1/me", "codex-pilot", nil, 401)
}
func TestSSEReplaysAndRevocation(t *testing.T) {
	f := newFixture(t)
	f.message("sse", "claude-pilot")
	req, _ := http.NewRequest("GET", f.server.URL+"/v1/channels/general/stream?after=0", nil)
	req.Header.Set("Authorization", "Bearer "+f.keys["viewer-pilot"])
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("SSE status %d", resp.StatusCode)
	}
	first := make([]byte, 256)
	n, err := resp.Body.Read(first)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(first[:n], []byte("event: hint")) || !bytes.Contains(first[:n], []byte("id: 1")) {
		t.Fatalf("invalid SSE event: %s", first[:n])
	}
	if err = f.s.Revoke(context.Background(), "viewer-pilot"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err = io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal("stream did not close cleanly after revocation")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("stream revocation too slow")
	}
}

func TestStaticAllowlistAndHeaders(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"index.html", "app.js", "app.css", "credentials.json"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	handler := (&Server{WebDir: dir}).Handler()
	for _, path := range []string{"/", "/index.html", "/app.js", "/app.css"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		// net/http canonicalizes /index.html to /; either path exposes only the allowlist.
		if w.Code != 200 && !(path == "/index.html" && w.Code == 301) {
			t.Fatalf("static %s returned %d", path, w.Code)
		}
		if w.Header().Get("Content-Security-Policy") == "" || w.Header().Get("Access-Control-Allow-Origin") != "" || w.Header().Get("Strict-Transport-Security") != "" {
			t.Fatal("unexpected static security headers")
		}
	}
	for _, path := range []string{"/credentials.json", "/api-contract.json", "/internal/link/schema.sql", "/.git/config"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 404 {
			t.Fatalf("non-allowlisted %s returned %d", path, w.Code)
		}
	}
	if err := os.Remove(filepath.Join(dir, "app.js")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "credentials.json"), filepath.Join(dir, "app.js")); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/app.js", nil))
	if w.Code != 404 {
		t.Fatal("static symlink was served")
	}
}

func TestAuthenticationDatabaseOutageIsNotRevocation(t *testing.T) {
	f := newFixture(t)
	f.s.Pool.Close()
	f.expect("GET", "/v1/me", "viewer-pilot", nil, 503)
	f.expect("GET", "/v1/me", "", nil, 401)
	f.expect("GET", "/healthz", "", nil, 503)
}

func TestSSELastEventIDAndChannelRevocation(t *testing.T) {
	f := newFixture(t)
	f.message("stream-one", "claude-pilot")
	f.message("stream-two", "claude-pilot")
	req, _ := http.NewRequest("GET", f.server.URL+"/v1/channels/general/stream?after=0", nil)
	req.Header.Set("Authorization", "Bearer "+f.keys["viewer-pilot"])
	req.Header.Set("Last-Event-ID", "1")
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buffer := make([]byte, 512)
	n, err := resp.Body.Read(buffer)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(buffer[:n], []byte("id: 2\n")) || bytes.Contains(buffer[:n], []byte("id: 1\n")) {
		t.Fatal("SSE ignored Last-Event-ID")
	}
	if _, err = f.s.Pool.Exec(context.Background(), "DELETE FROM channel_members WHERE channel_id='general' AND agent_id='viewer-pilot'"); err != nil {
		t.Fatal(err)
	}
	if _, err = io.ReadAll(resp.Body); err != nil {
		t.Fatal("stream failed to close on channel membership revocation")
	}
	f.expect("GET", "/v1/channels/general/events", "viewer-pilot", nil, 404)
}
