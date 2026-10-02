package link

import (
	"context"
	"fmt"
	"sync"
	"testing"
)

func memoryTestCreate(f *fixture, client string) map[string]any {
	f.t.Helper()
	return f.expect("POST", "/v1/projects/pilot/memory", "codex-pilot", map[string]any{"client_id": client, "title": "Shared context", "body": "Original project-wide context"}, 201)["memory"].(map[string]any)
}

func TestMemoryVersionHistoryCASAndOriginalReplay(t *testing.T) {
	f := newFixture(t)
	initial := memoryTestCreate(f, "memory-1")
	path := "/v1/projects/pilot/memory/" + initial["id"].(string)
	secondInput := map[string]any{"client_id": "memory-update-1", "expected_version": 1, "title": "Updated context", "body": "Independent contributor revision"}
	second := f.expect("PUT", path, "claude-pilot", secondInput, 200)["memory"].(map[string]any)
	if second["version"] != float64(2) || second["author_id"] != "codex-pilot" || second["updated_by"] != "claude-pilot" {
		t.Fatal("version attribution lost")
	}
	f.expect("PUT", path, "codex-pilot", map[string]any{"client_id": "stale", "expected_version": 1, "title": "Stale", "body": "Must not overwrite"}, 409)
	third := f.expect("PUT", path, "codex-pilot", map[string]any{"client_id": "memory-update-2", "expected_version": 2, "title": "Third", "body": "Latest context"}, 200)["memory"].(map[string]any)
	if third["version"] != float64(3) {
		t.Fatal("revision did not increment")
	}
	replayed := f.expect("PUT", path, "claude-pilot", secondInput, 200)
	if replayed["replayed"] != true || replayed["memory"].(map[string]any)["version"] != float64(2) {
		t.Fatal("update replay must return original accepted revision")
	}
	replayed = f.expect("POST", "/v1/projects/pilot/memory", "codex-pilot", map[string]any{"client_id": "memory-1", "title": "Shared context", "body": "Original project-wide context"}, 200)
	if replayed["memory"].(map[string]any)["version"] != float64(1) {
		t.Fatal("creation replay replaced original version")
	}
	detail := f.expect("GET", path, "viewer-pilot", nil, 200)
	if detail["memory"].(map[string]any)["body"] != "Latest context" || detail["can_write"] != false {
		t.Fatal("replay changed current revision or capabilities")
	}
	versions := detail["versions"].([]any)
	if len(versions) != 3 {
		t.Fatal("immutable history missing")
	}
	for i, value := range versions {
		if value.(map[string]any)["version"] != float64(3-i) {
			t.Fatal("history not ordered by descending revision")
		}
	}
	page := f.expect("GET", path+"?before_version=3", "viewer-pilot", nil, 200)
	if len(page["versions"].([]any)) != 2 {
		t.Fatal("history cursor did not filter versions")
	}
	secondInput["body"] = "Different payload"
	f.expect("PUT", path, "claude-pilot", secondInput, 409)
	other := memoryTestCreate(f, "memory-other")
	secondInput["body"] = "Independent contributor revision"
	f.expect("PUT", "/v1/projects/pilot/memory/"+other["id"].(string), "claude-pilot", secondInput, 409)
	f.expect("PUT", path, "codex-pilot", map[string]any{"client_id": "memory-1", "expected_version": 3, "title": "Conflicting operation", "body": "Create client cannot update"}, 409)
}

func TestMemoryACLArchiveAndLegacyNotesRemainSeparate(t *testing.T) {
	f := newFixture(t)
	f.owner("owner")
	memory := memoryTestCreate(f, "memory-1")
	path := "/v1/projects/pilot/memory/" + memory["id"].(string)
	for _, actor := range []string{"viewer-pilot", "owner"} {
		list := f.expect("GET", "/v1/projects/pilot/memory", actor, nil, 200)
		if list["can_write"] != false {
			t.Fatal("readonly principal advertised memory writes")
		}
		f.expect("POST", "/v1/projects/pilot/memory", actor, map[string]any{"client_id": "blocked", "title": "No", "body": "No"}, 403)
		f.expect("PUT", path, actor, map[string]any{"client_id": "blocked", "expected_version": 1, "title": "No", "body": "No"}, 403)
	}
	f.expect("GET", path, "deny-pilot", nil, 404)
	f.expect("GET", "/v1/projects/pilot/memory", "deny-pilot", nil, 404)
	f.expect("GET", "/v1/projects/isolated/memory/"+memory["id"].(string), "owner", nil, 404)
	legacy := f.expect("POST", "/v1/projects/pilot/notes", "codex-pilot", map[string]any{"client_id": "legacy", "title": "Immutable legacy", "body": "Do not revise"}, 201)["note"].(map[string]any)
	f.expect("POST", "/v1/admin/projects/pilot/archive", "owner", map[string]any{}, 200)
	f.expect("GET", path, "codex-pilot", nil, 404)
	f.expect("GET", path, "owner", nil, 200)
	f.expect("PUT", path, "codex-pilot", map[string]any{"client_id": "archived", "expected_version": 1, "title": "No", "body": "No"}, 404)
	f.expect("POST", "/v1/admin/projects/pilot/restore", "owner", map[string]any{}, 200)
	f.expect("PUT", path, "claude-pilot", map[string]any{"client_id": "restored", "expected_version": 1, "title": "Restored", "body": "Memory only"}, 200)
	notes := f.expect("GET", "/v1/projects/pilot/notes", "codex-pilot", nil, 200)["notes"].([]any)
	if len(notes) != 1 || notes[0].(map[string]any)["id"] != legacy["id"] || notes[0].(map[string]any)["body"] != "Do not revise" {
		t.Fatal("memory revisions mutated legacy notes")
	}
	f.access("claude-pilot", "project", "pilot", "read", 200)
	f.expect("PUT", path, "claude-pilot", map[string]any{"client_id": "no-longer-writer", "expected_version": 2, "title": "No", "body": "No"}, 404)
}

func TestMemoryConcurrentCASAndReplay(t *testing.T) {
	for _, same := range []bool{false, true} {
		t.Run(fmt.Sprintf("same_payload_%t", same), func(t *testing.T) {
			f := newFixture(t)
			memory := memoryTestCreate(f, "initial")
			path := "/v1/projects/pilot/memory/" + memory["id"].(string)
			var wg sync.WaitGroup
			results := make(chan map[string]any, 12)
			codes := make(chan int, 12)
			for i := 0; i < 12; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					client := "same"
					if !same {
						client = fmt.Sprintf("update-%d", i)
					}
					status, body := f.request("PUT", path, "claude-pilot", map[string]any{"client_id": client, "expected_version": 1, "title": "Concurrent", "body": "One new revision"})
					codes <- status
					results <- body
				}(i)
			}
			wg.Wait()
			close(codes)
			close(results)
			success, conflicts := 0, 0
			for status := range codes {
				if status == 200 {
					success++
				} else if status == 409 {
					conflicts++
				} else {
					t.Errorf("unexpected status %d", status)
				}
			}
			if (same && (success != 12 || conflicts != 0)) || (!same && (success != 1 || conflicts != 11)) {
				t.Fatal("CAS/replay did not serialize updates")
			}
			nonReplay := 0
			for body := range results {
				if body["replayed"] == false {
					nonReplay++
				}
			}
			if nonReplay != 1 {
				t.Fatal("multiple non-replayed writes")
			}
			var count int
			if err := f.s.Pool.QueryRow(context.Background(), `SELECT count(*) FROM link_memory_versions`).Scan(&count); err != nil || count != 2 {
				t.Fatal("concurrency inserted duplicate history")
			}
		})
	}
}

func TestMemoryHistoryFailureRollsBackAllChanges(t *testing.T) {
	f := newFixture(t)
	memory := memoryTestCreate(f, "initial")
	path := "/v1/projects/pilot/memory/" + memory["id"].(string)
	ctx := context.Background()
	_, err := f.s.Pool.Exec(ctx, `CREATE FUNCTION memory_history_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER fail_revision BEFORE INSERT ON link_memory_versions FOR EACH ROW EXECUTE FUNCTION memory_history_failure()`)
	if err != nil {
		t.Fatal(err)
	}
	in := map[string]any{"client_id": "revision", "expected_version": 1, "title": "Rejected revision", "body": "No partial write"}
	f.expect("PUT", path, "codex-pilot", in, 500)
	got := f.expect("GET", path, "codex-pilot", nil, 200)
	if got["memory"].(map[string]any)["version"] != float64(1) || got["memory"].(map[string]any)["title"] != "Shared context" || len(got["versions"].([]any)) != 1 {
		t.Fatal("history insertion failure left partial memory mutation")
	}
	f.expect("POST", "/v1/projects/pilot/memory", "codex-pilot", map[string]any{"client_id": "new-failure", "title": "Rejected new", "body": "No orphan"}, 500)
	var count int
	if err = f.s.Pool.QueryRow(ctx, `SELECT count(*) FROM link_memory`).Scan(&count); err != nil || count != 1 {
		t.Fatal("history failure left orphan memory record")
	}
	if _, err = f.s.Pool.Exec(ctx, `DROP TRIGGER fail_revision ON link_memory_versions`); err != nil {
		t.Fatal(err)
	}
	f.expect("PUT", path, "codex-pilot", in, 200)
}

func TestMemoryDetailSnapshotAndProjectScopeConstraint(t *testing.T) {
	f := newFixture(t)
	memory := memoryTestCreate(f, "snapshot-initial")
	id := memory["id"].(string)
	endpoint := "/v1/projects/pilot/memory/" + id
	done := make(chan struct{})
	failures := make(chan int, 1)
	go func() {
		defer close(done)
		for i := 0; i < 30; i++ {
			code, _ := f.request("PUT", endpoint, "claude-pilot", map[string]any{"client_id": fmt.Sprintf("snapshot-%d", i), "expected_version": i + 1, "title": "Consistent", "body": fmt.Sprintf("revision-%d", i+2)})
			if code != 200 {
				failures <- code
				return
			}
		}
	}()
	for i := 0; i < 45; i++ {
		out := f.expect("GET", endpoint, "viewer-pilot", nil, 200)
		current := out["memory"].(map[string]any)
		latest := out["versions"].([]any)[0].(map[string]any)
		if current["version"] != latest["version"] || current["body"] != latest["body"] {
			t.Error("memory detail mixed different committed snapshots")
			break
		}
	}
	<-done
	select {
	case status := <-failures:
		t.Fatalf("memory writer failed: %d", status)
	default:
	}
	if _, err := f.s.Pool.Exec(context.Background(), `UPDATE link_memory_versions SET project_id='isolated' WHERE memory_id=$1 AND version=1`, id); err == nil {
		t.Fatal("history linked to a different project")
	}
}
