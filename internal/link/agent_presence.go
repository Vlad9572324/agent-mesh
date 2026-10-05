package link

import (
	"context"
	_ "embed"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed agent_presence_schema.sql
var agentPresenceSchema string

// A wake profile is a bounded, untrusted declaration of how an agent is reached and
// how often it promises to make contact. It never carries commands, paths or tmux
// targets, never verifies a runtime, and never changes lease/heartbeat state.
type WakeProfile struct {
	Mode                    string    `json:"mode"`
	ExpectedResponseSeconds *int      `json:"expected_response_seconds"`
	ExpectedContactSeconds  *int      `json:"expected_contact_seconds"`
	Version                 int64     `json:"version"`
	UpdatedAt               time.Time `json:"updated_at"`
	SetBy                   string    `json:"set_by"`
}

// Liveness is observed contact, never proof that a model is running. State is one of
// unknown, alive, idle (no contact promise, quiet), silent, dead (promised cadence missed).
type Liveness struct {
	State         string     `json:"state"`
	LastContactAt *time.Time `json:"last_contact_at"`
	AsOf          time.Time  `json:"as_of"`
	Source        string     `json:"source"`
	Scope         string     `json:"scope"`
	Reason        string     `json:"reason"`
}

const (
	defaultContactBaseSeconds = 300
	clockAnomalyTolerance     = 60 * time.Second
)

func presenceJitter(base int) int {
	if jitter := (base + 3) / 4; jitter > 30 {
		return jitter
	}
	return 30
}

// classifyLiveness is deliberately pure. Idle agents without a contact promise are
// never called silent or dead; negative conclusions need a promise, complete
// visibility of the channels the agent can report to, and a usable reporting path.
func classifyLiveness(last *time.Time, asOf time.Time, profile *WakeProfile, complete, reportingBlocked bool) (state, reason string) {
	if last == nil {
		return "unknown", "no_contact"
	}
	if last.After(asOf.Add(clockAnomalyTolerance)) {
		return "unknown", "clock_anomaly"
	}
	age := asOf.Sub(*last)
	if age < 0 {
		age = 0
	}
	base := defaultContactBaseSeconds
	promise := profile != nil && profile.ExpectedContactSeconds != nil
	if promise {
		base = *profile.ExpectedContactSeconds
	} else if profile != nil && profile.ExpectedResponseSeconds != nil {
		base = *profile.ExpectedResponseSeconds
	}
	if age <= time.Duration(base+presenceJitter(base))*time.Second {
		return "alive", ""
	}
	if !promise {
		return "idle", ""
	}
	if !complete {
		return "unknown", "partial_visibility"
	}
	if reportingBlocked {
		return "unknown", "reporting_blocked"
	}
	if age > time.Duration(3*base+presenceJitter(base))*time.Second {
		return "dead", ""
	}
	return "silent", ""
}

// observeLiveness reads the newest eligible contact among the given visible channels.
// Eligible: native lifecycle/tool/waiting/seen/accepted reports, authored messages, and
// the agent's own legacy heartbeat. Not eligible: inbox.offered (connector delivery, not
// readiness), messages addressed to the agent, profile edits and rejected writes.
func observeLiveness(ctx context.Context, q querier, agentID string, channels []string, total int, profile *WakeProfile, asOf time.Time) (Liveness, error) {
	result := Liveness{State: "unknown", AsOf: asOf, Source: "none", Scope: "partial", Reason: "no_contact"}
	complete := len(channels) == total
	if complete {
		result.Scope = "complete"
	}
	var last *time.Time
	var source *string
	// Per-channel indexed latest-row lookups (LIMIT 1), never max() over history.
	err := q.QueryRow(ctx, `SELECT t,src FROM (
 SELECT (SELECT n.created_at FROM native_activity n WHERE n.channel_id=ch AND n.actor_id=$2 AND n.event_type<>'inbox.offered' ORDER BY n.created_at DESC,n.id DESC LIMIT 1) t,'native_activity' src FROM unnest($1::text[]) ch
 UNION ALL SELECT (SELECT m.created_at FROM messages m WHERE m.channel_id=ch AND m.author_id=$2 ORDER BY m.created_at DESC,m.id DESC LIMIT 1),'message' FROM unnest($1::text[]) ch
 UNION ALL SELECT last_seen_at,'legacy_heartbeat' FROM principals WHERE id=$2
) x WHERE t IS NOT NULL ORDER BY t DESC LIMIT 1`, channels, agentID).Scan(&last, &source)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	if source != nil {
		result.Source = *source
	}
	result.LastContactAt = last
	result.State, result.Reason = classifyLiveness(last, asOf, profile, complete, false)
	if complete && (result.State == "silent" || result.State == "dead") {
		// A full quota explains silence. Telemetry and delivery evidence are bounded
		// separately (nativeActivityQuota / nativeEvidenceQuota); either can block reports.
		var blocked bool
		if err = q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM (SELECT (message_id IS NOT NULL) AS evidence,count(*) AS n FROM native_activity
 WHERE channel_id=ANY($1) GROUP BY channel_id,1) q WHERE n >= CASE WHEN evidence THEN $3::bigint ELSE $2::bigint END)`,
			channels, int64(nativeActivityQuota), int64(nativeEvidenceQuota)).Scan(&blocked); err != nil {
			return result, err
		}
		if blocked {
			result.State, result.Reason = classifyLiveness(last, asOf, profile, complete, true)
		}
	}
	return result, nil
}

func loadWakeProfiles(ctx context.Context, q querier, project string) (map[string]*WakeProfile, error) {
	rows, err := q.Query(ctx, `SELECT agent_id,mode,expected_response_seconds,expected_contact_seconds,version,updated_at,set_by FROM agent_wake_profiles WHERE project_id=$1`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	profiles := map[string]*WakeProfile{}
	for rows.Next() {
		var agent string
		profile := &WakeProfile{}
		if err = rows.Scan(&agent, &profile.Mode, &profile.ExpectedResponseSeconds, &profile.ExpectedContactSeconds, &profile.Version, &profile.UpdatedAt, &profile.SetBy); err != nil {
			return nil, err
		}
		profiles[agent] = profile
	}
	return profiles, rows.Err()
}

type wakeProfileInput struct {
	Mode                    string `json:"mode"`
	ExpectedResponseSeconds *int   `json:"expected_response_seconds"`
	ExpectedContactSeconds  *int   `json:"expected_contact_seconds"`
	ExpectedVersion         *int64 `json:"expected_version"`
}

func validWakeProfile(in wakeProfileInput) bool {
	if in.ExpectedVersion == nil || *in.ExpectedVersion < 0 {
		return false
	}
	inRange := func(v *int, low, high int) bool { return v != nil && *v >= low && *v <= high }
	switch in.Mode {
	case "unknown":
		return in.ExpectedResponseSeconds == nil && in.ExpectedContactSeconds == nil
	case "loop", "tmux":
		if !inRange(in.ExpectedResponseSeconds, 30, 86400) {
			return false
		}
		if in.Mode == "loop" {
			return inRange(in.ExpectedContactSeconds, 15, 86400)
		}
		return in.ExpectedContactSeconds == nil || inRange(in.ExpectedContactSeconds, 15, 86400)
	case "on_demand":
		return inRange(in.ExpectedResponseSeconds, 30, 86400) && in.ExpectedContactSeconds == nil
	}
	return false
}

// visibleAgentChannels applies the project directory's ACL rule: an owner sees every
// channel an agent belongs to; an agent sees only channels it shares. One deliberate
// difference: an agent may always read its own record (a member with no channel is not
// in the directory but still needs its own profile version to update it).
func visibleAgentChannels(ctx context.Context, q querier, project, caller string, owner bool, target string) (channels []string, total int, ok bool, err error) {
	err = q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM principals p JOIN project_members pm ON pm.agent_id=p.id AND pm.project_id=$1
 WHERE p.id=$3 AND p.kind='agent' AND ($2::boolean OR p.id=$4 OR EXISTS(SELECT 1 FROM channels c JOIN channel_members mine ON mine.channel_id=c.id AND mine.agent_id=$4
   JOIN channel_members theirs ON theirs.channel_id=c.id AND theirs.agent_id=p.id WHERE c.project_id=$1)))`, project, owner, target, caller).Scan(&ok)
	if err != nil || !ok {
		return nil, 0, false, err
	}
	err = q.QueryRow(ctx, `SELECT count(*) FROM channels c JOIN channel_members theirs ON theirs.channel_id=c.id AND theirs.agent_id=$2 WHERE c.project_id=$1`, project, target).Scan(&total)
	if err != nil {
		return nil, 0, false, err
	}
	rows, err := q.Query(ctx, `SELECT c.id FROM channels c JOIN channel_members theirs ON theirs.channel_id=c.id AND theirs.agent_id=$2
 WHERE c.project_id=$1 AND ($3::boolean OR EXISTS(SELECT 1 FROM channel_members mine WHERE mine.channel_id=c.id AND mine.agent_id=$4)) ORDER BY c.id`, project, target, owner, caller)
	if err != nil {
		return nil, 0, false, err
	}
	defer rows.Close()
	channels = []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, 0, false, err
		}
		channels = append(channels, id)
	}
	return channels, total, true, rows.Err()
}

func (s *Server) getWakeProfile(w http.ResponseWriter, r *http.Request) {
	project, target := r.PathValue("project"), r.PathValue("agent")
	if !validID(project) || !validID(target) {
		fail(w, 404, "not found")
		return
	}
	// Key validity, ACLs, the profile, contacts and the clock sample share one snapshot.
	ctx, actor := r.Context(), principal(r)
	tx, err := s.Store.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	var live bool
	var asOf time.Time
	if tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM principals WHERE id=$1 AND key_hash=$2),clock_timestamp()`, actor.ID, digest(bearer(r))).Scan(&live, &asOf) != nil {
		internal(w)
		return
	}
	if !live {
		fail(w, 401, "invalid or revoked key")
		return
	}
	if !projectAccess(ctx, tx, project, actor.ID, false) {
		fail(w, 404, "not found")
		return
	}
	channels, total, ok, err := visibleAgentChannels(ctx, tx, project, actor.ID, actor.Kind == "owner", target)
	if err != nil {
		internal(w)
		return
	}
	if !ok {
		fail(w, 404, "not found")
		return
	}
	profiles, err := loadWakeProfiles(ctx, tx, project)
	if err != nil {
		internal(w)
		return
	}
	liveness, err := observeLiveness(ctx, tx, target, channels, total, profiles[target], asOf)
	if err != nil {
		internal(w)
		return
	}
	_ = tx.Rollback(ctx) // release the connection before writing to a possibly slow client
	respond(w, 200, map[string]any{"wake_profile": profiles[target], "liveness": liveness})
}

func (s *Server) putWakeProfile(w http.ResponseWriter, r *http.Request) {
	project, target := r.PathValue("project"), r.PathValue("agent")
	if !validID(project) || !validID(target) {
		fail(w, 404, "not found")
		return
	}
	var in wakeProfileInput
	if !decodeMax(w, r, &in, 1024) {
		return
	}
	if !validWakeProfile(in) {
		fail(w, 400, "invalid wake profile fields")
		return
	}
	ctx, actor := r.Context(), principal(r)
	owner := actor.Kind == "owner"
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	// Same lock order as every other write: management lock (exclusive for owners,
	// shared for agents), then the writer's own principal row, then resource rows.
	if err = managementLock(ctx, tx, !owner); err != nil {
		internal(w)
		return
	}
	var kind string
	err = tx.QueryRow(ctx, "SELECT kind FROM principals WHERE id=$1 AND key_hash=$2 FOR UPDATE", actor.ID, digest(bearer(r))).Scan(&kind)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 401, "invalid or revoked key")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	if kind != "owner" && kind != "agent" {
		fail(w, 403, "principal cannot perform this operation")
		return
	}
	setBy := "owner"
	if kind == "agent" {
		// An agent may only describe itself, and only with active project write access.
		if actor.ID != target || !projectAccess(ctx, tx, project, actor.ID, true) {
			fail(w, 404, "not found")
			return
		}
		setBy = "self"
	}
	var member, active bool
	if tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM project_members pm JOIN principals p ON p.id=pm.agent_id WHERE pm.project_id=$1 AND pm.agent_id=$2 AND p.kind='agent'),
 COALESCE((SELECT archived_at IS NULL FROM projects WHERE id=$1),false)`, project, target).Scan(&member, &active) != nil {
		internal(w)
		return
	}
	if !member || !active {
		fail(w, 404, "not found")
		return
	}
	var current int64
	err = tx.QueryRow(ctx, `SELECT version FROM agent_wake_profiles WHERE project_id=$1 AND agent_id=$2 FOR UPDATE`, project, target).Scan(&current)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		internal(w)
		return
	}
	if *in.ExpectedVersion != current {
		fail(w, 409, "wake profile version conflict")
		return
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agent_wake_profiles(project_id,agent_id,mode,expected_response_seconds,expected_contact_seconds,updated_by,set_by)
 VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(project_id,agent_id) DO UPDATE SET mode=EXCLUDED.mode,expected_response_seconds=EXCLUDED.expected_response_seconds,
  expected_contact_seconds=EXCLUDED.expected_contact_seconds,version=agent_wake_profiles.version+1,updated_at=clock_timestamp(),
  updated_by=EXCLUDED.updated_by,set_by=EXCLUDED.set_by`,
		project, target, in.Mode, in.ExpectedResponseSeconds, in.ExpectedContactSeconds, actor.ID, setBy); err != nil {
		internal(w)
		return
	}
	if err = writeAudit(ctx, tx, actor.ID, "agent.wake_profile.set", "agent", target, auditDetails{AgentID: target, ProjectID: project, Kind: in.Mode}); err != nil {
		internal(w)
		return
	}
	profile := &WakeProfile{}
	if err = tx.QueryRow(ctx, `SELECT mode,expected_response_seconds,expected_contact_seconds,version,updated_at,set_by FROM agent_wake_profiles WHERE project_id=$1 AND agent_id=$2`, project, target).
		Scan(&profile.Mode, &profile.ExpectedResponseSeconds, &profile.ExpectedContactSeconds, &profile.Version, &profile.UpdatedAt, &profile.SetBy); err != nil || tx.Commit(ctx) != nil {
		internal(w)
		return
	}
	status := 200
	if current == 0 {
		status = 201
	}
	respond(w, status, map[string]any{"wake_profile": profile})
}
