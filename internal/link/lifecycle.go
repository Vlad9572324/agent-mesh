package link

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const projectSelect = "SELECT id,name,archived_at,lifecycle_version FROM projects "

func lifecycleProject(w http.ResponseWriter, r *http.Request, tx pgx.Tx, id string) (Project, bool) {
	var p Project
	if !validID(id) {
		fail(w, 404, "project not found")
		return p, false
	}
	err := tx.QueryRow(r.Context(), projectSelect+"WHERE id=$1 FOR UPDATE", id).Scan(&p.ID, &p.Name, &p.ArchivedAt, &p.LifecycleVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "project not found")
		return p, false
	}
	if err != nil {
		internal(w)
		return p, false
	}
	return p, true
}

func activeAdminProject(w http.ResponseWriter, r *http.Request, tx pgx.Tx, id string) bool {
	p, ok := lifecycleProject(w, r, tx, id)
	if !ok {
		return false
	}
	if p.ArchivedAt != nil {
		fail(w, 409, "project is archived; restore it before changing channels or memberships")
		return false
	}
	return true
}

func unretired(w http.ResponseWriter, r *http.Request, tx pgx.Tx, id, kind string) bool {
	query := "SELECT EXISTS(SELECT 1 FROM retired_project_ids WHERE id=$1)"
	if kind == "channel" {
		query = "SELECT EXISTS(SELECT 1 FROM retired_channel_ids WHERE id=$1)"
	}
	var retired bool
	if err := tx.QueryRow(r.Context(), query, id).Scan(&retired); err != nil {
		internal(w)
		return false
	}
	if retired {
		fail(w, 409, "identifier was retired by permanent deletion and cannot be reused")
		return false
	}
	return true
}

func (s *Server) adminArchive(w http.ResponseWriter, r *http.Request) {
	s.adminProjectState(w, r, true)
}
func (s *Server) adminRestore(w http.ResponseWriter, r *http.Request) {
	s.adminProjectState(w, r, false)
}

func (s *Server) adminProjectState(w http.ResponseWriter, r *http.Request, archive bool) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	p, ok := lifecycleProject(w, r, tx, r.PathValue("project"))
	if !ok {
		return
	}
	if (p.ArchivedAt != nil) == archive {
		// Idempotent same-state requests neither advance the version nor invent
		// another state transition/audit entry.
		if tx.Commit(r.Context()) != nil {
			internal(w)
			return
		}
		respond(w, 200, map[string]any{"project": p})
		return
	}
	query := "UPDATE projects SET archived_at=clock_timestamp(),lifecycle_version=lifecycle_version+1 WHERE id=$1 RETURNING archived_at,lifecycle_version"
	action := "project.archive"
	if !archive {
		query = "UPDATE projects SET archived_at=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1 RETURNING archived_at,lifecycle_version"
		action = "project.restore"
	}
	if err := tx.QueryRow(r.Context(), query, p.ID).Scan(&p.ArchivedAt, &p.LifecycleVersion); err != nil {
		internal(w)
		return
	}
	if adminCommit(w, r, tx, action, "project", p.ID, auditDetails{}) {
		respond(w, 200, map[string]any{"project": p})
	}
}

type deletionCounts struct {
	Channels              int64 `json:"channels"`
	Messages              int64 `json:"messages"`
	Notes                 int64 `json:"notes"`
	Receipts              int64 `json:"receipts"`
	Events                int64 `json:"events"`
	ProjectMembers        int64 `json:"project_members"`
	ChannelMembers        int64 `json:"channel_members"`
	Tasks                 int64 `json:"tasks"`
	TaskRuns              int64 `json:"task_runs"`
	TaskEvents            int64 `json:"task_events"`
	Memory                int64 `json:"memory"`
	MemoryVersions        int64 `json:"memory_versions"`
	Artifacts             int64 `json:"artifacts"`
	ArtifactBytes         int64 `json:"artifact_bytes"`
	Sessions              int64 `json:"sessions"`
	NativeActivity        int64 `json:"native_activity"`
	OnboardingInvitations int64 `json:"onboarding_invitations"`
}

func (s *Server) adminDeletionPreview(w http.ResponseWriter, r *http.Request) {
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	p, ok := lifecycleProject(w, r, tx, r.PathValue("project"))
	if !ok {
		return
	}
	var counts deletionCounts
	err := tx.QueryRow(r.Context(), `SELECT
 (SELECT count(*) FROM channels WHERE project_id=$1),
 (SELECT count(*) FROM messages m JOIN channels c ON c.id=m.channel_id WHERE c.project_id=$1),
 (SELECT count(*) FROM notes WHERE project_id=$1),
 (SELECT count(*) FROM receipts r JOIN messages m ON m.id=r.message_id JOIN channels c ON c.id=m.channel_id WHERE c.project_id=$1),
 (SELECT count(*) FROM events e JOIN channels c ON c.id=e.channel_id WHERE c.project_id=$1),
 (SELECT count(*) FROM project_members WHERE project_id=$1),
 (SELECT count(*) FROM channel_members cm JOIN channels c ON c.id=cm.channel_id WHERE c.project_id=$1),
 (SELECT count(*) FROM link_tasks WHERE project_id=$1),
 (SELECT count(*) FROM link_task_runs tr JOIN link_tasks t ON t.id=tr.task_id WHERE t.project_id=$1),
 (SELECT count(*) FROM link_task_events te JOIN link_tasks t ON t.id=te.task_id WHERE t.project_id=$1),
 (SELECT count(*) FROM link_memory WHERE project_id=$1),
 (SELECT count(*) FROM link_memory_versions WHERE project_id=$1),
 (SELECT count(*) FROM link_artifacts WHERE project_id=$1),
 (SELECT COALESCE(sum(size_bytes),0) FROM link_artifacts WHERE project_id=$1),
 (SELECT count(*) FROM execution_sessions WHERE project_id=$1),
 (SELECT count(*) FROM native_activity na JOIN channels c ON c.id=na.channel_id WHERE c.project_id=$1),
 (SELECT count(*) FROM onboarding_invitations WHERE project_id=$1)`, p.ID).Scan(&counts.Channels, &counts.Messages, &counts.Notes, &counts.Receipts, &counts.Events, &counts.ProjectMembers, &counts.ChannelMembers,
		&counts.Tasks, &counts.TaskRuns, &counts.TaskEvents, &counts.Memory, &counts.MemoryVersions, &counts.Artifacts, &counts.ArtifactBytes, &counts.Sessions, &counts.NativeActivity, &counts.OnboardingInvitations)
	if err != nil {
		internal(w)
		return
	}
	if tx.Commit(r.Context()) != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"project": p, "counts": counts, "can_delete": p.ArchivedAt != nil})
}

func (s *Server) adminDeleteProject(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ConfirmID       string `json:"confirm_id"`
		ExpectedVersion *int64 `json:"expected_version"`
	}
	if !decode(w, r, &in) {
		return
	}
	id := r.PathValue("project")
	if in.ConfirmID != id || !validID(in.ConfirmID) || in.ExpectedVersion == nil || *in.ExpectedVersion < 0 {
		fail(w, 400, "exact project confirmation and nonnegative expected_version required")
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	p, ok := lifecycleProject(w, r, tx, id)
	if !ok {
		return
	}
	if p.ArchivedAt == nil {
		fail(w, 409, "archive project before permanent deletion")
		return
	}
	if p.LifecycleVersion != *in.ExpectedVersion {
		fail(w, 409, "project lifecycle changed; request a fresh deletion preview")
		return
	}
	// Refuse both inbound and outbound anomalous cross-project references.
	// Never clear foreign references or cascade through unrelated content.
	var anomalous bool
	err := tx.QueryRow(r.Context(), `SELECT EXISTS(
 SELECT 1 FROM messages m JOIN channels mc ON mc.id=m.channel_id
 JOIN messages parent ON parent.id=m.reply_to JOIN channels pc ON pc.id=parent.channel_id
 WHERE mc.project_id<>pc.project_id AND (mc.project_id=$1 OR pc.project_id=$1)
 UNION ALL
 SELECT 1 FROM notes n JOIN messages source ON source.id=n.source_message_id JOIN channels sc ON sc.id=source.channel_id
 WHERE n.project_id<>sc.project_id AND (n.project_id=$1 OR sc.project_id=$1)
 UNION ALL
 SELECT 1 FROM execution_sessions es JOIN channels c ON c.id=es.channel_id
 WHERE es.project_id<>c.project_id AND (es.project_id=$1 OR c.project_id=$1)
 UNION ALL
 SELECT 1 FROM link_memory_versions mv JOIN link_memory m ON m.id=mv.memory_id
 WHERE mv.project_id<>m.project_id AND (mv.project_id=$1 OR m.project_id=$1)
 UNION ALL
 SELECT 1 FROM native_activity na JOIN channels nc ON nc.id=na.channel_id
 JOIN messages m ON m.id=na.message_id JOIN channels mc ON mc.id=m.channel_id
 WHERE nc.project_id<>mc.project_id AND (nc.project_id=$1 OR mc.project_id=$1)
)`, id).Scan(&anomalous)
	if err != nil {
		internal(w)
		return
	}
	if anomalous {
		fail(w, 409, "cross-project references prevent safe deletion; operator inspection required")
		return
	}
	queries := []string{
		"INSERT INTO retired_project_ids(id) VALUES($1)",
		"INSERT INTO retired_channel_ids(id) SELECT id FROM channels WHERE project_id=$1",
		"DELETE FROM notes WHERE project_id=$1",
		"DELETE FROM receipts WHERE message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE c.project_id=$1)",
		"DELETE FROM events WHERE channel_id IN (SELECT id FROM channels WHERE project_id=$1)",
		"DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE project_id=$1)",
		"DELETE FROM channel_members WHERE channel_id IN (SELECT id FROM channels WHERE project_id=$1)",
		"DELETE FROM channels WHERE project_id=$1",
		"DELETE FROM project_members WHERE project_id=$1",
		"DELETE FROM projects WHERE id=$1",
	}
	for _, query := range queries {
		if _, err = tx.Exec(r.Context(), query, id); err != nil {
			var pe *pgconn.PgError
			if errors.As(err, &pe) && pe.Code == "23503" {
				fail(w, 409, "references prevent safe deletion; operator inspection required")
			} else {
				internal(w)
			}
			return
		}
	}
	if adminCommit(w, r, tx, "project.delete", "project", id, auditDetails{}) {
		respond(w, 200, map[string]any{"deleted": true, "project_id": id})
	}
}
