package onboarding

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"strings"
	"testing"
	"time"
)

func fixtureSpec(t *testing.T) Spec {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Unix(0, 0), NotAfter: time.Unix(2000000000, 0), DNSNames: []string{"mesh.example.invalid"}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return Spec{AgentID: "agent-fixture", ProjectID: "existing-project", ChannelIDs: []string{"coordination"}, Runtime: "auto", ServiceKey: strings.Repeat("e", 64), Origin: "https://mesh.example.invalid:443", SPKIPin: "sha256//" + base64.StdEncoding.EncodeToString(make([]byte, 32)), Repository: "https://github.com/example/mesh", CertificateCA: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

func packageFiles(t *testing.T, data []byte) map[string][]byte {
	t.Helper()
	compressed, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer compressed.Close()
	archive := tar.NewReader(compressed)
	files := map[string][]byte{}
	for {
		header, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if header.Typeflag != tar.TypeReg || header.Mode != 0600 || header.Linkname != "" || header.Uid != 0 || header.Gid != 0 || header.PAXRecords != nil || files[header.Name] != nil {
			t.Fatalf("unsafe/duplicate entry: %s", header.Name)
		}
		files[header.Name], err = io.ReadAll(archive)
		if err != nil {
			t.Fatal(err)
		}
	}
	return files
}

func TestPackageExactSourceClosureAndManifest(t *testing.T) {
	s := fixtureSpec(t)
	data, err := BuildPackage(s)
	if err != nil {
		t.Fatal(err)
	}
	again, err := BuildPackage(s)
	if err != nil || !bytes.Equal(data, again) {
		t.Fatal("package is not deterministic")
	}
	files := packageFiles(t, data)
	if len(files) != len(packagePaths())+1 {
		t.Fatal("unexpected package file set")
	}
	var manifest struct {
		Version int `json:"version"`
		Files   map[string]struct {
			SHA256 string `json:"sha256"`
			Size   int    `json:"size"`
		} `json:"files"`
	}
	if err := json.Unmarshal(files["MANIFEST.json"], &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Version != 1 || len(manifest.Files) != len(packagePaths()) {
		t.Fatal("bad manifest")
	}
	for _, name := range packagePaths() {
		content, exists := files[name]
		if !exists {
			t.Fatalf("missing %s", name)
		}
		sum := sha256.Sum256(content)
		meta := manifest.Files[name]
		if meta.Size != len(content) || meta.SHA256 != hex.EncodeToString(sum[:]) {
			t.Fatalf("wrong digest %s", name)
		}
		if strings.HasPrefix(name, "connectors/") {
			original, _ := assets.ReadFile(strings.TrimPrefix(name, "connectors/"))
			if !bytes.Equal(content, original) {
				t.Fatalf("source drift %s", name)
			}
		}
		if name != "agent.key" && bytes.Contains(content, []byte(s.ServiceKey)) {
			t.Fatalf("key leaked into %s", name)
		}
	}
	var profile map[string]any
	if err := json.Unmarshal(files["profile.json"], &profile); err != nil {
		t.Fatal(err)
	}
	if profile["runtime"] != "auto" || profile["project_id"] != s.ProjectID || profile["url"] != s.Origin {
		t.Fatal("profile binding mismatch")
	}
}

func TestPackageRefusesMalformedScopeAndSecrets(t *testing.T) {
	s := fixtureSpec(t)
	mutations := []func(*Spec){func(v *Spec) { v.AgentID = "../bad" }, func(v *Spec) { v.ChannelIDs = []string{"same", "same"} }, func(v *Spec) { v.Runtime = "shell" }, func(v *Spec) { v.Origin = "http://mesh.example.invalid" }, func(v *Spec) { v.Origin = "https://user:secret@mesh.example.invalid" }, func(v *Spec) { v.SPKIPin = "wrong" }, func(v *Spec) { v.CertificateCA = []byte("PRIVATE KEY") }, func(v *Spec) { v.Repository = "file:///private" }, func(v *Spec) { v.ServiceKey = "short" }}
	for i, mutate := range mutations {
		candidate := s
		mutate(&candidate)
		if data, err := BuildPackage(candidate); err == nil || data != nil {
			t.Fatalf("accepted malformed spec %d", i)
		}
	}
}

func TestInstallerFullyRenderedAndSecretFree(t *testing.T) {
	script := InstallScript()
	if bytes.Contains(script, []byte("__INSTALLER_PYTHON__")) || bytes.Contains(script, []byte("__PACKAGE_PATHS_JSON__")) || !bytes.Contains(script, []byte("--pinnedpubkey")) || !bytes.Contains(script, []byte("--data-binary")) {
		t.Fatal("incomplete installer")
	}
	for _, path := range packagePaths() {
		if !bytes.Contains(script, []byte(`"`+path+`"`)) {
			t.Fatalf("missing allowlist path %s", path)
		}
	}
	if !bytes.Contains(script, []byte("os.dup2(tty, descriptor)")) {
		t.Fatal("piped installer must restore interactive CLI stdio")
	}
}
