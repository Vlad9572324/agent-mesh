package link

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed memory_schema.sql
var memorySchema string

// ProjectMemory is explicitly project-shared. It never imports private or
// channel-restricted context, and it does not change the immutable /notes API.
type ProjectMemory struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	AuthorID  string    `json:"author_id"`
	UpdatedBy string    `json:"updated_by"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Version   int64     `json:"version"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type MemoryVersion struct {
	MemoryID  string    `json:"memory_id"`
	Version   int64     `json:"version"`
	AuthorID  string    `json:"author_id"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
}

const memoryColumns = `id,project_id,author_id,updated_by,title,body,version,created_at,updated_at`

func scanMemory(row pgx.Row) (v ProjectMemory, err error) {
	err = row.Scan(&v.ID, &v.ProjectID, &v.AuthorID, &v.UpdatedBy, &v.Title, &v.Body, &v.Version, &v.CreatedAt, &v.UpdatedAt)
	return
}

func (s *Server) memoryRoutes(api *http.ServeMux) {
	api.HandleFunc("GET /v1/projects/{project}/memory", s.listMemory)
	api.HandleFunc("POST /v1/projects/{project}/memory", s.createMemory)
	api.HandleFunc("GET /v1/projects/{project}/memory/{memory}", s.getMemory)
	api.HandleFunc("PUT /v1/projects/{project}/memory/{memory}", s.updateMemory)
}

func (s *Server) listMemory(w http.ResponseWriter, r *http.Request) {
	if !s.projectAllowed(w, r, false) {
		return
	}
	rows, err := s.Store.Pool.Query(r.Context(), `SELECT `+memoryColumns+` FROM link_memory WHERE project_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 1001`, r.PathValue("project"))
	if err != nil {
		internal(w)
		return
	}
	defer rows.Close()
	items := []ProjectMemory{}
	for rows.Next() {
		v, e := scanMemory(rows)
		if e != nil {
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
	respond(w, 200, map[string]any{"memory": items, "truncated": truncated, "can_write": s.coordinationCanWrite(r)})
}

func (s *Server) getMemory(w http.ResponseWriter, r *http.Request) {
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
	v, err := scanMemory(tx.QueryRow(r.Context(), `SELECT `+memoryColumns+` FROM link_memory WHERE id=$1 AND project_id=$2`, r.PathValue("memory"), r.PathValue("project")))
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "memory not found")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	// Optional cursor exposes every historical revision without unbounded reads.
	before := int64(9223372036854775807)
	if raw := r.URL.Query().Get("before_version"); raw != "" {
		before, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || before < 1 {
			fail(w, 400, "invalid before_version")
			return
		}
	}
	rows, err := tx.Query(r.Context(), `SELECT memory_id,version,author_id,title,body,created_at FROM link_memory_versions WHERE memory_id=$1 AND version<$2 ORDER BY version DESC LIMIT 1001`, v.ID, before)
	if err != nil {
		internal(w)
		return
	}
	defer rows.Close()
	items := []MemoryVersion{}
	for rows.Next() {
		var item MemoryVersion
		if err = rows.Scan(&item.MemoryID, &item.Version, &item.AuthorID, &item.Title, &item.Body, &item.CreatedAt); err != nil {
			internal(w)
			return
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		internal(w)
		return
	}
	rows.Close()
	truncated := len(items) > 1000
	if truncated {
		items = items[:1000]
	}
	canWrite := principal(r).Kind == "agent" && projectAccess(r.Context(), tx, v.ProjectID, principal(r).ID, true)
	respond(w, 200, map[string]any{"memory": v, "versions": items, "truncated": truncated, "can_write": canWrite})
}

type memoryCreateInput struct {
	ClientID string `json:"client_id"`
	Title    string `json:"title"`
	Body     string `json:"body"`
}
type memoryUpdateInput struct {
	ClientID        string `json:"client_id"`
	ExpectedVersion int64  `json:"expected_version"`
	Title           string `json:"title"`
	Body            string `json:"body"`
}

// The target ID and operation are part of the hash: a reused client ID cannot
// silently turn a create into an update or mutate a different note.
func memoryPayloadHash(operation, id string, in any) []byte {
	b, _ := json.Marshal(struct {
		Operation string `json:"operation"`
		ID        string `json:"id"`
		Input     any    `json:"input"`
	}{operation, id, in})
	return digest(string(b))
}

func memoryReplay(w http.ResponseWriter, r *http.Request, tx pgx.Tx, clientID string, hash []byte) bool {
	var previous []byte
	var v ProjectMemory
	err := tx.QueryRow(r.Context(), `SELECT m.id,m.project_id,m.author_id,v.author_id,v.title,v.body,v.version,m.created_at,v.created_at,v.payload_hash FROM link_memory_versions v JOIN link_memory m ON m.id=v.memory_id WHERE v.project_id=$1 AND v.author_id=$2 AND v.client_id=$3`, r.PathValue("project"), principal(r).ID, clientID).Scan(&v.ID, &v.ProjectID, &v.AuthorID, &v.UpdatedBy, &v.Title, &v.Body, &v.Version, &v.CreatedAt, &v.UpdatedAt, &previous)
	if errors.Is(err, pgx.ErrNoRows) {
		return false
	}
	if err != nil {
		internal(w)
		return true
	}
	if !bytes.Equal(previous, hash) {
		fail(w, 409, "client_id payload conflict")
		return true
	}
	respond(w, 200, map[string]any{"memory": v, "replayed": true})
	return true
}

func (s *Server) createMemory(w http.ResponseWriter, r *http.Request) {
	var in memoryCreateInput
	if !decode(w, r, &in) {
		return
	}
	if !validID(in.ClientID) || !taskNonempty(in.Title, 200) || !taskNonempty(in.Body, 16384) {
		fail(w, 400, "invalid project memory")
		return
	}
	hash := memoryPayloadHash("create", "", in)
	tx, ok := s.coordinationTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	if memoryReplay(w, r, tx, in.ClientID, hash) {
		return
	}
	id, err := randomHex(16)
	if err != nil {
		internal(w)
		return
	}
	v, err := scanMemory(tx.QueryRow(r.Context(), `INSERT INTO link_memory(id,project_id,author_id,updated_by,title,body) VALUES($1,$2,$3,$3,$4,$5) RETURNING `+memoryColumns, id, r.PathValue("project"), principal(r).ID, in.Title, in.Body))
	if err != nil {
		internal(w)
		return
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO link_memory_versions(memory_id,project_id,version,author_id,client_id,title,body,payload_hash,created_at) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)`, id, v.ProjectID, principal(r).ID, in.ClientID, in.Title, in.Body, hash, v.UpdatedAt)
	if err != nil {
		internal(w)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		internal(w)
		return
	}
	respond(w, 201, map[string]any{"memory": v, "replayed": false})
}

func (s *Server) updateMemory(w http.ResponseWriter, r *http.Request) {
	var in memoryUpdateInput
	if !decode(w, r, &in) {
		return
	}
	if !validID(in.ClientID) || in.ExpectedVersion < 1 || !taskNonempty(in.Title, 200) || !taskNonempty(in.Body, 16384) {
		fail(w, 400, "invalid project memory revision")
		return
	}
	hash := memoryPayloadHash("update", r.PathValue("memory"), in)
	tx, ok := s.coordinationTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	if memoryReplay(w, r, tx, in.ClientID, hash) {
		return
	}
	var version int64
	err := tx.QueryRow(r.Context(), `SELECT version FROM link_memory WHERE id=$1 AND project_id=$2 FOR UPDATE`, r.PathValue("memory"), r.PathValue("project")).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "memory not found")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	if version != in.ExpectedVersion {
		fail(w, 409, "memory version conflict")
		return
	}
	v, err := scanMemory(tx.QueryRow(r.Context(), `UPDATE link_memory SET title=$2,body=$3,updated_by=$4,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING `+memoryColumns, r.PathValue("memory"), in.Title, in.Body, principal(r).ID))
	if err != nil {
		internal(w)
		return
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO link_memory_versions(memory_id,project_id,version,author_id,client_id,title,body,payload_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, v.ID, v.ProjectID, v.Version, principal(r).ID, in.ClientID, in.Title, in.Body, hash, v.UpdatedAt)
	if err != nil {
		internal(w)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"memory": v, "replayed": false})
}
