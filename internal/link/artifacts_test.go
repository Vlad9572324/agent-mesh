package link

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func artifactTestInput(client string, data []byte) artifactInput {
	sum := sha256.Sum256(data)
	return artifactInput{ClientID: client, Role: "implementation", BaseRevision: strings.Repeat("a", 40), SHA256: hex.EncodeToString(sum[:]), ContentBase64: base64.StdEncoding.EncodeToString(data)}
}

func TestValidateArtifact(t *testing.T) {
	valid := artifactTestInput("test", []byte("bounded opaque artifact\x00"))
	if _, ok := validateArtifact(valid); !ok {
		t.Fatal("valid binary artifact rejected")
	}
	for name, change := range map[string]func(*artifactInput){
		"hash":       func(i *artifactInput) { i.SHA256 = strings.Repeat("0", 64) },
		"upper hash": func(i *artifactInput) { i.SHA256 = strings.ToUpper(i.SHA256) },
		"role":       func(i *artifactInput) { i.Role = "execute" },
		"client":     func(i *artifactInput) { i.ClientID = "../../secret" },
		"base":       func(i *artifactInput) { i.BaseRevision = "" },
		"empty":      func(i *artifactInput) { i.ContentBase64 = "" },
		"newlines":   func(i *artifactInput) { i.ContentBase64 += "\n" },
		"oversize":   func(i *artifactInput) { *i = artifactTestInput("large", make([]byte, artifactMaxBytes+1)) },
	} {
		t.Run(name, func(t *testing.T) {
			in := valid
			change(&in)
			if _, ok := validateArtifact(in); ok {
				t.Fatal("invalid artifact accepted")
			}
		})
	}
}

func TestArtifactHTTPACLIntegrityReplayAndQuota(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	in := artifactTestInput("first", []byte("patch carried between independent hosts"))
	created := f.expect("POST", "/v1/projects/pilot/artifacts", "claude-pilot", in, 201)
	a := created["artifact"].(map[string]any)
	id := a["id"].(string)
	path := "/v1/artifacts/" + id
	replayed := f.expect("POST", "/v1/projects/pilot/artifacts", "claude-pilot", in, 200)
	if !replayed["replayed"].(bool) || replayed["artifact"].(map[string]any)["id"] != id {
		t.Fatal("artifact replay produced another identity")
	}
	changed := in
	changed.Role = "baseline"
	f.expect("POST", "/v1/projects/pilot/artifacts", "claude-pilot", changed, 409)
	for _, actor := range []string{"viewer-pilot", "owner"} {
		f.expect("GET", path, actor, nil, 200)
		f.expect("POST", "/v1/projects/pilot/artifacts", actor, in, 404)
	}
	for _, suffix := range []string{"", "/content"} {
		f.expect("GET", path+suffix, "deny-pilot", nil, 404)
	}
	f.expect("GET", "/v1/projects/pilot/artifacts", "deny-pilot", nil, 404)
	req, err := http.NewRequest("GET", f.server.URL+path+"/content", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+f.keys["codex-pilot"])
	resp, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	expected, _ := base64.StdEncoding.DecodeString(in.ContentBase64)
	if resp.StatusCode != 200 || !bytes.Equal(data, expected) || resp.Header.Get("X-Content-SHA256") != in.SHA256 || resp.Header.Get("Content-Type") != "application/octet-stream" {
		t.Fatal("artifact download changed content or provenance")
	}
	// Simulated at-rest corruption must not be served as the claimed hash.
	_, err = f.s.Pool.Exec(context.Background(), `UPDATE link_artifacts SET payload=$2 WHERE id=$1`, id, bytes.Repeat([]byte{'x'}, len(expected)))
	if err != nil {
		t.Fatal(err)
	}
	f.expect("GET", path+"/content", "codex-pilot", nil, 500)
	_, err = f.s.Pool.Exec(context.Background(), `UPDATE link_artifacts SET payload=$2 WHERE id=$1`, id, expected)
	if err != nil {
		t.Fatal(err)
	}
	// Fill the bounded quota via test-only SQL without 64 MiB of HTTP traffic.
	_, err = f.s.Pool.Exec(context.Background(), `INSERT INTO link_artifacts(id,project_id,author_id,client_id,role,base_revision,sha256,size_bytes,payload,request_hash,seq)
 SELECT 'quota-'||n,'pilot','claude-pilot','quota-'||n,'bundle','base',repeat('a',64),$1::integer,decode(repeat('00',$1::integer),'hex'),decode('00','hex'),100+n FROM generate_series(1,32) n`, artifactMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	f.expect("POST", "/v1/projects/pilot/artifacts", "claude-pilot", artifactTestInput("over-quota", []byte("extra")), 409)
	f.expect("POST", "/v1/projects/pilot/artifacts", "claude-pilot", in, 200)
}

func TestArtifactConcurrentReplayAndPaging(t *testing.T) {
	f := newFixture(t)
	in := artifactTestInput("concurrent", []byte("one immutable object"))
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, out := f.request("POST", "/v1/projects/pilot/artifacts", "claude-pilot", in)
			if status != 200 && status != 201 {
				t.Errorf("concurrent publication status %d", status)
				return
			}
			ids <- out["artifact"].(map[string]any)["id"].(string)
		}()
	}
	wg.Wait()
	close(ids)
	first := ""
	for id := range ids {
		if first != "" && first != id {
			t.Fatal("same client_id generated distinct artifacts")
		}
		first = id
	}
	f.expect("POST", "/v1/projects/pilot/artifacts", "codex-pilot", artifactTestInput("second", []byte("different")), 201)
	hidden := f.expect("POST", "/v1/projects/isolated/artifacts", "deny-pilot", artifactTestInput("hidden", []byte("hidden")), 201)["artifact"].(map[string]any)
	third := f.expect("POST", "/v1/projects/pilot/artifacts", "codex-pilot", artifactTestInput("third", []byte("third")), 201)["artifact"].(map[string]any)
	if hidden["seq"] != float64(1) || third["seq"] != float64(3) {
		t.Fatal("artifact cursors disclose activity from other projects")
	}
	page := f.expect("GET", "/v1/projects/pilot/artifacts?limit=1", "viewer-pilot", nil, 200)
	if len(page["artifacts"].([]any)) != 1 || page["has_more"] != true {
		t.Fatal("artifact bounded page incorrect")
	}
	if _, ok := page["artifacts"].([]any)[0].(map[string]any)["payload"]; ok {
		t.Fatal("list exposed binary payload")
	}
}
