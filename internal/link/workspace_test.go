package link

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func workspaceTestRevision(t *testing.T, f *fixture, identity string) string {
	t.Helper()
	revision, err := (&Server{Store: f.s}).workspaceRevision(context.Background(), f.keys[identity])
	if err != nil {
		t.Fatal("workspace revision failed:", err)
	}
	decoded, err := hex.DecodeString(revision)
	if err != nil || len(decoded) != 32 || revision != strings.ToLower(revision) {
		t.Fatal("workspace revision is not an opaque SHA-256 hex value")
	}
	return revision
}

func workspaceExpectChanged(t *testing.T, before, after, change string) {
	t.Helper()
	if before == after {
		t.Fatal("workspace missed visible change:", change)
	}
}

func workspaceExpectSame(t *testing.T, before, after, change string) {
	t.Helper()
	if before != after {
		t.Fatal("workspace disclosed hidden/unchanged state:", change)
	}
}

func TestWorkspaceMessagesReceiptsNotesAndChannelSequence(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	viewer := workspaceTestRevision(t, f, "viewer-pilot")
	denied := workspaceTestRevision(t, f, "deny-pilot")
	channels := f.expect("GET", "/v1/projects/pilot/channels", "viewer-pilot", nil, 200)["channels"].([]any)
	if len(channels) != 1 || channels[0].(map[string]any)["latest_seq"] != float64(0) {
		t.Fatal("new authorized channel must expose latest_seq zero")
	}
	message := f.message("workspace-message", "claude-pilot")
	next := workspaceTestRevision(t, f, "viewer-pilot")
	workspaceExpectChanged(t, viewer, next, "message")
	workspaceExpectSame(t, denied, workspaceTestRevision(t, f, "deny-pilot"), "message outside projects")
	viewer = next
	f.heartbeat("codex-pilot", "workspace-receipts")
	next = workspaceTestRevision(t, f, "viewer-pilot")
	workspaceExpectChanged(t, viewer, next, "visible heartbeat")
	viewer = next
	owner := workspaceTestRevision(t, f, "owner")
	f.expect("POST", "/v1/messages/"+message["id"].(string)+"/receipts", "codex-pilot", map[string]any{"session_id": "workspace-receipts", "status": "delivered"}, 200)
	next = workspaceTestRevision(t, f, "viewer-pilot")
	workspaceExpectChanged(t, viewer, next, "receipt")
	workspaceExpectChanged(t, owner, workspaceTestRevision(t, f, "owner"), "owner delivery")
	channels = f.expect("GET", "/v1/projects/pilot/channels", "viewer-pilot", nil, 200)["channels"].([]any)
	if channels[0].(map[string]any)["latest_seq"] != float64(2) {
		t.Fatal("latest_seq must advance for both message and receipt, not count messages")
	}
	viewer = next
	f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", map[string]any{"client_id": "workspace-note", "title": "Visible note", "body": "Must never appear in the hint"}, 201)
	workspaceExpectChanged(t, viewer, workspaceTestRevision(t, f, "viewer-pilot"), "project note")
	channels = f.expect("GET", "/v1/projects/pilot/channels", "viewer-pilot", nil, 200)["channels"].([]any)
	if channels[0].(map[string]any)["latest_seq"] != float64(2) {
		t.Fatal("project note must invalidate without inventing a channel cursor event")
	}
	workspaceExpectSame(t, denied, workspaceTestRevision(t, f, "deny-pilot"), "all pilot state")
}

func TestWorkspaceHiddenStateAndFreshACL(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	viewer := workspaceTestRevision(t, f, "viewer-pilot")
	owner := workspaceTestRevision(t, f, "owner")
	f.expect("POST", "/v1/admin/projects", "owner", map[string]any{"id": "hidden-project", "name": "Hidden project"}, 201)
	f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": "hidden-channel", "project_id": "pilot", "name": "Hidden channel"}, 201)
	f.access("claude-pilot", "channel", "hidden-channel", "write", 200)
	f.expect("POST", "/v1/channels/hidden-channel/messages", "claude-pilot", map[string]any{"client_id": "hidden-channel-message", "body": "Hidden", "recipient_ids": []string{}}, 201)
	f.expect("POST", "/v1/channels/isolated/messages", "deny-pilot", map[string]any{"client_id": "hidden-project-message", "body": "Hidden", "recipient_ids": []string{}}, 201)
	f.expect("POST", "/v1/projects/isolated/notes", "deny-pilot", map[string]any{"client_id": "hidden-note", "title": "Hidden", "body": "Hidden"}, 201)
	f.heartbeat("deny-pilot", "hidden-session")
	workspaceExpectSame(t, viewer, workspaceTestRevision(t, f, "viewer-pilot"), "hidden project/channel/note/heartbeat/audit")
	workspaceExpectChanged(t, owner, workspaceTestRevision(t, f, "owner"), "owner inventory and hidden-to-viewer content")
	channels := f.expect("GET", "/v1/projects/pilot/channels", "viewer-pilot", nil, 200)["channels"].([]any)
	if len(channels) != 1 || channels[0].(map[string]any)["id"] != "general" || channels[0].(map[string]any)["latest_seq"] != float64(0) {
		t.Fatal("channel list/latest_seq leaked a hidden channel")
	}
	f.access("viewer-pilot", "channel", "hidden-channel", "read", 200)
	workspaceExpectChanged(t, viewer, workspaceTestRevision(t, f, "viewer-pilot"), "new channel grant")
	channels = f.expect("GET", "/v1/projects/pilot/channels", "viewer-pilot", nil, 200)["channels"].([]any)
	if len(channels) != 2 || channels[1].(map[string]any)["id"] != "hidden-channel" || channels[1].(map[string]any)["latest_seq"] != float64(1) {
		t.Fatal("newly authorized channel must expose its current cursor")
	}
	f.access("viewer-pilot", "channel", "hidden-channel", "none", 200)
	workspaceExpectSame(t, viewer, workspaceTestRevision(t, f, "viewer-pilot"), "revoked channel returns to original visible state")
	f.access("viewer-pilot", "project", "hidden-project", "read", 200)
	workspaceExpectChanged(t, viewer, workspaceTestRevision(t, f, "viewer-pilot"), "project addition without any selected channel")
	f.access("viewer-pilot", "project", "hidden-project", "none", 200)
	workspaceExpectSame(t, viewer, workspaceTestRevision(t, f, "viewer-pilot"), "project revoke")
}

func TestWorkspaceSharedPrincipalVisibilityFreshnessAndOwnerAudit(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": "status-hidden", "project_id": "pilot", "name": "Hidden status"}, 201)
	f.access("deny-pilot", "project", "pilot", "read", 200)
	f.access("deny-pilot", "channel", "status-hidden", "read", 200)
	viewer := workspaceTestRevision(t, f, "viewer-pilot")
	f.heartbeat("deny-pilot", "shared-project-not-channel")
	workspaceExpectSame(t, viewer, workspaceTestRevision(t, f, "viewer-pilot"), "co-project principal without a shared channel")
	f.access("viewer-pilot", "channel", "status-hidden", "read", 200)
	viewer = workspaceTestRevision(t, f, "viewer-pilot")
	f.expect("POST", "/v1/heartbeat", "deny-pilot", map[string]any{"session_id": "shared-project-not-channel", "activity": "changed", "runtime": "test"}, 200)
	workspaceExpectChanged(t, viewer, workspaceTestRevision(t, f, "viewer-pilot"), "now-visible shared-channel status")
	if _, err := f.s.Pool.Exec(context.Background(), "UPDATE principals SET last_seen_at=clock_timestamp()-interval '29 seconds' WHERE id='codex-pilot'"); err != nil {
		t.Fatal(err)
	}
	before := workspaceTestRevision(t, f, "viewer-pilot")
	time.Sleep(1100 * time.Millisecond)
	after := workspaceTestRevision(t, f, "viewer-pilot")
	workspaceExpectChanged(t, before, after, "fresh to stale without any intervening write")
	workspaceExpectSame(t, after, workspaceTestRevision(t, f, "viewer-pilot"), "wall clock alone after stale boundary")
	owner := workspaceTestRevision(t, f, "owner")
	f.expect("POST", "/v1/admin/principals/codex-pilot/rotate-key", "owner", map[string]any{}, 200)
	workspaceExpectChanged(t, owner, workspaceTestRevision(t, f, "owner"), "audit addition when key-active boolean stays true")
	workspaceExpectSame(t, after, workspaceTestRevision(t, f, "viewer-pilot"), "another principal's key hash/audit is not ordinary visible status")
}

func TestWorkspaceLifecycleArchiveRestoreDelete(t *testing.T) {
	f, _ := lifecycleFixture(t)
	viewer := workspaceTestRevision(t, f, "viewer-pilot")
	owner := workspaceTestRevision(t, f, "owner")
	f.lifecycle("archive", 200)
	workspaceExpectChanged(t, viewer, workspaceTestRevision(t, f, "viewer-pilot"), "archive revokes ordinary visibility")
	workspaceExpectChanged(t, owner, workspaceTestRevision(t, f, "owner"), "owner sees archived lifecycle")
	viewer = workspaceTestRevision(t, f, "viewer-pilot")
	f.lifecycle("restore", 200)
	workspaceExpectChanged(t, viewer, workspaceTestRevision(t, f, "viewer-pilot"), "restore returns visibility")
	f.lifecycle("archive", 200)
	viewer = workspaceTestRevision(t, f, "viewer-pilot")
	owner = workspaceTestRevision(t, f, "owner")
	preview := f.preview()
	f.deletion(preview["project"].(map[string]any)["lifecycle_version"], 200)
	workspaceExpectChanged(t, owner, workspaceTestRevision(t, f, "owner"), "permanent project deletion")
	workspaceExpectSame(t, viewer, workspaceTestRevision(t, f, "viewer-pilot"), "deletion of an already hidden archived project")
}

type workspaceFrame struct {
	revision string
	err      error
}

func workspaceTestStream(t *testing.T, f *fixture, identity string) <-chan workspaceFrame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, "GET", f.server.URL+"/v1/workspace/stream?after=not-a-cursor", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+f.keys[identity])
	req.Header.Set("Last-Event-ID", "not-a-durable-workspace-id")
	resp, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal("workspace stream failed:", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("workspace stream status or headers incorrect")
	}
	frames := make(chan workspaceFrame, 8)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		var event, data string
		var bad bool
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				data += strings.TrimPrefix(line, "data: ")
			case strings.HasPrefix(line, "id:"):
				bad = true
			case line == "" && data != "":
				var payload map[string]string
				decodeErr := json.Unmarshal([]byte(data), &payload)
				decoded, hexErr := hex.DecodeString(payload["revision"])
				if bad || event != "workspace" || decodeErr != nil || len(payload) != 1 || hexErr != nil || len(decoded) != 32 {
					frames <- workspaceFrame{err: io.ErrUnexpectedEOF}
					return
				}
				frames <- workspaceFrame{revision: payload["revision"]}
				event, data = "", ""
			}
		}
		err := scanner.Err()
		if err == nil {
			err = io.EOF
		}
		frames <- workspaceFrame{err: err}
	}()
	return frames
}

func workspaceNext(t *testing.T, frames <-chan workspaceFrame) string {
	t.Helper()
	select {
	case frame := <-frames:
		if frame.err != nil {
			t.Fatal("workspace stream ended or emitted malformed/content-bearing frame:", frame.err)
		}
		return frame.revision
	case <-time.After(3 * time.Second):
		t.Fatal("workspace hint deadline exceeded")
		return ""
	}
}

func TestWorkspaceStreamEmptyAccountGainsAccessAndIdleRevocation(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	f.expect("GET", "/v1/workspace/stream", "", nil, 401)
	f.access("viewer-pilot", "project", "pilot", "none", 200)
	frames := workspaceTestStream(t, f, "viewer-pilot")
	initial := workspaceNext(t, frames)
	workspaceExpectSame(t, initial, workspaceTestRevision(t, f, "viewer-pilot"), "initial empty workspace snapshot")
	f.access("viewer-pilot", "project", "pilot", "read", 200)
	project := workspaceNext(t, frames)
	workspaceExpectChanged(t, initial, project, "live stream sees first project grant")
	f.access("viewer-pilot", "channel", "general", "read", 200)
	channel := workspaceNext(t, frames)
	workspaceExpectChanged(t, project, channel, "live stream sees first channel grant")
	f.access("viewer-pilot", "project", "pilot", "none", 200)
	empty := workspaceNext(t, frames)
	workspaceExpectSame(t, initial, empty, "live stream sees complete access loss without disconnecting")
	if err := f.s.Revoke(context.Background(), "viewer-pilot"); err != nil {
		t.Fatal(err)
	}
	select {
	case frame := <-frames:
		if frame.err == nil {
			t.Fatal("revoked idle empty workspace emitted another hint instead of closing")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("revoked idle workspace stream did not close")
	}
	f.expect("GET", "/v1/workspace/stream", "viewer-pilot", nil, 401)
}
