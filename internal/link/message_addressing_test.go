package link

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func messageJournalSnapshot(f *fixture) string {
	f.t.Helper()
	var snapshot string
	err := f.s.Pool.QueryRow(context.Background(), `SELECT json_build_object(
 'messages',(SELECT count(*) FROM messages),
 'events',(SELECT count(*) FROM events),
 'receipts',(SELECT count(*) FROM receipts),
 'cursors',(SELECT json_agg(json_build_array(id,cursor) ORDER BY id) FROM channels))::text`).Scan(&snapshot)
	if err != nil {
		f.t.Fatal(err)
	}
	return snapshot
}

func TestMessageChannelOnlyRequiresExplicitIntent(t *testing.T) {
	f := newFixture(t)
	parent := f.message("addressing-parent", "codex-pilot")["id"]
	cases := []struct {
		name string
		body map[string]any
	}{
		{"omitted flag", map[string]any{"recipient_ids": []string{}}},
		{"false flag", map[string]any{"recipient_ids": []string{}, "channel_only": false}},
		{"reply does not infer recipient", map[string]any{"recipient_ids": []string{}, "reply_to": parent}},
		{"targets conflict with channel only", map[string]any{"recipient_ids": []string{"codex-pilot"}, "channel_only": true}},
		{"missing recipients", map[string]any{"channel_only": true}},
		{"null recipients", map[string]any{"recipient_ids": nil, "channel_only": true}},
		{"flag must be boolean", map[string]any{"recipient_ids": []string{}, "channel_only": "true"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			local := *f
			local.t = t
			f := &local
			before := messageJournalSnapshot(f)
			tc.body["client_id"], tc.body["body"] = "reject-"+strings.ReplaceAll(tc.name, " ", "-"), "Not an implicit broadcast"
			response := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", tc.body, 400)
			if tc.name == "omitted flag" && !strings.Contains(response["error"].(string), "channel_only") {
				t.Fatal("missing actionable addressing error")
			}
			if messageJournalSnapshot(f) != before {
				t.Fatal("rejected addressing changed messages, events, receipts or channel cursors")
			}
		})
	}

	body := map[string]any{"client_id": "explicit-channel-note", "body": "For channel history", "recipient_ids": []string{}, "channel_only": true, "reply_to": parent}
	first := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", body, 201)
	message := first["message"].(map[string]any)
	if len(message["recipient_ids"].([]any)) != 0 || len(message["receipts"].([]any)) != 0 || message["reply_to"] != parent {
		t.Fatal("explicit channel-only post inferred a recipient or lost its reply reference")
	}
	after := messageJournalSnapshot(f)
	replay := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", body, 200)
	if replay["replayed"] != true || replay["message"].(map[string]any)["id"] != message["id"] {
		t.Fatal("explicit channel-only replay mismatch")
	}
	delete(body, "channel_only")
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", body, 409)
	if messageJournalSnapshot(f) != after {
		t.Fatal("replay or conflicting intent changed the journal")
	}
}

func TestMessageLegacyBroadcastReplayPreservesHash(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	// This is the exact pre-channel_only canonical representation, independently
	// seeded so a new server cannot accidentally validate itself by creating it.
	const legacy = `{"client_id":"legacy-channel-note","body":"Old channel history","recipient_ids":[],"reply_to":null}`
	const id = "legacy-broadcast"
	tx, err := f.s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	seq, err := addEvent(ctx, tx, "general", "message.created", id)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO messages(id,channel_id,seq,author_id,client_id,body,recipient_ids,reply_to,payload_hash)
 VALUES($1,'general',$2,'claude-pilot','legacy-channel-note','Old channel history','[]'::jsonb,NULL,$3)`, id, seq, digest(legacy))
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	before := messageJournalSnapshot(f)
	var body map[string]any
	if err = json.Unmarshal([]byte(legacy), &body); err != nil {
		t.Fatal(err)
	}
	for _, explicitFalse := range []bool{false, true} {
		if explicitFalse {
			body["channel_only"] = false
		}
		replay := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", body, 200)
		if replay["replayed"] != true || replay["message"].(map[string]any)["id"] != id {
			t.Fatal("legacy channel-only request did not return the existing message")
		}
	}
	body["channel_only"] = true
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", body, 409)
	body["channel_only"], body["client_id"] = false, "new-implicit-channel-note"
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", body, 400)
	if messageJournalSnapshot(f) != before {
		t.Fatal("legacy replay or rejected new broadcast changed durable records")
	}
	var stored []byte
	if err = f.s.Pool.QueryRow(ctx, "SELECT payload_hash FROM messages WHERE id=$1", id).Scan(&stored); err != nil || !bytes.Equal(stored, digest(legacy)) {
		t.Fatal("legacy payload hash changed")
	}
	// Historical replay still requires the sender's current channel grant.
	f.owner("owner")
	f.access("claude-pilot", "channel", "general", "none", 200)
	body["client_id"] = "legacy-channel-note"
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", body, 404)
}

func TestMessageAddressingPreservesDirectedReplayAndAuthorization(t *testing.T) {
	f := newFixture(t)
	const canonical = `{"client_id":"direct-addressing","body":"Direct message","recipient_ids":["codex-pilot"],"reply_to":null}`
	body := map[string]any{"client_id": "direct-addressing", "body": "Direct message", "recipient_ids": []string{"codex-pilot"}}
	m := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", body, 201)["message"].(map[string]any)
	var stored []byte
	if err := f.s.Pool.QueryRow(context.Background(), "SELECT payload_hash FROM messages WHERE id=$1", m["id"]).Scan(&stored); err != nil || !bytes.Equal(stored, digest(canonical)) {
		t.Fatal("ordinary directed request no longer has the legacy canonical hash")
	}
	body["channel_only"] = false
	replay := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", body, 200)
	if replay["replayed"] != true || replay["message"].(map[string]any)["id"] != m["id"] {
		t.Fatal("false optional flag changed directed retry identity")
	}
	before := messageJournalSnapshot(f)
	body = map[string]any{"client_id": "authorized-addressing", "body": "Channel note", "recipient_ids": []string{}, "channel_only": true}
	for _, actor := range []string{"deny-pilot", "viewer-pilot"} {
		f.expect("POST", "/v1/channels/general/messages", actor, body, 404)
	}
	f.expect("POST", "/v1/channels/general/messages", "", body, 401)
	body["reply_to"] = "missing-parent"
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", body, 404)
	// Existing parent visibility and recipient checks remain separate from intent.
	body["reply_to"] = m["id"]
	f.expect("POST", "/v1/channels/isolated/messages", "deny-pilot", body, 404)
	delete(body, "reply_to")
	body["channel_only"], body["recipient_ids"] = false, []string{"deny-pilot"}
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", body, 404)
	body["recipient_ids"] = []string{"viewer-pilot"}
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", body, 400)
	if messageJournalSnapshot(f) != before {
		t.Fatal("authorization errors or directed replay changed durable records")
	}
}
