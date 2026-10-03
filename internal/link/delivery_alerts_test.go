package link

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func deliveryPolicyBody(enabled bool, ack, reply int, version int64) map[string]any {
	return map[string]any{"enabled": enabled, "ack_timeout_seconds": ack, "reply_timeout_seconds": reply, "expected_version": version}
}
func deliveryTestPolicy(t *testing.T, f *fixture) {
	t.Helper()
	f.owner("owner")
	f.expect("PUT", "/v1/admin/delivery-policy", "owner", deliveryPolicyBody(true, 60, 120, 0), 200)
	if _, err := f.s.Pool.Exec(context.Background(), `UPDATE delivery_alert_policy SET enabled_at=clock_timestamp()-interval '1 hour'`); err != nil {
		t.Fatal(err)
	}
}
func deliveryTestMessage(t *testing.T, f *fixture, client string) string {
	t.Helper()
	id := f.message(client, "claude-pilot")["id"].(string)
	if _, err := f.s.Pool.Exec(context.Background(), `UPDATE messages SET created_at=clock_timestamp()-interval '5 minutes' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	return id
}
func deliveryTestRows(t *testing.T, f *fixture) map[string]map[string]any {
	t.Helper()
	result := f.expect("GET", "/v1/admin/delivery-alerts", "owner", nil, 200)
	rows := map[string]map[string]any{}
	for _, raw := range result["alerts"].([]any) {
		row := raw.(map[string]any)
		rows[row["message_id"].(string)+"/"+row["recipient_id"].(string)] = row
	}
	if len(rows) != int(result["total"].(float64)) {
		t.Fatal("unexpected limited test snapshot")
	}
	return rows
}
func deliveryTestReport(f *fixture, message, actor, client, event string) map[string]any {
	f.t.Helper()
	in := nativeInput(client, event)
	in.MessageID = &message
	return f.expect("POST", "/v1/channels/general/activity", actor, in, 201)["activity"].(map[string]any)
}
func deliveryTestReply(f *fixture, client, actor, channel, original string, recipients []string) string {
	f.t.Helper()
	return f.expect("POST", "/v1/channels/"+channel+"/messages", actor, map[string]any{"client_id": client, "body": "private fixture reply", "recipient_ids": recipients, "channel_only": len(recipients) == 0, "reply_to": original}, 201)["message"].(map[string]any)["id"].(string)
}

func TestDeliveryPolicyPersistenceCutoffCASAndValidation(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	old := f.message("pre-policy-history", "claude-pilot")["id"].(string)
	initial := f.expect("GET", "/v1/admin/delivery-policy", "owner", nil, 200)["policy"].(map[string]any)
	if initial["enabled"] != false || initial["version"] != float64(0) || initial["enabled_at"] != nil || initial["ack_timeout_seconds"] != float64(300) || initial["reply_timeout_seconds"] != float64(1800) {
		t.Fatal("wrong disabled defaults")
	}
	disabled := f.expect("GET", "/v1/admin/delivery-alerts", "owner", nil, 200)
	if len(disabled["alerts"].([]any)) != 0 || disabled["total"] != float64(0) || disabled["next_cursor"] != nil || disabled["truncated"] != false {
		t.Fatal("disabled policy returned alerts")
	}
	enabled := f.expect("PUT", "/v1/admin/delivery-policy", "owner", deliveryPolicyBody(true, 60, 120, 0), 200)["policy"].(map[string]any)
	cutoff, err := time.Parse(time.RFC3339Nano, enabled["enabled_at"].(string))
	if err != nil {
		t.Fatal(err)
	}
	var oldTime time.Time
	if err = f.s.Pool.QueryRow(context.Background(), `SELECT created_at FROM messages WHERE id=$1`, old).Scan(&oldTime); err != nil || !oldTime.Before(cutoff) {
		t.Fatal("enable cutoff is not server time after old history")
	}
	edited := f.expect("PUT", "/v1/admin/delivery-policy", "owner", deliveryPolicyBody(true, 120, 0, 1), 200)["policy"].(map[string]any)
	if edited["enabled_at"] != enabled["enabled_at"] || edited["version"] != float64(2) {
		t.Fatal("editing enabled policy reset cutoff")
	}
	f.expect("PUT", "/v1/admin/delivery-policy", "owner", deliveryPolicyBody(false, 120, 0, 1), 409)
	for _, body := range []map[string]any{
		{}, {"enabled": nil, "ack_timeout_seconds": 60, "reply_timeout_seconds": 120, "expected_version": 2},
		deliveryPolicyBody(true, 59, 120, 2), deliveryPolicyBody(true, 86401, 0, 2), deliveryPolicyBody(true, 120, 60, 2), deliveryPolicyBody(true, 60, -1, 2), deliveryPolicyBody(true, 60, 604801, 2), deliveryPolicyBody(true, 60, 120, -1),
		{"enabled": true, "ack_timeout_seconds": 60, "reply_timeout_seconds": 120, "expected_version": 2, "extra": true},
	} {
		f.expect("PUT", "/v1/admin/delivery-policy", "owner", body, 400)
	}
	for _, query := range []string{"?extra=1", "?limit=1"} {
		f.expect("GET", "/v1/admin/delivery-policy"+query, "owner", nil, 400)
	}
	f.server.Close()
	f.server = httptest.NewServer((&Server{Store: f.s}).Handler())
	t.Cleanup(f.server.Close)
	if got := f.expect("GET", "/v1/admin/delivery-policy", "owner", nil, 200)["policy"]; !reflect.DeepEqual(got, edited) {
		t.Fatal("policy lost across handler restart")
	}
	if err := f.s.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := f.expect("GET", "/v1/admin/delivery-policy", "owner", nil, 200)["policy"]; !reflect.DeepEqual(got, edited) {
		t.Fatal("migration reset policy")
	}
	f.expect("PUT", "/v1/admin/delivery-policy", "owner", deliveryPolicyBody(false, 120, 0, 2), 200)
	reenabled := f.expect("PUT", "/v1/admin/delivery-policy", "owner", deliveryPolicyBody(true, 120, 0, 3), 200)["policy"].(map[string]any)
	if reenabled["enabled_at"] == enabled["enabled_at"] {
		t.Fatal("re-enable did not establish a new cutoff")
	}
	if rows := deliveryTestRows(t, f); len(rows) != 0 {
		t.Fatal("pre-cutoff history generated alerts")
	}
	var audits int
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM admin_audit WHERE action='delivery_policy.update' AND actor_id='owner' AND target_type='delivery_policy' AND target_id='global' AND details='{}'::jsonb`).Scan(&audits); err != nil || audits != 4 {
		t.Fatal("missing exact content-free policy audits")
	}
}

func TestDeliveryAlertNativeLegacyAndDirectReplySemantics(t *testing.T) {
	f := newFixture(t)
	deliveryTestPolicy(t, f)
	offered := deliveryTestMessage(t, f, "offered-only")
	seen := deliveryTestMessage(t, f, "seen-only")
	accepted := deliveryTestMessage(t, f, "accepted-only")
	delivered := deliveryTestMessage(t, f, "legacy-delivered")
	legacyAccepted := deliveryTestMessage(t, f, "legacy-accepted")
	direct := deliveryTestMessage(t, f, "direct-only")
	wrongAuthor := deliveryTestMessage(t, f, "wrong-author")
	wrongDestination := deliveryTestMessage(t, f, "wrong-destination")
	broadcast := deliveryTestMessage(t, f, "broadcast-reply")
	crossChannel := deliveryTestMessage(t, f, "cross-channel-reply")
	firstOffer := deliveryTestReport(f, offered, "codex-pilot", "offered-first", "inbox.offered")
	deliveryTestReport(f, offered, "codex-pilot", "offered-second", "inbox.offered")
	firstSeen := deliveryTestReport(f, seen, "codex-pilot", "seen-first", "inbox.seen")
	deliveryTestReport(f, seen, "codex-pilot", "seen-second", "inbox.seen")
	acceptedReport := deliveryTestReport(f, accepted, "codex-pilot", "accepted-only", "inbox.accepted")
	f.heartbeat("codex-pilot", "delivery-fixture")
	for _, id := range []string{delivered, legacyAccepted} {
		f.expect("POST", "/v1/messages/"+id+"/receipts", "codex-pilot", map[string]any{"status": "delivered", "session_id": "delivery-fixture"}, 200)
	}
	f.expect("POST", "/v1/messages/"+legacyAccepted+"/receipts", "codex-pilot", map[string]any{"status": "accepted", "session_id": "delivery-fixture"}, 200)
	deliveryTestReply(f, "correct-direct", "codex-pilot", "general", direct, []string{"claude-pilot"})
	deliveryTestReply(f, "incorrect-author", "claude-pilot", "general", wrongAuthor, []string{"claude-pilot"})
	deliveryTestReply(f, "incorrect-destination", "codex-pilot", "general", wrongDestination, []string{"codex-pilot"})
	deliveryTestReply(f, "broadcast", "codex-pilot", "general", broadcast, []string{})
	other := deliveryTestReply(f, "other-channel", "codex-pilot", "general", crossChannel, []string{"claude-pilot"})
	// Simulate a historical anomalous cross-channel reply: it must never clear.
	if _, err := f.s.Pool.Exec(context.Background(), `UPDATE messages SET channel_id='isolated',seq=999 WHERE id=$1`, other); err != nil {
		t.Fatal(err)
	}
	rows := deliveryTestRows(t, f)
	if len(rows) != 9 || rows[direct+"/codex-pilot"] != nil {
		t.Fatalf("expected 9 unresolved pairs, got %d", len(rows))
	}
	for _, id := range []string{offered, wrongAuthor, wrongDestination, broadcast, crossChannel} {
		if rows[id+"/codex-pilot"]["reason"] != "unacknowledged" {
			t.Fatal("nonacknowledgement cleared timeout")
		}
	}
	for _, id := range []string{seen, accepted, delivered, legacyAccepted} {
		if rows[id+"/codex-pilot"]["reason"] != "unanswered" {
			t.Fatal("acknowledged row has wrong priority")
		}
	}
	if rows[offered+"/codex-pilot"]["offered_at"] != firstOffer["created_at"] || rows[seen+"/codex-pilot"]["seen_at"] != firstSeen["created_at"] {
		t.Fatal("first native report changed")
	}
	if rows[accepted+"/codex-pilot"]["accepted_at"] != acceptedReport["created_at"] || rows[accepted+"/codex-pilot"]["seen_at"] != nil || rows[accepted+"/codex-pilot"]["offered_at"] != nil {
		t.Fatal("acceptance invented a native stage")
	}
	for _, id := range []string{delivered, legacyAccepted} {
		row := rows[id+"/codex-pilot"]
		if row["delivered_at"] == nil || row["seen_at"] != nil || row["accepted_at"] != nil {
			t.Fatal("legacy receipt invented native acknowledgement")
		}
	}
	if rows[legacyAccepted+"/codex-pilot"]["legacy_accepted_at"] == nil || rows[delivered+"/codex-pilot"]["legacy_accepted_at"] != nil {
		t.Fatal("legacy stages merged")
	}
	b, _ := json.Marshal(rows)
	if strings.Contains(string(b), "private fixture") || strings.Contains(string(b), "hello") || strings.Contains(string(b), "key_hash") || strings.Contains(string(b), "session_id") {
		t.Fatal("alert exposed content or identity secrets")
	}
	f.expect("PUT", "/v1/admin/delivery-policy", "owner", deliveryPolicyBody(true, 60, 0, 1), 200)
	if rows := deliveryTestRows(t, f); len(rows) != 5 {
		t.Fatal("disabled reply timeout retained acknowledged alerts")
	}
}

func TestDeliveryAlertBoundariesAndCutoff(t *testing.T) {
	f := newFixture(t)
	deliveryTestPolicy(t, f)
	id := f.message("boundary", "claude-pilot")["id"].(string)
	var created time.Time
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT created_at FROM messages WHERE id=$1`, id).Scan(&created); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	tx, err := f.s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	p, err := scanDeliveryPolicy(tx.QueryRow(ctx, `SELECT `+deliveryPolicyColumns+` FROM delivery_alert_policy`))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		at    time.Time
		count int64
	}{{created.Add(60*time.Second - time.Microsecond), 0}, {created.Add(60 * time.Second), 1}} {
		rows, total, err := loadDeliveryAlerts(ctx, tx, p, tc.at, nil, 50)
		if err != nil {
			t.Fatal(err)
		}
		if total != tc.count || int64(len(rows)) != tc.count {
			t.Fatal("ack deadline is not inclusive at the exact server boundary")
		}
		if len(rows) > 0 && !rows[0].DueAt.Equal(created.Add(60*time.Second)) {
			t.Fatal("incorrect due_at")
		}
	}
	p.EnabledAt = &created
	if _, total, err := loadDeliveryAlerts(ctx, tx, p, created.Add(time.Hour), nil, 50); err != nil || total != 1 {
		t.Fatal("message exactly at cutoff excluded")
	}
	later := created.Add(time.Microsecond)
	p.EnabledAt = &later
	if _, total, err := loadDeliveryAlerts(ctx, tx, p, created.Add(time.Hour), nil, 50); err != nil || total != 0 {
		t.Fatal("message before cutoff included")
	}
	_ = tx.Rollback(ctx)
	deliveryTestReport(f, id, "codex-pilot", "boundary-seen", "inbox.seen")
	tx, err = f.s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	p.EnabledAt = &created
	for _, tc := range []struct {
		at    time.Time
		count int64
	}{{created.Add(120*time.Second - time.Microsecond), 0}, {created.Add(120 * time.Second), 1}} {
		rows, total, err := loadDeliveryAlerts(ctx, tx, p, tc.at, nil, 50)
		if err != nil {
			t.Fatal(err)
		}
		if total != tc.count {
			t.Fatal("reply deadline boundary incorrect")
		}
		if len(rows) > 0 && (rows[0].Reason != "unanswered" || !rows[0].DueAt.Equal(created.Add(120*time.Second))) {
			t.Fatal("reply due time must be from original creation, not ack time")
		}
	}
}

func TestDeliveryAlertsRecipientBindingRevocationAndReadOnly(t *testing.T) {
	f := newFixture(t)
	deliveryTestPolicy(t, f)
	id := deliveryTestMessage(t, f, "unresolved-offline-recipient")
	f.expect("POST", "/v1/channels/general/activity", "claude-pilot", func() nativeActivityInput {
		in := nativeInput("wrong-recipient", "inbox.seen")
		in.MessageID = &id
		return in
	}(), 404)
	// A legacy anomalous nonrecipient report is still ignored by the aggregate.
	if _, err := f.s.Pool.Exec(context.Background(), `INSERT INTO native_activity(id,channel_id,seq,actor_id,client_id,session_id,runtime,event_type,message_id,request_hash) VALUES('foreign-ack','general',1000,'claude-pilot','foreign-ack','fixture','claude','inbox.accepted',$1,decode('00','hex'))`, id); err != nil {
		t.Fatal(err)
	}
	f.access("codex-pilot", "channel", "general", "none", 200)
	f.expect("POST", "/v1/admin/principals/codex-pilot/revoke-key", "owner", map[string]any{}, 200)
	const snapshot = `SELECT json_build_object('messages',(SELECT json_agg(m ORDER BY id) FROM messages m),'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r),'native',(SELECT json_agg(n ORDER BY id) FROM native_activity n),'events',(SELECT json_agg(e ORDER BY channel_id,seq) FROM events e),'principals',(SELECT json_agg(p ORDER BY id) FROM principals p),'audit',(SELECT json_agg(a ORDER BY id) FROM admin_audit a),'reads',(SELECT json_agg(r ORDER BY principal_id,channel_id) FROM navigation_reads r))::text`
	before := f.snapshot(snapshot)
	rows := deliveryTestRows(t, f)
	if len(rows) != 1 || rows[id+"/codex-pilot"]["reason"] != "unacknowledged" {
		t.Fatal("revoked/offline recipient silently disappeared or got foreign ack")
	}
	if before != f.snapshot(snapshot) {
		t.Fatal("read-only alert inspection mutated journal/state")
	}
	for _, actor := range []string{"claude-pilot", "viewer-pilot", "deny-pilot", ""} {
		want := 403
		if actor == "" {
			want = 401
		}
		for _, route := range []struct {
			method, path string
			body         any
		}{{"GET", "/v1/admin/delivery-alerts", nil}, {"GET", "/v1/admin/delivery-policy", nil}, {"PUT", "/v1/admin/delivery-policy", deliveryPolicyBody(true, 60, 120, 1)}} {
			f.expect(route.method, route.path, actor, route.body, want)
		}
	}
	server := &Server{Store: f.s}
	invoke := func(actor, key string, handler http.HandlerFunc) int {
		req := httptest.NewRequest("GET", "/v1/admin/delivery-alerts", nil)
		req.Header.Set("Authorization", "Bearer "+key)
		req = req.WithContext(context.WithValue(req.Context(), contextKey{}, Principal{ID: actor, Kind: "owner"}))
		response := httptest.NewRecorder()
		handler(response, req)
		return response.Code
	}
	if got := invoke("viewer-pilot", f.keys["viewer-pilot"], server.adminDeliveryAlerts); got != 403 {
		t.Fatal("stale middleware role elevated viewer")
	}
	f.owner("backup-owner")
	oldKey := f.keys["owner"]
	if err := f.s.Revoke(context.Background(), "owner"); err != nil {
		t.Fatal(err)
	}
	for _, handler := range []http.HandlerFunc{server.adminDeliveryAlerts, server.adminDeliveryPolicy} {
		if got := invoke("owner", oldKey, handler); got != 401 {
			t.Fatal("revoked owner accepted after stale preauthentication")
		}
	}
}

func TestDeliveryPolicyConcurrentCASAndAuditRollback(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, _ := f.request("PUT", "/v1/admin/delivery-policy", "owner", deliveryPolicyBody(true, 60, 120, 0))
			codes <- code
		}()
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatal("concurrent CAS did not elect exactly one policy write")
	}
	before := f.expect("GET", "/v1/admin/delivery-policy", "owner", nil, 200)["policy"]
	if _, err := f.s.Pool.Exec(context.Background(), `CREATE FUNCTION reject_delivery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='delivery_policy.update' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_delivery_audit BEFORE INSERT ON admin_audit FOR EACH ROW EXECUTE FUNCTION reject_delivery_audit()`); err != nil {
		t.Fatal(err)
	}
	f.expect("PUT", "/v1/admin/delivery-policy", "owner", deliveryPolicyBody(false, 60, 0, 1), 500)
	if after := f.expect("GET", "/v1/admin/delivery-policy", "owner", nil, 200)["policy"]; !reflect.DeepEqual(before, after) {
		t.Fatal("audit failure committed policy")
	}
}

func TestDeliveryAlertsCursorAndLifecycle(t *testing.T) {
	f := newFixture(t)
	deliveryTestPolicy(t, f)
	ids := []string{}
	for i := 0; i < 5; i++ {
		ids = append(ids, deliveryTestMessage(t, f, fmt.Sprintf("paging-%d", i)))
	}
	// Equal timestamps require both message and recipient keyset tiebreakers.
	if _, err := f.s.Pool.Exec(context.Background(), `UPDATE messages SET created_at=statement_timestamp()-interval '5 minutes' WHERE id=ANY($1)`, ids); err != nil {
		t.Fatal(err)
	}
	multi := f.expect("POST", "/v1/channels/general/messages", "claude-pilot", map[string]any{"client_id": "multi-page", "body": "private", "recipient_ids": []string{"claude-pilot", "codex-pilot"}}, 201)["message"].(map[string]any)["id"].(string)
	if _, err := f.s.Pool.Exec(context.Background(), `UPDATE messages SET created_at=(SELECT created_at FROM messages WHERE id=$1) WHERE id=$2`, ids[0], multi); err != nil {
		t.Fatal(err)
	}
	first := f.expect("GET", "/v1/admin/delivery-alerts?limit=1", "owner", nil, 200)
	if first["total"] != float64(7) || first["truncated"] != true || first["next_cursor"] == nil {
		t.Fatal("bad first page counts")
	}
	if first["as_of"] != first["generated_at"] {
		t.Fatal("first page has inconsistent deadline window")
	}
	cursor := first["next_cursor"].(string)
	previous := ""
	seen := map[string]bool{}
	page := first
	for {
		for _, raw := range page["alerts"].([]any) {
			row := raw.(map[string]any)
			key := row["message_id"].(string) + "/" + row["recipient_id"].(string)
			if seen[key] || key <= previous {
				t.Fatal("keyset duplicates or unstable tie ordering")
			}
			seen[key] = true
			previous = key
		}
		if page["as_of"] != first["as_of"] {
			t.Fatal("pagination changed deadline window")
		}
		if page["next_cursor"] == nil {
			break
		}
		page = f.expect("GET", "/v1/admin/delivery-alerts?limit=1&cursor="+url.QueryEscape(page["next_cursor"].(string)), "owner", nil, 200)
	}
	if len(seen) != 7 {
		t.Fatal("cursor lost equal-time recipients")
	}
	f.server.Close()
	f.server = httptest.NewServer((&Server{Store: f.s}).Handler())
	t.Cleanup(f.server.Close)
	f.expect("GET", "/v1/admin/delivery-alerts?cursor="+url.QueryEscape(cursor), "owner", nil, 200)
	// A later fresh page can include newly eligible messages; an old cursor must
	// keep its original server-time message/deadline window across restarts.
	newID := f.message("new-window", "claude-pilot")["id"].(string)
	if _, err := f.s.Pool.Exec(context.Background(), `UPDATE messages SET created_at=clock_timestamp()+interval '60 seconds' WHERE id=$1`, newID); err != nil {
		t.Fatal(err)
	}
	oldWindow := f.expect("GET", "/v1/admin/delivery-alerts?cursor="+url.QueryEscape(cursor), "owner", nil, 200)
	if oldWindow["total"] != float64(7) || oldWindow["as_of"] != first["as_of"] {
		t.Fatal("cursor deadline window drifted after restart")
	}
	f.owner("another-owner")
	f.expect("GET", "/v1/admin/delivery-alerts?cursor="+url.QueryEscape(cursor), "another-owner", nil, 400)
	for _, query := range []string{"limit=0", "limit=101", "limit=1&limit=2", "cursor=", "cursor=bad", "unknown=1", "cursor=" + strings.Repeat("a", 2049)} {
		f.expect("GET", "/v1/admin/delivery-alerts?"+query, "owner", nil, 400)
	}
	decoded, ok := decodeDeliveryCursor(cursor, f.keys["owner"], "owner")
	if !ok {
		t.Fatal("server cursor not decodable")
	}
	decoded.AsOf = time.Now().Add(time.Hour)
	future := encodeDeliveryCursor(decoded, f.keys["owner"])
	f.expect("GET", "/v1/admin/delivery-alerts?cursor="+url.QueryEscape(future), "owner", nil, 400)
	// A reply received after the first page still removes its alert on later pages.
	deliveryTestReply(f, "page-cleared", "codex-pilot", "general", ids[0], []string{"claude-pilot"})
	changed := f.expect("GET", "/v1/admin/delivery-alerts?cursor="+url.QueryEscape(cursor), "owner", nil, 200)
	if changed["total"] != float64(6) {
		t.Fatal("later page ignored new durable answer")
	}
	f.expect("PUT", "/v1/admin/delivery-policy", "owner", deliveryPolicyBody(true, 60, 0, 1), 200)
	f.expect("GET", "/v1/admin/delivery-alerts?cursor="+url.QueryEscape(cursor), "owner", nil, 409)
	f.expect("POST", "/v1/admin/projects/pilot/archive", "owner", map[string]any{}, 200)
	if rows := deliveryTestRows(t, f); len(rows) != 0 {
		t.Fatal("archived project visible in active alerts")
	}
	f.expect("POST", "/v1/admin/projects/pilot/restore", "owner", map[string]any{}, 200)
	if rows := deliveryTestRows(t, f); len(rows) != 6 {
		t.Fatal("restoration lost unresolved facts")
	}
	f.expect("POST", "/v1/admin/projects/pilot/archive", "owner", map[string]any{}, 200)
	preview := f.expect("GET", "/v1/admin/projects/pilot/deletion-preview", "owner", nil, 200)
	project := preview["project"].(map[string]any)
	f.expect("DELETE", "/v1/admin/projects/pilot", "owner", map[string]any{"confirm_id": "pilot", "expected_version": project["lifecycle_version"]}, 200)
	if rows := deliveryTestRows(t, f); len(rows) != 0 {
		t.Fatal("deleted project retained derived alerts")
	}
	if got := f.expect("GET", "/v1/admin/delivery-policy", "owner", nil, 200)["policy"].(map[string]any)["version"]; got != float64(2) {
		t.Fatal("project deletion modified global policy")
	}
}

func TestDeliveryPolicyMigrationPreservesJournal(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	f.message("existing-before-migration", "claude-pilot")
	f.heartbeat("codex-pilot", "migration-lease")
	const snapshot = `SELECT json_build_object('principals',(SELECT json_agg(p ORDER BY id) FROM principals p),'messages',(SELECT json_agg(m ORDER BY id) FROM messages m),'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r),'events',(SELECT json_agg(e ORDER BY channel_id,seq) FROM events e),'members',(SELECT json_agg(m ORDER BY channel_id,agent_id) FROM channel_members m),'audit',(SELECT json_agg(a ORDER BY id) FROM admin_audit a))::text`
	before := f.snapshot(snapshot)
	if _, err := f.s.Pool.Exec(context.Background(), `DROP TABLE delivery_alert_policy; DROP INDEX messages_delivery_deadline; DROP INDEX messages_direct_reply`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := f.s.Migrate(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if before != f.snapshot(snapshot) {
		t.Fatal("additive migration changed journal, identities, receipts, memberships or audit")
	}
	p := f.expect("GET", "/v1/admin/delivery-policy", "owner", nil, 200)["policy"].(map[string]any)
	if p["enabled"] != false || p["version"] != float64(0) || p["enabled_at"] != nil {
		t.Fatal("migration did not establish disabled policy")
	}
}
