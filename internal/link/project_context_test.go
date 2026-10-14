package link

import "testing"

func TestProjectContextPreviewIsUTF8Bounded(t *testing.T) {
	input := "🙂" + string(make([]byte, 300))
	preview := projectContextPreview(input)
	if len([]byte(preview)) > 256 || preview[:4] != "🙂" {
		t.Fatal("project context preview is not UTF-8 safe and byte bounded")
	}
	if projectContextPreview("short") != "short" {
		t.Fatal("short preview changed")
	}
}

func TestProjectContextAggregatesAndUpdatesWithCAS(t *testing.T) {
	f := newFixture(t)
	viewerRevision := workspaceTestRevision(t, f, "viewer-pilot")
	isolatedRevision := workspaceTestRevision(t, f, "deny-pilot")
	f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", map[string]any{"client_id": "context-note", "title": "Decision", "body": "Use the shared contract"}, 201)
	f.expect("POST", "/v1/projects/pilot/memory", "claude-pilot", map[string]any{"client_id": "context-memory", "title": "Architecture", "body": "Bounded context"}, 201)
	f.expect("POST", "/v1/projects/pilot/tasks", "claude-pilot", map[string]any{"client_id": "context-task", "title": "Implement context", "owner_id": "claude-pilot", "reviewer_id": "codex-pilot", "scope": []string{"context"}, "acceptance": []string{"visible"}}, 201)

	initial := f.expect("GET", "/v1/projects/pilot/context", "viewer-pilot", nil, 200)
	project := initial["project"].(map[string]any)
	if project["context_version"] != float64(1) || initial["can_write"] != false || len(initial["tasks"].([]any)) != 1 || len(initial["memory"].([]any)) != 1 || len(initial["notes"].([]any)) != 1 {
		t.Fatal("initial project context is incomplete")
	}
	body := map[string]any{"client_id": "brief-1", "expected_version": 1, "objective": "Ship reliable coordination", "working_context": "Current milestone: project briefing", "agent_instructions": "Read addressed messages before acting"}
	updated := f.expect("PUT", "/v1/projects/pilot/context", "codex-pilot", body, 200)["project"].(map[string]any)
	if updated["context_version"] != float64(2) || updated["objective"] != body["objective"] || updated["working_context"] != body["working_context"] || updated["agent_instructions"] != body["agent_instructions"] {
		t.Fatal("updated project context did not round trip")
	}
	workspaceExpectChanged(t, viewerRevision, workspaceTestRevision(t, f, "viewer-pilot"), "visible project context")
	workspaceExpectSame(t, isolatedRevision, workspaceTestRevision(t, f, "deny-pilot"), "hidden project context")
	replayed := f.expect("PUT", "/v1/projects/pilot/context", "codex-pilot", body, 200)
	if replayed["replayed"] != true || replayed["project"].(map[string]any)["context_version"] != float64(2) {
		t.Fatal("identical project context retry was not replayed")
	}
	conflict := map[string]any{"client_id": "brief-1", "expected_version": 2, "objective": "different", "working_context": "", "agent_instructions": ""}
	f.expect("PUT", "/v1/projects/pilot/context", "codex-pilot", conflict, 409)
	f.expect("PUT", "/v1/projects/pilot/context", "claude-pilot", body, 409)
	f.expect("PUT", "/v1/projects/pilot/context", "viewer-pilot", map[string]any{"client_id": "brief-viewer", "expected_version": 2, "objective": "x", "working_context": "", "agent_instructions": ""}, 403)
	f.expect("GET", "/v1/projects/isolated/context", "viewer-pilot", nil, 404)
}

func TestProjectContextRejectsInvalidAndIsBounded(t *testing.T) {
	f := newFixture(t)
	for _, body := range []map[string]any{
		{"client_id": "invalid-1", "expected_version": 0, "objective": "x", "working_context": "", "agent_instructions": ""},
		{"client_id": "invalid-2", "expected_version": 1, "objective": string(make([]byte, 4001)), "working_context": "", "agent_instructions": ""},
	} {
		f.expect("PUT", "/v1/projects/pilot/context", "codex-pilot", body, 400)
	}
}
