package link

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed artifacts_schema.sql
var artifactsSchema string

const artifactMaxBytes = 2 << 20
const artifactProjectQuota = 64 << 20

var artifactHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Artifact struct {
	ID           string    `json:"id"`
	Seq          int64     `json:"seq"`
	ProjectID    string    `json:"project_id"`
	AuthorID     string    `json:"author_id"`
	Role         string    `json:"role"`
	BaseRevision string    `json:"base_revision"`
	SHA256       string    `json:"sha256"`
	SizeBytes    int64     `json:"size_bytes"`
	CreatedAt    time.Time `json:"created_at"`
}

type artifactInput struct {
	ClientID      string `json:"client_id"`
	Role          string `json:"role"`
	BaseRevision  string `json:"base_revision"`
	SHA256        string `json:"sha256"`
	ContentBase64 string `json:"content_base64"`
}

const artifactColumns = `id,seq,project_id,author_id,role,base_revision,sha256,size_bytes,created_at`

func validArtifactRole(role string) bool {
	switch role {
	case "baseline", "implementation", "test", "evidence", "bundle":
		return true
	}
	return false
}

func validateArtifact(in artifactInput) ([]byte, bool) {
	if !validID(in.ClientID) || !validArtifactRole(in.Role) || !validID(in.BaseRevision) || !artifactHashPattern.MatchString(in.SHA256) || len(in.ContentBase64) > base64.StdEncoding.EncodedLen(artifactMaxBytes) {
		return nil, false
	}
	content, err := base64.StdEncoding.Strict().DecodeString(in.ContentBase64)
	// Re-encoding rejects ignored CR/LF and other equivalent spellings, keeping
	// idempotency unambiguous without trusting a caller-supplied digest.
	if err != nil || len(content) == 0 || len(content) > artifactMaxBytes || base64.StdEncoding.EncodeToString(content) != in.ContentBase64 {
		return nil, false
	}
	sum := sha256.Sum256(content)
	if hex.EncodeToString(sum[:]) != in.SHA256 {
		return nil, false
	}
	return content, true
}

func scanArtifact(row pgx.Row) (Artifact, error) {
	var a Artifact
	err := row.Scan(&a.ID, &a.Seq, &a.ProjectID, &a.AuthorID, &a.Role, &a.BaseRevision, &a.SHA256, &a.SizeBytes, &a.CreatedAt)
	return a, err
}

func loadArtifact(ctx context.Context, q querier, id string) (Artifact, error) {
	return scanArtifact(q.QueryRow(ctx, `SELECT `+artifactColumns+` FROM link_artifacts WHERE id=$1`, id))
}

func (s *Server) artifactRoutes(api *http.ServeMux) {
	api.HandleFunc("GET /v1/projects/{project}/artifacts", s.artifacts)
	api.HandleFunc("POST /v1/projects/{project}/artifacts", s.postArtifact)
	api.HandleFunc("GET /v1/artifacts/{artifact}", s.artifactMetadata)
	api.HandleFunc("GET /v1/artifacts/{artifact}/content", s.artifactContent)
}

func (s *Server) postArtifact(w http.ResponseWriter, r *http.Request) {
	if principal(r).Kind != "agent" {
		fail(w, 404, "not found")
		return
	}
	if !s.projectAllowed(w, r, true) {
		return
	}
	var in artifactInput
	if !decodeMax(w, r, &in, 3<<20) {
		return
	}
	content, ok := validateArtifact(in)
	if !ok {
		fail(w, 400, "invalid artifact fields, content size, encoding or sha256")
		return
	}
	canonical, _ := json.Marshal(in)
	hash := digest(string(canonical))
	ctx, p, project := r.Context(), principal(r), r.PathValue("project")
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	if !s.authorizeWrite(w, r, tx, false) {
		return
	}
	if !projectAccess(ctx, tx, project, p.ID, true) {
		fail(w, 404, "not found")
		return
	}
	// One project lock makes the quota and idempotency checks atomic even for
	// different authors. Lock order matches management -> principal -> resource.
	if _, err = tx.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project); err != nil {
		internal(w)
		return
	}
	var existing string
	var oldHash []byte
	err = tx.QueryRow(ctx, `SELECT id,request_hash FROM link_artifacts WHERE project_id=$1 AND author_id=$2 AND client_id=$3`, project, p.ID, in.ClientID).Scan(&existing, &oldHash)
	if err == nil {
		if !bytes.Equal(hash, oldHash) {
			fail(w, 409, "client_id payload conflict")
			return
		}
		a, loadErr := loadArtifact(ctx, tx, existing)
		if loadErr != nil {
			internal(w)
			return
		}
		respond(w, 200, map[string]any{"artifact": a, "replayed": true})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		internal(w)
		return
	}
	var used, sequence int64
	if tx.QueryRow(ctx, `SELECT COALESCE(sum(size_bytes),0),COALESCE(max(seq),0)+1 FROM link_artifacts WHERE project_id=$1`, project).Scan(&used, &sequence) != nil {
		internal(w)
		return
	}
	if used+int64(len(content)) > artifactProjectQuota {
		fail(w, 409, "project artifact quota exceeded")
		return
	}
	id, err := randomHex(16)
	if err != nil {
		internal(w)
		return
	}
	_, err = tx.Exec(ctx, `INSERT INTO link_artifacts(id,project_id,author_id,client_id,role,base_revision,sha256,size_bytes,payload,request_hash,seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, id, project, p.ID, in.ClientID, in.Role, in.BaseRevision, in.SHA256, len(content), content, hash, sequence)
	if err != nil {
		internal(w)
		return
	}
	a, err := loadArtifact(ctx, tx, id)
	if err != nil || tx.Commit(ctx) != nil {
		internal(w)
		return
	}
	respond(w, 201, map[string]any{"artifact": a, "replayed": false})
}

func (s *Server) artifacts(w http.ResponseWriter, r *http.Request) {
	if !s.projectAllowed(w, r, false) {
		return
	}
	after, limit, ok := pagination(w, r, "after_seq")
	if !ok {
		return
	}
	rows, err := s.Store.Pool.Query(r.Context(), `SELECT `+artifactColumns+` FROM link_artifacts WHERE project_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`, r.PathValue("project"), after, limit+1)
	if err != nil {
		internal(w)
		return
	}
	defer rows.Close()
	result := []Artifact{}
	for rows.Next() {
		a, e := scanArtifact(rows)
		if e != nil {
			internal(w)
			return
		}
		result = append(result, a)
	}
	if rows.Err() != nil {
		internal(w)
		return
	}
	more := len(result) > limit
	if more {
		result = result[:limit]
	}
	if len(result) > 0 {
		after = result[len(result)-1].Seq
	}
	respond(w, 200, map[string]any{"artifacts": result, "has_more": more, "next_after_seq": after})
}

func (s *Server) authorizedArtifact(w http.ResponseWriter, r *http.Request) (Artifact, bool) {
	id := r.PathValue("artifact")
	if !validID(id) {
		fail(w, 404, "not found")
		return Artifact{}, false
	}
	a, err := loadArtifact(r.Context(), s.Store.Pool, id)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "not found")
		return a, false
	}
	if err != nil {
		internal(w)
		return a, false
	}
	if !projectAccess(r.Context(), s.Store.Pool, a.ProjectID, principal(r).ID, false) {
		fail(w, 404, "not found")
		return Artifact{}, false
	}
	return a, true
}

func (s *Server) artifactMetadata(w http.ResponseWriter, r *http.Request) {
	if a, ok := s.authorizedArtifact(w, r); ok {
		respond(w, 200, map[string]any{"artifact": a})
	}
}

func (s *Server) artifactContent(w http.ResponseWriter, r *http.Request) {
	a, ok := s.authorizedArtifact(w, r)
	if !ok {
		return
	}
	var content []byte
	if s.Store.Pool.QueryRow(r.Context(), `SELECT payload FROM link_artifacts WHERE id=$1`, a.ID).Scan(&content) != nil {
		fail(w, 404, "not found")
		return
	}
	sum := sha256.Sum256(content)
	if int64(len(content)) != a.SizeBytes || hex.EncodeToString(sum[:]) != a.SHA256 {
		fail(w, 500, "artifact integrity check failed")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="artifact-`+a.ID+`.bin"`)
	w.Header().Set("X-Content-SHA256", a.SHA256)
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.WriteHeader(200)
	_, _ = w.Write(content)
}
