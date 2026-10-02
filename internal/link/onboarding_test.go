package link

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func onboardingConfig(t *testing.T) *OnboardingConfig {
	t.Helper()
	tlsServer := httptest.NewTLSServer(http.NotFoundHandler())
	defer tlsServer.Close()
	return &OnboardingConfig{Origin: "https://mesh.example.test:8766", SPKIPin: "sha256//" + base64.StdEncoding.EncodeToString(make([]byte, 32)), Repository: "https://github.com/Vlad9572324/agent-mesh", CertificateCA: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: tlsServer.Certificate().Raw}), Installer: []byte("#!/bin/sh\nexit 0\n"), Package: func(_ context.Context, p OnboardingPackage) ([]byte, error) {
		data, err := json.Marshal(p)
		if err != nil {
			return nil, err
		}
		var out bytes.Buffer
		gz := gzip.NewWriter(&out)
		tw := tar.NewWriter(gz)
		if err = tw.WriteHeader(&tar.Header{Name: "fixture.json", Mode: 0600, Size: int64(len(data))}); err != nil {
			return nil, err
		}
		if _, err = tw.Write(data); err != nil {
			return nil, err
		}
		if err = tw.Close(); err != nil {
			return nil, err
		}
		if err = gz.Close(); err != nil {
			return nil, err
		}
		return out.Bytes(), nil
	}}
}
func onboardingFixture(t *testing.T) (*fixture, *OnboardingConfig) {
	f := newFixture(t)
	f.owner("owner")
	cfg := onboardingConfig(t)
	f.server.Close()
	f.server = httptest.NewServer((&Server{Store: f.s, Onboarding: cfg}).Handler())
	t.Cleanup(f.server.Close)
	return f, cfg
}
func onboardingInput(id string) map[string]any {
	return map[string]any{"id": id, "name": "New communication agent", "project_id": "pilot", "channel_ids": []string{"general"}, "runtime": "auto", "expires_in_hours": 12}
}
func invite(t *testing.T, f *fixture, id string) (string, string) {
	t.Helper()
	result := f.expect("POST", "/v1/admin/onboarding", "owner", onboardingInput(id), 201)
	return result["invitation"].(map[string]any)["id"].(string), result["token"].(string)
}

type download struct {
	status int
	body   []byte
	header http.Header
	err    error
}

func redeem(f *fixture, token string) download {
	data, _ := json.Marshal(map[string]string{"token": token})
	req, err := http.NewRequest("POST", f.server.URL+"/connect/redeem", bytes.NewReader(data))
	if err != nil {
		return download{err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := f.server.Client().Do(req)
	if err != nil {
		return download{err: err}
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	return download{res.StatusCode, body, res.Header, err}
}
func unpackOnboarding(t *testing.T, res download) OnboardingPackage {
	t.Helper()
	if res.err != nil || res.status != 200 {
		t.Fatalf("redemption failed: status %d error %v", res.status, res.err)
	}
	if res.header.Get("Content-Type") != "application/gzip" || res.header.Get("Cache-Control") != "no-store" || res.header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("unsafe download headers")
	}
	gz, err := gzip.NewReader(bytes.NewReader(res.body))
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	if _, err = tr.Next(); err != nil {
		t.Fatal(err)
	}
	var p OnboardingPackage
	if err = json.NewDecoder(tr).Decode(&p); err != nil {
		t.Fatal(err)
	}
	return p
}
func expectRedemption(t *testing.T, f *fixture, token string, status int) {
	t.Helper()
	res := redeem(f, token)
	if res.err != nil || res.status != status {
		t.Fatalf("redemption status %d want %d error %v", res.status, status, res.err)
	}
}
func assertInactive(t *testing.T, f *fixture, agent string) {
	t.Helper()
	var inactive bool
	if err := f.s.Pool.QueryRow(context.Background(), "SELECT key_hash IS NULL FROM principals WHERE id=$1", agent).Scan(&inactive); err != nil || !inactive {
		t.Fatal("invited agent must remain inactive")
	}
}

func TestOnboardingOnceOnlyScopedKeyAndSanitizedMetadata(t *testing.T) {
	f, cfg := onboardingFixture(t)
	id, token := invite(t, f, "new-agent")
	assertInactive(t, f, "new-agent")
	list := f.expect("GET", "/v1/admin/onboarding", "owner", nil, 200)
	if list["enabled"] != true || list["public_url"] != cfg.Origin || len(list["invitations"].([]any)) != 1 {
		t.Fatal("invalid onboarding metadata")
	}
	var stored []byte
	if err := f.s.Pool.QueryRow(context.Background(), "SELECT token_hash FROM onboarding_invitations WHERE id=$1", id).Scan(&stored); err != nil || !bytes.Equal(stored, digest(token)) {
		t.Fatal("invitation must persist only its digest")
	}
	p := unpackOnboarding(t, redeem(f, token))
	if p.AgentID != "new-agent" || p.ProjectID != "pilot" || p.Runtime != "auto" || p.Origin != cfg.Origin || p.SPKIPin != cfg.SPKIPin || len(p.ChannelIDs) != 1 || p.ChannelIDs[0] != "general" || len(p.ServiceKey) != 64 {
		t.Fatal("wrong package scope or trust")
	}
	f.keys[p.AgentID] = p.ServiceKey
	f.expect("GET", "/v1/me", p.AgentID, nil, 200)
	f.expect("GET", "/v1/channels/general/messages", p.AgentID, nil, 200)
	f.expect("GET", "/v1/channels/isolated/messages", p.AgentID, nil, 404)
	f.expect("GET", "/v1/admin/onboarding", p.AgentID, nil, 403)
	expectRedemption(t, f, token, 410)
	expectRedemption(t, f, strings.Repeat("0", 64), 410)
	f.expect("POST", "/v1/admin/onboarding/"+id+"/reissue", "owner", map[string]any{"expires_in_hours": 1}, 409)
	f.expect("POST", "/v1/admin/onboarding/"+id+"/revoke", "owner", map[string]any{}, 409)
	for _, path := range []string{"/v1/admin/onboarding", "/v1/admin/audit", "/v1/admin/overview"} {
		result := f.expect("GET", path, "owner", nil, 200)
		data, _ := json.Marshal(result)
		if bytes.Contains(data, []byte(token)) || bytes.Contains(data, []byte(p.ServiceKey)) || bytes.Contains(data, []byte("token_hash")) {
			t.Fatal("metadata or audit leaked a credential")
		}
	}
	var keys, claims int
	if err := f.s.Pool.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM principals WHERE id=$1 AND key_hash=$2),(SELECT count(*) FROM admin_audit WHERE action='onboarding.claim' AND target_id=$3)", p.AgentID, digest(p.ServiceKey), id).Scan(&keys, &claims); err != nil || keys != 1 || claims != 1 {
		t.Fatal("missing atomic claim audit/key")
	}
}

func TestOnboardingConcurrentRedeemAndRevoke(t *testing.T) {
	f, cfg := onboardingFixture(t)
	var packages atomic.Int32
	build := cfg.Package
	cfg.Package = func(ctx context.Context, p OnboardingPackage) ([]byte, error) { packages.Add(1); return build(ctx, p) }
	_, token := invite(t, f, "race-agent")
	results := make(chan download, 2)
	start := make(chan struct{})
	for n := 0; n < 2; n++ {
		go func() { <-start; results <- redeem(f, token) }()
	}
	close(start)
	successes, unavailable := 0, 0
	for n := 0; n < 2; n++ {
		res := <-results
		if res.err != nil {
			t.Fatal(res.err)
		}
		switch res.status {
		case 200:
			successes++
			unpackOnboarding(t, res)
		case 410:
			unavailable++
		default:
			t.Fatalf("unexpected status %d", res.status)
		}
	}
	if successes != 1 || unavailable != 1 || packages.Load() != 1 {
		t.Fatal("redemption was not exactly once")
	}
	id, token := invite(t, f, "revoked-agent")
	f.expect("POST", "/v1/admin/onboarding/"+id+"/revoke", "owner", map[string]any{}, 200)
	f.expect("POST", "/v1/admin/onboarding/"+id+"/revoke", "owner", map[string]any{}, 200)
	expectRedemption(t, f, token, 410)
	assertInactive(t, f, "revoked-agent")
}

func TestOnboardingPackageFailureAndAuditFailureRollBack(t *testing.T) {
	f, cfg := onboardingFixture(t)
	id, token := invite(t, f, "retry-agent")
	build := cfg.Package
	for _, bad := range []func(context.Context, OnboardingPackage) ([]byte, error){func(context.Context, OnboardingPackage) ([]byte, error) { return nil, errors.New("fixture failure") }, func(context.Context, OnboardingPackage) ([]byte, error) { return make([]byte, (16<<20)+1), nil }} {
		cfg.Package = bad
		expectRedemption(t, f, token, 503)
		assertInactive(t, f, "retry-agent")
	}
	cfg.Package = build
	ctx := context.Background()
	if _, err := f.s.Pool.Exec(ctx, `CREATE FUNCTION fail_onboarding_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='onboarding.claim' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_onboarding_audit BEFORE INSERT ON admin_audit FOR EACH ROW EXECUTE FUNCTION fail_onboarding_audit()`); err != nil {
		t.Fatal(err)
	}
	expectRedemption(t, f, token, 500)
	assertInactive(t, f, "retry-agent")
	var claimed bool
	if err := f.s.Pool.QueryRow(ctx, "SELECT claimed_at IS NOT NULL FROM onboarding_invitations WHERE id=$1", id).Scan(&claimed); err != nil || claimed {
		t.Fatal("failed redemption consumed invitation")
	}
	if _, err := f.s.Pool.Exec(ctx, "DROP TRIGGER fail_onboarding_audit ON admin_audit"); err != nil {
		t.Fatal(err)
	}
	unpackOnboarding(t, redeem(f, token))
}

func TestOnboardingExpiredAndReissueRecovery(t *testing.T) {
	f, _ := onboardingFixture(t)
	id, token := invite(t, f, "expired-agent")
	ctx := context.Background()
	if _, err := f.s.Pool.Exec(ctx, "UPDATE onboarding_invitations SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1", id); err != nil {
		t.Fatal(err)
	}
	expectRedemption(t, f, token, 410)
	result := f.expect("POST", "/v1/admin/onboarding/"+id+"/reissue", "owner", map[string]any{"expires_in_hours": 1}, 201)
	replacement := result["token"].(string)
	replacementID := result["invitation"].(map[string]any)["id"].(string)
	if replacement == token || replacementID == id {
		t.Fatal("reissue reused capability")
	}
	expectRedemption(t, f, token, 410)
	unpackOnboarding(t, redeem(f, replacement))
	f.expect("POST", "/v1/admin/onboarding/"+replacementID+"/reissue", "owner", map[string]any{"expires_in_hours": 24}, 409)
	f.expect("POST", "/v1/admin/principals/expired-agent/revoke-key", "owner", map[string]any{}, 200)
	recovered := f.expect("POST", "/v1/admin/onboarding/"+replacementID+"/reissue", "owner", map[string]any{"expires_in_hours": 24}, 201)
	unpackOnboarding(t, redeem(f, recovered["token"].(string)))
}

func TestOnboardingRevalidatesACLAndLifecycle(t *testing.T) {
	for _, change := range []string{"project-read", "project-none", "channel-read", "channel-none", "archived"} {
		t.Run(change, func(t *testing.T) {
			f, _ := onboardingFixture(t)
			id, token := invite(t, f, "changed-agent")
			switch change {
			case "project-read":
				f.access("changed-agent", "project", "pilot", "read", 200)
			case "project-none":
				f.access("changed-agent", "project", "pilot", "none", 200)
			case "channel-read":
				f.access("changed-agent", "channel", "general", "read", 200)
			case "channel-none":
				f.access("changed-agent", "channel", "general", "none", 200)
			case "archived":
				f.expect("POST", "/v1/admin/projects/pilot/archive", "owner", map[string]any{}, 200)
			}
			expectRedemption(t, f, token, 410)
			assertInactive(t, f, "changed-agent")
			f.expect("POST", "/v1/admin/onboarding/"+id+"/reissue", "owner", map[string]any{"expires_in_hours": 12}, 409)
		})
	}
}

func TestOnboardingKeyManagementInvalidatesPendingInvitations(t *testing.T) {
	for _, method := range []string{"admin-revoke", "admin-rotate", "cli-revoke", "cli-rotate"} {
		t.Run(method, func(t *testing.T) {
			f, _ := onboardingFixture(t)
			id, token := invite(t, f, "managed-agent")
			var err error
			switch method {
			case "admin-revoke":
				f.expect("POST", "/v1/admin/principals/managed-agent/revoke-key", "owner", map[string]any{}, 200)
			case "admin-rotate":
				f.expect("POST", "/v1/admin/principals/managed-agent/rotate-key", "owner", map[string]any{}, 200)
			case "cli-revoke":
				err = f.s.Revoke(context.Background(), "managed-agent")
			case "cli-rotate":
				err = f.s.Rotate(context.Background(), "managed-agent", filepath.Join(t.TempDir(), "key.json"))
			}
			if err != nil {
				t.Fatal(err)
			}
			expectRedemption(t, f, token, 410)
			var revoked bool
			if err = f.s.Pool.QueryRow(context.Background(), "SELECT revoked_at IS NOT NULL FROM onboarding_invitations WHERE id=$1", id).Scan(&revoked); err != nil || !revoked {
				t.Fatal("key management left live invitation")
			}
			if strings.HasSuffix(method, "rotate") {
				f.expect("POST", "/v1/admin/onboarding/"+id+"/reissue", "owner", map[string]any{"expires_in_hours": 12}, 409)
			} else {
				assertInactive(t, f, "managed-agent")
			}
		})
	}
}

func TestOnboardingAuthorizationValidationAndTrustedOrigin(t *testing.T) {
	f, cfg := onboardingFixture(t)
	for _, who := range []string{"claude-pilot", "viewer-pilot"} {
		f.expect("GET", "/v1/admin/onboarding", who, nil, 403)
		f.expect("POST", "/v1/admin/onboarding", who, onboardingInput("forbidden-agent"), 403)
		f.expect("POST", "/v1/admin/onboarding/missing/reissue", who, map[string]any{"expires_in_hours": 1}, 403)
		f.expect("POST", "/v1/admin/onboarding/missing/revoke", who, map[string]any{}, 403)
	}
	f.expect("GET", "/v1/admin/onboarding", "", nil, 401)
	for _, change := range []func(map[string]any){func(v map[string]any) { v["runtime"] = "shell" }, func(v map[string]any) { v["expires_in_hours"] = 2 }, func(v map[string]any) { v["channel_ids"] = []string{"general", "general"} }, func(v map[string]any) { v["channel_ids"] = []string{} }, func(v map[string]any) { v["channel_ids"] = []string{"a", "b", "c", "d", "e", "f", "g", "h", "i"} }, func(v map[string]any) { v["unexpected"] = true }} {
		in := onboardingInput("invalid-agent")
		change(in)
		f.expect("POST", "/v1/admin/onboarding", "owner", in, 400)
	}
	in := onboardingInput("cross-project-agent")
	in["channel_ids"] = []string{"isolated"}
	f.expect("POST", "/v1/admin/onboarding", "owner", in, 404)
	var agents int
	if err := f.s.Pool.QueryRow(context.Background(), "SELECT count(*) FROM principals WHERE id IN ('forbidden-agent','invalid-agent','cross-project-agent')").Scan(&agents); err != nil || agents != 0 {
		t.Fatal("invalid requests created state")
	}
	invite(t, f, "duplicate-agent")
	f.expect("POST", "/v1/admin/onboarding", "owner", onboardingInput("duplicate-agent"), 409)
	req, _ := http.NewRequest("GET", f.server.URL+"/v1/admin/onboarding", nil)
	req.Host = "evil.invalid"
	req.Header.Set("Forwarded", "host=evil.invalid;proto=http")
	req.Header.Set("Authorization", "Bearer "+f.keys["owner"])
	res, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Contains(data, []byte(cfg.Origin)) || bytes.Contains(data, []byte("evil.invalid")) {
		t.Fatal("metadata trusted request origin")
	}
	res, err = f.server.Client().Get(f.server.URL + "/connect/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	data, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Equal(data, cfg.Installer) {
		t.Fatal("installer unavailable")
	}
	f.expect("GET", "/connect/install.sh?token=forbidden", "", nil, 400)
	f.expect("POST", "/connect/redeem?token=forbidden", "", map[string]any{"token": strings.Repeat("0", 64)}, 400)
	expectRedemption(t, f, "bad-token", 400)
	cfg.Origin = ""
	f.expect("GET", "/v1/admin/onboarding", "owner", nil, 200)
	f.expect("POST", "/v1/admin/onboarding", "owner", onboardingInput("disabled-agent"), 503)
	f.expect("GET", "/connect/install.sh", "", nil, 503)
	expectRedemption(t, f, strings.Repeat("0", 64), 503)
}

func TestOnboardingMigrationAndProjectDeletion(t *testing.T) {
	f, _ := onboardingFixture(t)
	ctx := context.Background()
	f.message("onboarding-migration-message", "claude-pilot")
	var before string
	snapshot := `SELECT json_build_object('principals',(SELECT json_agg(p ORDER BY id) FROM principals p),'messages',(SELECT json_agg(m ORDER BY id) FROM messages m),'events',(SELECT json_agg(e ORDER BY channel_id,seq) FROM events e))::text`
	if err := f.s.Pool.QueryRow(ctx, snapshot).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Pool.Exec(ctx, "DROP TABLE onboarding_invitations"); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		if err := f.s.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var after string
	if err := f.s.Pool.QueryRow(ctx, snapshot).Scan(&after); err != nil || before != after {
		t.Fatal("onboarding migration changed existing state")
	}
	_, token := invite(t, f, "deleted-project-agent")
	if err := f.s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	preview := f.expect("GET", "/v1/admin/projects/pilot/deletion-preview", "owner", nil, 200)
	if preview["counts"].(map[string]any)["onboarding_invitations"] != float64(1) {
		t.Fatal("deletion preview omitted invitations")
	}
	f.expect("POST", "/v1/admin/projects/pilot/archive", "owner", map[string]any{}, 200)
	f.expect("DELETE", "/v1/admin/projects/pilot", "owner", map[string]any{"confirm_id": "pilot", "expected_version": 1}, 200)
	expectRedemption(t, f, token, 410)
	assertInactive(t, f, "deleted-project-agent")
	var count int
	if err := f.s.Pool.QueryRow(ctx, "SELECT count(*) FROM onboarding_invitations").Scan(&count); err != nil || count != 0 {
		t.Fatal("project deletion left invitation capability")
	}
}

func TestOnboardingExpiryDuringPackaging(t *testing.T) {
	f, cfg := onboardingFixture(t)
	id, token := invite(t, f, "late-agent")
	build := cfg.Package
	if _, err := f.s.Pool.Exec(context.Background(), "UPDATE onboarding_invitations SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=$1", id); err != nil {
		t.Fatal(err)
	}
	cfg.Package = func(ctx context.Context, p OnboardingPackage) ([]byte, error) {
		time.Sleep(400 * time.Millisecond)
		return build(ctx, p)
	}
	expectRedemption(t, f, token, 410)
	assertInactive(t, f, "late-agent")
}

func TestOnboardingConfigurationValidation(t *testing.T) {
	cfg := onboardingConfig(t)
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	for n, change := range []func(*OnboardingConfig){func(c *OnboardingConfig) { c.Origin = "http://mesh.test" }, func(c *OnboardingConfig) { c.Origin = "https://mesh.test/" }, func(c *OnboardingConfig) { c.Origin = "https://user@mesh.test" }, func(c *OnboardingConfig) { c.Origin = "https://mesh.test?redirect=evil" }, func(c *OnboardingConfig) { c.Origin = "https://mesh.test:65536" }, func(c *OnboardingConfig) { c.SPKIPin = "sha256//bad" }, func(c *OnboardingConfig) { c.CertificateCA = []byte("invalid") }, func(c *OnboardingConfig) { c.Repository = "http://repo.test" }, func(c *OnboardingConfig) {
		c.CertificateCA = append(append([]byte{}, c.CertificateCA...), []byte("-----BEGIN "+"PRIVATE KEY-----\nprivate\n-----END "+"PRIVATE KEY-----\n")...)
	}, func(c *OnboardingConfig) { c.CertificateCA = append([]byte("unexpected text\n"), c.CertificateCA...) }, func(c *OnboardingConfig) {
		c.CertificateCA = append(append([]byte{}, c.CertificateCA...), []byte("trailing text")...)
	}, func(c *OnboardingConfig) { c.Origin = "https://" + strings.Repeat("a", 2048) }, func(c *OnboardingConfig) { c.Package = nil }, func(c *OnboardingConfig) { c.Installer = nil }} {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			copy := *cfg
			change(&copy)
			if copy.Validate() == nil {
				t.Fatal("invalid onboarding configuration accepted")
			}
		})
	}
}

func TestOnboardingCreateAndReissueAuditFailureIsAtomic(t *testing.T) {
	f, _ := onboardingFixture(t)
	ctx := context.Background()
	if _, err := f.s.Pool.Exec(ctx, `CREATE FUNCTION reject_invitation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('onboarding.create','onboarding.reissue') THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`); err != nil {
		t.Fatal(err)
	}
	reject := func() {
		t.Helper()
		if _, err := f.s.Pool.Exec(ctx, "CREATE TRIGGER reject_invitation_audit BEFORE INSERT ON admin_audit FOR EACH ROW EXECUTE FUNCTION reject_invitation_audit()"); err != nil {
			t.Fatal(err)
		}
	}
	allow := func() {
		t.Helper()
		if _, err := f.s.Pool.Exec(ctx, "DROP TRIGGER reject_invitation_audit ON admin_audit"); err != nil {
			t.Fatal(err)
		}
	}
	reject()
	f.expect("POST", "/v1/admin/onboarding", "owner", onboardingInput("atomic-agent"), 500)
	var count int
	if err := f.s.Pool.QueryRow(ctx, "SELECT count(*) FROM principals WHERE id='atomic-agent'").Scan(&count); err != nil || count != 0 {
		t.Fatal("failed creation left an agent")
	}
	allow()
	id, token := invite(t, f, "atomic-agent")
	reject()
	f.expect("POST", "/v1/admin/onboarding/"+id+"/reissue", "owner", map[string]any{"expires_in_hours": 1}, 500)
	allow()
	if err := f.s.Pool.QueryRow(ctx, "SELECT count(*) FROM onboarding_invitations WHERE agent_id='atomic-agent' AND claimed_at IS NULL AND revoked_at IS NULL").Scan(&count); err != nil || count != 1 {
		t.Fatal("failed reissue changed invitation state")
	}
	unpackOnboarding(t, redeem(f, token))
}

func TestOnboardingKeyRevokeWaitsForInFlightRedemption(t *testing.T) {
	f, cfg := onboardingFixture(t)
	_, token := invite(t, f, "ordered-agent")
	build := cfg.Package
	entered, release := make(chan struct{}), make(chan struct{})
	cfg.Package = func(ctx context.Context, p OnboardingPackage) ([]byte, error) {
		close(entered)
		select {
		case <-release:
			return build(ctx, p)
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	claimed := make(chan download, 1)
	go func() { claimed <- redeem(f, token) }()
	<-entered
	requested := make(chan struct{})
	revoked := make(chan download, 1)
	go func() {
		req, _ := http.NewRequest("POST", f.server.URL+"/v1/admin/principals/ordered-agent/revoke-key", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+f.keys["owner"])
		close(requested)
		res, err := f.server.Client().Do(req)
		if err != nil {
			revoked <- download{err: err}
			return
		}
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		revoked <- download{status: res.StatusCode, body: body, err: err}
	}()
	<-requested
	close(release)
	p := unpackOnboarding(t, <-claimed)
	res := <-revoked
	if res.err != nil || res.status != 200 {
		t.Fatal("key revocation did not serialize after redemption")
	}
	assertInactive(t, f, "ordered-agent")
	f.keys["ordered-agent"] = p.ServiceKey
	f.expect("GET", "/v1/me", "ordered-agent", nil, 401)
	expectRedemption(t, f, token, 410)
}
