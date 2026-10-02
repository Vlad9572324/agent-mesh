// Package onboarding embeds reviewed connector sources for one-use invitations.
// It builds private packages in memory and never opens files or starts a model.
package onboarding

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"crypto/x509"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// These are actual repository sources, not a second vendored connector copy.
//
//go:embed onboarding/install.sh onboarding/install.py onboarding/connect.py onboarding/README.md onboarding/PROMPT.md
//go:embed scripts/agent-link-cli.py scripts/native_launch.py scripts/agent-link-hook.py scripts/agent-link-mcp.py
//go:embed adapters/native_bridge.py adapters/native_hooks.py adapters/native_mcp.py
//go:embed scripts/agent-link-listener.py adapters/task_listener.py adapters/coordination.py scripts/dev_trial_runtimes.py
//go:embed scripts/artifact_client.py scripts/agent-link-artifacts.py docs/task-listener.md listener-contract.json
//go:embed LICENSE NOTICE CLI-CONNECTION.md docs/third-party-notices.md
var assets embed.FS

var connectorFiles = []string{
	"scripts/agent-link-cli.py", "scripts/native_launch.py", "scripts/agent-link-hook.py", "scripts/agent-link-mcp.py",
	"adapters/native_bridge.py", "adapters/native_hooks.py", "adapters/native_mcp.py",
	"scripts/agent-link-listener.py", "adapters/task_listener.py", "adapters/coordination.py", "scripts/dev_trial_runtimes.py",
	"scripts/artifact_client.py", "scripts/agent-link-artifacts.py", "docs/task-listener.md", "listener-contract.json",
	"LICENSE", "NOTICE", "CLI-CONNECTION.md", "docs/third-party-notices.md",
}

// Spec is supplied only by the server's validated deployment configuration and
// locked invitation transaction. The fresh ServiceKey is never persisted here.
type Spec struct {
	AgentID, ProjectID                               string
	ChannelIDs                                       []string
	Runtime, ServiceKey, Origin, SPKIPin, Repository string
	CertificateCA                                    []byte
}

var identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)
var keyPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func validSpec(s Spec) bool {
	if !identifier.MatchString(s.AgentID) || !identifier.MatchString(s.ProjectID) || !keyPattern.MatchString(s.ServiceKey) ||
		(s.Runtime != "auto" && s.Runtime != "codex" && s.Runtime != "claude") || len(s.ChannelIDs) < 1 || len(s.ChannelIDs) > 8 {
		return false
	}
	seen := map[string]bool{}
	for _, id := range s.ChannelIDs {
		if !identifier.MatchString(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	u, err := url.Parse(s.Origin)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || len(s.Origin) > 2048 {
		return false
	}
	r, err := url.Parse(s.Repository)
	if err != nil || r.Scheme != "https" || r.Hostname() == "" || r.User != nil || r.RawQuery != "" || r.Fragment != "" || len(s.Repository) > 2048 {
		return false
	}
	pin, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(s.SPKIPin, "sha256//"))
	if err != nil || !strings.HasPrefix(s.SPKIPin, "sha256//") || len(pin) != 32 || len(s.CertificateCA) == 0 || len(s.CertificateCA) > 128<<10 {
		return false
	}
	remaining, count := s.CertificateCA, 0
	for len(bytes.TrimSpace(remaining)) > 0 {
		block, rest := pem.Decode(remaining)
		if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) != 0 {
			return false
		}
		if _, err := x509.ParseCertificate(block.Bytes); err != nil {
			return false
		}
		remaining = rest
		count++
	}
	return count > 0
}

// InstallScript returns the static, secret-free pinned bootstrap script.
func InstallScript() []byte {
	script, _ := assets.ReadFile("onboarding/install.sh")
	python, _ := assets.ReadFile("onboarding/install.py")
	paths, _ := json.Marshal(packagePaths())
	python = bytes.ReplaceAll(python, []byte("__PACKAGE_PATHS_JSON__"), paths)
	return bytes.ReplaceAll(script, []byte("__INSTALLER_PYTHON__"), python)
}

func packagePaths() []string {
	paths := []string{"connect.py", "README.md", "PROMPT.md", "profile.json", "agent.key", "ca.crt"}
	for _, name := range connectorFiles {
		paths = append(paths, "connectors/"+name)
	}
	sort.Strings(paths)
	return paths
}

// BuildPackage returns a bounded rootless tar.gz of regular private files. The
// manifest proves byte consistency; authenticity comes from pinned HTTPS.
func BuildPackage(s Spec) ([]byte, error) {
	if !validSpec(s) {
		return nil, errors.New("invalid onboarding package specification")
	}
	files := map[string][]byte{}
	for _, name := range connectorFiles {
		data, err := assets.ReadFile(name)
		if err != nil {
			return nil, errors.New("missing embedded connector")
		}
		files["connectors/"+name] = data
	}
	for _, name := range []string{"connect.py", "README.md", "PROMPT.md"} {
		data, err := assets.ReadFile("onboarding/" + name)
		if err != nil {
			return nil, errors.New("missing embedded onboarding asset")
		}
		files[name] = data
	}
	profile := map[string]any{"version": 1, "agent_id": s.AgentID, "project_id": s.ProjectID,
		"url": s.Origin, "channel_ids": s.ChannelIDs, "runtime": s.Runtime, "repository": s.Repository, "connector_dir": "connectors"}
	files["profile.json"], _ = json.MarshalIndent(profile, "", "  ")
	files["agent.key"] = []byte(s.ServiceKey + "\n")
	files["ca.crt"] = append([]byte(nil), s.CertificateCA...)
	type entry struct {
		SHA256 string `json:"sha256"`
		Size   int    `json:"size"`
	}
	manifest := struct {
		Version int              `json:"version"`
		Files   map[string]entry `json:"files"`
	}{1, map[string]entry{}}
	total := 0
	for name, data := range files {
		hash := sha256.Sum256(data)
		total += len(data)
		manifest.Files[name] = entry{hex.EncodeToString(hash[:]), len(data)}
	}
	if total > 8<<20 {
		return nil, errors.New("onboarding package exceeds size bound")
	}
	files["MANIFEST.json"], _ = json.Marshal(manifest)
	var output bytes.Buffer
	compressed := gzip.NewWriter(&output)
	archive := tar.NewWriter(compressed)
	paths := packagePaths()
	paths = append(paths, "MANIFEST.json")
	sort.Strings(paths)
	for _, name := range paths {
		data := files[name]
		if err := archive.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(data)), Typeflag: tar.TypeReg, Format: tar.FormatUSTAR}); err != nil {
			return nil, err
		}
		if _, err := archive.Write(data); err != nil {
			return nil, err
		}
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	if err := compressed.Close(); err != nil {
		return nil, err
	}
	if output.Len() > 8<<20 {
		return nil, errors.New("compressed onboarding package exceeds size bound")
	}
	return output.Bytes(), nil
}
