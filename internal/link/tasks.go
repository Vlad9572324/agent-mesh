package link

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed tasks_schema.sql
var tasksSchema string

type Task struct {
	ID           string    `json:"id"`
	ProjectID    string    `json:"project_id"`
	Title        string    `json:"title"`
	OwnerID      string    `json:"owner_id"`
	ReviewerID   string    `json:"reviewer_id"`
	Scope        []string  `json:"scope"`
	Acceptance   []string  `json:"acceptance"`
	CreatedBy    string    `json:"created_by"`
	Version      int64     `json:"version"`
	State        string    `json:"state"`
	CurrentRunID *string   `json:"current_run_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type TaskArtifactRef struct {
	ArtifactID string `json:"artifact_id"`
	SHA256     string `json:"sha256"`
	Role       string `json:"role"`
}

// Nested JSON needs the same duplicate/exact-field protection as the top level.
func (v *TaskArtifactRef) UnmarshalJSON(b []byte) error {
	type plain TaskArtifactRef
	var p plain
	if !strictObject(b, &p) {
		return errors.New("invalid artifact reference object")
	}
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*v = TaskArtifactRef(p)
	return nil
}

type TaskEvidence struct {
	Status   string          `json:"status"`
	Command  string          `json:"command"`
	ExitCode *int            `json:"exit_code"`
	Artifact TaskArtifactRef `json:"artifact"`
}

func (v *TaskEvidence) UnmarshalJSON(b []byte) error {
	type plain TaskEvidence
	var p plain
	if !strictObject(b, &p) {
		return errors.New("invalid evidence object")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(b, &fields) != nil || len(fields) != 4 {
		return errors.New("all evidence fields required, including nullable exit_code")
	}
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*v = TaskEvidence(p)
	return nil
}

type TaskRun struct {
	ID                 string            `json:"id"`
	TaskID             string            `json:"task_id"`
	State              string            `json:"state"`
	Version            int64             `json:"version"`
	Artifacts          []TaskArtifactRef `json:"artifacts"`
	ReviewRequestID    *string           `json:"review_request_id"`
	VerificationStatus *string           `json:"verification_status"`
	CreatedAt          time.Time         `json:"created_at"`
	UpdatedAt          time.Time         `json:"updated_at"`
}

type TaskEventInput struct {
	ClientID        string            `json:"client_id"`
	ExpectedVersion int64             `json:"expected_version"`
	Type            string            `json:"type"`
	RunID           string            `json:"run_id"`
	Summary         string            `json:"summary"`
	Artifacts       []TaskArtifactRef `json:"artifacts,omitempty"`
	ReviewRequestID *string           `json:"review_request_id,omitempty"`
	Verdict         *string           `json:"verdict,omitempty"`
	Evidence        *TaskEvidence     `json:"evidence,omitempty"`
	RecoveryAction  *string           `json:"recovery_action,omitempty"`
}

type TaskEvent struct {
	ID              string            `json:"id"`
	TaskID          string            `json:"task_id"`
	RunID           string            `json:"run_id"`
	ActorID         string            `json:"actor_id"`
	ClientID        string            `json:"client_id"`
	Version         int64             `json:"version"`
	Type            string            `json:"type"`
	Summary         string            `json:"summary"`
	Artifacts       []TaskArtifactRef `json:"artifacts"`
	ReviewRequestID *string           `json:"review_request_id"`
	Verdict         *string           `json:"verdict"`
	Evidence        *TaskEvidence     `json:"evidence"`
	RecoveryAction  *string           `json:"recovery_action"`
	CreatedAt       time.Time         `json:"created_at"`
}

const taskColumns = `id,project_id,title,owner_id,reviewer_id,scope,acceptance,created_by,version,state,current_run_id,created_at,updated_at`
const taskRunColumns = `id,task_id,state,version,artifacts,review_request_id,verification_status,created_at,updated_at`
const taskEventColumns = `id,task_id,run_id,actor_id,client_id,version,type,payload,created_at`

func scanTask(row pgx.Row) (t Task, err error) {
	err = row.Scan(&t.ID, &t.ProjectID, &t.Title, &t.OwnerID, &t.ReviewerID, &t.Scope, &t.Acceptance, &t.CreatedBy, &t.Version, &t.State, &t.CurrentRunID, &t.CreatedAt, &t.UpdatedAt)
	return
}
func scanTaskRun(row pgx.Row) (v TaskRun, err error) {
	err = row.Scan(&v.ID, &v.TaskID, &v.State, &v.Version, &v.Artifacts, &v.ReviewRequestID, &v.VerificationStatus, &v.CreatedAt, &v.UpdatedAt)
	return
}
func scanTaskEvent(row pgx.Row) (v TaskEvent, err error) {
	var b []byte
	err = row.Scan(&v.ID, &v.TaskID, &v.RunID, &v.ActorID, &v.ClientID, &v.Version, &v.Type, &b, &v.CreatedAt)
	if err != nil {
		return
	}
	var in TaskEventInput
	err = json.Unmarshal(b, &in)
	v.Summary, v.Artifacts, v.ReviewRequestID, v.Verdict, v.Evidence, v.RecoveryAction = in.Summary, in.Artifacts, in.ReviewRequestID, in.Verdict, in.Evidence, in.RecoveryAction
	if v.Artifacts == nil {
		v.Artifacts = []TaskArtifactRef{}
	}
	return
}

func (s *Server) taskRoutes(api *http.ServeMux) {
	api.HandleFunc("GET /v1/projects/{project}/tasks", s.listTasks)
	api.HandleFunc("POST /v1/projects/{project}/tasks", s.createTask)
	api.HandleFunc("GET /v1/projects/{project}/tasks/{task}", s.getTask)
	api.HandleFunc("GET /v1/projects/{project}/tasks/{task}/events", s.listTaskEvents)
	api.HandleFunc("POST /v1/projects/{project}/tasks/{task}/events", s.appendTaskEvent)
}

// New project-wide records use the existing auth/ACL lock order. Holding the
// project row also serializes archive/deletion and bounded per-project writes.
func (s *Server) coordinationTx(w http.ResponseWriter, r *http.Request) (pgx.Tx, bool) {
	tx, err := s.Store.Pool.Begin(r.Context())
	if err != nil {
		internal(w)
		return nil, false
	}
	if !s.authorizeWrite(w, r, tx, false) {
		_ = tx.Rollback(r.Context())
		return nil, false
	}
	ok := projectAccess(r.Context(), tx, r.PathValue("project"), principal(r).ID, true)
	if !ok {
		fail(w, 404, "project not found")
		_ = tx.Rollback(r.Context())
		return nil, false
	}
	var id string
	err = tx.QueryRow(r.Context(), `SELECT id FROM projects WHERE id=$1 AND archived_at IS NULL FOR UPDATE`, r.PathValue("project")).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			fail(w, 404, "project not found")
		} else {
			internal(w)
		}
		_ = tx.Rollback(r.Context())
		return nil, false
	}
	return tx, true
}

func (s *Server) coordinationCanWrite(r *http.Request) bool {
	if principal(r).Kind != "agent" {
		return false
	}
	return projectAccess(r.Context(), s.Store.Pool, r.PathValue("project"), principal(r).ID, true)
}

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	if !s.projectAllowed(w, r, false) {
		return
	}
	rows, err := s.Store.Pool.Query(r.Context(), `SELECT `+taskColumns+` FROM link_tasks WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1001`, r.PathValue("project"))
	if err != nil {
		internal(w)
		return
	}
	defer rows.Close()
	items := []Task{}
	for rows.Next() {
		v, err := scanTask(rows)
		if err != nil {
			internal(w)
			return
		}
		items = append(items, v)
	}
	if rows.Err() != nil {
		internal(w)
		return
	}
	truncated := len(items) > 1000
	if truncated {
		items = items[:1000]
	}
	respond(w, 200, map[string]any{"tasks": items, "truncated": truncated, "can_write": s.coordinationCanWrite(r)})
}

func (s *Server) getTask(w http.ResponseWriter, r *http.Request) {
	tx, err := s.Store.Pool.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(r.Context())
	if !projectAccess(r.Context(), tx, r.PathValue("project"), principal(r).ID, false) {
		fail(w, 404, "project not found")
		return
	}
	t, err := scanTask(tx.QueryRow(r.Context(), `SELECT `+taskColumns+` FROM link_tasks WHERE id=$1 AND project_id=$2`, r.PathValue("task"), r.PathValue("project")))
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "task not found")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	rows, err := tx.Query(r.Context(), `SELECT `+taskRunColumns+` FROM link_task_runs WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1000`, t.ID)
	if err != nil {
		internal(w)
		return
	}
	runs := []TaskRun{}
	for rows.Next() {
		v, e := scanTaskRun(rows)
		if e != nil {
			rows.Close()
			internal(w)
			return
		}
		runs = append(runs, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		internal(w)
		return
	}
	events, truncated, err := s.taskEvents(r.Context(), tx, t.ID, 0, 200, true)
	if err != nil {
		internal(w)
		return
	}
	canWrite := principal(r).Kind == "agent" && projectAccess(r.Context(), tx, t.ProjectID, principal(r).ID, true)
	respond(w, 200, map[string]any{"task": t, "runs": runs, "events": events, "events_truncated": truncated, "can_write": canWrite})
}

func (s *Server) taskEvents(ctx context.Context, q querier, taskID string, after int64, limit int, latest bool) ([]TaskEvent, bool, error) {
	order := "ASC"
	if latest {
		order = "DESC"
	}
	rows, err := q.Query(ctx, `SELECT `+taskEventColumns+` FROM link_task_events WHERE task_id=$1 AND version>$2 ORDER BY version `+order+` LIMIT $3`, taskID, after, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := []TaskEvent{}
	for rows.Next() {
		v, e := scanTaskEvent(rows)
		if e != nil {
			return nil, false, e
		}
		items = append(items, v)
	}
	if rows.Err() != nil {
		return nil, false, rows.Err()
	}
	truncated := len(items) > limit
	if truncated {
		items = items[:limit]
	}
	if latest {
		for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
			items[i], items[j] = items[j], items[i]
		}
	}
	return items, truncated, nil
}

func (s *Server) listTaskEvents(w http.ResponseWriter, r *http.Request) {
	if !s.projectAllowed(w, r, false) {
		return
	}
	var exists bool
	if err := s.Store.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM link_tasks WHERE id=$1 AND project_id=$2)`, r.PathValue("task"), r.PathValue("project")).Scan(&exists); err != nil {
		internal(w)
		return
	}
	if !exists {
		fail(w, 404, "task not found")
		return
	}
	after := int64(0)
	limit := 200
	if raw := r.URL.Query().Get("after_version"); raw != "" {
		var err error
		after, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || after < 0 {
			fail(w, 400, "invalid after_version")
			return
		}
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 1000 {
			fail(w, 400, "invalid limit")
			return
		}
	}
	items, truncated, err := s.taskEvents(r.Context(), s.Store.Pool, r.PathValue("task"), after, limit, false)
	if err != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"events": items, "truncated": truncated})
}

type taskCreateInput struct {
	ClientID   string   `json:"client_id"`
	Title      string   `json:"title"`
	OwnerID    string   `json:"owner_id"`
	ReviewerID string   `json:"reviewer_id"`
	Scope      []string `json:"scope"`
	Acceptance []string `json:"acceptance"`
}

func taskNonempty(v string, max int) bool { return validText(v, max) && strings.TrimSpace(v) != "" }
func taskScopeValid(scope []string) bool {
	if len(scope) < 1 || len(scope) > 32 {
		return false
	}
	seen := map[string]bool{}
	for _, v := range scope {
		if !taskNonempty(v, 300) || strings.IndexFunc(v, func(c rune) bool { return c < 32 || c == 127 }) >= 0 || path.IsAbs(v) || strings.Contains(v, "\\") || strings.Contains(v, ":") || path.Clean(v) != strings.TrimSuffix(v, "/") || v == "." || strings.HasPrefix(v, "../") || v == ".." || seen[strings.TrimSuffix(v, "/")] {
			return false
		}
		seen[strings.TrimSuffix(v, "/")] = true
	}
	return true
}

func (s *Server) createTask(w http.ResponseWriter, r *http.Request) {
	var in taskCreateInput
	if !decode(w, r, &in) {
		return
	}
	if !validID(in.ClientID) || !taskNonempty(in.Title, 200) || !validID(in.OwnerID) || !validID(in.ReviewerID) || in.OwnerID == in.ReviewerID || !taskScopeValid(in.Scope) || len(in.Acceptance) < 1 || len(in.Acceptance) > 32 {
		fail(w, 400, "invalid task definition")
		return
	}
	for _, v := range in.Acceptance {
		if !taskNonempty(v, 1200) {
			fail(w, 400, "invalid acceptance criterion")
			return
		}
	}
	b, _ := json.Marshal(in)
	hash := digest(string(b))
	tx, ok := s.coordinationTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	var id string
	var previous []byte
	err := tx.QueryRow(r.Context(), `SELECT id,payload_hash FROM link_tasks WHERE project_id=$1 AND created_by=$2 AND client_id=$3`, r.PathValue("project"), principal(r).ID, in.ClientID).Scan(&id, &previous)
	if err == nil {
		if !bytes.Equal(previous, hash) {
			fail(w, 409, "client_id payload conflict")
			return
		}
		t, e := scanTask(tx.QueryRow(r.Context(), `SELECT `+taskColumns+` FROM link_tasks WHERE id=$1`, id))
		if e != nil {
			internal(w)
			return
		}
		respond(w, 200, map[string]any{"task": t, "replayed": true})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		internal(w)
		return
	}
	var eligible int
	err = tx.QueryRow(r.Context(), `SELECT count(*) FROM project_members m JOIN principals p ON p.id=m.agent_id WHERE m.project_id=$1 AND m.can_write AND p.kind='agent' AND p.key_hash IS NOT NULL AND p.id=ANY($2::text[])`, r.PathValue("project"), []string{in.OwnerID, in.ReviewerID}).Scan(&eligible)
	if err != nil {
		internal(w)
		return
	}
	if eligible != 2 {
		fail(w, 409, "owner and reviewer must be distinct active writable project agents")
		return
	}
	id, err = randomHex(16)
	if err != nil {
		internal(w)
		return
	}
	t, err := scanTask(tx.QueryRow(r.Context(), `INSERT INTO link_tasks(id,project_id,title,owner_id,reviewer_id,scope,acceptance,created_by,client_id,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING `+taskColumns, id, r.PathValue("project"), in.Title, in.OwnerID, in.ReviewerID, in.Scope, in.Acceptance, principal(r).ID, in.ClientID, hash))
	if err != nil {
		internal(w)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		internal(w)
		return
	}
	respond(w, 201, map[string]any{"task": t, "replayed": false})
}

func taskRefsValid(refs []TaskArtifactRef) bool {
	if len(refs) < 1 || len(refs) > 32 {
		return false
	}
	seen := map[string]bool{}
	for _, v := range refs {
		if !validID(v.ArtifactID) || seen[v.ArtifactID] || len(v.SHA256) != 64 {
			return false
		}
		for _, c := range v.SHA256 {
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				return false
			}
		}
		switch v.Role {
		case "baseline", "implementation", "test", "evidence", "bundle":
		default:
			return false
		}
		seen[v.ArtifactID] = true
	}
	return true
}
func canonicalTaskRefs(refs []TaskArtifactRef) []TaskArtifactRef {
	result := append([]TaskArtifactRef{}, refs...)
	sort.Slice(result, func(i, j int) bool { return result[i].ArtifactID < result[j].ArtifactID })
	return result
}
func sameTaskRefs(a, b []TaskArtifactRef) bool {
	if len(a) != len(b) {
		return false
	}
	a = canonicalTaskRefs(a)
	b = canonicalTaskRefs(b)
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
func taskEventValid(in TaskEventInput) bool {
	if !validID(in.ClientID) || in.ExpectedVersion < 1 || !validID(in.RunID) || !taskNonempty(in.Summary, 2500) {
		return false
	}
	hasArtifacts, hasRequest, hasVerdict, hasEvidence, hasRecovery := false, false, false, false, false
	switch in.Type {
	case "run_started", "uncertain", "cancelled":
	case "artifacts_ready", "review_requested":
		hasArtifacts = true
	case "review_result":
		hasArtifacts = true
		hasRequest = true
		hasVerdict = true
	case "verification_reported":
		hasArtifacts = true
		hasEvidence = true
	case "completion_reported":
		hasArtifacts = true
		hasRequest = true
	case "recovery_decided":
		hasRecovery = true
	default:
		return false
	}
	if hasArtifacts {
		if !taskRefsValid(in.Artifacts) {
			return false
		}
	} else if len(in.Artifacts) > 0 {
		return false
	}
	if (in.ReviewRequestID != nil) != hasRequest || (in.Verdict != nil) != hasVerdict || (in.Evidence != nil) != hasEvidence || (in.RecoveryAction != nil) != hasRecovery {
		return false
	}
	if hasRequest && !validID(*in.ReviewRequestID) {
		return false
	}
	if hasVerdict && *in.Verdict != "approved" && *in.Verdict != "changes_requested" {
		return false
	}
	if hasRecovery && *in.RecoveryAction != "resume" && *in.RecoveryAction != "cancel" {
		return false
	}
	if hasEvidence {
		e := in.Evidence
		if !taskNonempty(e.Command, 2000) || !taskRefsValid([]TaskArtifactRef{e.Artifact}) || e.Artifact.Role != "evidence" {
			return false
		}
		switch e.Status {
		case "passed":
			if e.ExitCode == nil || *e.ExitCode != 0 {
				return false
			}
		case "failed":
			if e.ExitCode != nil && *e.ExitCode == 0 {
				return false
			}
		case "inconclusive":
		default:
			return false
		}
		found := false
		for _, v := range in.Artifacts {
			if v == e.Artifact {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func taskTerminal(state string) bool { return state == "completion_reported" || state == "cancelled" }

// Pure transition validation: a successful return records an attributed claim,
// never executes a command or asserts that external file writes have stopped.
func taskTransition(t Task, run TaskRun, in TaskEventInput, actor, eventID string) (TaskRun, int, string) {
	owner, reviewer := actor == t.OwnerID, actor == t.ReviewerID
	if !owner && !reviewer {
		return run, 403, "task owner or reviewer required"
	}
	if in.Type == "review_result" {
		if !reviewer {
			return run, 403, "task reviewer required"
		}
	} else if in.Type != "uncertain" && in.Type != "verification_reported" && !owner {
		return run, 403, "task owner required"
	}
	if in.Type == "run_started" {
		if t.State != "ready" && !taskTerminal(t.State) {
			return run, 409, "previous run is not terminal"
		}
		return TaskRun{ID: in.RunID, TaskID: t.ID, State: "running", Version: t.Version + 1, Artifacts: []TaskArtifactRef{}}, 0, ""
	}
	if t.CurrentRunID == nil || *t.CurrentRunID != in.RunID || run.ID != in.RunID || taskTerminal(run.State) {
		return run, 409, "current nonterminal run required"
	}
	if in.Type != "recovery_decided" && run.State == "uncertain" && in.Type != "cancelled" {
		return run, 409, "explicit recovery decision required"
	}
	match := func() bool { return sameTaskRefs(in.Artifacts, run.Artifacts) }
	clear := func() { run.ReviewRequestID = nil; run.VerificationStatus = nil }
	switch in.Type {
	case "artifacts_ready":
		switch run.State {
		case "running", "artifacts_ready", "changes_requested", "approved", "review_pending":
		default:
			return run, 409, "run cannot accept artifacts in this state"
		}
		run.Artifacts = canonicalTaskRefs(in.Artifacts)
		run.State = "artifacts_ready"
		clear()
	case "review_requested":
		if run.State != "artifacts_ready" || !match() {
			return run, 409, "current artifact set required in artifacts_ready state"
		}
		run.State = "review_pending"
		run.ReviewRequestID = &eventID
	case "review_result":
		if run.State != "review_pending" || run.ReviewRequestID == nil || *run.ReviewRequestID != *in.ReviewRequestID || !match() {
			return run, 409, "stale review request or artifact set"
		}
		run.State = *in.Verdict
	case "verification_reported":
		if (run.State != "artifacts_ready" && run.State != "review_pending" && run.State != "approved" && run.State != "changes_requested") || !match() {
			return run, 409, "current artifact set required for external evidence"
		}
		run.VerificationStatus = &in.Evidence.Status
	case "completion_reported":
		if run.State != "approved" || run.VerificationStatus == nil || *run.VerificationStatus != "passed" || run.ReviewRequestID == nil || *run.ReviewRequestID != *in.ReviewRequestID || !match() {
			return run, 409, "current approval and passed external evidence required"
		}
		run.State = "completion_reported"
	case "uncertain":
		run.State = "uncertain"
		clear()
	case "recovery_decided":
		if run.State != "uncertain" {
			return run, 409, "run is not uncertain"
		}
		clear()
		if *in.RecoveryAction == "cancel" {
			run.State = "cancelled"
		} else {
			run.State = "running"
			run.Artifacts = []TaskArtifactRef{}
		}
	case "cancelled":
		run.State = "cancelled"
		clear()
	default:
		return run, 400, "invalid event type"
	}
	run.Version = t.Version + 1
	return run, 0, ""
}

func validateTaskArtifacts(ctx context.Context, tx pgx.Tx, t Task, refs []TaskArtifactRef) (bool, error) {
	// Upload provenance survives key rotation/revocation and write downgrades.
	// Referencing immutable history is not a new action by that uploader. The
	// actor publishing this event has independently reauthenticated write ACL.
	// An uploader removed from the project is deliberately ineligible here.
	baseRevision := ""
	for _, v := range refs {
		var base string
		err := tx.QueryRow(ctx, `SELECT a.base_revision FROM link_artifacts a JOIN principals p ON p.id=a.author_id JOIN project_members m ON m.agent_id=a.author_id AND m.project_id=a.project_id WHERE a.id=$1 AND a.project_id=$2 AND a.sha256=$3 AND a.role=$4 AND p.kind='agent' AND ($4<>'implementation' OR a.author_id=$5)`, v.ArtifactID, t.ProjectID, v.SHA256, v.Role, t.OwnerID).Scan(&base)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if !validID(base) || (baseRevision != "" && baseRevision != base) {
			return false, nil
		}
		baseRevision = base
	}
	return true, nil
}

func (s *Server) appendTaskEvent(w http.ResponseWriter, r *http.Request) {
	var in TaskEventInput
	if !decode(w, r, &in) {
		return
	}
	if !taskEventValid(in) {
		fail(w, 400, "invalid typed task event")
		return
	}
	in.Artifacts = canonicalTaskRefs(in.Artifacts)
	b, _ := json.Marshal(in)
	hash := digest(string(b))
	tx, ok := s.coordinationTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	t, err := scanTask(tx.QueryRow(r.Context(), `SELECT `+taskColumns+` FROM link_tasks WHERE id=$1 AND project_id=$2 FOR UPDATE`, r.PathValue("task"), r.PathValue("project")))
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "task not found")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	var previous []byte
	err = tx.QueryRow(r.Context(), `SELECT payload_hash FROM link_task_events WHERE task_id=$1 AND actor_id=$2 AND client_id=$3`, t.ID, principal(r).ID, in.ClientID).Scan(&previous)
	if err == nil {
		if !bytes.Equal(previous, hash) {
			fail(w, 409, "client_id payload conflict")
			return
		}
		e, err := scanTaskEvent(tx.QueryRow(r.Context(), `SELECT `+taskEventColumns+` FROM link_task_events WHERE task_id=$1 AND actor_id=$2 AND client_id=$3`, t.ID, principal(r).ID, in.ClientID))
		if err != nil {
			internal(w)
			return
		}
		respond(w, 200, map[string]any{"task": t, "event": e, "replayed": true, "server_verified": false})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		internal(w)
		return
	}
	if t.Version != in.ExpectedVersion {
		fail(w, 409, "task version conflict")
		return
	}
	var run TaskRun
	if in.Type != "run_started" {
		run, err = scanTaskRun(tx.QueryRow(r.Context(), `SELECT `+taskRunColumns+` FROM link_task_runs WHERE id=$1 AND task_id=$2`, in.RunID, t.ID))
		if errors.Is(err, pgx.ErrNoRows) {
			fail(w, 409, "run does not belong to task")
			return
		}
		if err != nil {
			internal(w)
			return
		}
	}
	eventID, err := randomHex(16)
	if err != nil {
		internal(w)
		return
	}
	next, status, message := taskTransition(t, run, in, principal(r).ID, eventID)
	if status != 0 {
		fail(w, status, message)
		return
	}
	if len(in.Artifacts) > 0 {
		ok, err = validateTaskArtifacts(r.Context(), tx, t, in.Artifacts)
		if err != nil {
			internal(w)
			return
		}
		if !ok {
			fail(w, 409, "artifact reference unavailable, mixed base revision, wrong project, hash, role or implementation author")
			return
		}
	}
	if in.Type == "run_started" {
		_, err = tx.Exec(r.Context(), `INSERT INTO link_task_runs(id,task_id,state,version,artifacts) VALUES($1,$2,$3,$4,$5)`, next.ID, next.TaskID, next.State, next.Version, next.Artifacts)
	} else {
		_, err = tx.Exec(r.Context(), `UPDATE link_task_runs SET state=$2,version=$3,artifacts=$4,review_request_id=$5,verification_status=$6,updated_at=clock_timestamp() WHERE id=$1`, next.ID, next.State, next.Version, next.Artifacts, next.ReviewRequestID, next.VerificationStatus)
	}
	if err != nil {
		adminError(w, err)
		return
	}
	t, err = scanTask(tx.QueryRow(r.Context(), `UPDATE link_tasks SET state=$2,version=$3,current_run_id=$4,updated_at=clock_timestamp() WHERE id=$1 RETURNING `+taskColumns, t.ID, next.State, next.Version, next.ID))
	if err != nil {
		internal(w)
		return
	}
	e, err := scanTaskEvent(tx.QueryRow(r.Context(), `INSERT INTO link_task_events(id,task_id,run_id,actor_id,client_id,version,type,payload,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING `+taskEventColumns, eventID, t.ID, next.ID, principal(r).ID, in.ClientID, next.Version, in.Type, b, hash))
	if err != nil {
		internal(w)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		internal(w)
		return
	}
	respond(w, 201, map[string]any{"task": t, "event": e, "replayed": false, "server_verified": false})
}
