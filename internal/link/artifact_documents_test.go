package link

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestArtifactDocumentTitleValidation(t *testing.T) {
	in := artifactTestInput("doc", []byte("Requirements, not executable code"))
	in.Role, in.BaseRevision = "document", "requirements-v1"
	for _, title := range []string{"", "Requirements", "Требования <script>not markup</script>", strings.Repeat("я", 100)} {
		in.Title = title
		if _, ok := validateArtifact(in); !ok {
			t.Fatalf("valid title rejected: %q", title)
		}
	}
	for _, title := range []string{" ", "\t", "line\nbreak", "control\x7f", "control\u0085", "line\u2028break", "paragraph\u2029break", strings.Repeat("x", 201), strings.Repeat("я", 101), "invalid\xff"} {
		in.Title = title
		if _, ok := validateArtifact(in); ok {
			t.Fatalf("invalid title accepted: %q", title)
		}
	}
}

func TestArtifactDocumentTitleHTTPReplayAndACL(t *testing.T) {
	f := newFixture(t)
	in := artifactTestInput("document", []byte("Exact requirements text"))
	in.Role, in.BaseRevision, in.Title = "document", "requirements-v1", "Requirements <b>literal</b>"
	path := "/v1/projects/pilot/artifacts"
	first := f.expect("POST", path, "codex-pilot", in, 201)["artifact"].(map[string]any)
	id := first["id"].(string)
	if first["title"] != in.Title || first["role"] != "document" || first["base_revision"] != "requirements-v1" || first["sha256"] != in.SHA256 {
		t.Fatal("document metadata changed")
	}
	if replay := f.expect("POST", path, "codex-pilot", in, 200); replay["replayed"] != true || replay["artifact"].(map[string]any)["id"] != id {
		t.Fatal("document replay lost identity")
	}
	for _, title := range []string{"Different title", ""} {
		changed := in
		changed.Title = title
		f.expect("POST", path, "codex-pilot", changed, 409)
	}
	f.expect("GET", "/v1/artifacts/"+id, "deny-pilot", nil, 404)
	f.expect("POST", path, "viewer-pilot", in, 404)
	read := f.expect("GET", "/v1/artifacts/"+id, "viewer-pilot", nil, 200)["artifact"].(map[string]any)
	listed := f.expect("GET", path+"?limit=1", "viewer-pilot", nil, 200)["artifacts"].([]any)[0].(map[string]any)
	if read["title"] != in.Title || listed["title"] != in.Title {
		t.Fatal("metadata/list lost title")
	}
	found := false
	for _, item := range f.expect("GET", "/v1/projects/pilot/map", "viewer-pilot", nil, 200)["nodes"].([]any) {
		node := item.(map[string]any)
		if node["type"] == "artifact" && node["id"] == id {
			found = node["label"] == in.Title && node["meta"].(map[string]any)["title"] == in.Title
		}
	}
	if !found {
		t.Fatal("project map lost literal document title")
	}
	for _, title := range []any{strings.Repeat("я", 101), "\n", "  ", 7, []string{"title"}} {
		f.expect("POST", path, "codex-pilot", map[string]any{"client_id": "invalid", "role": "document", "title": title,
			"base_revision": in.BaseRevision, "sha256": in.SHA256, "content_base64": in.ContentBase64}, 400)
	}
	var content []byte
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT payload FROM link_artifacts WHERE id=$1`, id).Scan(&content); err != nil || string(content) != "Exact requirements text" {
		t.Fatal("title replay changed stored bytes")
	}
}

func TestArtifactDocumentMigrationPreservesLegacyReplay(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	// Reconstruct the old schema and exact old canonical request, independently
	// of the new input struct. An old client's queued retry must still replay.
	if _, err := f.s.Pool.Exec(ctx, `ALTER TABLE link_artifacts DROP COLUMN title;
 ALTER TABLE link_artifacts DROP CONSTRAINT link_artifacts_role_check;
 ALTER TABLE link_artifacts ADD CONSTRAINT renamed_legacy_role CHECK(role IN ('baseline','implementation','test','evidence','bundle'));
 ALTER TABLE link_artifacts ADD CONSTRAINT custom_role_guard CHECK(role <> 'bundle' OR role = 'baseline')`); err != nil {
		t.Fatal(err)
	}
	var customBefore string
	if err := f.s.Pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='link_artifacts'::regclass AND conname='custom_role_guard'`).Scan(&customBefore); err != nil {
		t.Fatal(err)
	}
	in := artifactTestInput("legacy", []byte("Old immutable bytes"))
	canonical := fmt.Sprintf(`{"client_id":"legacy","role":"implementation","base_revision":%q,"sha256":%q,"content_base64":%q}`, in.BaseRevision, in.SHA256, in.ContentBase64)
	content, _ := base64.StdEncoding.DecodeString(in.ContentBase64)
	if _, err := f.s.Pool.Exec(ctx, `INSERT INTO link_artifacts(id,seq,project_id,author_id,client_id,role,base_revision,sha256,size_bytes,payload,request_hash)
 VALUES('legacy-artifact',1,'pilot','codex-pilot','legacy','implementation',$1,$2,$3,$4,$5)`, in.BaseRevision, in.SHA256, len(content), content, digest(canonical)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := f.s.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var payload, hash []byte
	var title string
	if err := f.s.Pool.QueryRow(ctx, `SELECT payload,request_hash,title FROM link_artifacts WHERE id='legacy-artifact'`).Scan(&payload, &hash, &title); err != nil || !bytes.Equal(payload, content) || !bytes.Equal(hash, digest(canonical)) || title != "" {
		t.Fatal("migration rewrote immutable legacy data")
	}
	var oldRequest map[string]any
	if json.Unmarshal([]byte(canonical), &oldRequest) != nil {
		t.Fatal("invalid old request fixture")
	}
	for _, empty := range []any{nil, ""} {
		replay := f.expect("POST", "/v1/projects/pilot/artifacts", "codex-pilot", oldRequest, 200)
		if replay["replayed"] != true || replay["artifact"].(map[string]any)["id"] != "legacy-artifact" {
			t.Fatal("old canonical replay changed after migration")
		}
		oldRequest["title"] = empty
	}
	f.expect("POST", "/v1/projects/pilot/artifacts", "codex-pilot", oldRequest, 200)
	in.ClientID, in.Title, in.Role, in.BaseRevision = "new-doc", "After migration", "document", "requirements-v1"
	f.expect("POST", "/v1/projects/pilot/artifacts", "codex-pilot", in, 201)
	if err := f.s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	f.expect("POST", "/v1/projects/pilot/artifacts", "codex-pilot", in, 200)
	var customAfter, roleAfter string
	if err := f.s.Pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='link_artifacts'::regclass AND conname='custom_role_guard'`).Scan(&customAfter); err != nil || customBefore != customAfter {
		t.Fatal("migration altered an unrelated custom role constraint")
	}
	if err := f.s.Pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='link_artifacts'::regclass AND conname='renamed_legacy_role'`).Scan(&roleAfter); err != nil || !strings.Contains(roleAfter, "'document'::text") {
		t.Fatal("migration lost the renamed legacy role constraint")
	}
	// The role check is extended, not removed.
	if _, err := f.s.Pool.Exec(ctx, `UPDATE link_artifacts SET role='execute' WHERE id='legacy-artifact'`); err == nil {
		t.Fatal("migration removed the role constraint")
	}
}

func TestArtifactDocumentTaskReferenceIsNotEvidence(t *testing.T) {
	v := newTaskScenario(t)
	v.emit("codex-pilot", "run_started", nil, 201)
	ref := taskTestArtifact(v.f, "pilot", "claude-pilot", "document", "requirements")
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": []TaskArtifactRef{ref}}, 201)
	v.emit("codex-pilot", "review_requested", map[string]any{"artifacts": []TaskArtifactRef{ref}}, 201)
	zero := 0
	v.emit("claude-pilot", "verification_reported", map[string]any{"artifacts": []TaskArtifactRef{ref},
		"evidence": TaskEvidence{Status: "passed", Command: "fixture", ExitCode: &zero, Artifact: ref}}, 400)
	wrong := ref
	wrong.Role = "evidence"
	v.emit("codex-pilot", "artifacts_ready", map[string]any{"artifacts": []TaskArtifactRef{wrong}}, 409)
}
