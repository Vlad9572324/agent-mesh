package link

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func navigationItem(t *testing.T, result map[string]any, collection, id string) map[string]any {
	t.Helper()
	for _, v := range result[collection].([]any) {
		item := v.(map[string]any)
		if item["id"] == id {
			return item
		}
	}
	t.Fatalf("missing %s item %s", collection, id)
	return nil
}
func navigationGet(f *fixture, actor string) map[string]any {
	return f.expect("GET", "/v1/navigation", actor, nil, 200)
}
func navigationRead(f *fixture, actor, channel string, seq float64, status int) map[string]any {
	return f.expect("PUT", "/v1/channels/"+channel+"/read", actor, map[string]any{"through_seq": seq}, status)
}
func navigationMessage(f *fixture, actor, channel, id string) map[string]any {
	return f.expect("POST", "/v1/channels/"+channel+"/messages", actor, map[string]any{"client_id": id, "body": "Discussion", "recipient_ids": []string{}}, 201)["message"].(map[string]any)
}

func TestNavigationCountsMessagesNotJournalPositions(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	empty := navigationItem(t, navigationGet(f, "viewer-pilot"), "channels", "general")
	if empty["unread_messages"] != float64(0) || empty["latest_message_seq"] != float64(0) || empty["last_read_seq"] != float64(0) || empty["last_message_at"] != nil {
		t.Fatal("empty channel has invented progress or activity")
	}
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", nativeInput("nav-start", "session.started"), 201)
	first := f.message("navigation-first", "claude-pilot")
	f.heartbeat("codex-pilot", "navigation-session")
	f.expect("POST", "/v1/messages/"+first["id"].(string)+"/receipts", "codex-pilot", map[string]any{"session_id": "navigation-session", "status": "delivered"}, 200)
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", nativeInput("nav-tool", "tool.started"), 201)
	navigationMessage(f, "codex-pilot", "general", "navigation-own")
	last := navigationMessage(f, "claude-pilot", "general", "navigation-last")
	latest := last["seq"].(float64)
	if latest <= 3 {
		t.Fatal("fixture must contain journal gaps")
	}
	for actor, want := range map[string]float64{"viewer-pilot": 3, "owner": 3, "codex-pilot": 2, "claude-pilot": 1} {
		got := navigationGet(f, actor)
		channel := navigationItem(t, got, "channels", "general")
		project := navigationItem(t, got, "projects", "pilot")
		if channel["unread_messages"] != want || project["unread_messages"] != want || channel["latest_message_seq"] != latest || !navigationSameTime(channel["last_message_at"], last["created_at"]) || !navigationSameTime(project["last_message_at"], last["created_at"]) {
			t.Fatalf("wrong message count or activity for %s: %v", actor, got)
		}
	}
	navigationRead(f, "viewer-pilot", "general", first["seq"].(float64)+1, 409)
	navigationRead(f, "viewer-pilot", "general", first["seq"].(float64), 200)
	if navigationItem(t, navigationGet(f, "viewer-pilot"), "channels", "general")["unread_messages"] != float64(2) {
		t.Fatal("unread count subtracted journal positions")
	}
	navigationRead(f, "viewer-pilot", "general", latest, 200)
	lower := navigationRead(f, "viewer-pilot", "general", first["seq"].(float64), 200)
	if lower["last_read_seq"] != latest {
		t.Fatal("read cursor regressed")
	}
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", nativeInput("nav-after", "session.ended"), 201)
	navigationRead(f, "viewer-pilot", "general", latest+1, 409)
	channel := navigationItem(t, navigationGet(f, "viewer-pilot"), "channels", "general")
	if channel["unread_messages"] != float64(0) || !navigationSameTime(channel["last_message_at"], last["created_at"]) || channel["last_read_seq"] != latest {
		t.Fatal("telemetry changed read count or message activity")
	}
}

func TestNavigationMarkersArePrivateAndSeparateFromDelivery(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	message := f.message("private-read", "claude-pilot")
	seq := message["seq"].(float64)
	const journal = `SELECT json_build_object('receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r),'native',(SELECT json_agg(n ORDER BY id) FROM native_activity n),'events',(SELECT json_agg(e ORDER BY channel_id,seq) FROM events e),'channels',(SELECT json_agg(c ORDER BY id) FROM channels c))::text`
	before := f.snapshot(journal)
	viewer := workspaceTestRevision(t, f, "viewer-pilot")
	other := workspaceTestRevision(t, f, "claude-pilot")
	owner := workspaceTestRevision(t, f, "owner")
	navigationRead(f, "viewer-pilot", "general", seq, 200)
	next := workspaceTestRevision(t, f, "viewer-pilot")
	workspaceExpectChanged(t, viewer, next, "own read cursor")
	workspaceExpectSame(t, other, workspaceTestRevision(t, f, "claude-pilot"), "another principal read cursor")
	workspaceExpectSame(t, owner, workspaceTestRevision(t, f, "owner"), "another principal read cursor")
	navigationRead(f, "viewer-pilot", "general", seq, 200)
	navigationRead(f, "viewer-pilot", "general", 0, 200)
	workspaceExpectSame(t, next, workspaceTestRevision(t, f, "viewer-pilot"), "idempotent or lower cursor")
	navigationRead(f, "owner", "general", seq, 200)
	navigationRead(f, "codex-pilot", "general", seq, 200)
	if before != f.snapshot(journal) {
		t.Fatal("GUI reading changed receipts, native inbox or journal")
	}
	for _, actor := range []string{"viewer-pilot", "owner", "codex-pilot"} {
		item := navigationItem(t, navigationGet(f, actor), "channels", "general")
		if item["last_read_seq"] != seq || item["unread_messages"] != float64(0) {
			t.Fatal("per-principal marker missing")
		}
	}
}

func TestNavigationACLProjectTotalsAndArchivedOwner(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	visible := navigationMessage(f, "claude-pilot", "general", "visible-nav")
	f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": "private-nav", "project_id": "pilot", "name": "Private"}, 201)
	f.access("claude-pilot", "channel", "private-nav", "write", 200)
	private := navigationMessage(f, "claude-pilot", "private-nav", "private-nav-message")
	navigationMessage(f, "deny-pilot", "isolated", "hidden-nav-message")
	viewer := navigationGet(f, "viewer-pilot")
	if len(viewer["projects"].([]any)) != 1 || len(viewer["channels"].([]any)) != 1 {
		t.Fatal("navigation leaked hidden scope")
	}
	pilot := navigationItem(t, viewer, "projects", "pilot")
	if pilot["unread_messages"] != float64(1) || !navigationSameTime(pilot["last_message_at"], visible["created_at"]) {
		t.Fatal("project total/activity included private channel")
	}
	owner := navigationItem(t, navigationGet(f, "owner"), "projects", "pilot")
	if owner["unread_messages"] != float64(2) || !navigationSameTime(owner["last_message_at"], private["created_at"]) {
		t.Fatal("owner did not see authorized scope")
	}
	navigationRead(f, "viewer-pilot", "private-nav", private["seq"].(float64), 404)
	navigationRead(f, "viewer-pilot", "isolated", 1, 404)
	f.access("viewer-pilot", "channel", "general", "none", 200)
	empty := navigationGet(f, "viewer-pilot")
	if len(empty["channels"].([]any)) != 0 {
		t.Fatal("revoked channel remained in navigation")
	}
	pilot = navigationItem(t, empty, "projects", "pilot")
	if pilot["unread_messages"] != float64(0) || pilot["last_message_at"] != nil {
		t.Fatal("project-only grant leaked channels")
	}
	f.access("viewer-pilot", "project", "pilot", "none", 200)
	none := navigationGet(f, "viewer-pilot")
	if len(none["projects"].([]any)) != 0 || len(none["channels"].([]any)) != 0 {
		t.Fatal("missing project grant was ignored")
	}
	f.expect("POST", "/v1/admin/projects/pilot/archive", "owner", map[string]any{}, 200)
	ordinary := navigationGet(f, "claude-pilot")
	if len(ordinary["projects"].([]any)) != 0 || len(ordinary["channels"].([]any)) != 0 {
		t.Fatal("archived project leaked to ordinary agent")
	}
	if channels := navigationGet(f, "owner")["channels"].([]any); len(channels) != 1 || channels[0].(map[string]any)["id"] != "isolated" {
		t.Fatal("archived channels remained in owner sidebar")
	}
	navigationRead(f, "owner", "private-nav", private["seq"].(float64), 200)
}

func TestNavigationStrictInputsAndFreshAuthorization(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	m := f.message("authorization-nav", "claude-pilot")
	seq := m["seq"].(float64)
	f.expect("GET", "/v1/navigation", "", nil, 401)
	navigationRead(f, "", "general", seq, 401)
	for _, in := range []map[string]any{{}, {"through_seq": nil}, {"through_seq": -1}, {"through_seq": 1.5}, {"through_seq": seq, "extra": true}} {
		f.expect("PUT", "/v1/channels/general/read", "viewer-pilot", in, 400)
	}
	navigationRead(f, "viewer-pilot", "general", seq+1, 409)
	navigationRead(f, "viewer-pilot", "missing", 0, 404)
	req := func(method, path string) *http.Request {
		r := httptest.NewRequest(method, path, strings.NewReader(fmt.Sprintf(`{"through_seq":%.0f}`, seq)))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+f.keys["viewer-pilot"])
		r.SetPathValue("channel", "general")
		return r.WithContext(context.WithValue(r.Context(), contextKey{}, Principal{ID: "viewer-pilot", Kind: "viewer"}))
	}
	f.access("viewer-pilot", "channel", "general", "none", 200)
	w := httptest.NewRecorder()
	(&Server{Store: f.s}).markChannelRead(w, req("PUT", "/v1/channels/general/read"))
	if w.Code != 404 {
		t.Fatal("read handler trusted stale ACL")
	}
	if err := f.s.Revoke(context.Background(), "viewer-pilot"); err != nil {
		t.Fatal(err)
	}
	for _, handler := range []func(http.ResponseWriter, *http.Request){(&Server{Store: f.s}).markChannelRead, (&Server{Store: f.s}).navigation} {
		w = httptest.NewRecorder()
		handler(w, req("PUT", "/v1/channels/general/read"))
		if w.Code != 401 {
			t.Fatal("handler trusted middleware before key revocation")
		}
	}
	var rows int
	if err := f.s.Pool.QueryRow(context.Background(), "SELECT count(*) FROM navigation_reads").Scan(&rows); err != nil || rows != 0 {
		t.Fatal("rejected reading request changed cursors")
	}
}

func TestNavigationConcurrentMonotonicReads(t *testing.T) {
	f := newFixture(t)
	first := navigationMessage(f, "claude-pilot", "general", "race-read-first")
	last := navigationMessage(f, "claude-pilot", "general", "race-read-last")
	results := make(chan download, 2)
	start := make(chan struct{})
	for _, seq := range []float64{first["seq"].(float64), last["seq"].(float64)} {
		go func(seq float64) {
			<-start
			data, _ := json.Marshal(map[string]any{"through_seq": seq})
			req, _ := http.NewRequest("PUT", f.server.URL+"/v1/channels/general/read", bytes.NewReader(data))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+f.keys["viewer-pilot"])
			res, err := f.server.Client().Do(req)
			if err != nil {
				results <- download{err: err}
				return
			}
			defer res.Body.Close()
			body, err := io.ReadAll(res.Body)
			results <- download{status: res.StatusCode, body: body, err: err}
		}(seq)
	}
	close(start)
	for n := 0; n < 2; n++ {
		res := <-results
		if res.err != nil || res.status != 200 {
			t.Fatal("concurrent marker update failed")
		}
	}
	if item := navigationItem(t, navigationGet(f, "viewer-pilot"), "channels", "general"); item["last_read_seq"] != last["seq"] || item["unread_messages"] != float64(0) {
		t.Fatal("concurrent marker update regressed progress")
	}
}

func TestNavigationMigrationRestartAndDeletion(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	message := f.message("migration-read", "claude-pilot")
	seq := message["seq"].(float64)
	ctx := context.Background()
	const snapshot = `SELECT json_build_object('principals',(SELECT json_agg(p ORDER BY id) FROM principals p),'messages',(SELECT json_agg(m ORDER BY id) FROM messages m),'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r),'events',(SELECT json_agg(e ORDER BY channel_id,seq) FROM events e))::text`
	before := f.snapshot(snapshot)
	if _, err := f.s.Pool.Exec(ctx, "DROP TABLE navigation_reads"); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		if err := f.s.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if before != f.snapshot(snapshot) {
		t.Fatal("read migration changed existing state")
	}
	navigationRead(f, "viewer-pilot", "general", seq, 200)
	if err := f.s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	restarted := httptest.NewServer((&Server{Store: f.s}).Handler())
	defer restarted.Close()
	old := f.server
	f.server = restarted
	defer func() { f.server = old }()
	if navigationItem(t, navigationGet(f, "viewer-pilot"), "channels", "general")["last_read_seq"] != seq {
		t.Fatal("restart lost read progress")
	}
	preview := f.expect("GET", "/v1/admin/projects/pilot/deletion-preview", "owner", nil, 200)
	if preview["counts"].(map[string]any)["navigation_reads"] != float64(1) {
		t.Fatal("deletion preview omitted read markers")
	}
	f.expect("POST", "/v1/admin/projects/pilot/archive", "owner", map[string]any{}, 200)
	f.expect("DELETE", "/v1/admin/projects/pilot", "owner", map[string]any{"confirm_id": "pilot", "expected_version": 1}, 200)
	var count int
	if err := f.s.Pool.QueryRow(ctx, "SELECT count(*) FROM navigation_reads").Scan(&count); err != nil || count != 0 {
		t.Fatal("project deletion left read markers")
	}
}

func navigationSameTime(a, b any) bool {
	left, ok := a.(string)
	if !ok {
		return false
	}
	right, ok := b.(string)
	if !ok {
		return false
	}
	x, e1 := time.Parse(time.RFC3339Nano, left)
	y, e2 := time.Parse(time.RFC3339Nano, right)
	return e1 == nil && e2 == nil && x.Equal(y)
}
