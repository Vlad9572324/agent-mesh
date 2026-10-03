package link

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func nativeReceiptPath(channel string, ids ...string) string {
	query := url.Values{}
	for _, id := range ids {
		query.Add("message_id", id)
	}
	return "/v1/channels/" + channel + "/native-receipts?" + query.Encode()
}

func TestNativeReceiptsStrictBatch(t *testing.T) {
	for _, query := range []string{"", "message_id=", "other=a", "message_id=a&other=b", "message_id=a&message_id=a", "message_id=../hidden", "message_id=%zz", "message_id=a;b", "message_id=" + strings.Repeat("a", 129)} {
		if _, ok := nativeReceiptIDs(query); ok {
			t.Fatalf("accepted invalid batch %q", query)
		}
	}
	query := url.Values{}
	for i := 0; i < nativeReceiptBatchLimit; i++ {
		query.Add("message_id", fmt.Sprintf("message-%03d", i))
	}
	if ids, ok := nativeReceiptIDs(query.Encode()); !ok || len(ids) != 100 {
		t.Fatal("valid maximum batch rejected")
	}
	query.Add("message_id", "one-too-many")
	if _, ok := nativeReceiptIDs(query.Encode()); ok {
		t.Fatal("oversized batch accepted")
	}
}

func TestNativeReceiptsIndependentStagesAndReadOnly(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	multi := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", map[string]any{
		"client_id": "receipt-multi", "body": "Private fixture body must not be copied into reports", "recipient_ids": []string{"claude-pilot", "codex-pilot"},
	}, 201)["message"].(map[string]any)["id"].(string)
	seenOnly := f.message("receipt-seen-only", "claude-pilot")["id"].(string)
	none := f.message("receipt-none", "claude-pilot")["id"].(string)
	report := func(message, actor, client, kind, session string) map[string]any {
		in := nativeInput(client, kind)
		in.MessageID, in.SessionID = &message, session
		return f.expect("POST", "/v1/channels/general/activity", actor, in, 201)["activity"].(map[string]any)
	}
	first := report(multi, "codex-pilot", "offer-first", "inbox.offered", "session-one")
	report(multi, "codex-pilot", "offer-again", "inbox.offered", "session-two")
	seen := report(multi, "codex-pilot", "seen", "inbox.seen", "session-two")
	accepted := report(multi, "claude-pilot", "accepted-only", "inbox.accepted", "session-three")
	viewed := report(seenOnly, "codex-pilot", "seen-only", "inbox.seen", "session-one")
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", nativeInput("tool-no-receipt", "tool.completed"), 201)
	// The API rejects this report. Even a legacy/corrupt stored row must not be
	// exposed as a valid recipient's report by the aggregate's join.
	if _, err := f.s.Pool.Exec(context.Background(), `INSERT INTO native_activity(id,channel_id,seq,actor_id,client_id,session_id,runtime,event_type,message_id,request_hash)
 VALUES('nonrecipient-report','general',1000,'claude-pilot','nonrecipient-report','session','claude','inbox.accepted',$1,decode('00','hex'))`, none); err != nil {
		t.Fatal(err)
	}
	f.heartbeat("codex-pilot", "legacy-session")
	f.expect("POST", "/v1/messages/"+multi+"/receipts", "codex-pilot", map[string]any{"session_id": "legacy-session", "status": "delivered"}, 200)
	const snapshot = `SELECT json_build_object('messages',(SELECT json_agg(m ORDER BY id) FROM messages m),'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r),'native',(SELECT json_agg(n ORDER BY id) FROM native_activity n),'events',(SELECT json_agg(e ORDER BY channel_id,seq) FROM events e),'principals',(SELECT json_agg(p ORDER BY id) FROM principals p),'reads',(SELECT json_agg(r ORDER BY principal_id,channel_id) FROM navigation_reads r))::text`
	before := f.snapshot(snapshot)
	path := nativeReceiptPath("general", none, seenOnly, multi)
	for _, actor := range []string{"claude-pilot", "codex-pilot", "viewer-pilot", "owner"} {
		result := f.expect("GET", path, actor, nil, 200)
		rows := result["receipts"].([]any)
		if len(rows) != 3 {
			t.Fatalf("expected three reported pairs, got %d", len(rows))
		}
		previous := ""
		for _, value := range rows {
			row := value.(map[string]any)
			pair := row["message_id"].(string) + "/" + row["agent_id"].(string)
			if pair <= previous || row["provenance"] != "client_reported" || row["server_verified"] != false || len(row) != 7 {
				t.Fatal("unstable ordering or unexpected report provenance/fields")
			}
			previous = pair
			want := map[string]any{"offered_at": nil, "seen_at": nil, "accepted_at": nil}
			switch pair {
			case multi + "/codex-pilot":
				want["offered_at"], want["seen_at"] = first["created_at"], seen["created_at"]
			case multi + "/claude-pilot":
				want["accepted_at"] = accepted["created_at"]
			case seenOnly + "/codex-pilot":
				want["seen_at"] = viewed["created_at"]
			default:
				t.Fatal("exposed unreported or nonrecipient pair")
			}
			for field, timestamp := range want {
				if row[field] != timestamp {
					t.Fatalf("invented stage or replaced first report time in %s", field)
				}
				if timestamp != nil {
					if _, err := time.Parse(time.RFC3339Nano, timestamp.(string)); err != nil {
						t.Fatal("timestamp is not RFC3339")
					}
				}
			}
		}
	}
	if rows := f.expect("GET", nativeReceiptPath("general", none), "viewer-pilot", nil, 200)["receipts"].([]any); len(rows) != 0 {
		t.Fatal("missing native reports must be an empty array")
	}
	if before != f.snapshot(snapshot) {
		t.Fatal("GET changed native state, legacy receipts, read markers, or activity")
	}
}

func TestNativeReceiptsACLAndFreshKey(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	id := f.message("receipt-acl", "claude-pilot")["id"].(string)
	hidden := navigationMessage(f, "deny-pilot", "isolated", "hidden-receipt")["id"].(string)
	path := nativeReceiptPath("general", id)
	f.expect("GET", path, "", nil, 401)
	f.expect("GET", path, "deny-pilot", nil, 404)
	for _, actor := range []string{"viewer-pilot", "owner"} {
		for _, mixed := range []string{hidden, "nonexistent-message"} {
			result := f.expect("GET", nativeReceiptPath("general", id, mixed), actor, nil, 404)
			if len(result) != 1 || result["error"] != "not found" {
				t.Fatal("mixed batch exposed per-message existence")
			}
		}
	}
	f.expect("GET", nativeReceiptPath("isolated", hidden), "viewer-pilot", nil, 404)
	f.expect("GET", nativeReceiptPath("missing", id), "owner", nil, 404)
	f.expect("GET", "/v1/channels/general/native-receipts?message_id="+id+"&limit=1", "viewer-pilot", nil, 400)
	request := func() *http.Request {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+f.keys["viewer-pilot"])
		r.SetPathValue("channel", "general")
		return r.WithContext(context.WithValue(r.Context(), contextKey{}, Principal{ID: "viewer-pilot", Kind: "viewer"}))
	}
	checkStale := func(status int) {
		w := httptest.NewRecorder()
		(&Server{Store: f.s}).nativeReceipts(w, request())
		if w.Code != status {
			t.Fatalf("handler trusted stale middleware: got %d want %d", w.Code, status)
		}
	}
	f.access("viewer-pilot", "channel", "general", "none", 200)
	checkStale(404)
	f.access("viewer-pilot", "channel", "general", "read", 200)
	f.access("viewer-pilot", "project", "pilot", "none", 200)
	checkStale(404)
	f.access("viewer-pilot", "project", "pilot", "read", 200)
	checkStale(404) // Project revocation also removed the channel grant.
	f.access("viewer-pilot", "channel", "general", "read", 200)
	f.expect("POST", "/v1/admin/projects/pilot/archive", "owner", map[string]any{}, 200)
	checkStale(404)
	f.expect("GET", path, "owner", nil, 200) // Owner can inspect archived history.
	f.expect("POST", "/v1/admin/projects/pilot/restore", "owner", map[string]any{}, 200)
	checkStale(200)
	if err := f.s.Revoke(context.Background(), "viewer-pilot"); err != nil {
		t.Fatal(err)
	}
	checkStale(401)
	f.expect("GET", path, "viewer-pilot", nil, 401)
}

func TestNativeReceiptsBatchIndexAndMigration(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	// A full valid batch plus unrelated lifecycle telemetry uses test-only SQL
	// instead of thousands of HTTP writes. No deployed database is involved.
	_, err := f.s.Pool.Exec(ctx, `INSERT INTO messages(id,channel_id,seq,author_id,client_id,body,recipient_ids,payload_hash)
 SELECT 'receipt-'||n,'general',n,'claude-pilot','receipt-'||n,'body','["codex-pilot"]'::jsonb,decode('00','hex') FROM generate_series(1,100) n;
 INSERT INTO native_activity(id,channel_id,seq,actor_id,client_id,session_id,runtime,event_type,message_id,request_hash)
 SELECT 'receipt-event-'||n,'general',100+n,'codex-pilot','receipt-event-'||n,'session','codex','inbox.seen','receipt-'||n,decode('00','hex') FROM generate_series(1,100) n;
 INSERT INTO native_activity(id,channel_id,seq,actor_id,client_id,session_id,runtime,event_type,request_hash)
 SELECT 'noise-'||n,'general',200+n,'codex-pilot','noise-'||n,'session','codex','tool.completed',decode('00','hex') FROM generate_series(1,9000) n;
 ANALYZE native_activity; ANALYZE messages`)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, nativeReceiptBatchLimit)
	for i := range ids {
		ids[i] = fmt.Sprintf("receipt-%d", i+1)
	}
	if rows := f.expect("GET", nativeReceiptPath("general", ids...), "viewer-pilot", nil, 200)["receipts"].([]any); len(rows) != 100 {
		t.Fatal("maximum batch omitted reported messages")
	}
	f.expect("GET", nativeReceiptPath("general", append(ids, "too-many")...), "viewer-pilot", nil, 400)
	var plan json.RawMessage
	if err := f.s.Pool.QueryRow(ctx, "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+nativeReceiptQuery, "general", ids).Scan(&plan); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(plan), "native_activity_message_receipts") {
		t.Fatal("receipt query scanned unrelated lifecycle telemetry instead of its partial index")
	}
	t.Logf("receipt aggregate EXPLAIN: %s", plan)
	const snapshot = `SELECT json_build_object('native',(SELECT json_agg(n ORDER BY id) FROM native_activity n),'messages',(SELECT json_agg(m ORDER BY id) FROM messages m))::text`
	before := f.snapshot(snapshot)
	if _, err := f.s.Pool.Exec(ctx, "DROP INDEX native_activity_message_receipts"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := f.s.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if after := f.snapshot(snapshot); after != before {
		t.Fatal("additive index migration changed native history or messages")
	}
	if rows := f.expect("GET", nativeReceiptPath("general", ids...), "viewer-pilot", nil, 200)["receipts"].([]any); len(rows) != 100 {
		t.Fatal("receipt aggregate changed after repeated migration")
	}
}
