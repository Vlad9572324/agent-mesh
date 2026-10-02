package link

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

//go:embed sessions_schema.sql
var sessionsSchema string

// ExecutionSession is presence and API coordination authority, not an OS lock.
// It neither replaces principals.session_id nor authorizes legacy receipts.
type ExecutionSession struct {
	SessionID          string     `json:"session_id"`
	AgentID            string     `json:"agent_id"`
	ProjectID          string     `json:"project_id"`
	ChannelID          string     `json:"channel_id"`
	RunID              string     `json:"run_id"`
	TaskRole           string     `json:"task_role"`
	Runtime            string     `json:"runtime"`
	Model              string     `json:"model"`
	Activity           string     `json:"activity"`
	TTLSeconds         int        `json:"ttl_seconds"`
	MaxDurationSeconds int        `json:"max_duration_seconds"`
	CreatedAt          time.Time  `json:"created_at"`
	LastSeenAt         time.Time  `json:"last_seen_at"`
	ExpiresAt          time.Time  `json:"expires_at"`
	DeadlineAt         time.Time  `json:"deadline_at"`
	ClosedAt           *time.Time `json:"closed_at"`
	Freshness          string     `json:"freshness"`
}

type sessionCreateInput struct {
	SessionID          string `json:"session_id"`
	ChannelID          string `json:"channel_id"`
	RunID              string `json:"run_id"`
	TaskRole           string `json:"task_role"`
	Runtime            string `json:"runtime"`
	Model              string `json:"model"`
	Activity           string `json:"activity"`
	TTLSeconds         int    `json:"ttl_seconds"`
	MaxDurationSeconds int    `json:"max_duration_seconds"`
}

func (s *Server) sessionRoutes(api *http.ServeMux) {
	api.HandleFunc("GET /v1/projects/{project}/sessions", s.listSessions)
	api.HandleFunc("POST /v1/projects/{project}/sessions", s.createSession)
	api.HandleFunc("POST /v1/projects/{project}/sessions/{session}/renew", s.renewSession)
	api.HandleFunc("POST /v1/projects/{project}/sessions/{session}/close", s.closeSession)
}

func sessionText(value string, maximum int) bool {
	return len(value) <= maximum && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}

func validSessionCreate(in sessionCreateInput) bool {
	role := in.TaskRole == "listener" || in.TaskRole == "writer" || in.TaskRole == "tester" || in.TaskRole == "reviewer"
	return validID(in.SessionID) && validID(in.ChannelID) && validID(in.RunID) && role &&
		validText(in.Runtime, 64) && sessionText(in.Model, 128) && sessionText(in.Activity, 512) &&
		in.TTLSeconds >= 10 && in.TTLSeconds <= 120 && in.MaxDurationSeconds >= 30 &&
		in.MaxDurationSeconds <= 3600 && in.TTLSeconds <= in.MaxDurationSeconds
}

// Keep this visibility predicate aligned with the workspace invalidation query:
// ordinary callers see only their channel, not other sessions of the same agent.
const executionSessionSelect = `SELECT es.session_id,es.agent_id,es.project_id,es.channel_id,
 es.run_id,es.task_role,es.runtime,es.model,es.activity,es.ttl_seconds,es.max_duration_seconds,
 es.created_at,es.last_seen_at,es.expires_at,es.deadline_at,es.closed_at,
 CASE WHEN es.closed_at IS NOT NULL THEN 'closed'
      WHEN es.expires_at<=statement_timestamp() OR es.deadline_at<=statement_timestamp() OR NOT EXISTS (
        SELECT 1 FROM principals a JOIN project_members pm ON pm.agent_id=a.id AND pm.project_id=es.project_id
        JOIN projects p ON p.id=pm.project_id JOIN channel_members cm ON cm.agent_id=a.id AND cm.channel_id=es.channel_id
        WHERE a.id=es.agent_id AND a.kind='agent' AND a.key_hash IS NOT NULL AND p.archived_at IS NULL
          AND pm.can_write AND cm.can_write
      ) THEN 'stale' ELSE 'fresh' END
 FROM execution_sessions es`

func scanExecutionSession(row pgx.Row) (ExecutionSession, error) {
	var item ExecutionSession
	err := row.Scan(&item.SessionID, &item.AgentID, &item.ProjectID, &item.ChannelID, &item.RunID, &item.TaskRole,
		&item.Runtime, &item.Model, &item.Activity, &item.TTLSeconds, &item.MaxDurationSeconds, &item.CreatedAt,
		&item.LastSeenAt, &item.ExpiresAt, &item.DeadlineAt, &item.ClosedAt, &item.Freshness)
	return item, err
}

// sessionLive is for additive coordination endpoints. Callers must separately
// authorize the current key and task/channel ACL in their mutation transaction.
func sessionLive(ctx context.Context, q querier, project, channel, agent, sessionID string) bool {
	var live bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM execution_sessions es
 JOIN principals a ON a.id=es.agent_id JOIN projects p ON p.id=es.project_id
 JOIN project_members pm ON pm.project_id=es.project_id AND pm.agent_id=es.agent_id
 JOIN channel_members cm ON cm.channel_id=es.channel_id AND cm.agent_id=es.agent_id
 WHERE es.project_id=$1 AND es.channel_id=$2 AND es.agent_id=$3 AND es.session_id=$4
 AND es.closed_at IS NULL AND es.expires_at>clock_timestamp() AND es.deadline_at>clock_timestamp()
 AND a.kind='agent' AND a.key_hash IS NOT NULL AND p.archived_at IS NULL AND pm.can_write AND cm.can_write)`,
		project, channel, agent, sessionID).Scan(&live)
	return err == nil && live
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	if !s.projectAllowed(w, r, false) {
		return
	}
	rows, err := s.Store.Pool.Query(r.Context(), executionSessionSelect+`
 WHERE es.project_id=$1 AND ($3::boolean OR EXISTS (
 SELECT 1 FROM project_members pm JOIN projects p ON p.id=pm.project_id
 JOIN channel_members cm ON cm.agent_id=pm.agent_id AND cm.channel_id=es.channel_id
 WHERE pm.project_id=es.project_id AND pm.agent_id=$2 AND p.archived_at IS NULL))
 ORDER BY (es.closed_at IS NULL AND es.expires_at>statement_timestamp()) DESC,
 es.created_at DESC,es.agent_id,es.session_id LIMIT 201`, r.PathValue("project"), principal(r).ID, principal(r).Kind == "owner")
	if err != nil {
		internal(w)
		return
	}
	defer rows.Close()
	items := []ExecutionSession{}
	for rows.Next() {
		item, err := scanExecutionSession(rows)
		if err != nil {
			internal(w)
			return
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		internal(w)
		return
	}
	truncated := len(items) > 200
	if truncated {
		items = items[:200]
	}
	respond(w, 200, map[string]any{"sessions": items, "truncated": truncated})
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	if principal(r).Kind != "agent" {
		fail(w, 404, "not found")
		return
	}
	var in sessionCreateInput
	if !decode(w, r, &in) {
		return
	}
	if !validSessionCreate(in) {
		fail(w, 400, "invalid session fields")
		return
	}
	ctx := r.Context()
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	if !s.authorizeWrite(w, r, tx, false) {
		return
	}
	var matching bool
	if tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM channels WHERE id=$1 AND project_id=$2)", in.ChannelID, r.PathValue("project")).Scan(&matching) != nil {
		internal(w)
		return
	}
	if !matching || !channelAccess(ctx, tx, in.ChannelID, principal(r).ID, true) {
		fail(w, 404, "not found")
		return
	}
	payload, _ := json.Marshal(in)
	hash := digest(string(payload))
	var previous []byte
	err = tx.QueryRow(ctx, `SELECT payload_hash FROM execution_sessions WHERE project_id=$1 AND agent_id=$2 AND session_id=$3`,
		r.PathValue("project"), principal(r).ID, in.SessionID).Scan(&previous)
	replayed := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		internal(w)
		return
	}
	if replayed && !bytes.Equal(previous, hash) {
		fail(w, 409, "session identity already has different parameters")
		return
	}
	if !replayed {
		var count int
		if tx.QueryRow(ctx, `SELECT count(*) FROM execution_sessions WHERE agent_id=$1 AND closed_at IS NULL
 AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`, principal(r).ID).Scan(&count) != nil {
			internal(w)
			return
		}
		if count >= 8 {
			fail(w, 409, "active session budget exhausted")
			return
		}
		_, err = tx.Exec(ctx, `INSERT INTO execution_sessions(project_id,agent_id,session_id,channel_id,run_id,task_role,runtime,model,
 activity,ttl_seconds,max_duration_seconds,expires_at,deadline_at,payload_hash)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()+make_interval(secs=>$10::integer),clock_timestamp()+make_interval(secs=>$11::integer),$12)`,
			r.PathValue("project"), principal(r).ID, in.SessionID, in.ChannelID, in.RunID, in.TaskRole, in.Runtime, in.Model, in.Activity, in.TTLSeconds, in.MaxDurationSeconds, hash)
		if err != nil {
			internal(w)
			return
		}
	}
	item, err := scanExecutionSession(tx.QueryRow(ctx, executionSessionSelect+` WHERE es.project_id=$1 AND es.agent_id=$2 AND es.session_id=$3`,
		r.PathValue("project"), principal(r).ID, in.SessionID))
	if err != nil || tx.Commit(ctx) != nil {
		internal(w)
		return
	}
	status := 201
	if replayed {
		status = 200
	}
	respond(w, status, map[string]any{"session": item, "replayed": replayed})
}

func (s *Server) sessionMutation(w http.ResponseWriter, r *http.Request, closeSession bool) {
	if principal(r).Kind != "agent" {
		fail(w, 404, "not found")
		return
	}
	var in struct {
		Activity string `json:"activity"`
	}
	if closeSession {
		if !decode(w, r, &struct{}{}) {
			return
		}
	} else if !decode(w, r, &in) {
		return
	}
	if !validID(r.PathValue("session")) || !sessionText(in.Activity, 512) {
		fail(w, 400, "invalid session fields")
		return
	}
	ctx := r.Context()
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	if !s.authorizeWrite(w, r, tx, false) {
		return
	}
	item, err := scanExecutionSession(tx.QueryRow(ctx, executionSessionSelect+`
 WHERE es.project_id=$1 AND es.agent_id=$2 AND es.session_id=$3 FOR UPDATE OF es`, r.PathValue("project"), principal(r).ID, r.PathValue("session")))
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "not found")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	if !channelAccess(ctx, tx, item.ChannelID, principal(r).ID, true) {
		fail(w, 404, "not found")
		return
	}
	if !closeSession && item.Freshness != "fresh" {
		fail(w, 409, "expired or closed session cannot be renewed")
		return
	}
	query := `UPDATE execution_sessions SET closed_at=COALESCE(closed_at,clock_timestamp()) WHERE project_id=$1 AND agent_id=$2 AND session_id=$3`
	args := []any{item.ProjectID, item.AgentID, item.SessionID}
	if !closeSession {
		query = `UPDATE execution_sessions SET activity=$4,last_seen_at=clock_timestamp(),
 expires_at=LEAST(deadline_at,clock_timestamp()+make_interval(secs=>ttl_seconds))
 WHERE project_id=$1 AND agent_id=$2 AND session_id=$3 AND closed_at IS NULL AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`
		args = append(args, in.Activity)
	}
	changed, err := tx.Exec(ctx, query, args...)
	if err != nil {
		internal(w)
		return
	}
	if changed.RowsAffected() != 1 {
		fail(w, 409, "session expired during renewal")
		return
	}
	item, err = scanExecutionSession(tx.QueryRow(ctx, executionSessionSelect+` WHERE es.project_id=$1 AND es.agent_id=$2 AND es.session_id=$3`, item.ProjectID, item.AgentID, item.SessionID))
	if err != nil || tx.Commit(ctx) != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"session": item})
}

func (s *Server) renewSession(w http.ResponseWriter, r *http.Request) { s.sessionMutation(w, r, false) }
func (s *Server) closeSession(w http.ResponseWriter, r *http.Request) { s.sessionMutation(w, r, true) }
