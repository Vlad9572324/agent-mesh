package link

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestProjectActivityCursorValidation(t *testing.T) {
	scope := projectActivityCursor{Project: "project", Reader: "viewer", Actor: "agent", Channel: "channel"}
	position := scope
	position.At = time.Date(2026, 10, 1, 12, 0, 0, 123456000, time.UTC)
	position.ID = "event-1"
	value := encodeProjectActivityCursor(position)
	if got, ok := decodeProjectActivityCursor(value, scope); !ok || got != position {
		t.Fatal("valid cursor did not round trip")
	}
	for _, changed := range []projectActivityCursor{
		{Project: "other", Reader: "viewer", Actor: "agent", Channel: "channel"},
		{Project: "project", Reader: "other", Actor: "agent", Channel: "channel"},
		{Project: "project", Reader: "viewer", Actor: "other", Channel: "channel"},
		{Project: "project", Reader: "viewer", Actor: "agent", Channel: "other"},
	} {
		if _, ok := decodeProjectActivityCursor(value, changed); ok {
			t.Fatal("cursor was accepted for another scope")
		}
	}
	invalid := []string{"", "%%%", strings.Repeat("x", 2049), value + "=", value + "\n"}
	for _, body := range []string{
		`null`, `{}`, `[]`, `["1","project","viewer","agent","channel","2026-10-01T12:00:00Z"]`,
		`["2","project","viewer","agent","channel","2026-10-01T12:00:00Z","event-1"]`,
		`["1","project","viewer","agent","channel","invalid","event-1"]`,
		`["1","project","viewer","agent","channel","2026-10-01T12:00:00.000000001Z","event-1"]`,
		`["1","project","viewer","agent","channel","2026-10-01T12:00:00+00:00","event-1"]`,
		`["1","project","viewer","agent","channel","2026-10-01T12:00:00Z","../event"]`,
		`["1", "project","viewer","agent","channel","2026-10-01T12:00:00Z","event-1"]`,
	} {
		invalid = append(invalid, base64.RawURLEncoding.EncodeToString([]byte(body)))
	}
	for _, value := range invalid {
		if _, ok := decodeProjectActivityCursor(value, scope); ok {
			t.Fatal("malformed/noncanonical cursor was accepted")
		}
	}
}

func TestProjectActivityScopeFiltersAndReadOnly(t *testing.T) {
	f, _ := lifecycleFixture(t)
	for _, entry := range []struct{ channel, actor, client string }{
		{lifecycleChannel, "codex-pilot", "one"},
		{lifecycleChannel, "claude-pilot", "two"},
		{lifecycleSide, "claude-pilot", "hidden"},
		{"general", "codex-pilot", "other-project"},
	} {
		f.expect("POST", "/v1/channels/"+entry.channel+"/activity", entry.actor, nativeInput(entry.client, "tool.completed"), 201)
	}
	snapshot := `SELECT json_build_object('native',(SELECT json_agg(n ORDER BY id) FROM native_activity n),'principals',(SELECT json_agg(p ORDER BY id) FROM principals p),'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r),'channels',(SELECT json_agg(c ORDER BY id) FROM channels c))::text`
	before := f.snapshot(snapshot)
	base := "/v1/projects/" + lifecycleID + "/activity"
	for _, test := range []struct {
		reader, query string
		count         int
	}{
		{"viewer-pilot", "", 2}, {"owner", "", 3},
		{"viewer-pilot", "?actor_id=codex-pilot", 1},
		{"viewer-pilot", "?actor_id=claude-pilot&channel_id=" + lifecycleChannel, 1},
		{"viewer-pilot", "?actor_id=missing-actor", 0},
		{"viewer-pilot", "?actor_id=deny-pilot", 0},
		{"owner", "?channel_id=" + lifecycleSide, 1},
	} {
		page := f.expect("GET", base+test.query, test.reader, nil, 200)
		items := page["activity"].([]any)
		if len(items) != test.count || page["has_more"] != false || page["next_before"] != nil {
			t.Fatalf("unexpected visible page for %s %s", test.reader, test.query)
		}
		for _, item := range items {
			row := item.(map[string]any)
			if row["provenance"] != "client_reported" || row["server_verified"] != false || row["channel_id"] == "general" || (test.reader != "owner" && row["channel_id"] == lifecycleSide) {
				t.Fatal("wrong scope or provenance in project activity")
			}
		}
	}
	for _, channel := range []string{lifecycleSide, "missing-channel", "general"} {
		f.expect("GET", base+"?channel_id="+channel, "viewer-pilot", nil, 404)
	}
	f.expect("GET", base+"?channel_id=general", "owner", nil, 404)
	f.expect("GET", base, "deny-pilot", nil, 404)
	f.expect("GET", base, "", nil, 401)
	for _, query := range []string{"?limit=0", "?limit=-1", "?limit=no", "?limit=", "?limit=1&limit=2", "?actor_id=", "?actor_id=../x", "?channel_id=../x", "?before=", "?before=not-a-cursor", "?after_seq=0", "?actor_id=a&actor_id=b", "?actor_id=bad%00id"} {
		f.expect("GET", base+query, "viewer-pilot", nil, 400)
	}
	if f.snapshot(snapshot) != before {
		t.Fatal("project activity reads changed stored state")
	}
}

func TestProjectActivityNewestPagingTiesAndConcurrentArrival(t *testing.T) {
	f, _ := lifecycleFixture(t)
	f.access("viewer-pilot", "channel", lifecycleSide, "read", 200)
	// Only this fixture's schema is changed. Equal timestamps exercise the ID
	// tiebreaker; a large shared cursor must not hide older native reports.
	_, err := f.s.Pool.Exec(context.Background(), `INSERT INTO native_activity(id,channel_id,seq,actor_id,client_id,session_id,runtime,event_type,request_hash,created_at)
 SELECT 'feed-'||lpad(g::text,4,'0'),CASE WHEN g%2=0 THEN $1 ELSE $2 END,g+100,
 'claude-pilot','page-'||g,'session','claude','turn.started','\\x00'::bytea,
 CASE WHEN g>100 THEN '2021-01-01T00:00:00Z'::timestamptz ELSE '2020-01-01T00:00:00Z'::timestamptz END
 FROM generate_series(1,105) g`, lifecycleChannel, lifecycleSide)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Pool.Exec(context.Background(), `UPDATE channels SET cursor=10000 WHERE project_id=$1`, lifecycleID); err != nil {
		t.Fatal(err)
	}
	base := "/v1/projects/" + lifecycleID + "/activity"
	first := f.expect("GET", base+"?limit=500", "viewer-pilot", nil, 200)
	items := first["activity"].([]any)
	if len(items) != 100 || first["has_more"] != true {
		t.Fatal("first page must return latest 100, independent of channel cursor")
	}
	for i, item := range items {
		if item.(map[string]any)["id"] != fmt.Sprintf("feed-%04d", 105-i) {
			t.Fatal("newest-first timestamp/ID ordering incorrect")
		}
	}
	cursor := first["next_before"].(string)
	f.expect("POST", "/v1/channels/"+lifecycleChannel+"/activity", "claude-pilot", nativeInput("new-arrival", "turn.completed"), 201)
	second := f.expect("GET", base+"?before="+url.QueryEscape(cursor), "viewer-pilot", nil, 200)
	if len(second["activity"].([]any)) != 5 || second["has_more"] != false || second["next_before"] != nil {
		t.Fatal("older continuation duplicated/skipped records or included new arrival")
	}
	for i, item := range second["activity"].([]any) {
		if item.(map[string]any)["id"] != fmt.Sprintf("feed-%04d", 5-i) {
			t.Fatal("same-timestamp continuation boundary incorrect")
		}
	}
	latest := f.expect("GET", base+"?limit=1", "viewer-pilot", nil, 200)
	if latest["activity"].([]any)[0].(map[string]any)["client_id"] != "new-arrival" {
		t.Fatal("fresh first page did not include new arrival")
	}
	for _, suffix := range []string{"&actor_id=claude-pilot", "&channel_id=" + lifecycleChannel} {
		f.expect("GET", base+"?before="+cursor+suffix, "viewer-pilot", nil, 400)
	}
	f.expect("GET", "/v1/projects/pilot/activity?before="+cursor, "viewer-pilot", nil, 400)
	f.expect("GET", base+"?before="+cursor, "owner", nil, 400)
	filteredQuery := "?actor_id=claude-pilot&channel_id=" + lifecycleSide
	filtered := f.expect("GET", base+filteredQuery+"&limit=1", "viewer-pilot", nil, 200)
	filteredCursor := filtered["next_before"].(string)
	olderFiltered := f.expect("GET", base+filteredQuery+"&before="+filteredCursor+"&limit=2", "viewer-pilot", nil, 200)
	if len(olderFiltered["activity"].([]any)) != 2 {
		t.Fatal("changing page size broke a valid filtered continuation")
	}
	for _, item := range olderFiltered["activity"].([]any) {
		row := item.(map[string]any)
		if row["channel_id"] != lifecycleSide || row["actor_id"] != "claude-pilot" {
			t.Fatal("filtered continuation escaped its intersection")
		}
	}
	// A scope-bound cursor cannot preserve revoked channel access.
	f.access("viewer-pilot", "channel", lifecycleSide, "none", 200)
	f.expect("GET", base+filteredQuery+"&before="+filteredCursor, "viewer-pilot", nil, 404)
	page := f.expect("GET", base+"?before="+cursor, "viewer-pilot", nil, 200)
	if len(page["activity"].([]any)) != 2 {
		t.Fatal("continuation retained a revoked channel")
	}
	for _, item := range page["activity"].([]any) {
		if item.(map[string]any)["channel_id"] != lifecycleChannel {
			t.Fatal("revoked channel leaked through continuation")
		}
	}
}

func TestProjectActivityRevocationArchiveAndKeyRecheck(t *testing.T) {
	f, _ := lifecycleFixture(t)
	f.expect("POST", "/v1/channels/"+lifecycleChannel+"/activity", "codex-pilot", nativeInput("archive", "session.started"), 201)
	base := "/v1/projects/" + lifecycleID + "/activity"
	f.lifecycle("archive", 200)
	f.expect("GET", base, "viewer-pilot", nil, 404)
	if len(f.expect("GET", base, "owner", nil, 200)["activity"].([]any)) != 1 {
		t.Fatal("owner lost archived activity history")
	}
	f.lifecycle("restore", 200)
	f.access("viewer-pilot", "channel", lifecycleChannel, "none", 200)
	if len(f.expect("GET", base, "viewer-pilot", nil, 200)["activity"].([]any)) != 0 {
		t.Fatal("project member without channel access saw reports")
	}
	f.expect("GET", base+"?channel_id="+lifecycleChannel, "viewer-pilot", nil, 404)
	f.access("viewer-pilot", "project", lifecycleID, "none", 200)
	f.expect("GET", base, "viewer-pilot", nil, 404)
	oldKey := f.keys["codex-pilot"]
	f.expect("POST", "/v1/admin/principals/codex-pilot/revoke-key", "owner", map[string]any{}, 200)
	f.expect("GET", base, "codex-pilot", nil, 401)
	// Simulate identity already accepted by middleware immediately before key
	// revocation: the endpoint must independently recheck inside its snapshot.
	req := httptest.NewRequest(http.MethodGet, base, nil)
	req.Header.Set("Authorization", "Bearer "+oldKey)
	req.SetPathValue("project", lifecycleID)
	req = req.WithContext(context.WithValue(req.Context(), contextKey{}, Principal{ID: "codex-pilot", Kind: "agent"}))
	recorder := httptest.NewRecorder()
	(&Server{Store: f.s}).projectNativeActivity(recorder, req)
	if recorder.Code != 401 {
		t.Fatal("project endpoint trusted stale middleware identity after key revocation")
	}
	var body map[string]any
	if json.Unmarshal(recorder.Body.Bytes(), &body) != nil || body["activity"] != nil {
		t.Fatal("revoked response contained activity")
	}
}
