package link

import (
	"context"
	"sync"
	"testing"
	"time"
)

func seconds(n int) *time.Time {
	t := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC).Add(-time.Duration(n) * time.Second)
	return &t
}

func intp(v int) *int { return &v }

func TestClassifyLivenessThresholds(t *testing.T) {
	asOf := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	loop := &WakeProfile{Mode: "loop", ExpectedResponseSeconds: intp(60), ExpectedContactSeconds: intp(130)}
	tmuxNoPromise := &WakeProfile{Mode: "tmux", ExpectedResponseSeconds: intp(60)}
	cases := []struct {
		name                         string
		age                          int
		profile                      *WakeProfile
		complete, blocked            bool
		wantState, wantReason        string
		noContact, futureBeyondSlack bool
	}{
		{name: "never seen", noContact: true, complete: true, wantState: "unknown", wantReason: "no_contact"},
		{name: "future timestamp is an anomaly", futureBeyondSlack: true, profile: loop, complete: true, wantState: "unknown", wantReason: "clock_anomaly"},
		{name: "loop alive at boundary (130+33)", age: 163, profile: loop, complete: true, wantState: "alive"},
		{name: "loop silent just past boundary", age: 164, profile: loop, complete: true, wantState: "silent"},
		{name: "loop still silent at dead threshold (3*130+33)", age: 423, profile: loop, complete: true, wantState: "silent"},
		{name: "loop dead past threshold", age: 424, profile: loop, complete: true, wantState: "dead"},
		{name: "partial visibility never concludes stale", age: 9999, profile: loop, complete: false, wantState: "unknown", wantReason: "partial_visibility"},
		{name: "blocked reporting never concludes dead", age: 9999, profile: loop, complete: true, blocked: true, wantState: "unknown", wantReason: "reporting_blocked"},
		{name: "no profile: alive within 300+75", age: 375, complete: true, wantState: "alive"},
		{name: "no profile: quiet is idle, never silent or dead", age: 100000, complete: true, wantState: "idle"},
		{name: "tmux without cadence promise: idle, never dead", age: 100000, profile: tmuxNoPromise, complete: true, wantState: "idle"},
		{name: "tmux uses its response time as the alive window", age: 90, profile: tmuxNoPromise, complete: true, wantState: "alive"},
		{name: "partial visibility does not hide a recent contact", age: 10, profile: loop, complete: false, wantState: "alive"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var last *time.Time
			switch {
			case c.noContact:
			case c.futureBeyondSlack:
				future := asOf.Add(2 * time.Minute)
				last = &future
			default:
				last = seconds(c.age)
			}
			state, reason := classifyLiveness(last, asOf, c.profile, c.complete, c.blocked)
			if state != c.wantState || reason != c.wantReason {
				t.Fatalf("got %s/%s want %s/%s", state, reason, c.wantState, c.wantReason)
			}
		})
	}
}

func TestValidWakeProfile(t *testing.T) {
	version := int64(0)
	good := []wakeProfileInput{
		{Mode: "unknown", ExpectedVersion: &version},
		{Mode: "loop", ExpectedResponseSeconds: intp(60), ExpectedContactSeconds: intp(130), ExpectedVersion: &version},
		{Mode: "tmux", ExpectedResponseSeconds: intp(30), ExpectedVersion: &version},
		{Mode: "tmux", ExpectedResponseSeconds: intp(30), ExpectedContactSeconds: intp(15), ExpectedVersion: &version},
		{Mode: "on_demand", ExpectedResponseSeconds: intp(86400), ExpectedVersion: &version},
	}
	bad := map[string]wakeProfileInput{
		"missing version":              {Mode: "unknown"},
		"negative version":             {Mode: "unknown", ExpectedVersion: func() *int64 { v := int64(-1); return &v }()},
		"unknown mode":                 {Mode: "daemon", ExpectedResponseSeconds: intp(60), ExpectedVersion: &version},
		"unknown with response":        {Mode: "unknown", ExpectedResponseSeconds: intp(60), ExpectedVersion: &version},
		"loop without contact":         {Mode: "loop", ExpectedResponseSeconds: intp(60), ExpectedVersion: &version},
		"loop without response":        {Mode: "loop", ExpectedContactSeconds: intp(60), ExpectedVersion: &version},
		"on_demand with contact":       {Mode: "on_demand", ExpectedResponseSeconds: intp(60), ExpectedContactSeconds: intp(60), ExpectedVersion: &version},
		"response below minimum":       {Mode: "tmux", ExpectedResponseSeconds: intp(29), ExpectedVersion: &version},
		"response above maximum":       {Mode: "tmux", ExpectedResponseSeconds: intp(86401), ExpectedVersion: &version},
		"contact below minimum":        {Mode: "loop", ExpectedResponseSeconds: intp(60), ExpectedContactSeconds: intp(14), ExpectedVersion: &version},
		"contact above maximum":        {Mode: "loop", ExpectedResponseSeconds: intp(60), ExpectedContactSeconds: intp(86401), ExpectedVersion: &version},
		"on_demand without a response": {Mode: "on_demand", ExpectedVersion: &version},
	}
	for i, in := range good {
		if !validWakeProfile(in) {
			t.Errorf("valid profile %d rejected", i)
		}
	}
	for name, in := range bad {
		if validWakeProfile(in) {
			t.Errorf("invalid profile accepted: %s", name)
		}
	}
}

func findAgentRow(t *testing.T, listing map[string]any, id string) map[string]any {
	t.Helper()
	for _, item := range listing["agents"].([]any) {
		if row := item.(map[string]any); row["id"] == id {
			return row
		}
	}
	t.Fatalf("agent %s not visible", id)
	return nil
}

func TestWakeProfileWriteReadAuthorizationAndAudit(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	path := "/v1/projects/pilot/agents/codex-pilot/wake-profile"
	loop := func(version int64) map[string]any {
		return map[string]any{"mode": "loop", "expected_response_seconds": 60, "expected_contact_seconds": 130, "expected_version": version}
	}
	f.expect("PUT", path, "", loop(0), 401)
	f.expect("PUT", path, "claude-pilot", loop(0), 404) // an agent may only describe itself
	f.expect("PUT", path, "viewer-pilot", loop(0), 403)
	f.expect("PUT", "/v1/projects/pilot/agents/deny-pilot/wake-profile", "owner", loop(0), 404) // not a member of the project
	f.expect("PUT", "/v1/projects/pilot/agents/nobody/wake-profile", "owner", loop(0), 404)
	f.expect("PUT", "/v1/projects/isolated/agents/codex-pilot/wake-profile", "owner", loop(0), 404)
	for name, body := range map[string]map[string]any{
		"mode loop without contact": {"mode": "loop", "expected_response_seconds": 60, "expected_version": 0},
		"missing version":           {"mode": "unknown"},
		"extra field":               {"mode": "unknown", "expected_version": 0, "command": "rm -rf /"},
		"response out of range":     {"mode": "tmux", "expected_response_seconds": 5, "expected_version": 0},
	} {
		if status, _ := f.request("PUT", path, "codex-pilot", body); status != 400 {
			t.Errorf("%s: status %d want 400", name, status)
		}
	}
	before := f.snapshot(`SELECT json_build_object('seen',(SELECT json_agg(p.last_seen_at ORDER BY p.id) FROM principals p),'activity',(SELECT json_agg(n ORDER BY id) FROM native_activity n))::text`)
	created := f.expect("PUT", path, "codex-pilot", loop(0), 201)["wake_profile"].(map[string]any)
	if created["version"] != float64(1) || created["set_by"] != "self" || created["mode"] != "loop" {
		t.Fatalf("created profile wrong: %v", created)
	}
	f.expect("PUT", path, "codex-pilot", loop(0), 409) // stale/zero version after creation
	updated := f.expect("PUT", path, "owner", loop(1), 200)["wake_profile"].(map[string]any)
	if updated["version"] != float64(2) || updated["set_by"] != "owner" {
		t.Fatalf("owner update wrong: %v", updated)
	}
	if after := f.snapshot(`SELECT json_build_object('seen',(SELECT json_agg(p.last_seen_at ORDER BY p.id) FROM principals p),'activity',(SELECT json_agg(n ORDER BY id) FROM native_activity n))::text`); after != before {
		t.Fatal("a profile edit changed heartbeat/lease state or created native activity")
	}
	read := f.expect("GET", path, "claude-pilot", nil, 200)
	if read["wake_profile"].(map[string]any)["version"] != float64(2) {
		t.Fatalf("shared-channel peer cannot read the profile: %v", read)
	}
	live := read["liveness"].(map[string]any)
	if live["state"] != "unknown" || live["reason"] != "no_contact" {
		t.Fatalf("a profile edit must never count as contact: %v", live)
	}
	f.expect("GET", path, "deny-pilot", nil, 404)
	var audits int
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM admin_audit WHERE action='agent.wake_profile.set' AND target_id='codex-pilot'`).Scan(&audits); err != nil || audits != 2 {
		t.Fatalf("expected two audit rows, got %d (%v)", audits, err)
	}
}

func TestAgentDirectoryLivenessIsAdditiveAndObservedOnly(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	list := func() map[string]any {
		return findAgentRow(t, f.expect("GET", "/v1/projects/pilot/agents", "claude-pilot", nil, 200), "codex-pilot")
	}
	row := list()
	if row["freshness"] != "unknown" || row["liveness"].(map[string]any)["state"] != "unknown" || row["wake_profile"] != nil {
		t.Fatalf("initial row wrong: %v", row)
	}
	f.message("addressed-to-codex", "claude-pilot") // addressed TO the agent is not its contact
	if list()["liveness"].(map[string]any)["state"] != "unknown" {
		t.Fatal("a message addressed to the agent counted as its contact")
	}
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", nativeInput("turn", "turn.started"), 201)
	live := list()["liveness"].(map[string]any)
	if live["state"] != "alive" || live["source"] != "native_activity" || live["scope"] != "complete" {
		t.Fatalf("native activity must make the agent alive: %v", live)
	}
	if list()["freshness"] != "unknown" {
		t.Fatal("native activity changed legacy freshness/lease semantics")
	}
	age := func(interval string) {
		t.Helper()
		if _, err := f.s.Pool.Exec(ctx, `UPDATE native_activity SET created_at=clock_timestamp()-$1::interval`, interval); err != nil {
			t.Fatal(err)
		}
	}
	age("10 minutes")
	// inbox.offered is connector delivery, not readiness: it must not revive a quiet agent.
	messageID := f.message("offer-target", "claude-pilot")["id"].(string)
	offered := nativeInput("offered", "inbox.offered")
	offered.MessageID = &messageID
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", offered, 201)
	if state := list()["liveness"].(map[string]any)["state"]; state != "idle" {
		t.Fatalf("offer-only activity must leave a quiet unpromised agent idle, got %v", state)
	}
	f.expect("PUT", "/v1/projects/pilot/agents/codex-pilot/wake-profile", "codex-pilot",
		map[string]any{"mode": "loop", "expected_response_seconds": 60, "expected_contact_seconds": 60, "expected_version": 0}, 201)
	dead := list()
	if dead["liveness"].(map[string]any)["state"] != "dead" || dead["wake_profile"].(map[string]any)["mode"] != "loop" {
		t.Fatalf("a missed promised cadence must be dead: %v", dead)
	}
	// A full telemetry quota explains silence: never conclude dead from it.
	if _, err := f.s.Pool.Exec(ctx, `INSERT INTO native_activity(id,channel_id,seq,actor_id,client_id,session_id,runtime,event_type,request_hash,created_at)
 SELECT 'old-'||n,'general',100000+n,'codex-pilot','old-'||n,'session','codex','agent.waiting',decode('00','hex'),clock_timestamp()-interval '1 day' FROM generate_series(1,10000) n;
 UPDATE channels SET cursor=110000 WHERE id='general'`); err != nil {
		t.Fatal(err)
	}
	blocked := list()["liveness"].(map[string]any)
	if blocked["state"] != "unknown" || blocked["reason"] != "reporting_blocked" {
		t.Fatalf("quota-blocked telemetry must be unknown, got %v", blocked)
	}
	// ...while an authored message still proves contact even with telemetry full.
	f.expect("POST", "/v1/channels/general/messages", "codex-pilot", map[string]any{"client_id": "reply", "body": "still here", "recipient_ids": []string{"claude-pilot"}}, 201)
	if again := list()["liveness"].(map[string]any); again["state"] != "alive" || again["source"] != "message" {
		t.Fatalf("an authored message must prove contact when telemetry is full: %v", again)
	}
	f.heartbeat("codex-pilot", "legacy-session")
	if list()["freshness"] != "fresh" {
		t.Fatal("legacy heartbeat freshness regressed")
	}
}

func TestLivenessNeverUsesChannelsTheCallerCannotSee(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": "codex-private", "project_id": "pilot", "name": "private"}, 201)
	f.access("codex-pilot", "channel", "codex-private", "write", 200)
	path := "/v1/projects/pilot/agents"
	f.expect("PUT", path+"/codex-pilot/wake-profile", "codex-pilot",
		map[string]any{"mode": "loop", "expected_response_seconds": 60, "expected_contact_seconds": 60, "expected_version": 0}, 201)
	f.expect("POST", "/v1/channels/codex-private/messages", "codex-pilot", map[string]any{"client_id": "hidden-contact", "body": "private", "recipient_ids": []string{"codex-pilot"}}, 201)
	peer := findAgentRow(t, f.expect("GET", path, "claude-pilot", nil, 200), "codex-pilot")["liveness"].(map[string]any)
	if peer["scope"] != "partial" || peer["last_contact_at"] != nil || peer["state"] != "unknown" {
		t.Fatalf("a hidden-channel message leaked into the peer's view: %v", peer)
	}
	owner := findAgentRow(t, f.expect("GET", path, "owner", nil, 200), "codex-pilot")["liveness"].(map[string]any)
	if owner["scope"] != "complete" || owner["state"] != "alive" {
		t.Fatalf("the owner must see complete scope and the contact: %v", owner)
	}
	// Quiet for a long time: the partially-informed peer may not claim silence or death.
	if _, err := f.s.Pool.Exec(context.Background(), `UPDATE messages SET created_at=clock_timestamp()-interval '1 hour'`); err != nil {
		t.Fatal(err)
	}
	peer = findAgentRow(t, f.expect("GET", path, "claude-pilot", nil, 200), "codex-pilot")["liveness"].(map[string]any)
	if peer["state"] == "dead" || peer["state"] == "silent" {
		t.Fatalf("a peer with incomplete visibility must not conclude %v", peer["state"])
	}
	owner = findAgentRow(t, f.expect("GET", path, "owner", nil, 200), "codex-pilot")["liveness"].(map[string]any)
	if owner["state"] != "dead" {
		t.Fatalf("with complete visibility the missed cadence is dead, got %v", owner)
	}
}

func TestHeartbeatOnlyContactIsLabelledAsLegacy(t *testing.T) {
	f := newFixture(t)
	f.heartbeat("codex-pilot", "hb-session")
	row := findAgentRow(t, f.expect("GET", "/v1/projects/pilot/agents", "claude-pilot", nil, 200), "codex-pilot")
	live := row["liveness"].(map[string]any)
	if live["state"] != "alive" || live["source"] != "legacy_heartbeat" || row["freshness"] != "fresh" {
		t.Fatalf("heartbeat-only contact wrong: %v / %v", live, row["freshness"])
	}
}

func TestEvidenceQuotaExhaustionAlsoBlocksANegativeVerdict(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.expect("PUT", "/v1/projects/pilot/agents/codex-pilot/wake-profile", "codex-pilot",
		map[string]any{"mode": "loop", "expected_response_seconds": 60, "expected_contact_seconds": 60, "expected_version": 0}, 201)
	messageID := f.message("evidence-block", "claude-pilot")["id"].(string)
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", nativeInput("turn", "turn.started"), 201)
	if _, err := f.s.Pool.Exec(ctx, `UPDATE native_activity SET created_at=clock_timestamp()-interval '30 minutes'`); err != nil {
		t.Fatal(err)
	}
	row := func() map[string]any {
		return findAgentRow(t, f.expect("GET", "/v1/projects/pilot/agents", "claude-pilot", nil, 200), "codex-pilot")["liveness"].(map[string]any)
	}
	if row()["state"] != "dead" {
		t.Fatalf("with room in both quotas the missed cadence is dead, got %v", row())
	}
	// Only the delivery-evidence bucket is full; telemetry still has room. Reports of
	// seen/accepted would be refused, so silence is not proof of death.
	if _, err := f.s.Pool.Exec(ctx, `INSERT INTO native_activity(id,channel_id,seq,actor_id,client_id,session_id,runtime,event_type,message_id,request_hash,created_at)
 SELECT 'ev-'||n,'general',100000+n,'codex-pilot','ev-'||n,'session','codex','inbox.seen',$1,decode('00','hex'),clock_timestamp()-interval '1 day' FROM generate_series(1,10000) n`, messageID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Pool.Exec(ctx, `UPDATE channels SET cursor=110000 WHERE id='general'`); err != nil {
		t.Fatal(err)
	}
	if got := row(); got["state"] != "unknown" || got["reason"] != "reporting_blocked" {
		t.Fatalf("a full evidence quota must block a negative verdict, got %v", got)
	}
}

func TestConcurrentFirstProfileWritesLetExactlyOneWin(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	path := "/v1/projects/pilot/agents/codex-pilot/wake-profile"
	body := map[string]any{"mode": "tmux", "expected_response_seconds": 60, "expected_version": 0}
	var wg sync.WaitGroup
	statuses := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(actor string) {
			defer wg.Done()
			status, _ := f.request("PUT", path, actor, body)
			statuses <- status
		}([]string{"codex-pilot", "owner"}[i%2])
	}
	wg.Wait()
	close(statuses)
	created, conflicts := 0, 0
	for status := range statuses {
		switch status {
		case 201:
			created++
		case 409:
			conflicts++
		default:
			t.Fatalf("unexpected status %d", status)
		}
	}
	if created != 1 || conflicts != 7 {
		t.Fatalf("expected one creator and seven version conflicts, got %d/%d", created, conflicts)
	}
	var version int64
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT version FROM agent_wake_profiles WHERE agent_id='codex-pilot'`).Scan(&version); err != nil || version != 1 {
		t.Fatalf("profile must be at version 1, got %d (%v)", version, err)
	}
}

func TestProfileWritesRespectRevokedKeysAndArchivedProjects(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	path := "/v1/projects/pilot/agents/codex-pilot/wake-profile"
	body := map[string]any{"mode": "tmux", "expected_response_seconds": 60, "expected_version": 0}
	oldKey := f.keys["codex-pilot"]
	if _, err := f.s.Pool.Exec(context.Background(), `UPDATE principals SET key_hash=decode('00','hex') WHERE id='codex-pilot'`); err != nil {
		t.Fatal(err)
	}
	f.expect("PUT", path, "codex-pilot", body, 401)
	f.expect("GET", path, "codex-pilot", nil, 401)
	f.expect("GET", "/v1/projects/pilot/agents", "codex-pilot", nil, 401)
	f.keys["codex-pilot"] = oldKey
	if _, err := f.s.Pool.Exec(context.Background(), `UPDATE principals SET key_hash=decode($1,'hex') WHERE id='codex-pilot'`, hexOfDigest(oldKey)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Pool.Exec(context.Background(), `UPDATE projects SET archived_at=clock_timestamp() WHERE id='pilot'`); err != nil {
		t.Fatal(err)
	}
	f.expect("PUT", path, "codex-pilot", body, 404)
	f.expect("PUT", path, "owner", body, 404)
}

func hexOfDigest(key string) string {
	sum := digest(key)
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(sum)*2)
	for _, b := range sum {
		out = append(out, digits[b>>4], digits[b&15])
	}
	return string(out)
}
