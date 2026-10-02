package link

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// This exercises the Python listener against the real HTTP routes and an
// isolated PostgreSQL schema. The only injected component is a deterministic
// local file writer: this test never launches a model or touches a live Mesh.
func TestTaskListenerRealHTTPDurableHandoff(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not installed; Python listener integration test skipped")
	}
	f := newFixture(t)
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal("cannot locate test repository")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, python, "-B", filepath.Join(root, "tests", "task_listener_integration.py"),
		"--origin", f.server.URL, "--credentials", f.credentials, "--directory", t.TempDir(), "--repo", root)
	command.Dir = root
	output, runErr := command.CombinedOutput()
	// A failed test must never put bootstrap credentials in CI output, even if a
	// future client changes its exception formatting.
	for _, key := range f.keys {
		output = bytes.ReplaceAll(output, []byte(key), []byte("[redacted]"))
	}
	if runErr != nil {
		t.Fatalf("listener HTTP integration failed (%v): %s", runErr, output)
	}
	var result struct {
		Success     bool   `json:"success"`
		RunnerCalls int    `json:"runner_calls"`
		TaskID      string `json:"task_id"`
		State       string `json:"state"`
	}
	if json.Unmarshal(output, &result) != nil || !result.Success || result.RunnerCalls != 1 || result.TaskID == "" || result.State != "review_pending" {
		t.Fatalf("invalid listener integration result: %s", output)
	}
	// Check persisted state independently of the Python listener's reports.
	var runs, events, completions int
	err = f.s.Pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM link_task_runs WHERE task_id=$1),
		(SELECT count(*) FROM link_task_events WHERE task_id=$1),
		(SELECT count(*) FROM link_task_events WHERE task_id=$1 AND type='completion_reported')`, result.TaskID).Scan(&runs, &events, &completions)
	if err != nil || runs != 1 || events != 3 || completions != 0 {
		t.Fatalf("listener did not persist one run and the three handoff events: runs=%d events=%d completions=%d query_failed=%t", runs, events, completions, err != nil)
	}
}
