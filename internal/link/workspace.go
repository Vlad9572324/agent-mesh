package link

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// The caller, ACL and state all come from one statement snapshot. In particular,
// do not substitute a global journal/audit counter for ordinary principals:
// even an opaque changing hash would disclose activity in hidden projects.
// Only metadata for existing REST-visible state enters this in-memory snapshot.
// Bodies, raw keys, key hashes and audit details never enter the returned JSON.
const workspaceSnapshotSQL = `
WITH caller AS MATERIALIZED (
 SELECT id,name,kind FROM principals WHERE key_hash=$1
), visible_projects AS MATERIALIZED (
 SELECT p.id,p.name,p.archived_at,p.lifecycle_version,
        CASE WHEN me.kind='owner' THEN false ELSE pm.can_write END AS can_write
 FROM projects p CROSS JOIN caller me
 LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.agent_id=me.id
 WHERE me.kind='owner' OR (p.archived_at IS NULL AND pm.agent_id IS NOT NULL)
), visible_channels AS MATERIALIZED (
 SELECT c.id,c.project_id,c.name,c.cursor,
        me.kind<>'owner' AND COALESCE(cm.can_write AND p.can_write,false) AS can_write,
        ARRAY(SELECT member.agent_id FROM channel_members member
              JOIN project_members pm ON pm.agent_id=member.agent_id AND pm.project_id=c.project_id
              WHERE member.channel_id=c.id ORDER BY member.agent_id) AS member_ids
 FROM channels c JOIN visible_projects p ON p.id=c.project_id CROSS JOIN caller me
 LEFT JOIN channel_members cm ON cm.channel_id=c.id AND cm.agent_id=me.id
 WHERE me.kind='owner' OR cm.agent_id IS NOT NULL
), visible_principals AS MATERIALIZED (
 SELECT p.id,p.name,p.kind,p.runtime,p.session_id,p.last_seen_at,p.activity,
        CASE WHEN p.last_seen_at IS NULL THEN 'unknown'
             WHEN p.last_seen_at>statement_timestamp()-interval '30 seconds' THEN 'fresh'
             ELSE 'stale' END AS freshness,
        CASE WHEN me.kind='owner' THEN p.key_hash IS NOT NULL ELSE NULL END AS key_active
 FROM principals p CROSS JOIN caller me
 WHERE me.kind='owner' OR EXISTS (
   SELECT 1 FROM project_members pm JOIN visible_projects vp ON vp.id=pm.project_id
   WHERE pm.agent_id=p.id AND EXISTS (
     SELECT 1 FROM visible_channels vc JOIN channel_members theirs ON theirs.channel_id=vc.id
     WHERE vc.project_id=pm.project_id AND theirs.agent_id=p.id
   )
 )
), visible_sessions AS MATERIALIZED (
 SELECT es.project_id,es.channel_id,es.agent_id,es.session_id,es.run_id,es.task_role,
        es.runtime,es.model,es.activity,es.last_seen_at,es.expires_at,es.deadline_at,es.closed_at,
        CASE WHEN es.closed_at IS NOT NULL THEN 'closed'
          WHEN es.expires_at<=statement_timestamp() OR es.deadline_at<=statement_timestamp() OR NOT EXISTS (
            SELECT 1 FROM principals a JOIN project_members pm ON pm.agent_id=a.id AND pm.project_id=es.project_id
            JOIN projects p ON p.id=pm.project_id JOIN channel_members cm ON cm.agent_id=a.id AND cm.channel_id=es.channel_id
            WHERE a.id=es.agent_id AND a.kind='agent' AND a.key_hash IS NOT NULL AND p.archived_at IS NULL AND pm.can_write AND cm.can_write
          ) THEN 'stale' ELSE 'fresh' END AS freshness
 FROM execution_sessions es JOIN visible_channels vc ON vc.id=es.channel_id AND vc.project_id=es.project_id
)
SELECT json_build_object(
 'self',json_build_array(me.id,me.name,me.kind),
 'projects',COALESCE((SELECT json_agg(p ORDER BY p.id) FROM visible_projects p),'[]'::json),
 'channels',COALESCE((SELECT json_agg(c ORDER BY c.id) FROM visible_channels c),'[]'::json),
 'navigation_reads',COALESCE((SELECT json_agg(json_build_array(nr.channel_id,nr.last_read_seq) ORDER BY nr.channel_id)
                              FROM navigation_reads nr JOIN visible_channels c ON c.id=nr.channel_id
                              WHERE nr.principal_id=me.id),'[]'::json),
 'principals',COALESCE((SELECT json_agg(p ORDER BY p.id) FROM visible_principals p),'[]'::json),
 'notes',COALESCE((SELECT json_agg(n ORDER BY n.project_id) FROM (
                    SELECT notes.project_id,count(*) AS note_count,max(notes.id) AS max_id,max(notes.created_at) AS latest_at
                    FROM notes JOIN visible_projects p ON p.id=notes.project_id GROUP BY notes.project_id
                  ) n),'[]'::json),
 'tasks',COALESCE((SELECT json_agg(t ORDER BY t.project_id) FROM (
                  SELECT t.project_id,count(*) AS count,sum(t.version) AS versions,max(t.updated_at) AS latest_at
                  FROM link_tasks t JOIN visible_projects p ON p.id=t.project_id GROUP BY t.project_id
                ) t),'[]'::json),
 'memory',COALESCE((SELECT json_agg(m ORDER BY m.project_id) FROM (
                  SELECT m.project_id,count(*) AS count,sum(m.version) AS versions,max(m.updated_at) AS latest_at
                  FROM link_memory m JOIN visible_projects p ON p.id=m.project_id GROUP BY m.project_id
                ) m),'[]'::json),
 'artifacts',COALESCE((SELECT json_agg(a ORDER BY a.project_id) FROM (
                  SELECT a.project_id,count(*) AS count,max(a.seq) AS latest_seq
                  FROM link_artifacts a JOIN visible_projects p ON p.id=a.project_id GROUP BY a.project_id
                ) a),'[]'::json),
 'execution_sessions',COALESCE((SELECT json_agg(es ORDER BY es.project_id,es.agent_id,es.session_id) FROM visible_sessions es),'[]'::json),
 'project_members',CASE WHEN me.kind='owner' THEN
    COALESCE((SELECT json_agg(pm ORDER BY pm.project_id,pm.agent_id) FROM project_members pm),'[]'::json)
    ELSE '[]'::json END,
 'channel_members',CASE WHEN me.kind='owner' THEN
    COALESCE((SELECT json_agg(cm ORDER BY cm.channel_id,cm.agent_id) FROM channel_members cm),'[]'::json)
    ELSE '[]'::json END,
 'audit',CASE WHEN me.kind='owner' THEN
    (SELECT json_build_array(count(*),max(id)) FROM admin_audit) ELSE NULL END,
 'deliveries',CASE WHEN me.kind='owner' THEN
    COALESCE((SELECT json_agg(json_build_array(r.message_id,r.agent_id,r.delivered_at,r.accepted_at,r.uncertain_at)
                             ORDER BY r.message_id,r.agent_id)
              FROM receipts r WHERE r.accepted_at IS NULL OR r.uncertain_at IS NOT NULL),'[]'::json)
    ELSE '[]'::json END
)::text FROM caller me`

func (s *Server) workspaceRevision(ctx context.Context, key string) (string, error) {
	if len(key) != 64 {
		return "", pgx.ErrNoRows
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var snapshot string
	if err := s.Store.Pool.QueryRow(ctx, workspaceSnapshotSQL, digest(key)).Scan(&snapshot); err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(snapshot))
	return hex.EncodeToString(sum[:]), nil
}

// workspaceStream is an invalidation feed, not a durable log or replay cursor.
// Last-Event-ID and query cursors are intentionally ignored; every connection
// receives an initial revision and clients reconcile through authorized REST.
func (s *Server) workspaceStream(w http.ResponseWriter, r *http.Request) {
	if _, ok := w.(http.Flusher); !ok {
		fail(w, 500, "streaming unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	key := bearer(r)
	revision, err := s.workspaceRevision(ctx, key)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			fail(w, 401, "invalid or revoked key")
		} else {
			internal(w)
		}
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	write := func(next string) error {
		if err := controller.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return err
		}
		if next == "" {
			_, err = io.WriteString(w, ": keepalive\n\n")
		} else {
			_, err = fmt.Fprintf(w, "event: workspace\ndata: {\"revision\":%q}\n\n", next)
		}
		if err != nil {
			return err
		}
		if err := controller.Flush(); err != nil {
			return err
		}
		// Bound each actual write, not the idle interval between frames. HTTP/2
		// resets the stream when a write deadline expires, even without a write;
		// the next keepalive cannot revive an already expired stream timer.
		return controller.SetWriteDeadline(time.Time{})
	}
	if write(revision) != nil {
		return
	}
	lastWrite := time.Now()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		// The SQL statement reauthenticates even an idle or empty workspace and
		// derives the current role/ACL from scratch on every poll.
		next, err := s.workspaceRevision(ctx, key)
		if err != nil {
			return
		}
		if next != revision {
			if write(next) != nil {
				return
			}
			revision = next
			lastWrite = time.Now()
		} else if time.Since(lastWrite) >= 10*time.Second {
			if write("") != nil {
				return
			}
			lastWrite = time.Now()
		}
	}
}
