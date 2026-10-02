package link

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// HTTP/1's socket deadline may be renewed before the next write. HTTP/2 has
// an active per-stream timer which resets the stream when that deadline expires,
// even if no write is in progress. Exercise the actual TLS HTTP/2 transport.
func TestWorkspaceHTTP2IdleKeepaliveChangeAndRevocation(t *testing.T) {
	f := newFixture(t)
	server := httptest.NewUnstartedServer((&Server{Store: f.s}).Handler())
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, "GET", server.URL+"/v1/workspace/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+f.keys["viewer-pilot"])
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatal("open HTTP/2 workspace stream:", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusOK || resp.ProtoMajor != 2 {
		t.Fatalf("expected real HTTP/2 SSE response; status=%d protocol=%s", resp.StatusCode, resp.Proto)
	}
	type frame struct {
		text string
		err  error
	}
	frames := make(chan frame, 8)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		var lines []string
		for scanner.Scan() {
			if scanner.Text() == "" {
				frames <- frame{text: strings.Join(lines, "\n")}
				lines = nil
			} else {
				lines = append(lines, scanner.Text())
			}
		}
		err := scanner.Err()
		if err == nil {
			err = io.EOF
		}
		frames <- frame{err: err}
	}()
	next := func(timeout time.Duration) frame {
		t.Helper()
		select {
		case result := <-frames:
			return result
		case <-time.After(timeout):
			t.Fatal("HTTP/2 workspace frame deadline exceeded")
			return frame{}
		}
	}
	revision := func(result frame) string {
		t.Helper()
		const prefix = "event: workspace\ndata: "
		if result.err != nil || !strings.HasPrefix(result.text, prefix) {
			t.Fatalf("expected workspace revision; frame=%q error=%v", result.text, result.err)
		}
		var payload map[string]string
		if json.Unmarshal([]byte(strings.TrimPrefix(result.text, prefix)), &payload) != nil || len(payload) != 1 || len(payload["revision"]) != 64 {
			t.Fatal("malformed workspace revision")
		}
		return payload["revision"]
	}
	initial := revision(next(3 * time.Second))
	idleStarted := time.Now()
	keepalive := next(14 * time.Second)
	if keepalive.err != nil || keepalive.text != ": keepalive" {
		t.Fatalf("idle HTTP/2 stream did not survive the 10-second write deadline: frame=%q error=%v", keepalive.text, keepalive.err)
	}
	if time.Since(idleStarted) < 9*time.Second {
		t.Fatal("keepalive arrived without exercising the idle deadline boundary")
	}

	// One stream, no reconnect: a visible publication still invalidates after idle.
	f.expect("POST", "/v1/projects/pilot/notes", "claude-pilot", map[string]any{
		"client_id": "http2-idle-note", "title": "After idle", "body": "Visible invalidation",
	}, 201)
	workspaceExpectChanged(t, initial, revision(next(3*time.Second)), "HTTP/2 publication after idle")
	if err := f.s.Revoke(context.Background(), "viewer-pilot"); err != nil {
		t.Fatal(err)
	}
	if closed := next(3 * time.Second); closed.err == nil {
		t.Fatalf("revoked idle HTTP/2 stream remained open: %q", closed.text)
	}
}
