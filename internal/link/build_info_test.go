package link

import (
	"net/http/httptest"
	"testing"
)

func TestAuthenticatedBuildIdentity(t *testing.T) {
	f := newFixture(t)
	f.server.Close()
	f.server = httptest.NewServer((&Server{Store: f.s, Build: BuildInformation{
		Version: "v0.2.0", SourceCommit: "abcdef0123456789abcdef0123456789abcdef0123", BuildDate: "2026-10-03T00:00:00Z",
	}}).Handler())
	t.Cleanup(f.server.Close)
	f.expect("GET", "/v1/me", "", nil, 401)
	for _, agent := range []string{"codex-pilot", "viewer-pilot"} {
		body := f.expect("GET", "/v1/me", agent, nil, 200)
		build, ok := body["server_build"].(map[string]any)
		if !ok || build["version"] != "v0.2.0" || build["source_commit"] != "abcdef0123456789abcdef0123456789abcdef0123" || build["build_date"] != "2026-10-03T00:00:00Z" {
			t.Fatal("authenticated server build was not preserved")
		}
		if body["agent"].(map[string]any)["id"] != agent {
			t.Fatal("build metadata changed principal identity")
		}
	}
}

func TestUnstampedBuildIdentityIsExplicit(t *testing.T) {
	info := (&Server{}).buildInformation()
	if info.Version != "dev" || info.SourceCommit != "unknown" || info.BuildDate != "unknown" {
		t.Fatal("unstamped build must not invent a release identity")
	}
}
