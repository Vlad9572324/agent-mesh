package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"agent-link/internal/link"
)

func TestOnboardingConnectorIdentityMatchesServerBuild(t *testing.T) {
	oldVersion, oldCommit := version, commit
	t.Cleanup(func() { version, commit = oldVersion, oldCommit })
	cert, key, _ := onboardingCertificate(t, false)
	for _, tc := range []struct{ name, version, commit string }{
		{"development", "dev", "unknown"},
		{"stamped", "v1.2.3-fixture.4", strings.Repeat("a", 40)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			version, commit = tc.version, tc.commit
			var serverJSON bytes.Buffer
			if err := writeVersion(&serverJSON); err != nil {
				t.Fatal(err)
			}
			var serverBuild buildInformation
			if err := json.Unmarshal(serverJSON.Bytes(), &serverBuild); err != nil {
				t.Fatal(err)
			}
			cfg, err := loadOnboarding("https://127.0.0.1:8766", cert, "https://github.com/example/mesh", cert, key)
			if err != nil {
				t.Fatal(err)
			}
			// The configured package factory captures this binary's stamp, rather
			// than deriving provenance from request input or mutable external files.
			version, commit = "dev", "unknown"
			body, err := cfg.Package(context.Background(), link.OnboardingPackage{
				AgentID: "agent-fixture", ProjectID: "project-fixture", ChannelIDs: []string{"coordination"},
				Runtime: "auto", ServiceKey: strings.Repeat("e", 64), Origin: cfg.Origin,
				SPKIPin: cfg.SPKIPin, Repository: cfg.Repository, CertificateCA: cfg.CertificateCA,
			})
			if err != nil {
				t.Fatal(err)
			}
			compressed, err := gzip.NewReader(bytes.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			defer compressed.Close()
			archive := tar.NewReader(compressed)
			found := false
			for {
				header, err := archive.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				if header.Name != "connectors/RELEASE.json" {
					continue
				}
				if found || header.Typeflag != tar.TypeReg || header.Mode != 0600 || header.Size > 32768 {
					t.Fatal("invalid connector metadata archive entry")
				}
				found = true
				var metadata map[string]string
				if err := json.NewDecoder(archive).Decode(&metadata); err != nil {
					t.Fatal(err)
				}
				if len(metadata) != 2 || metadata["version"] != serverBuild.Version || metadata["source_commit"] != serverBuild.Commit {
					t.Fatalf("connector/server source mismatch: %v", metadata)
				}
			}
			if !found {
				t.Fatal("connector metadata missing from generated package")
			}
		})
	}
}
