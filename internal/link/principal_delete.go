package link

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Every durable reference must be absent before an identifier can be reused.
// In particular, recipient_ids is not protected by a foreign key.
var principalDeletionBlockers = []struct {
	name, query string
}{
	{"active_peers", "SELECT EXISTS(SELECT 1 FROM principals WHERE id<>$1 AND kind<>'owner' AND archived_at IS NULL)"},
	{"addressed_messages", "SELECT EXISTS(SELECT 1 FROM messages WHERE recipient_ids ? $1)"},
	{"authored_messages", "SELECT EXISTS(SELECT 1 FROM messages WHERE author_id=$1)"},
	{"receipts", "SELECT EXISTS(SELECT 1 FROM receipts WHERE agent_id=$1)"},
	{"notes", "SELECT EXISTS(SELECT 1 FROM notes WHERE author_id=$1)"},
	{"context_versions", "SELECT EXISTS(SELECT 1 FROM project_context_versions WHERE actor_id=$1)"},
	{"memory", "SELECT EXISTS(SELECT 1 FROM link_memory WHERE author_id=$1 OR updated_by=$1)"},
	{"memory_versions", "SELECT EXISTS(SELECT 1 FROM link_memory_versions WHERE author_id=$1)"},
	{"tasks", "SELECT EXISTS(SELECT 1 FROM link_tasks WHERE owner_id=$1 OR reviewer_id=$1 OR created_by=$1)"},
	{"task_events", "SELECT EXISTS(SELECT 1 FROM link_task_events WHERE actor_id=$1)"},
	{"native_activity", "SELECT EXISTS(SELECT 1 FROM native_activity WHERE actor_id=$1)"},
	{"artifacts", "SELECT EXISTS(SELECT 1 FROM link_artifacts WHERE author_id=$1)"},
	{"created_invitations", "SELECT EXISTS(SELECT 1 FROM onboarding_invitations WHERE created_by=$1 AND agent_id<>$1)"},
}

func principalDeletionState(w http.ResponseWriter, r *http.Request, tx pgx.Tx, id string) (archivedPrincipal, []string, bool) {
	var p archivedPrincipal
	var archived bool
	err := tx.QueryRow(r.Context(), "SELECT id,name,kind,archived_at IS NOT NULL FROM principals WHERE id=$1 FOR UPDATE", id).Scan(&p.ID, &p.Name, &p.Kind, &archived)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "principal not found")
		return p, nil, false
	}
	if err != nil {
		internal(w)
		return p, nil, false
	}
	if p.Kind == "owner" {
		fail(w, 403, "owner accounts are managed only through local CLI")
		return p, nil, false
	}
	if !archived {
		fail(w, 409, "archive principal before permanent deletion")
		return p, nil, false
	}
	blockers := []string{}
	for _, check := range principalDeletionBlockers {
		var found bool
		if err := tx.QueryRow(r.Context(), check.query, id).Scan(&found); err != nil {
			internal(w)
			return p, nil, false
		}
		if found {
			blockers = append(blockers, check.name)
		}
	}
	return p, blockers, true
}

func (s *Server) adminPrincipalDeletionPreview(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("agent")
	if !validID(id) {
		fail(w, 400, "invalid principal identifier")
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	p, blockers, ok := principalDeletionState(w, r, tx, id)
	if !ok {
		return
	}
	respond(w, 200, map[string]any{"principal": p, "can_delete": len(blockers) == 0, "blockers": blockers})
}

func (s *Server) adminDeletePrincipal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ConfirmID string `json:"confirm_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	id := r.PathValue("agent")
	if !validID(id) || in.ConfirmID != id {
		fail(w, 400, "exact principal identifier confirmation required")
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	_, blockers, ok := principalDeletionState(w, r, tx, id)
	if !ok {
		return
	}
	if len(blockers) != 0 {
		fail(w, 409, "historical references or active peers prevent safe deletion; request deletion preview")
		return
	}
	for _, query := range []string{
		"DELETE FROM onboarding_invitations WHERE agent_id=$1",
		"DELETE FROM navigation_reads WHERE principal_id=$1",
		"DELETE FROM channel_members WHERE agent_id=$1",
		"DELETE FROM project_members WHERE agent_id=$1",
		"DELETE FROM principals WHERE id=$1",
	} {
		if _, err := tx.Exec(r.Context(), query, id); err != nil {
			var pe *pgconn.PgError
			if errors.As(err, &pe) && pe.Code == "23503" {
				fail(w, 409, "remaining references prevent safe deletion")
			} else {
				internal(w)
			}
			return
		}
	}
	if adminCommit(w, r, tx, "principal.delete", "principal", id, auditDetails{}) {
		respond(w, 200, map[string]any{"deleted": true, "agent_id": id})
	}
}
