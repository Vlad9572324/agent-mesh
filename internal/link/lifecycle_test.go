package link

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

const lifecycleID = "lifecycle-project"
const lifecycleChannel = "lifecycle-channel"
const lifecycleSide = "lifecycle-side"

func lifecycleFixture(t *testing.T) (*fixture, string) {
	t.Helper()
	f := newFixture(t)
	f.owner("owner")
	f.expect("POST", "/v1/admin/projects", "owner", map[string]any{"id": lifecycleID, "name": "Disposable lifecycle fixture"}, 201)
	for _, id := range []string{lifecycleChannel, lifecycleSide} {
		f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": id, "project_id": lifecycleID, "name": id}, 201)
	}
	for _, id := range []string{"claude-pilot", "codex-pilot", "viewer-pilot"} {
		access := "write"
		if id == "viewer-pilot" {
			access = "read"
		}
		f.access(id, "project", lifecycleID, access, 200)
		f.access(id, "channel", lifecycleChannel, access, 200)
	}
	f.access("claude-pilot", "channel", lifecycleSide, "write", 200)
	first := f.expect("POST", "/v1/channels/"+lifecycleChannel+"/messages", "claude-pilot", map[string]any{"client_id": "lifecycle-first", "body": "Preserved until explicit delete", "recipient_ids": []string{"codex-pilot"}}, 201)["message"].(map[string]any)["id"].(string)
	f.expect("POST", "/v1/channels/"+lifecycleChannel+"/messages", "claude-pilot", map[string]any{"client_id": "lifecycle-reply", "body": "Reply", "recipient_ids": []string{"codex-pilot"}, "reply_to": first}, 201)
	f.expect("POST", "/v1/projects/"+lifecycleID+"/notes", "claude-pilot", map[string]any{"client_id": "lifecycle-note", "title": "Context", "body": "Project context", "source_message_id": first}, 201)
	f.heartbeat("codex-pilot", "lifecycle-session")
	for _, status := range []string{"delivered", "accepted"} {
		f.expect("POST", "/v1/messages/"+first+"/receipts", "codex-pilot", map[string]any{"session_id": "lifecycle-session", "status": status}, 200)
	}
	return f, first
}

func (f *fixture) lifecycle(action string, want int) map[string]any {
	f.t.Helper()
	return f.expect("POST", "/v1/admin/projects/"+lifecycleID+"/"+action, "owner", map[string]any{}, want)
}

func (f *fixture) deletion(version any, want int) map[string]any {
	f.t.Helper()
	return f.expect("DELETE", "/v1/admin/projects/"+lifecycleID, "owner", map[string]any{"confirm_id": lifecycleID, "expected_version": version}, want)
}

func (f *fixture) preview() map[string]any {
	f.t.Helper()
	return f.expect("GET", "/v1/admin/projects/"+lifecycleID+"/deletion-preview", "owner", nil, 200)
}

func (f *fixture) snapshot(sql string, args ...any) string {
	f.t.Helper()
	var result string
	if err := f.s.Pool.QueryRow(context.Background(), sql, args...).Scan(&result); err != nil {
		f.t.Fatal(err)
	}
	return result
}

const lifecycleContentSnapshot = `SELECT json_build_object(
 'principals',(SELECT json_agg(p ORDER BY id) FROM principals p),
 'channels',(SELECT json_agg(c ORDER BY id) FROM channels c),
 'messages',(SELECT json_agg(m ORDER BY id) FROM messages m),
 'notes',(SELECT json_agg(n ORDER BY id) FROM notes n),
 'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r),
 'events',(SELECT json_agg(e ORDER BY channel_id,seq) FROM events e),
 'pm',(SELECT json_agg(pm ORDER BY project_id,agent_id) FROM project_members pm),
 'cm',(SELECT json_agg(cm ORDER BY channel_id,agent_id) FROM channel_members cm))::text`

const unrelatedSnapshot = `SELECT json_build_object(
 'principals',(SELECT json_agg(p ORDER BY id) FROM principals p),
 'projects',(SELECT json_agg(p ORDER BY id) FROM projects p WHERE id<>$1),
 'channels',(SELECT json_agg(c ORDER BY id) FROM channels c WHERE project_id<>$1),
 'messages',(SELECT json_agg(m ORDER BY m.id) FROM messages m JOIN channels c ON c.id=m.channel_id WHERE c.project_id<>$1),
 'notes',(SELECT json_agg(n ORDER BY id) FROM notes n WHERE project_id<>$1),
 'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r JOIN messages m ON m.id=r.message_id JOIN channels c ON c.id=m.channel_id WHERE c.project_id<>$1),
 'events',(SELECT json_agg(e ORDER BY channel_id,seq) FROM events e JOIN channels c ON c.id=e.channel_id WHERE c.project_id<>$1),
 'pm',(SELECT json_agg(pm ORDER BY project_id,agent_id) FROM project_members pm WHERE project_id<>$1),
 'cm',(SELECT json_agg(cm ORDER BY channel_id,agent_id) FROM channel_members cm JOIN channels c ON c.id=cm.channel_id WHERE c.project_id<>$1))::text`

func TestLifecycleMigrationPreservesLegacyData(t *testing.T) {
	f := newFixture(t)
	f.message("pre-lifecycle-history", "claude-pilot")
	before := f.snapshot(lifecycleContentSnapshot)
	ctx := context.Background()
	if _, err := f.s.Pool.Exec(ctx, `ALTER TABLE projects DROP COLUMN archived_at; ALTER TABLE projects DROP COLUMN lifecycle_version; DROP TABLE retired_project_ids; DROP TABLE retired_channel_ids`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := f.s.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if before != f.snapshot(lifecycleContentSnapshot) {
		t.Fatal("additive lifecycle migration changed existing content, ACL, presence or keys")
	}
	for _, entry := range f.expect("GET", "/v1/projects", "viewer-pilot", nil, 200)["projects"].([]any) {
		p := entry.(map[string]any)
		if p["archived_at"] != nil || p["lifecycle_version"] != float64(0) {
			t.Fatal("existing project did not migrate to active version0")
		}
	}
}

func TestArchiveRestoreVisibilityAndIdempotency(t *testing.T) {
	f, message := lifecycleFixture(t)
	before := f.snapshot(lifecycleContentSnapshot)
	initial := f.lifecycle("restore", 200)["project"].(map[string]any)
	if initial["archived_at"] != nil || initial["lifecycle_version"] != float64(0) {
		t.Fatal("same-state restore changed initial project")
	}
	archived := f.lifecycle("archive", 200)["project"].(map[string]any)
	if archived["archived_at"] == nil || archived["lifecycle_version"] != float64(1) {
		t.Fatal("archive did not set timestamp/version")
	}
	repeated := f.lifecycle("archive", 200)["project"].(map[string]any)
	a, _ := json.Marshal(archived)
	b, _ := json.Marshal(repeated)
	if !bytes.Equal(a, b) {
		t.Fatal("repeated archive changed project state")
	}
	if before != f.snapshot(lifecycleContentSnapshot) {
		t.Fatal("archive modified journal, ACL, keys or leases")
	}
	for _, identity := range []string{"owner", "claude-pilot", "viewer-pilot"} {
		for _, entry := range f.expect("GET", "/v1/projects", identity, nil, 200)["projects"].([]any) {
			if entry.(map[string]any)["id"] == lifecycleID {
				t.Fatal("archived project leaked into active listing")
			}
		}
	}
	paths := []string{"/v1/projects/" + lifecycleID + "/channels", "/v1/projects/" + lifecycleID + "/agents", "/v1/projects/" + lifecycleID + "/notes", "/v1/channels/" + lifecycleChannel + "/messages", "/v1/channels/" + lifecycleChannel + "/events", "/v1/messages/" + message}
	for _, path := range paths {
		f.expect("GET", path, "owner", nil, 200)
		for _, identity := range []string{"claude-pilot", "viewer-pilot", "deny-pilot"} {
			f.expect("GET", path, identity, nil, 404)
		}
	}
	f.expect("GET", "/v1/channels/"+lifecycleChannel+"/stream", "codex-pilot", nil, 404)
	for _, path := range []string{"/v1/channels/" + lifecycleChannel + "/messages", "/v1/projects/" + lifecycleID + "/notes", "/v1/messages/" + message + "/receipts"} {
		f.expect("POST", path, "codex-pilot", map[string]any{}, 404)
	}
	f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": "archive-blocked-channel", "project_id": lifecycleID, "name": "Blocked"}, 409)
	for _, access := range []string{"none", "read", "write"} {
		f.access("codex-pilot", "project", lifecycleID, access, 409)
		f.access("codex-pilot", "channel", lifecycleChannel, access, 409)
	}
	overview := f.expect("GET", "/v1/admin/overview", "owner", nil, 200)
	found := false
	for _, entry := range overview["projects"].([]any) {
		p := entry.(map[string]any)
		if p["id"] == lifecycleID {
			found = true
			if p["archived_at"] == nil || p["lifecycle_version"] != float64(1) {
				t.Fatal("overview omitted archived state")
			}
		}
	}
	if !found {
		t.Fatal("owner inventory omitted archived project")
	}
	restored := f.lifecycle("restore", 200)["project"].(map[string]any)
	if restored["archived_at"] != nil || restored["lifecycle_version"] != float64(2) {
		t.Fatal("restore did not update lifecycle")
	}
	if f.lifecycle("restore", 200)["project"].(map[string]any)["lifecycle_version"] != float64(2) {
		t.Fatal("same-state restore advanced version")
	}
	if before != f.snapshot(lifecycleContentSnapshot) {
		t.Fatal("restore did not preserve content and exact ACL")
	}
	f.expect("GET", "/v1/channels/"+lifecycleChannel+"/messages", "viewer-pilot", nil, 200)
	f.expect("POST", "/v1/channels/"+lifecycleChannel+"/messages", "claude-pilot", map[string]any{"client_id": "after-restore", "body": "Restored write", "recipient_ids": []string{}, "channel_only": true}, 201)
	f.expect("POST", "/v1/channels/"+lifecycleChannel+"/messages", "viewer-pilot", map[string]any{}, 404)
	var count int
	if err := f.s.Pool.QueryRow(context.Background(), "SELECT count(*) FROM admin_audit WHERE target_id=$1 AND action IN ('project.archive','project.restore')", lifecycleID).Scan(&count); err != nil || count != 2 {
		t.Fatal("same-state lifecycle requests duplicated audit")
	}
	// A heartbeat is identity-wide and remains legitimate while archived.
	f.lifecycle("archive", 200)
	f.heartbeat("codex-pilot", "lifecycle-session")
}

func TestLifecycleAdminAuthorizationAndStrictInputs(t *testing.T) {
	f, _ := lifecycleFixture(t)
	for _, identity := range []string{"claude-pilot", "viewer-pilot", "deny-pilot"} {
		for _, action := range []string{"archive", "restore"} {
			f.expect("POST", "/v1/admin/projects/"+lifecycleID+"/"+action, identity, map[string]any{}, 403)
		}
		f.expect("GET", "/v1/admin/projects/"+lifecycleID+"/deletion-preview", identity, nil, 403)
		f.expect("DELETE", "/v1/admin/projects/"+lifecycleID, identity, map[string]any{"confirm_id": lifecycleID, "expected_version": 0}, 403)
	}
	f.expect("POST", "/v1/admin/projects/"+lifecycleID+"/archive", "owner", map[string]any{"archived_at": "2020-01-01"}, 400)
	f.expect("POST", "/v1/admin/projects", "owner", map[string]any{"id": "cannot-set-state", "name": "Name", "lifecycle_version": 3}, 400)
	f.deletion(0, 409)
	if f.preview()["can_delete"] != false {
		t.Fatal("active preview allows deletion")
	}
	f.lifecycle("archive", 200)
	for _, body := range []map[string]any{
		{"confirm_id": "wrong", "expected_version": 1},
		{"confirm_id": lifecycleID + " ", "expected_version": 1},
		{"confirm_id": lifecycleID},
		{"confirm_id": lifecycleID, "expected_version": nil},
		{"confirm_id": lifecycleID, "expected_version": -1},
		{"confirm_id": lifecycleID, "expected_version": 1.5},
		{"confirm_id": lifecycleID, "expected_version": "1"},
		{"confirm_id": lifecycleID, "expected_version": 1, "force": true},
	} {
		f.expect("DELETE", "/v1/admin/projects/"+lifecycleID, "owner", body, 400)
	}
	f.deletion(0, 409)
	f.lifecycle("restore", 200)
	f.lifecycle("archive", 200)
	f.deletion(1, 409)
	if f.preview()["project"].(map[string]any)["lifecycle_version"] != float64(3) {
		t.Fatal("stale deletion changed version")
	}
	f.expect("GET", "/v1/admin/projects/unknown-project/deletion-preview", "owner", nil, 404)
	f.expect("POST", "/v1/admin/projects/unknown-project/archive", "owner", map[string]any{}, 404)
}

func TestHardDeletionCountsScopeTombstonesAndAudit(t *testing.T) {
	f, message := lifecycleFixture(t)
	f.message("unrelated-history", "claude-pilot")
	f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", map[string]any{"client_id": "unrelated-note", "title": "Unrelated", "body": "Keep"}, 201)
	before := f.snapshot(unrelatedSnapshot, lifecycleID)
	preview := f.preview()
	counts := preview["counts"].(map[string]any)
	for key, want := range map[string]float64{"channels": 2, "messages": 2, "notes": 1, "receipts": 2, "events": 4, "project_members": 3, "channel_members": 4} {
		if counts[key] != want {
			t.Fatalf("count %s=%v, want %v", key, counts[key], want)
		}
	}
	f.lifecycle("archive", 200)
	if f.preview()["can_delete"] != true {
		t.Fatal("archived preview prohibits delete")
	}
	deleted := f.deletion(1, 200)
	if deleted["deleted"] != true || deleted["project_id"] != lifecycleID {
		t.Fatal("wrong deletion result")
	}
	if before != f.snapshot(unrelatedSnapshot, lifecycleID) {
		t.Fatal("deletion changed principals, keys or unrelated project content")
	}
	for _, identity := range []string{"owner", "claude-pilot", "viewer-pilot"} {
		for _, path := range []string{"/v1/projects/" + lifecycleID + "/channels", "/v1/projects/" + lifecycleID + "/notes", "/v1/channels/" + lifecycleChannel + "/messages", "/v1/messages/" + message} {
			f.expect("GET", path, identity, nil, 404)
		}
	}
	f.deletion(1, 404)
	f.lifecycle("restore", 404)
	f.expect("GET", "/v1/admin/projects/"+lifecycleID+"/deletion-preview", "owner", nil, 404)
	f.expect("POST", "/v1/admin/projects", "owner", map[string]any{"id": lifecycleID, "name": "Must not reuse"}, 409)
	for _, channel := range []string{lifecycleChannel, lifecycleSide} {
		f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": channel, "project_id": "pilot", "name": "Must not retarget outbox"}, 409)
	}
	var reservedProjects, reservedChannels, audits int
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM retired_project_ids WHERE id=$1),(SELECT count(*) FROM retired_channel_ids WHERE id=ANY($2)),(SELECT count(*) FROM admin_audit WHERE action='project.delete' AND target_id=$1)`, lifecycleID, []string{lifecycleChannel, lifecycleSide}).Scan(&reservedProjects, &reservedChannels, &audits); err != nil || reservedProjects != 1 || reservedChannels != 2 || audits != 1 {
		t.Fatal("deletion tombstones/audit incomplete")
	}
	// Bootstrap remains a no-op and cannot silently resurrect a deleted project.
	if err := f.s.Bootstrap(context.Background(), f.credentials); err != nil {
		t.Fatal(err)
	}
	f.expect("POST", "/v1/admin/projects", "owner", map[string]any{"id": lifecycleID, "name": "Still retired"}, 409)
}

func TestLifecycleAuditFailureRollsBackEverything(t *testing.T) {
	f, _ := lifecycleFixture(t)
	ctx := context.Background()
	if _, err := f.s.Pool.Exec(ctx, `CREATE FUNCTION fail_lifecycle_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$`); err != nil {
		t.Fatal(err)
	}
	reject := func() {
		t.Helper()
		if _, err := f.s.Pool.Exec(ctx, `CREATE TRIGGER fail_lifecycle_audit BEFORE INSERT ON admin_audit FOR EACH ROW EXECUTE FUNCTION fail_lifecycle_audit()`); err != nil {
			t.Fatal(err)
		}
	}
	allow := func() {
		t.Helper()
		if _, err := f.s.Pool.Exec(ctx, `DROP TRIGGER fail_lifecycle_audit ON admin_audit`); err != nil {
			t.Fatal(err)
		}
	}
	before := f.snapshot(lifecycleContentSnapshot)
	reject()
	f.lifecycle("archive", 500)
	p := f.preview()["project"].(map[string]any)
	if p["archived_at"] != nil || p["lifecycle_version"] != float64(0) {
		t.Fatal("archive committed despite failed audit")
	}
	allow()
	f.lifecycle("archive", 200)
	reject()
	f.lifecycle("restore", 500)
	p = f.preview()["project"].(map[string]any)
	if p["archived_at"] == nil || p["lifecycle_version"] != float64(1) {
		t.Fatal("restore committed despite failed audit")
	}
	f.deletion(1, 500)
	if before != f.snapshot(lifecycleContentSnapshot) {
		t.Fatal("failed delete did not roll back content/ACL/identity changes")
	}
	var retired int
	if err := f.s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM retired_project_ids)+(SELECT count(*) FROM retired_channel_ids)`).Scan(&retired); err != nil || retired != 0 {
		t.Fatal("failed deletion left ID tombstones")
	}
	allow()
	f.deletion(1, 200)
}

func TestHardDeletionRejectsAnomalousCrossProjectReferences(t *testing.T) {
	for _, kind := range []string{"inbound-reply", "outbound-reply", "inbound-note", "outbound-note", "extra-fk"} {
		t.Run(kind, func(t *testing.T) {
			f, message := lifecycleFixture(t)
			ctx := context.Background()
			other := f.message("cross-project-control", "claude-pilot")["id"].(string)
			var err error
			switch kind {
			case "inbound-reply":
				_, err = f.s.Pool.Exec(ctx, "UPDATE messages SET reply_to=$1 WHERE id=$2", message, other)
			case "outbound-reply":
				_, err = f.s.Pool.Exec(ctx, "UPDATE messages SET reply_to=$1 WHERE id=$2", other, message)
			case "inbound-note":
				f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", map[string]any{"client_id": "cross-source", "title": "Other", "body": "Unrelated"}, 201)
				_, err = f.s.Pool.Exec(ctx, "UPDATE notes SET source_message_id=$1 WHERE project_id='pilot'", message)
			case "outbound-note":
				_, err = f.s.Pool.Exec(ctx, "UPDATE notes SET source_message_id=$1 WHERE project_id=$2", other, lifecycleID)
			case "extra-fk":
				_, err = f.s.Pool.Exec(ctx, `CREATE TABLE external_reference(project_id text REFERENCES projects(id)); INSERT INTO external_reference VALUES('lifecycle-project')`)
			}
			if err != nil {
				t.Fatal(err)
			}
			f.lifecycle("archive", 200)
			before := f.snapshot(lifecycleContentSnapshot)
			f.deletion(1, 409)
			if before != f.snapshot(lifecycleContentSnapshot) {
				t.Fatal("refused deletion altered related or unrelated data")
			}
			var retired int
			if err = f.s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM retired_project_ids)+(SELECT count(*) FROM retired_channel_ids)`).Scan(&retired); err != nil || retired != 0 {
				t.Fatal("refused FK deletion left tombstones")
			}
		})
	}
}

func TestArchiveClosesOrdinaryStreamButPreservesOwnerHistory(t *testing.T) {
	f, _ := lifecycleFixture(t)
	stream := func(identity string) (*http.Response, context.CancelFunc) {
		t.Helper()
		ctx, cancel := context.WithCancel(context.Background())
		req, _ := http.NewRequestWithContext(ctx, "GET", f.server.URL+"/v1/channels/"+lifecycleChannel+"/stream", nil)
		req.Header.Set("Authorization", "Bearer "+f.keys[identity])
		resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		if resp.StatusCode != 200 {
			cancel()
			t.Fatal("SSE denied")
		}
		buf := make([]byte, 2048)
		if _, err = resp.Body.Read(buf); err != nil {
			cancel()
			t.Fatal(err)
		}
		return resp, cancel
	}
	ordinary, cancelOrdinary := stream("viewer-pilot")
	defer cancelOrdinary()
	defer ordinary.Body.Close()
	owner, cancelOwner := stream("owner")
	defer cancelOwner()
	defer owner.Body.Close()
	f.lifecycle("archive", 200)
	start := time.Now()
	if _, err := io.ReadAll(ordinary.Body); err != nil {
		t.Fatal("archived ordinary SSE did not close cleanly")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("archive SSE revocation too slow")
	}
	done := make(chan error, 1)
	go func() { _, err := io.ReadAll(owner.Body); done <- err }()
	select {
	case <-done:
		t.Fatal("archive incorrectly closed owner history SSE")
	case <-time.After(100 * time.Millisecond):
	}
	cancelOwner()
	<-done
}

func TestConcurrentArchiveAgainstAgentWritesAndACL(t *testing.T) {
	f, _ := lifecycleFixture(t)
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make(chan error, 40)
	for i := 0; i < 36; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			method, path, identity := "POST", "/v1/channels/"+lifecycleChannel+"/messages", "claude-pilot"
			body := map[string]any{"client_id": fmt.Sprintf("concurrent-lifecycle-%d", i), "body": "concurrent", "recipient_ids": []string{}, "channel_only": true}
			if i%3 == 1 {
				path = "/v1/projects/" + lifecycleID + "/notes"
				body = map[string]any{"client_id": fmt.Sprintf("concurrent-note-%d", i), "title": "Concurrent", "body": "concurrent"}
			}
			if i%3 == 2 {
				method, path, identity = "PUT", "/v1/admin/access", "owner"
				body = map[string]any{"agent_id": "codex-pilot", "scope": "channel", "resource_id": lifecycleChannel, "access": "read"}
			}
			status, err := rawLifecycleRequest(f, method, path, identity, body)
			if err != nil {
				errs <- err
				return
			}
			if i%3 == 2 {
				if status != 200 && status != 409 {
					errs <- fmt.Errorf("concurrent ACL status %d", status)
				}
			} else if status != 201 && status != 404 {
				errs <- fmt.Errorf("concurrent write status %d", status)
			}
		}(i)
	}
	close(start)
	f.lifecycle("archive", 200)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	var lateWrite bool
	err := f.s.Pool.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM messages m JOIN channels c ON c.id=m.channel_id JOIN projects p ON p.id=c.project_id WHERE p.id=$1 AND m.created_at>p.archived_at) OR EXISTS(SELECT 1 FROM notes n JOIN projects p ON p.id=n.project_id WHERE p.id=$1 AND n.created_at>p.archived_at)`, lifecycleID).Scan(&lateWrite)
	if err != nil || lateWrite {
		t.Fatal("agent mutation committed with creation after archive boundary")
	}
	f.deletion(1, 200)
	f.expect("POST", "/v1/channels/"+lifecycleChannel+"/messages", "claude-pilot", map[string]any{}, 404)
}

func rawLifecycleRequest(f *fixture, method, path, identity string, body any) (int, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequest(method, f.server.URL+path, bytes.NewReader(b))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+f.keys[identity])
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.server.Client().Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

func TestConcurrentRestoreAndHardDeleteHaveSingleOutcome(t *testing.T) {
	for i := 0; i < 6; i++ {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			f, _ := lifecycleFixture(t)
			f.lifecycle("archive", 200)
			start := make(chan struct{})
			results := make(chan struct {
				action string
				status int
				err    error
			}, 2)
			for _, action := range []string{"restore", "delete"} {
				go func(action string) {
					<-start
					method, path := "POST", "/v1/admin/projects/"+lifecycleID+"/restore"
					body := map[string]any{}
					if action == "delete" {
						method, path = "DELETE", "/v1/admin/projects/"+lifecycleID
						body = map[string]any{"confirm_id": lifecycleID, "expected_version": 1}
					}
					status, err := rawLifecycleRequest(f, method, path, "owner", body)
					results <- struct {
						action string
						status int
						err    error
					}{action, status, err}
				}(action)
			}
			close(start)
			outcomes := map[string]int{}
			for j := 0; j < 2; j++ {
				r := <-results
				if r.err != nil {
					t.Fatal(r.err)
				}
				outcomes[r.action] = r.status
			}
			if !((outcomes["delete"] == 200 && outcomes["restore"] == 404) || (outcomes["restore"] == 200 && outcomes["delete"] == 409)) {
				t.Fatalf("nonlinear restore/delete result: %v", outcomes)
			}
			var exists, retired bool
			var deletes, restores int
			if err := f.s.Pool.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1),EXISTS(SELECT 1 FROM retired_project_ids WHERE id=$1),(SELECT count(*) FROM admin_audit WHERE action='project.delete' AND target_id=$1),(SELECT count(*) FROM admin_audit WHERE action='project.restore' AND target_id=$1)`, lifecycleID).Scan(&exists, &retired, &deletes, &restores); err != nil {
				t.Fatal(err)
			}
			if exists == retired || deletes+restores != 1 {
				t.Fatal("concurrent lifecycle committed inconsistent state/tombstone/audit")
			}
		})
	}
}

func TestDeleteStrictJSONDoesNotAcceptDuplicateVersion(t *testing.T) {
	f, _ := lifecycleFixture(t)
	f.lifecycle("archive", 200)
	body := `{"confirm_id":"` + lifecycleID + `","expected_version":0,"expected_version":1}`
	req, _ := http.NewRequest("DELETE", f.server.URL+"/v1/admin/projects/"+lifecycleID, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+f.keys["owner"])
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != 400 {
		t.Fatal("ambiguous deletion version accepted")
	}
}

func TestConcurrentArchivedHistoryReadsAndDeleteDoNotReturnServerErrors(t *testing.T) {
	f, message := lifecycleFixture(t)
	f.lifecycle("archive", 200)
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make(chan error, 24)
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			path := "/v1/messages/" + message
			if i%2 == 0 {
				path = "/v1/channels/" + lifecycleChannel + "/messages"
			}
			status, err := rawLifecycleRequest(f, "GET", path, "owner", nil)
			if err != nil {
				errs <- err
				return
			}
			if status != 200 && status != 404 {
				errs <- fmt.Errorf("history read racing deletion returned %d", status)
			}
		}(i)
	}
	close(start)
	f.deletion(1, 200)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}
