package link

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func deliveryRow(t *testing.T, message map[string]any, agent string) map[string]any {
	t.Helper()
	rows, ok := message["delivery_status"].([]any)
	if !ok {
		t.Fatal("missing additive delivery status")
	}
	for _, raw := range rows {
		row := raw.(map[string]any)
		if row["agent_id"] == agent {
			return row
		}
	}
	t.Fatal("recipient status missing")
	return nil
}

func TestMessageDeliveryIndependentNativeLegacyReplyFacts(t *testing.T) {
	f := newFixture(t)
	id := f.message("delivery-native-only", "claude-pilot")["id"].(string)
	get := func() map[string]any {
		return f.expect("GET", "/v1/messages/"+id, "claude-pilot", nil, 200)["message"].(map[string]any)
	}
	beforeLegacy, _ := json.Marshal(get()["receipts"])
	row := deliveryRow(t, get(), "codex-pilot")
	if row["status"] != "stored" || row["reply"] != nil {
		t.Fatal("unreported message is not stored-only")
	}
	report := func(client, kind string) map[string]any {
		in := nativeInput(client, kind)
		in.MessageID = &id
		return f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 201)["activity"].(map[string]any)
	}
	offered := report("delivery-offer", "inbox.offered")
	if row = deliveryRow(t, get(), "codex-pilot"); row["status"] != "offered" || row["native"].(map[string]any)["seen_at"] != nil {
		t.Fatal("offer invented a view")
	}
	seen := report("delivery-view", "inbox.seen")
	row = deliveryRow(t, get(), "codex-pilot")
	native := row["native"].(map[string]any)
	if row["status"] != "viewed" || native["seen_at"] != seen["created_at"] || native["offered_at"] != offered["created_at"] || native["accepted_at"] != nil || native["server_verified"] != false {
		t.Fatal("native view facts changed")
	}
	afterLegacy, _ := json.Marshal(get()["receipts"])
	if string(beforeLegacy) != string(afterLegacy) {
		t.Fatal("native report changed original legacy history")
	}
	acceptedID := f.message("delivery-accepted-only", "claude-pilot")["id"].(string)
	in := nativeInput("delivery-accept", "inbox.accepted")
	in.MessageID = &acceptedID
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", in, 201)
	accepted := deliveryRow(t, f.expect("GET", "/v1/messages/"+acceptedID, "claude-pilot", nil, 200)["message"].(map[string]any), "codex-pilot")
	if accepted["status"] != "accepted" || accepted["native"].(map[string]any)["seen_at"] != nil || accepted["legacy"].(map[string]any)["accepted_at"] != nil {
		t.Fatal("native acceptance fabricated earlier stages or legacy acknowledgement")
	}
	// Wrong recipient, author and channel must not satisfy direct-answer rules.
	f.expect("POST", "/v1/channels/general/messages", "codex-pilot", map[string]any{"client_id": "wrong-destination", "body": "not addressed back", "recipient_ids": []string{"codex-pilot"}, "reply_to": id}, 201)
	f.expect("POST", "/v1/channels/general/messages", "claude-pilot", map[string]any{"client_id": "wrong-author", "body": "author own reply", "recipient_ids": []string{"codex-pilot"}, "reply_to": id}, 201)
	if _, err := f.s.Pool.Exec(context.Background(), `INSERT INTO messages(id,channel_id,seq,author_id,client_id,body,recipient_ids,reply_to,payload_hash) VALUES('cross-channel-answer','isolated',999,'codex-pilot','cross-channel-answer','ignored','["claude-pilot"]',$1,decode('00','hex'))`, id); err != nil {
		t.Fatal(err)
	}
	if deliveryRow(t, get(), "codex-pilot")["reply"] != nil {
		t.Fatal("unqualified reply counted")
	}
	reply := f.expect("POST", "/v1/channels/general/messages", "codex-pilot", map[string]any{"client_id": "actual-answer", "body": "actual answer", "recipient_ids": []string{"claude-pilot"}, "reply_to": id}, 201)["message"].(map[string]any)
	row = deliveryRow(t, get(), "codex-pilot")
	if row["status"] != "replied" || row["reply"].(map[string]any)["message_id"] != reply["id"] || row["native"].(map[string]any)["accepted_at"] != nil {
		t.Fatal("actual reply omitted or converted into acceptance")
	}
	f.heartbeat("codex-pilot", "legacy-delivery")
	f.expect("POST", "/v1/messages/"+acceptedID+"/receipts", "codex-pilot", map[string]any{"session_id": "legacy-delivery", "status": "delivered"}, 200)
	accepted = deliveryRow(t, f.expect("GET", "/v1/messages/"+acceptedID, "claude-pilot", nil, 200)["message"].(map[string]any), "codex-pilot")
	if accepted["legacy"].(map[string]any)["delivered_at"] == nil || accepted["native"].(map[string]any)["seen_at"] != nil {
		t.Fatal("adapter delivery treated as viewing")
	}
	const snapshot = `SELECT json_build_object('messages',(SELECT json_agg(m ORDER BY id) FROM messages m),'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r),'native',(SELECT json_agg(n ORDER BY id) FROM native_activity n),'events',(SELECT json_agg(e ORDER BY channel_id,seq) FROM events e))::text`
	before := f.snapshot(snapshot)
	get()
	f.expect("GET", "/v1/channels/general/messages?after_seq=0&limit=100", "claude-pilot", nil, 200)
	if before != f.snapshot(snapshot) {
		t.Fatal("delivery inspection mutated history")
	}
}

func TestMessageDeliveryHistoryAndACL(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	id := f.message("delivery-acl", "claude-pilot")["id"].(string)
	for _, actor := range []string{"claude-pilot", "codex-pilot", "viewer-pilot", "owner"} {
		message := f.expect("GET", "/v1/messages/"+id, actor, nil, 200)["message"].(map[string]any)
		if deliveryRow(t, message, "codex-pilot")["status"] != "stored" {
			t.Fatal("unexpected fresh status")
		}
	}
	f.expect("GET", "/v1/messages/"+id, "deny-pilot", nil, 404)
	f.expect("GET", "/v1/messages/"+id, "", nil, 401)
	f.access("claude-pilot", "channel", "general", "none", 200)
	f.expect("GET", "/v1/messages/"+id, "claude-pilot", nil, 404)
	if err := f.s.Revoke(context.Background(), "codex-pilot"); err != nil {
		t.Fatal(err)
	}
	f.expect("GET", "/v1/messages/"+id, "codex-pilot", nil, 401)
	f.expect("POST", "/v1/admin/projects/pilot/archive", "owner", map[string]any{}, 200)
	f.expect("GET", "/v1/messages/"+id, "viewer-pilot", nil, 404)
	f.expect("GET", "/v1/messages/"+id, "owner", nil, 200)
}

// A normal 100-message page must not repeat the richer exact-GET status for
// every recipient, nor persist a stale status snapshot in connector inboxes.
func TestMessageDeliveryOnlyOnExactDetail(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	recipients := []string{}
	for i := 0; i < 32; i++ {
		recipients = append(recipients, fmt.Sprintf("recipient-%02d-%s", i, strings.Repeat("r", 110)))
	}
	if _, err := f.s.Pool.Exec(ctx, `INSERT INTO principals(id,name,kind) SELECT id,id,'agent' FROM unnest($1::text[]) AS id`, recipients); err != nil {
		t.Fatal(err)
	}
	rawRecipients, err := json.Marshal(recipients)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Pool.Exec(ctx, `INSERT INTO messages(id,channel_id,seq,author_id,client_id,body,recipient_ids,payload_hash)
 SELECT 'bulk-'||n,'general',n,'claude-pilot','bulk-'||n,repeat('x',3000),$1::jsonb,decode('00','hex') FROM generate_series(1,100) AS n`, string(rawRecipients)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Pool.Exec(ctx, `INSERT INTO receipts(message_id,agent_id) SELECT m.id,r.value FROM messages m CROSS JOIN LATERAL jsonb_array_elements_text(m.recipient_ids) AS r(value)`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Pool.Exec(ctx, `UPDATE channels SET cursor=100 WHERE id='general'`); err != nil {
		t.Fatal(err)
	}
	page := f.expect("GET", "/v1/channels/general/messages?after_seq=0&limit=100", "claude-pilot", nil, 200)
	messages := page["messages"].([]any)
	if len(messages) != 100 {
		t.Fatalf("got %d messages", len(messages))
	}
	for _, raw := range messages {
		message := raw.(map[string]any)
		if _, exists := message["delivery_status"]; exists {
			t.Fatal("list leaked detail-only status")
		}
		if len(message["recipient_ids"].([]any)) != 32 || len(message["receipts"].([]any)) != 32 {
			t.Fatal("missing original recipient history")
		}
	}
	encoded, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) >= 2*1024*1024 {
		t.Fatalf("concrete bounded page exceeds connector limit: %d", len(encoded))
	}
	detail := f.expect("GET", "/v1/messages/bulk-1", "claude-pilot", nil, 200)["message"].(map[string]any)
	if len(detail["delivery_status"].([]any)) != 32 {
		t.Fatal("exact detail lost recipient status")
	}
	// Negative control: adding this exact detail shape to the light page would
	// cross the real connector HTTP budget even though its original data fits.
	for _, raw := range messages {
		raw.(map[string]any)["delivery_status"] = detail["delivery_status"]
	}
	expanded, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	if len(expanded) <= 2*1024*1024 {
		t.Fatal("fixture no longer exercises detail expansion risk")
	}
	created := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", map[string]any{"client_id": "broadcast-detail", "body": "broadcast", "recipient_ids": []string{}}, 201)["message"].(map[string]any)
	if _, exists := created["delivery_status"]; exists {
		t.Fatal("send response contains detail-only status")
	}
	broadcast := f.expect("GET", "/v1/messages/"+created["id"].(string), "claude-pilot", nil, 200)["message"].(map[string]any)
	statuses, ok := broadcast["delivery_status"].([]any)
	if !ok || len(statuses) != 0 {
		t.Fatal("broadcast detail must explicitly contain empty statuses")
	}
}
