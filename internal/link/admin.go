package link

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Management changes take the exclusive lock before any principal/resource row.
// Agent writes take its shared variant then their principal row, then resource
// rows. Thus revocation/ACL edits and already-authorized writes have a definite
// commit order, and project/channel ACL edits cannot create orphaned grants.
func managementLock(ctx context.Context, tx pgx.Tx, shared bool) error {
	query := "SELECT pg_advisory_xact_lock(731840595)"
	if shared {
		query = "SELECT pg_advisory_xact_lock_shared(731840595)"
	}
	_, err := tx.Exec(ctx, query)
	return err
}

// Only bounded identifiers/enums enter audit metadata. Never accept arbitrary
// request maps, names, bodies, bearer keys, hashes or database errors here.
type auditDetails struct {
	AgentID    string `json:"agent_id,omitempty"`
	Scope      string `json:"scope,omitempty"`
	ResourceID string `json:"resource_id,omitempty"`
	Access     string `json:"access,omitempty"`
	Kind       string `json:"kind,omitempty"`
	ProjectID  string `json:"project_id,omitempty"`
}

func writeAudit(ctx context.Context, tx pgx.Tx, actor, action, targetType, target string, details auditDetails) error {
	b, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "INSERT INTO admin_audit(actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)", actor, action, targetType, target, b)
	return err
}

func (s *Server) authorizeWrite(w http.ResponseWriter, r *http.Request, tx pgx.Tx, owner bool) bool {
	if err := managementLock(r.Context(), tx, !owner); err != nil {
		internal(w)
		return false
	}
	var kind string
	err := tx.QueryRow(r.Context(), "SELECT kind FROM principals WHERE id=$1 AND key_hash=$2 FOR UPDATE", principal(r).ID, digest(bearer(r))).Scan(&kind)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 401, "invalid or revoked key")
		return false
	}
	if err != nil {
		internal(w)
		return false
	}
	if (owner && kind != "owner") || (!owner && kind != "agent") {
		fail(w, 403, "principal cannot perform this operation")
		return false
	}
	return true
}

func (s *Server) adminTx(w http.ResponseWriter, r *http.Request) (pgx.Tx, bool) {
	if principal(r).Kind != "owner" {
		fail(w, 403, "owner access required")
		return nil, false
	}
	tx, err := s.Store.Pool.Begin(r.Context())
	if err != nil {
		internal(w)
		return nil, false
	}
	if !s.authorizeWrite(w, r, tx, true) {
		_ = tx.Rollback(r.Context())
		return nil, false
	}
	return tx, true
}

func adminError(w http.ResponseWriter, err error) {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		switch pe.Code {
		case "23505":
			fail(w, 409, "identifier already exists")
			return
		case "23503":
			fail(w, 404, "referenced resource not found")
			return
		}
	}
	internal(w)
}

func adminCommit(w http.ResponseWriter, r *http.Request, tx pgx.Tx, action, targetType, target string, details auditDetails) bool {
	if err := writeAudit(r.Context(), tx, principal(r).ID, action, targetType, target, details); err != nil {
		internal(w)
		return false
	}
	if err := tx.Commit(r.Context()); err != nil {
		internal(w)
		return false
	}
	return true
}

func (s *Server) adminRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/admin/overview", s.adminOverview)
	mux.HandleFunc("POST /v1/admin/projects", s.adminProject)
	mux.HandleFunc("POST /v1/admin/channels", s.adminChannel)
	mux.HandleFunc("POST /v1/admin/principals", s.adminPrincipal)
	mux.HandleFunc("PUT /v1/admin/access", s.adminAccess)
	mux.HandleFunc("POST /v1/admin/principals/{agent}/rotate-key", s.adminRotate)
	mux.HandleFunc("POST /v1/admin/principals/{agent}/revoke-key", s.adminRevoke)
	mux.HandleFunc("GET /v1/admin/audit", s.adminAudit)
	mux.HandleFunc("GET /v1/admin/deliveries", s.adminDeliveries)
	mux.HandleFunc("POST /v1/admin/projects/{project}/archive", s.adminArchive)
	mux.HandleFunc("POST /v1/admin/projects/{project}/restore", s.adminRestore)
	mux.HandleFunc("GET /v1/admin/projects/{project}/deletion-preview", s.adminDeletionPreview)
	mux.HandleFunc("DELETE /v1/admin/projects/{project}", s.adminDeleteProject)
}

type inventoryPrincipal struct {
	Agent
	KeyActive bool `json:"key_active"`
}
type projectMembership struct {
	ProjectID string `json:"project_id"`
	AgentID   string `json:"agent_id"`
	CanWrite  bool   `json:"can_write"`
}
type channelMembership struct {
	ChannelID string `json:"channel_id"`
	AgentID   string `json:"agent_id"`
	CanWrite  bool   `json:"can_write"`
}

func collect[T any](ctx context.Context, q querier, sql string, scan func(pgx.CollectableRow) (T, error), args ...any) ([]T, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	result, err := pgx.CollectRows(rows, scan)
	if result == nil {
		result = []T{}
	}
	return result, err
}

func (s *Server) adminOverview(w http.ResponseWriter, r *http.Request) {
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	ctx := r.Context()
	principals, err := collect(ctx, tx, "SELECT id,name,kind,runtime,session_id,last_seen_at,activity,key_hash IS NOT NULL,clock_timestamp() FROM principals ORDER BY id", func(row pgx.CollectableRow) (inventoryPrincipal, error) {
		var p inventoryPrincipal
		var now time.Time
		err := row.Scan(&p.ID, &p.Name, &p.Kind, &p.Runtime, &p.SessionID, &p.LastSeenAt, &p.Activity, &p.KeyActive, &now)
		p.Freshness = fresh(p.LastSeenAt, now)
		return p, err
	})
	if err != nil {
		internal(w)
		return
	}
	projects, err := collect(ctx, tx, "SELECT id,name,archived_at,lifecycle_version FROM projects ORDER BY id", func(row pgx.CollectableRow) (Project, error) {
		var p Project
		err := row.Scan(&p.ID, &p.Name, &p.ArchivedAt, &p.LifecycleVersion)
		return p, err
	})
	if err != nil {
		internal(w)
		return
	}
	channels, err := collect(ctx, tx, "SELECT id,project_id,name FROM channels ORDER BY id", func(row pgx.CollectableRow) (Channel, error) {
		var c Channel
		err := row.Scan(&c.ID, &c.ProjectID, &c.Name)
		return c, err
	})
	if err != nil {
		internal(w)
		return
	}
	pm, err := collect(ctx, tx, "SELECT project_id,agent_id,can_write FROM project_members ORDER BY project_id,agent_id", func(row pgx.CollectableRow) (projectMembership, error) {
		var m projectMembership
		err := row.Scan(&m.ProjectID, &m.AgentID, &m.CanWrite)
		return m, err
	})
	if err != nil {
		internal(w)
		return
	}
	cm, err := collect(ctx, tx, "SELECT channel_id,agent_id,can_write FROM channel_members ORDER BY channel_id,agent_id", func(row pgx.CollectableRow) (channelMembership, error) {
		var m channelMembership
		err := row.Scan(&m.ChannelID, &m.AgentID, &m.CanWrite)
		return m, err
	})
	if err != nil {
		internal(w)
		return
	}
	if tx.Commit(ctx) != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"principals": principals, "projects": projects, "channels": channels, "project_members": pm, "channel_members": cm})
}

func (s *Server) adminProject(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validID(in.ID) || !validText(in.Name, 200) {
		fail(w, 400, "invalid project fields")
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	if !unretired(w, r, tx, in.ID, "project") {
		return
	}
	if _, err := tx.Exec(r.Context(), "INSERT INTO projects(id,name) VALUES($1,$2)", in.ID, in.Name); err != nil {
		adminError(w, err)
		return
	}
	if adminCommit(w, r, tx, "project.create", "project", in.ID, auditDetails{}) {
		respond(w, 201, map[string]any{"project": Project{ID: in.ID, Name: in.Name}})
	}
}

func (s *Server) adminChannel(w http.ResponseWriter, r *http.Request) {
	var in Channel
	if !decode(w, r, &in) {
		return
	}
	if !validID(in.ID) || !validID(in.ProjectID) || !validText(in.Name, 200) {
		fail(w, 400, "invalid channel fields")
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	if !activeAdminProject(w, r, tx, in.ProjectID) || !unretired(w, r, tx, in.ID, "channel") {
		return
	}
	if _, err := tx.Exec(r.Context(), "INSERT INTO channels(id,project_id,name) VALUES($1,$2,$3)", in.ID, in.ProjectID, in.Name); err != nil {
		adminError(w, err)
		return
	}
	if adminCommit(w, r, tx, "channel.create", "channel", in.ID, auditDetails{ProjectID: in.ProjectID}) {
		respond(w, 201, map[string]any{"channel": in})
	}
}

func (s *Server) adminPrincipal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Kind    string `json:"kind"`
		Runtime string `json:"runtime"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validID(in.ID) || !validText(in.Name, 200) || (in.Kind != "agent" && in.Kind != "viewer") || len(in.Runtime) > 64 || !utf8.ValidString(in.Runtime) || strings.ContainsRune(in.Runtime, 0) {
		fail(w, 400, "invalid principal fields")
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), "INSERT INTO principals(id,name,kind,runtime) VALUES($1,$2,$3,$4)", in.ID, in.Name, in.Kind, in.Runtime); err != nil {
		adminError(w, err)
		return
	}
	p := inventoryPrincipal{Agent: Agent{Principal: Principal{ID: in.ID, Name: in.Name, Kind: in.Kind}, Runtime: in.Runtime, Freshness: "unknown"}}
	if adminCommit(w, r, tx, "principal.create", "principal", in.ID, auditDetails{Kind: in.Kind}) {
		respond(w, 201, map[string]any{"principal": p})
	}
}

func (s *Server) adminAccess(w http.ResponseWriter, r *http.Request) {
	var in struct {
		AgentID    string `json:"agent_id"`
		Scope      string `json:"scope"`
		ResourceID string `json:"resource_id"`
		Access     string `json:"access"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validID(in.AgentID) || !validID(in.ResourceID) || (in.Scope != "project" && in.Scope != "channel") || (in.Access != "none" && in.Access != "read" && in.Access != "write") {
		fail(w, 400, "invalid access fields")
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	ctx := r.Context()
	var kind string
	err := tx.QueryRow(ctx, "SELECT kind FROM principals WHERE id=$1 FOR UPDATE", in.AgentID).Scan(&kind)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "principal not found")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	if kind == "owner" {
		fail(w, 403, "owner access cannot be changed through HTTP")
		return
	}
	if kind == "viewer" && in.Access == "write" {
		fail(w, 400, "viewer cannot have write access")
		return
	}
	var project string
	if in.Scope == "project" {
		err = tx.QueryRow(ctx, "SELECT id FROM projects WHERE id=$1", in.ResourceID).Scan(&project)
	} else {
		err = tx.QueryRow(ctx, "SELECT project_id FROM channels WHERE id=$1", in.ResourceID).Scan(&project)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "resource not found")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	if !activeAdminProject(w, r, tx, project) {
		return
	}
	if in.Scope == "project" {
		if in.Access == "none" {
			_, err = tx.Exec(ctx, "DELETE FROM channel_members WHERE agent_id=$1 AND channel_id IN (SELECT id FROM channels WHERE project_id=$2)", in.AgentID, project)
			if err == nil {
				_, err = tx.Exec(ctx, "DELETE FROM project_members WHERE agent_id=$1 AND project_id=$2", in.AgentID, project)
			}
		} else {
			_, err = tx.Exec(ctx, "INSERT INTO project_members(project_id,agent_id,can_write) VALUES($1,$2,$3) ON CONFLICT(project_id,agent_id) DO UPDATE SET can_write=EXCLUDED.can_write", project, in.AgentID, in.Access == "write")
			if err == nil && in.Access == "read" {
				_, err = tx.Exec(ctx, "UPDATE channel_members SET can_write=false WHERE agent_id=$1 AND channel_id IN (SELECT id FROM channels WHERE project_id=$2)", in.AgentID, project)
			}
		}
	} else if in.Access == "none" {
		_, err = tx.Exec(ctx, "DELETE FROM channel_members WHERE channel_id=$1 AND agent_id=$2", in.ResourceID, in.AgentID)
	} else {
		if !projectAccess(ctx, tx, project, in.AgentID, in.Access == "write") {
			fail(w, 409, "matching project access required before channel access")
			return
		}
		_, err = tx.Exec(ctx, "INSERT INTO channel_members(channel_id,agent_id,can_write) VALUES($1,$2,$3) ON CONFLICT(channel_id,agent_id) DO UPDATE SET can_write=EXCLUDED.can_write", in.ResourceID, in.AgentID, in.Access == "write")
	}
	if err != nil {
		internal(w)
		return
	}
	if adminCommit(w, r, tx, "access.set", in.Scope, in.ResourceID, auditDetails{AgentID: in.AgentID, Scope: in.Scope, ResourceID: in.ResourceID, Access: in.Access}) {
		respond(w, 200, map[string]bool{"updated": true})
	}
}

func (s *Server) adminKey(w http.ResponseWriter, r *http.Request, rotate bool) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
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
	var kind string
	err := tx.QueryRow(r.Context(), "SELECT kind FROM principals WHERE id=$1 FOR UPDATE", id).Scan(&kind)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "principal not found")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	if kind == "owner" {
		fail(w, 403, "owner keys are managed only through local CLI")
		return
	}
	var key string
	var hash []byte
	action := "key.revoke"
	if rotate {
		key, err = randomHex(32)
		if err != nil {
			internal(w)
			return
		}
		hash = digest(key)
		action = "key.rotate"
	}
	if _, err = tx.Exec(r.Context(), "UPDATE principals SET key_hash=$1 WHERE id=$2", hash, id); err != nil {
		internal(w)
		return
	}
	if err = revokeAgentInvitations(r.Context(), tx, id); err != nil {
		internal(w)
		return
	}
	if !adminCommit(w, r, tx, action, "principal", id, auditDetails{}) {
		return
	}
	if rotate {
		respond(w, 200, map[string]string{"agent_id": id, "key": key})
	} else {
		respond(w, 200, map[string]bool{"revoked": true})
	}
}
func (s *Server) adminRotate(w http.ResponseWriter, r *http.Request) { s.adminKey(w, r, true) }
func (s *Server) adminRevoke(w http.ResponseWriter, r *http.Request) { s.adminKey(w, r, false) }

func adminLimit(w http.ResponseWriter, r *http.Request) (int, bool) {
	limit := 100
	if raw, exists := r.URL.Query()["limit"]; exists {
		if len(raw) != 1 {
			fail(w, 400, "invalid limit")
			return 0, false
		}
		var err error
		limit, err = strconv.Atoi(raw[0])
		if err != nil || limit < 1 {
			fail(w, 400, "invalid limit")
			return 0, false
		}
		if limit > 500 {
			limit = 500
		}
	}
	return limit, true
}

type auditEntry struct {
	ID         int64        `json:"id"`
	ActorID    string       `json:"actor_id"`
	Action     string       `json:"action"`
	TargetType string       `json:"target_type"`
	TargetID   string       `json:"target_id"`
	Details    auditDetails `json:"details"`
	CreatedAt  time.Time    `json:"created_at"`
}

func (s *Server) adminAudit(w http.ResponseWriter, r *http.Request) {
	limit, ok := adminLimit(w, r)
	if !ok {
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	entries, err := collect(r.Context(), tx, "SELECT id,actor_id,action,target_type,target_id,details,created_at FROM admin_audit ORDER BY created_at DESC,id DESC LIMIT $1", func(row pgx.CollectableRow) (auditEntry, error) {
		var e auditEntry
		err := row.Scan(&e.ID, &e.ActorID, &e.Action, &e.TargetType, &e.TargetID, &e.Details, &e.CreatedAt)
		return e, err
	}, limit+1)
	if err != nil {
		internal(w)
		return
	}
	if tx.Commit(r.Context()) != nil {
		internal(w)
		return
	}
	truncated := len(entries) > limit
	if truncated {
		entries = entries[:limit]
	}
	respond(w, 200, map[string]any{"entries": entries, "truncated": truncated})
}

type delivery struct {
	MessageID   string     `json:"message_id"`
	ChannelID   string     `json:"channel_id"`
	AuthorID    string     `json:"author_id"`
	RecipientID string     `json:"recipient_id"`
	CreatedAt   time.Time  `json:"created_at"`
	DeliveredAt *time.Time `json:"delivered_at"`
	AcceptedAt  *time.Time `json:"accepted_at"`
	UncertainAt *time.Time `json:"uncertain_at"`
}

func (s *Server) adminDeliveries(w http.ResponseWriter, r *http.Request) {
	limit, ok := adminLimit(w, r)
	if !ok {
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	entries, err := collect(r.Context(), tx, `SELECT m.id,m.channel_id,m.author_id,r.agent_id,m.created_at,r.delivered_at,r.accepted_at,r.uncertain_at FROM receipts r JOIN messages m ON m.id=r.message_id WHERE r.accepted_at IS NULL OR r.uncertain_at IS NOT NULL ORDER BY m.created_at DESC,m.id DESC,r.agent_id LIMIT $1`, func(row pgx.CollectableRow) (delivery, error) {
		var d delivery
		err := row.Scan(&d.MessageID, &d.ChannelID, &d.AuthorID, &d.RecipientID, &d.CreatedAt, &d.DeliveredAt, &d.AcceptedAt, &d.UncertainAt)
		return d, err
	}, limit+1)
	if err != nil {
		internal(w)
		return
	}
	if tx.Commit(r.Context()) != nil {
		internal(w)
		return
	}
	truncated := len(entries) > limit
	if truncated {
		entries = entries[:limit]
	}
	respond(w, 200, map[string]any{"deliveries": entries, "truncated": truncated})
}
