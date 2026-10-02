package link

import (
	"context"
	"testing"
)

func coordinationTaskInput(client string) map[string]any {
	return map[string]any{"client_id": client, "title": "Bounded coordination test", "owner_id": "claude-pilot", "reviewer_id": "codex-pilot", "scope": []string{"fixture.go"}, "acceptance": []string{"isolated fixture only"}}
}

func coordinationSessionInput(session, channel string) map[string]any {
	return map[string]any{"session_id": session, "channel_id": channel, "run_id": "fixture-run", "task_role": "reviewer", "runtime": "fixture", "model": "", "activity": "test", "ttl_seconds": 30, "max_duration_seconds": 60}
}

func TestCoordinationWorkspaceVisibilityAndSessionTTL(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	visible := workspaceTestRevision(t, f, "viewer-pilot")
	hidden := workspaceTestRevision(t, f, "deny-pilot")
	f.expect("POST", "/v1/projects/pilot/tasks", "claude-pilot", coordinationTaskInput("task-visible"), 201)
	next := workspaceTestRevision(t, f, "viewer-pilot")
	workspaceExpectChanged(t, visible, next, "task created")
	visible = next
	f.expect("POST", "/v1/projects/pilot/memory", "claude-pilot", map[string]any{"client_id": "memory-visible", "title": "Selected context", "body": "Shared project context"}, 201)
	next = workspaceTestRevision(t, f, "viewer-pilot")
	workspaceExpectChanged(t, visible, next, "versioned memory created")
	visible = next
	f.expect("POST", "/v1/projects/pilot/artifacts", "claude-pilot", artifactTestInput("artifact-visible", []byte("shared patch")), 201)
	next = workspaceTestRevision(t, f, "viewer-pilot")
	workspaceExpectChanged(t, visible, next, "artifact created")
	visible = next
	f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", coordinationSessionInput("session-visible", "general"), 201)
	next = workspaceTestRevision(t, f, "viewer-pilot")
	workspaceExpectChanged(t, visible, next, "session created")
	workspaceExpectSame(t, hidden, workspaceTestRevision(t, f, "deny-pilot"), "other project coordination state")
	// A channel-scoped session must not leak through the project's SSE hint.
	f.expect("POST", "/v1/admin/channels", "owner", map[string]any{"id": "private-coordination", "project_id": "pilot", "name": "private"}, 201)
	f.access("codex-pilot", "channel", "private-coordination", "write", 200)
	visible = workspaceTestRevision(t, f, "viewer-pilot")
	f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", coordinationSessionInput("session-hidden", "private-coordination"), 201)
	workspaceExpectSame(t, visible, workspaceTestRevision(t, f, "viewer-pilot"), "hidden channel session")
	_, err := f.s.Pool.Exec(context.Background(), `UPDATE execution_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id='session-visible'`)
	if err != nil {
		t.Fatal(err)
	}
	workspaceExpectChanged(t, visible, workspaceTestRevision(t, f, "viewer-pilot"), "expired visible session")
}

func TestCoordinationArchiveDeletePreviewAndCascade(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	task := f.expect("POST", "/v1/projects/pilot/tasks", "claude-pilot", coordinationTaskInput("task-delete"), 201)["task"].(map[string]any)
	f.expect("POST", "/v1/projects/pilot/tasks/"+task["id"].(string)+"/events", "claude-pilot", map[string]any{"client_id": "run", "expected_version": 1, "type": "run_started", "run_id": "delete-run", "summary": "fixture run"}, 201)
	f.expect("POST", "/v1/projects/pilot/memory", "claude-pilot", map[string]any{"client_id": "memory-delete", "title": "Delete fixture", "body": "fixture only"}, 201)
	f.expect("POST", "/v1/projects/pilot/artifacts", "claude-pilot", artifactTestInput("artifact-delete", []byte("fixture")), 201)
	f.expect("POST", "/v1/projects/pilot/sessions", "codex-pilot", coordinationSessionInput("session-delete", "general"), 201)
	f.expect("POST", "/v1/channels/general/activity", "codex-pilot", map[string]any{"client_id": "native-delete", "session_id": "native-delete-session", "runtime": "codex", "event_type": "session.started"}, 201)
	preview := f.expect("GET", "/v1/admin/projects/pilot/deletion-preview", "owner", nil, 200)
	counts := preview["counts"].(map[string]any)
	for _, key := range []string{"tasks", "task_runs", "task_events", "memory", "memory_versions", "artifacts", "sessions", "native_activity"} {
		if counts[key] != float64(1) {
			t.Fatalf("preview count %s=%v", key, counts[key])
		}
	}
	// Content in an unrelated project must remain byte-for-byte untouched.
	f.expect("POST", "/v1/projects/isolated/artifacts", "deny-pilot", artifactTestInput("preserve", []byte("unrelated")), 201)
	f.expect("POST", "/v1/admin/projects/pilot/archive", "owner", map[string]any{}, 200)
	f.expect("GET", "/v1/projects/pilot/tasks", "claude-pilot", nil, 404)
	f.expect("GET", "/v1/projects/pilot/tasks", "owner", nil, 200)
	preview = f.expect("GET", "/v1/admin/projects/pilot/deletion-preview", "owner", nil, 200)
	project := preview["project"].(map[string]any)
	f.expect("DELETE", "/v1/admin/projects/pilot", "owner", map[string]any{"confirm_id": "pilot", "expected_version": project["lifecycle_version"]}, 200)
	for _, table := range []string{"link_tasks", "link_task_runs", "link_task_events", "link_memory", "link_memory_versions", "execution_sessions", "native_activity"} {
		var count int
		if err := f.s.Pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("coordination fixture not removed from %s", table)
		}
	}
	var artifacts int
	if err := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM link_artifacts WHERE project_id='isolated'`).Scan(&artifacts); err != nil || artifacts != 1 {
		t.Fatal("unrelated artifact not preserved")
	}
}
