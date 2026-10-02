package link

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func (f *fixture) owner(id string) string {
	f.t.Helper()
	path := filepath.Join(f.t.TempDir(), id+".json")
	if err := f.s.BootstrapOwner(context.Background(), id, "Владелец", path); err != nil {
		f.t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		f.t.Fatal(err)
	}
	var creds map[string]string
	if err = json.Unmarshal(b, &creds); err != nil {
		f.t.Fatal(err)
	}
	if creds["agent_id"] != id || len(creds["key"]) != 64 {
		f.t.Fatal("invalid owner credentials")
	}
	f.keys[id] = creds["key"]
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		f.t.Fatal("owner credential file must be 0600")
	}
	return path
}

func (f *fixture) access(agent, scope, resource, access string, want int) {
	f.t.Helper()
	f.expect("PUT", "/v1/admin/access", "owner", map[string]any{"agent_id": agent, "scope": scope, "resource_id": resource, "access": access}, want)
}

func TestOwnerBootstrapMigrationPreservesExistingState(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	m := f.message("migration-history", "claude-pilot")
	f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", map[string]any{"client_id": "migration-note", "title": "existing", "body": "keep"}, 201)
	f.heartbeat("codex-pilot", "existing-lease")
	var before string
	snapshot := `SELECT json_build_object('principals',(SELECT json_agg(p ORDER BY id) FROM principals p),'messages',(SELECT json_agg(m ORDER BY id) FROM messages m),'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r),'events',(SELECT json_agg(e ORDER BY channel_id,seq) FROM events e),'notes',(SELECT json_agg(n ORDER BY id) FROM notes n),'project_members',(SELECT json_agg(pm ORDER BY project_id,agent_id) FROM project_members pm),'channel_members',(SELECT json_agg(cm ORDER BY channel_id,agent_id) FROM channel_members cm))::text`
	if err := f.s.Pool.QueryRow(ctx, snapshot).Scan(&before); err != nil {
		t.Fatal(err)
	}
	// Recreate the original schema boundary, then migrate twice.
	if _, err := f.s.Pool.Exec(ctx, `ALTER TABLE principals DROP CONSTRAINT principals_kind_check; ALTER TABLE principals ADD CONSTRAINT principals_kind_check CHECK(kind IN ('agent','viewer')); DROP TABLE admin_audit`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := f.s.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var after string
	if err := f.s.Pool.QueryRow(ctx, snapshot).Scan(&after); err != nil || before != after {
		t.Fatal("migration changed existing keys, identity, leases, journal, notes or memberships")
	}
	seedBefore, _ := os.ReadFile(f.credentials)
	path := f.owner("owner")
	ownerBefore, _ := os.ReadFile(path)
	if err := f.s.BootstrapOwner(ctx, "owner", "Ignored new name", path); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(t.TempDir(), "must-not-regenerate.json")
	if err := f.s.BootstrapOwner(ctx, "owner", "Ignored", missing); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("idempotent bootstrap regenerated credentials")
	}
	ownerAfter, _ := os.ReadFile(path)
	if !bytes.Equal(ownerBefore, ownerAfter) {
		t.Fatal("owner bootstrap rotated existing key")
	}
	if err := f.s.BootstrapOwner(ctx, "claude-pilot", "elevation", missing); err == nil {
		t.Fatal("seed principal elevated to owner")
	}
	if err := f.s.Bootstrap(ctx, f.credentials); err != nil {
		t.Fatal(err)
	}
	seedAfter, _ := os.ReadFile(f.credentials)
	if !bytes.Equal(seedBefore, seedAfter) {
		t.Fatal("seed credentials changed")
	}
	f.expect("GET", "/v1/messages/"+m["id"].(string), "owner", nil, 200)
	if err := f.s.Revoke(ctx, "owner"); err == nil {
		t.Fatal("last active owner was revoked")
	}
	f.owner("backup-owner")
	if err := f.s.Revoke(ctx, "backup-owner"); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Revoke(ctx, "owner"); err == nil {
		t.Fatal("inactive backup incorrectly allows owner lockout")
	}
}

func TestOwnerReadAndAdministrationBoundaries(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	m := f.message("owner-reading", "claude-pilot")
	for _, route := range []struct {
		method, path string
		body         any
	}{
		{"GET", "/v1/admin/overview", nil}, {"GET", "/v1/admin/audit", nil}, {"GET", "/v1/admin/deliveries", nil},
		{"POST", "/v1/admin/projects", map[string]any{}}, {"POST", "/v1/admin/channels", map[string]any{}}, {"POST", "/v1/admin/principals", map[string]any{}},
		{"PUT", "/v1/admin/access", map[string]any{}}, {"POST", "/v1/admin/principals/codex-pilot/rotate-key", map[string]any{}}, {"POST", "/v1/admin/principals/codex-pilot/revoke-key", map[string]any{}},
	} {
		for _, id := range []string{"claude-pilot", "viewer-pilot", "deny-pilot"} {
			f.expect(route.method, route.path, id, route.body, 403)
		}
	}
	projects := f.expect("GET", "/v1/projects", "owner", nil, 200)["projects"].([]any)
	if len(projects) != 2 {
		t.Fatal("owner cannot see every project")
	}
	for _, path := range []string{"/v1/projects/isolated/channels", "/v1/projects/isolated/agents", "/v1/channels/isolated/messages", "/v1/channels/isolated/events", "/v1/projects/isolated/notes", "/v1/messages/" + m["id"].(string)} {
		f.expect("GET", path, "owner", nil, 200)
	}
	channels := f.expect("GET", "/v1/projects/pilot/channels", "owner", nil, 200)["channels"].([]any)
	if channels[0].(map[string]any)["can_write"] != false || len(channels[0].(map[string]any)["member_ids"].([]any)) != 3 {
		t.Fatal("owner read-only channel membership visibility incorrect")
	}
	for _, path := range []string{"/v1/heartbeat", "/v1/channels/general/messages", "/v1/projects/pilot/notes", "/v1/messages/" + m["id"].(string) + "/receipts"} {
		f.expect("POST", path, "owner", map[string]any{}, 404)
	}
	for _, action := range []string{"rotate-key", "revoke-key"} {
		f.expect("POST", "/v1/admin/principals/owner/"+action, "owner", map[string]any{}, 403)
	}
	f.access("owner", "project", "pilot", "read", 403)
	f.expect("POST", "/v1/admin/principals", "owner", map[string]any{"id": "evil-owner", "name": "evil", "kind": "owner"}, 400)
	f.expect("GET", "/v1/projects/nonexistent/channels", "owner", nil, 404)
	f.expect("GET", "/v1/channels/nonexistent/messages", "owner", nil, 404)
}

func TestAdminInventoryAccessAndSecretHygiene(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	f.expect("POST", "/v1/admin/projects", "owner", map[string]any{"id": "new-project", "name": "Новый"}, 201)
	f.expect("POST", "/v1/admin/projects", "owner", map[string]any{"id": "new-project", "name": "Duplicate"}, 409)
	f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": "new-channel", "project_id": "missing", "name": "Channel"}, 404)
	f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": "new-channel", "project_id": "new-project", "name": "Channel"}, 201)
	f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": "new-channel", "project_id": "new-project", "name": "Duplicate"}, 409)
	p := f.expect("POST", "/v1/admin/principals", "owner", map[string]any{"id": "new-agent", "name": "Name not in audit", "kind": "agent", "runtime": "test"}, 201)["principal"].(map[string]any)
	if p["key_active"] != false || p["freshness"] != "unknown" || p["last_seen_at"] != nil {
		t.Fatal("new principal was incorrectly active")
	}
	f.expect("POST", "/v1/admin/principals", "owner", map[string]any{"id": "new-agent", "name": "Duplicate", "kind": "agent"}, 409)
	f.access("new-agent", "channel", "new-channel", "read", 409)
	f.access("new-agent", "project", "new-project", "read", 200)
	f.access("new-agent", "channel", "new-channel", "write", 409)
	f.access("new-agent", "channel", "new-channel", "read", 200)
	f.access("viewer-pilot", "project", "pilot", "write", 400)
	f.access("viewer-pilot", "channel", "general", "write", 400)
	rotated := f.expect("POST", "/v1/admin/principals/new-agent/rotate-key", "owner", map[string]any{}, 200)
	key := rotated["key"].(string)
	f.keys["new-agent"] = key
	f.expect("GET", "/v1/channels/new-channel/messages", "new-agent", nil, 200)
	f.expect("POST", "/v1/channels/new-channel/messages", "new-agent", map[string]any{}, 404)
	f.access("new-agent", "project", "new-project", "write", 200)
	f.access("new-agent", "channel", "new-channel", "write", 200)
	f.expect("POST", "/v1/channels/new-channel/messages", "new-agent", map[string]any{"client_id": "allowed", "body": "test", "recipient_ids": []string{}}, 201)
	f.access("new-agent", "project", "new-project", "read", 200)
	var channelWrite bool
	if err := f.s.Pool.QueryRow(context.Background(), "SELECT can_write FROM channel_members WHERE channel_id='new-channel' AND agent_id='new-agent'").Scan(&channelWrite); err != nil || channelWrite {
		t.Fatal("project downgrade left channel write grant")
	}
	f.access("new-agent", "project", "new-project", "none", 200)
	var count int
	if err := f.s.Pool.QueryRow(context.Background(), "SELECT count(*) FROM channel_members WHERE agent_id='new-agent'").Scan(&count); err != nil || count != 0 {
		t.Fatal("project removal left child membership")
	}
	f.expect("GET", "/v1/channels/new-channel/messages", "new-agent", nil, 404)
	f.expect("POST", "/v1/admin/principals/new-agent/revoke-key", "owner", map[string]any{}, 200)
	f.expect("GET", "/v1/me", "new-agent", nil, 401)
	for _, path := range []string{"/v1/admin/overview", "/v1/admin/audit"} {
		result := f.expect("GET", path, "owner", nil, 200)
		raw, _ := json.Marshal(result)
		for _, secret := range f.keys {
			if bytes.Contains(raw, []byte(secret)) || bytes.Contains(raw, []byte(hex.EncodeToString(digest(secret)))) {
				t.Fatal("secret or hash disclosed in inventory/audit")
			}
		}
		if bytes.Contains(raw, []byte("key_hash")) {
			t.Fatal("hash field exposed")
		}
		if path == "/v1/admin/audit" && bytes.Contains(raw, []byte("Name not in audit")) {
			t.Fatal("unallowlisted display name entered audit")
		}
	}
	audit := f.expect("GET", "/v1/admin/audit?limit=1", "owner", nil, 200)
	if len(audit["entries"].([]any)) != 1 || audit["truncated"] != true {
		t.Fatal("audit limit/truncation broken")
	}
	for _, raw := range []string{"0", "-1", "x", "", "1&limit=2"} {
		f.expect("GET", "/v1/admin/audit?limit="+raw, "owner", nil, 400)
	}
}

func TestAdminMutationAndAuditAtomicity(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	ctx := context.Background()
	if _, err := f.s.Pool.Exec(ctx, `CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit unavailable'; END $$; CREATE TRIGGER reject_audit BEFORE INSERT ON admin_audit FOR EACH ROW EXECUTE FUNCTION reject_audit()`); err != nil {
		t.Fatal(err)
	}
	f.expect("POST", "/v1/admin/projects", "owner", map[string]any{"id": "must-rollback", "name": "Rollback"}, 500)
	f.access("codex-pilot", "project", "pilot", "none", 500)
	f.expect("POST", "/v1/admin/principals/codex-pilot/revoke-key", "owner", map[string]any{}, 500)
	f.expect("POST", "/v1/admin/principals/codex-pilot/rotate-key", "owner", map[string]any{}, 500)
	if err := f.s.Revoke(ctx, "claude-pilot"); err == nil {
		t.Fatal("CLI revoke committed without audit")
	}
	if err := f.s.Rotate(ctx, "claude-pilot", filepath.Join(t.TempDir(), "key.json")); err == nil {
		t.Fatal("CLI rotate committed without audit")
	}
	var exists bool
	if err := f.s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM projects WHERE id='must-rollback')").Scan(&exists); err != nil || exists {
		t.Fatal("state persisted despite audit failure")
	}
	f.expect("GET", "/v1/channels/general/messages", "codex-pilot", nil, 200)
	f.expect("GET", "/v1/me", "claude-pilot", nil, 200)
	if _, err := f.s.Pool.Exec(ctx, "DROP TRIGGER reject_audit ON admin_audit"); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Revoke(ctx, "deny-pilot"); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Rotate(ctx, "deny-pilot", filepath.Join(t.TempDir(), "key.json")); err != nil {
		t.Fatal(err)
	}
	entries := f.expect("GET", "/v1/admin/audit", "owner", nil, 200)["entries"].([]any)
	if len(entries) != 3 {
		t.Fatalf("failed mutations created audit entries: %d", len(entries))
	}
	for _, entry := range entries {
		if entry.(map[string]any)["actor_id"] != "local-cli" {
			t.Fatal("CLI audit actor incorrect")
		}
	}
}

func TestAdminDeliveryQueueAndBoundedAudit(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	f.heartbeat("codex-pilot", "queue-session")
	pending := f.message("pending", "claude-pilot")["id"].(string)
	accepted := f.message("accepted", "claude-pilot")["id"].(string)
	uncertain := f.message("uncertain", "claude-pilot")["id"].(string)
	for _, id := range []string{accepted, uncertain} {
		for _, state := range []string{"delivered", "accepted"} {
			f.expect("POST", "/v1/messages/"+id+"/receipts", "codex-pilot", map[string]any{"session_id": "queue-session", "status": state}, 200)
		}
	}
	f.expect("POST", "/v1/messages/"+uncertain+"/receipts", "codex-pilot", map[string]any{"session_id": "queue-session", "status": "uncertain"}, 200)
	queue := f.expect("GET", "/v1/admin/deliveries", "owner", nil, 200)
	deliveries := queue["deliveries"].([]any)
	if len(deliveries) != 2 || queue["truncated"] != false {
		t.Fatal("wrong pending/uncertain queue")
	}
	seen := map[string]bool{}
	for _, item := range deliveries {
		d := item.(map[string]any)
		seen[d["message_id"].(string)] = true
		if _, ok := d["body"]; ok {
			t.Fatal("delivery queue contains message bodies")
		}
	}
	if !seen[pending] || !seen[uncertain] || seen[accepted] {
		t.Fatal("queue omitted pending/uncertain or included accepted")
	}
	if f.expect("GET", "/v1/admin/deliveries?limit=1", "owner", nil, 200)["truncated"] != true {
		t.Fatal("delivery truncation not signaled")
	}
	req, _ := http.NewRequest("POST", f.server.URL+"/v1/admin/deliveries", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+f.keys["owner"])
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 405 {
		t.Fatal("delivery queue unexpectedly exposes a write operation")
	}
	if _, err := f.s.Pool.Exec(context.Background(), `INSERT INTO admin_audit(actor_id,action,target_type,target_id,details,created_at) SELECT 'fixture','access.set','project','pilot','{}','2025-01-01T00:00:00Z' FROM generate_series(1,501)`); err != nil {
		t.Fatal(err)
	}
	first := f.expect("GET", "/v1/admin/audit?limit=9999", "owner", nil, 200)
	second := f.expect("GET", "/v1/admin/audit?limit=9999", "owner", nil, 200)
	if len(first["entries"].([]any)) != 500 || first["truncated"] != true {
		t.Fatal("audit maximum500 not enforced")
	}
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(second)
	if !bytes.Equal(a, b) {
		t.Fatal("audit ordering not deterministic")
	}
}

func TestAdminACLRevocationClosesStream(t *testing.T) {
	for _, scope := range []string{"channel", "project"} {
		t.Run(scope, func(t *testing.T) {
			f := newFixture(t)
			f.owner("owner")
			f.message("stream-acl", "claude-pilot")
			req, _ := http.NewRequest("GET", f.server.URL+"/v1/channels/general/stream", nil)
			req.Header.Set("Authorization", "Bearer "+f.keys["viewer-pilot"])
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 {
				t.Fatal("stream unavailable")
			}
			buf := make([]byte, 512)
			if _, err = resp.Body.Read(buf); err != nil {
				t.Fatal(err)
			}
			resource := "general"
			if scope == "project" {
				resource = "pilot"
			}
			f.access("viewer-pilot", scope, resource, "none", 200)
			start := time.Now()
			if _, err = io.ReadAll(resp.Body); err != nil {
				t.Fatal(err)
			}
			if time.Since(start) > 3*time.Second {
				t.Fatal("stream did not promptly revoke ACL")
			}
		})
	}
}

func TestConcurrentAdminACLInvariant(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	var wg sync.WaitGroup
	errs := make(chan error, 60)
	for i := 0; i < 60; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			scope, resource, access := "project", "pilot", "write"
			switch i % 4 {
			case 0:
				access = "none"
			case 1:
				access = "read"
			case 2:
				scope, resource = "channel", "general"
			}
			body, _ := json.Marshal(map[string]string{"agent_id": "codex-pilot", "scope": scope, "resource_id": resource, "access": access})
			req, _ := http.NewRequest("PUT", f.server.URL+"/v1/admin/access", bytes.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+f.keys["owner"])
			req.Header.Set("Content-Type", "application/json")
			resp, err := f.server.Client().Do(req)
			if err != nil {
				errs <- err
				return
			}
			defer resp.Body.Close()
			io.Copy(io.Discard, resp.Body)
			if resp.StatusCode != 200 && resp.StatusCode != 409 {
				errs <- fmt.Errorf("ACL concurrent status %d", resp.StatusCode)
			}
			var invalid bool
			err = f.s.Pool.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM channel_members cm JOIN channels c ON c.id=cm.channel_id LEFT JOIN project_members pm ON pm.project_id=c.project_id AND pm.agent_id=cm.agent_id WHERE pm.agent_id IS NULL OR (cm.can_write AND NOT pm.can_write))`).Scan(&invalid)
			if err != nil {
				errs <- err
			} else if invalid {
				errs <- fmt.Errorf("orphaned or excessive channel grant")
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

func TestRevokedKeyCannotAuthorizeStaleMutation(t *testing.T) {
	for _, owner := range []bool{true, false} {
		t.Run(fmt.Sprintf("owner=%v", owner), func(t *testing.T) {
			f := newFixture(t)
			f.owner("owner")
			ctx := context.Background()
			id, kind := "codex-pilot", "agent"
			if owner {
				id, kind = "owner", "owner"
			}
			// Capture middleware identity before revocation, then block the transactional
			// authorization behind the uncommitted revocation management lock.
			req := httptest.NewRequest("POST", "/", strings.NewReader("{}"))
			req.Header.Set("Authorization", "Bearer "+f.keys[id])
			req = req.WithContext(context.WithValue(ctx, contextKey{}, Principal{ID: id, Kind: kind}))
			revoke, err := f.s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer revoke.Rollback(ctx)
			if err = managementLock(ctx, revoke, false); err != nil {
				t.Fatal(err)
			}
			if _, err = revoke.Exec(ctx, "UPDATE principals SET key_hash=NULL WHERE id=$1", id); err != nil {
				t.Fatal(err)
			}
			mutation, err := f.s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer mutation.Rollback(ctx)
			var pid int
			if err = mutation.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
				t.Fatal(err)
			}
			result := make(chan bool, 1)
			w := httptest.NewRecorder()
			go func() { result <- (&Server{Store: f.s}).authorizeWrite(w, req, mutation, owner) }()
			deadline := time.Now().Add(2 * time.Second)
			for {
				var waiting bool
				if err = f.s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted)", pid).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("authorization did not wait on revocation")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if err = revoke.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if <-result || w.Code != 401 {
				t.Fatal("stale middleware identity authorized mutation after key revocation")
			}
		})
	}
}

func TestAuthorizedOwnerMutationBlocksLocalRevocation(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	f.owner("backup-owner")
	ctx := context.Background()
	req := httptest.NewRequest("POST", "/", nil)
	req.Header.Set("Authorization", "Bearer "+f.keys["owner"])
	req = req.WithContext(context.WithValue(ctx, contextKey{}, Principal{ID: "owner", Kind: "owner"}))
	tx, err := f.s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	w := httptest.NewRecorder()
	if !(&Server{Store: f.s}).authorizeWrite(w, req, tx, true) {
		t.Fatal("owner auth failed")
	}
	if _, err = tx.Exec(ctx, "INSERT INTO projects VALUES('authorized-before-revoke','Authorized')"); err != nil {
		t.Fatal(err)
	}
	if err = writeAudit(ctx, tx, "owner", "project.create", "project", "authorized-before-revoke", auditDetails{}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- f.s.Revoke(ctx, "owner") }()
	select {
	case err := <-done:
		t.Fatalf("revocation overtook authorized mutation: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	f.expect("GET", "/v1/me", "owner", nil, 401)
	var state, audit bool
	if err = f.s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id='authorized-before-revoke'),EXISTS(SELECT 1 FROM admin_audit WHERE target_id='authorized-before-revoke')`).Scan(&state, &audit); err != nil || !state || !audit {
		t.Fatal("authorized mutation/audit not atomically preserved")
	}
}

func TestAdminStrictInputs(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	for _, body := range []string{`{"id":"x","id":"y","name":"Name"}`, `{"ID":"x","name":"Name"}`, `{"id":"x","name":"Name","key":"secret"}`, `null`} {
		req, _ := http.NewRequest("POST", f.server.URL+"/v1/admin/projects", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+f.keys["owner"])
		resp, err := f.server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatal("admin accepted ambiguous JSON")
		}
	}
	f.expect("POST", "/v1/admin/principals/codex-pilot/rotate-key", "owner", map[string]any{"retry": true}, 400)
	f.expect("POST", "/v1/admin/projects", "owner", map[string]any{"id": "bad/id", "name": "Name"}, 400)
	f.expect("POST", "/v1/admin/projects", "owner", map[string]any{"id": "x", "name": strings.Repeat("я", 101)}, 400)
	f.expect("POST", "/v1/admin/principals", "owner", map[string]any{"id": "x", "name": "X", "kind": "agent", "runtime": strings.Repeat("x", 65)}, 400)
}
