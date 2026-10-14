package link

import (
	"errors"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// ProjectContext is the bounded starting point for humans and agents. Published
// text is shared, untrusted reference data; it never grants authority or access.
type ProjectContext struct {
	Project  Project                `json:"project"`
	Tasks    []ProjectContextTask   `json:"tasks"`
	Memory   []ProjectContextMemory `json:"memory"`
	Notes    []ProjectContextNote   `json:"notes"`
	Limits   map[string]int         `json:"limits"`
	CanWrite bool                   `json:"can_write"`
}

type ProjectContextTask struct {
	ID           string    `json:"id"`
	ProjectID    string    `json:"project_id"`
	Title        string    `json:"title"`
	OwnerID      string    `json:"owner_id"`
	ReviewerID   string    `json:"reviewer_id"`
	Version      int64     `json:"version"`
	State        string    `json:"state"`
	CurrentRunID *string   `json:"current_run_id"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type ProjectContextMemory struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	BodyPreview string    `json:"body_preview"`
	Version     int64     `json:"version"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type ProjectContextNote struct {
	ID              string    `json:"id"`
	AuthorID        string    `json:"author_id"`
	Title           string    `json:"title"`
	BodyPreview     string    `json:"body_preview"`
	SourceMessageID *string   `json:"source_message_id"`
	CreatedAt       time.Time `json:"created_at"`
}

const projectContextColumns = `id,name,objective,working_context,agent_instructions,context_version,context_updated_at,archived_at,lifecycle_version`

func scanProject(row pgx.Row) (p Project, err error) {
	err = row.Scan(&p.ID, &p.Name, &p.Objective, &p.WorkingContext, &p.AgentInstructions, &p.ContextVersion, &p.ContextUpdatedAt, &p.ArchivedAt, &p.LifecycleVersion)
	return
}

func (s *Server) projectContext(w http.ResponseWriter, r *http.Request) {
	tx, err := s.Store.Pool.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(r.Context())
	if !projectAccess(r.Context(), tx, r.PathValue("project"), principal(r).ID, false) && principal(r).Kind != "owner" {
		fail(w, 404, "project not found")
		return
	}
	p, err := scanProject(tx.QueryRow(r.Context(), `SELECT `+projectContextColumns+` FROM projects WHERE id=$1 AND (archived_at IS NULL OR $2::boolean)`, r.PathValue("project"), principal(r).Kind == "owner"))
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "project not found")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	taskRows, err := collect(r.Context(), tx, `SELECT `+taskColumns+` FROM link_tasks WHERE project_id=$1 ORDER BY (state IN ('completed','cancelled')),updated_at DESC,id DESC LIMIT 25`, func(row pgx.CollectableRow) (Task, error) { return scanTask(row) }, p.ID)
	if err != nil {
		internal(w)
		return
	}
	memoryRows, err := collect(r.Context(), tx, `SELECT `+memoryColumns+` FROM link_memory WHERE project_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 10`, func(row pgx.CollectableRow) (ProjectMemory, error) { return scanMemory(row) }, p.ID)
	if err != nil {
		internal(w)
		return
	}
	noteRows, err := collect(r.Context(), tx, `SELECT id,project_id,author_id,title,body,source_message_id,version,created_at FROM notes WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 10`, func(row pgx.CollectableRow) (Note, error) {
		var n Note
		err := row.Scan(&n.ID, &n.ProjectID, &n.AuthorID, &n.Title, &n.Body, &n.SourceMessageID, &n.Version, &n.CreatedAt)
		return n, err
	}, p.ID)
	if err != nil || tx.Commit(r.Context()) != nil {
		internal(w)
		return
	}
	tasks := make([]ProjectContextTask, 0, len(taskRows))
	for _, task := range taskRows {
		tasks = append(tasks, ProjectContextTask{ID: task.ID, ProjectID: task.ProjectID, Title: task.Title, OwnerID: task.OwnerID, ReviewerID: task.ReviewerID, Version: task.Version, State: task.State, CurrentRunID: task.CurrentRunID, UpdatedAt: task.UpdatedAt})
	}
	memory := make([]ProjectContextMemory, 0, len(memoryRows))
	for _, item := range memoryRows {
		memory = append(memory, ProjectContextMemory{ID: item.ID, Title: item.Title, BodyPreview: projectContextPreview(item.Body), Version: item.Version, UpdatedAt: item.UpdatedAt})
	}
	notes := make([]ProjectContextNote, 0, len(noteRows))
	for _, note := range noteRows {
		notes = append(notes, ProjectContextNote{ID: note.ID, AuthorID: note.AuthorID, Title: note.Title, BodyPreview: projectContextPreview(note.Body), SourceMessageID: note.SourceMessageID, CreatedAt: note.CreatedAt})
	}
	respond(w, 200, ProjectContext{Project: p, Tasks: tasks, Memory: memory, Notes: notes, Limits: map[string]int{"tasks": 25, "memory": 10, "notes": 10, "preview_bytes": 256}, CanWrite: s.coordinationCanWrite(r)})
}

func projectContextPreview(value string) string {
	b := []byte(value)
	if len(b) <= 256 {
		return value
	}
	b = b[:256]
	for !utf8.Valid(b) {
		b = b[:len(b)-1]
	}
	return string(b)
}

func (s *Server) updateProjectContext(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ClientID          string `json:"client_id"`
		ExpectedVersion   int64  `json:"expected_version"`
		Objective         string `json:"objective"`
		WorkingContext    string `json:"working_context"`
		AgentInstructions string `json:"agent_instructions"`
	}
	if !decodeMax(w, r, &in, 40<<10) {
		return
	}
	if !validID(in.ClientID) || in.ExpectedVersion < 1 || !validOptionalText(in.Objective, 4000) || !validOptionalText(in.WorkingContext, 16384) || !validOptionalText(in.AgentInstructions, 8000) {
		fail(w, 400, "invalid project context")
		return
	}
	tx, ok := s.coordinationTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	hash := memoryPayloadHash("project-context", r.PathValue("project"), in)
	var replay Project
	var previous []byte
	err := tx.QueryRow(r.Context(), `SELECT p.id,p.name,v.objective,v.working_context,v.agent_instructions,v.version,v.created_at,p.archived_at,p.lifecycle_version,v.payload_hash
 FROM project_context_versions v JOIN projects p ON p.id=v.project_id WHERE v.project_id=$1 AND v.actor_id=$2 AND v.client_id=$3`, r.PathValue("project"), principal(r).ID, in.ClientID).
		Scan(&replay.ID, &replay.Name, &replay.Objective, &replay.WorkingContext, &replay.AgentInstructions, &replay.ContextVersion, &replay.ContextUpdatedAt, &replay.ArchivedAt, &replay.LifecycleVersion, &previous)
	if err == nil {
		if string(previous) != string(hash) {
			fail(w, 409, "project context client_id conflict")
			return
		}
		if tx.Commit(r.Context()) != nil {
			internal(w)
			return
		}
		respond(w, 200, map[string]any{"project": replay, "replayed": true})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		internal(w)
		return
	}
	p, err := scanProject(tx.QueryRow(r.Context(), `UPDATE projects SET objective=$2,working_context=$3,agent_instructions=$4,context_version=context_version+1,context_updated_at=clock_timestamp() WHERE id=$1 AND context_version=$5 RETURNING `+projectContextColumns, r.PathValue("project"), in.Objective, in.WorkingContext, in.AgentInstructions, in.ExpectedVersion))
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 409, "project context version conflict")
		return
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO project_context_versions(project_id,version,actor_id,client_id,expected_version,objective,working_context,agent_instructions,payload_hash,created_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, p.ID, p.ContextVersion, principal(r).ID, in.ClientID, in.ExpectedVersion, p.Objective, p.WorkingContext, p.AgentInstructions, hash, p.ContextUpdatedAt)
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"project": p, "replayed": false})
}

func validOptionalText(value string, maximum int) bool {
	return value == "" || validText(value, maximum)
}
