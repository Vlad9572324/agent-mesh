package link

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed navigation_schema.sql
var navigationSchema string

// Reauthentication, ACL and counters use one statement snapshot. Each visible
// channel uses the existing messages(channel_id,seq) index for its latest
// message and unread range. Neither telemetry nor private channels enter sums.
const navigationSQL = `
WITH caller AS MATERIALIZED (
 SELECT id,kind FROM principals WHERE key_hash=$1
), visible_projects AS MATERIALIZED (
 SELECT p.id FROM projects p CROSS JOIN caller me
 WHERE p.archived_at IS NULL AND (me.kind='owner' OR EXISTS(
  SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.agent_id=me.id))
), visible_channels AS MATERIALIZED (
 SELECT c.id,c.project_id FROM channels c JOIN visible_projects p ON p.id=c.project_id CROSS JOIN caller me
 WHERE me.kind='owner' OR EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.agent_id=me.id)
), channel_stats AS MATERIALIZED (
 SELECT c.id,c.project_id,
  (SELECT count(*) FROM messages unread WHERE unread.channel_id=c.id
    AND unread.seq>COALESCE(nr.last_read_seq,0) AND unread.author_id<>me.id) AS unread_messages,
  latest.created_at AS last_message_at,COALESCE(nr.last_read_seq,0) AS last_read_seq,COALESCE(latest.seq,0) AS latest_message_seq
 FROM visible_channels c CROSS JOIN caller me
 LEFT JOIN navigation_reads nr ON nr.channel_id=c.id AND nr.principal_id=me.id
 LEFT JOIN LATERAL (SELECT m.seq,m.created_at FROM messages m WHERE m.channel_id=c.id ORDER BY m.seq DESC LIMIT 1) latest ON true
)
SELECT json_build_object(
 'projects',COALESCE((SELECT json_agg(p ORDER BY p.id) FROM (
  SELECT p.id,COALESCE(sum(c.unread_messages),0) AS unread_messages,max(c.last_message_at) AS last_message_at
  FROM visible_projects p LEFT JOIN channel_stats c ON c.project_id=p.id GROUP BY p.id
 ) p),'[]'::json),
 'channels',COALESCE((SELECT json_agg(c ORDER BY c.id) FROM channel_stats c),'[]'::json)
)::text FROM caller`

func (s *Server) navigation(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var snapshot string
	if err := s.Store.Pool.QueryRow(ctx, navigationSQL, digest(bearer(r))).Scan(&snapshot); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			fail(w, 401, "invalid or revoked key")
		} else {
			internal(w)
		}
		return
	}
	respond(w, 200, json.RawMessage(snapshot))
}

func (s *Server) markChannelRead(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ThroughSeq *int64 `json:"through_seq"`
	}
	if !decodeMax(w, r, &in, 1024) {
		return
	}
	if in.ThroughSeq == nil || *in.ThroughSeq < 0 {
		fail(w, 400, "nonnegative through_seq required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	// Owners and viewers can record what they have read. This is not channel
	// content creation, so the agent-only authorizeWrite helper does not apply.
	if err = managementLock(ctx, tx, true); err != nil {
		internal(w)
		return
	}
	var caller string
	err = tx.QueryRow(ctx, "SELECT id FROM principals WHERE id=$1 AND key_hash=$2 FOR UPDATE", principal(r).ID, digest(bearer(r))).Scan(&caller)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 401, "invalid or revoked key")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	channel := r.PathValue("channel")
	if !channelAccess(ctx, tx, channel, caller, false) {
		fail(w, 404, "not found")
		return
	}
	var latest int64
	var storedMessage bool
	if err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT seq FROM messages WHERE channel_id=$1 ORDER BY seq DESC LIMIT 1),0),
 $2::bigint=0 OR EXISTS(SELECT 1 FROM messages WHERE channel_id=$1 AND seq=$2)`, channel, *in.ThroughSeq).Scan(&latest, &storedMessage); err != nil {
		internal(w)
		return
	}
	if *in.ThroughSeq > latest || !storedMessage {
		fail(w, 409, "read cursor must be zero or an existing message position")
		return
	}
	var read int64
	if err = tx.QueryRow(ctx, `INSERT INTO navigation_reads(principal_id,channel_id,last_read_seq) VALUES($1,$2,$3)
 ON CONFLICT(principal_id,channel_id) DO UPDATE SET last_read_seq=GREATEST(navigation_reads.last_read_seq,EXCLUDED.last_read_seq)
 RETURNING last_read_seq`, caller, channel, *in.ThroughSeq).Scan(&read); err != nil {
		internal(w)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"channel_id": channel, "last_read_seq": read, "latest_message_seq": latest})
}
