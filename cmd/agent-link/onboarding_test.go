package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func onboardingCertificate(t *testing.T, expired bool) (string, string, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(time.Hour)
	if expired {
		until = time.Now().Add(-time.Hour)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "fixture"}, NotBefore: time.Now().Add(-2 * time.Hour), NotAfter: until, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true, DNSNames: []string{"mesh.test"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	private, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	crt, priv := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err = os.WriteFile(crt, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(priv, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: private}), 0600); err != nil {
		t.Fatal(err)
	}
	return crt, priv, der
}
func TestOnboardingStartupTrust(t *testing.T) {
	cert, key, der := onboardingCertificate(t, false)
	const repository = "https://github.com/Vlad9572324/agent-mesh"
	cfg, err := loadOnboarding("https://127.0.0.1:8766", cert, repository, cert, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	pin := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
	if cfg.SPKIPin != "sha256//"+base64.StdEncoding.EncodeToString(pin[:]) || len(cfg.Installer) == 0 || cfg.Package == nil {
		t.Fatal("trust or embedded assets missing")
	}
	if disabled, err := loadOnboarding("", "", repository, "", ""); err != nil || disabled != nil {
		t.Fatal("default server should leave onboarding disabled")
	}
	other, otherKey, _ := onboardingCertificate(t, false)
	expired, expiredKey, _ := onboardingCertificate(t, true)
	for _, tc := range []struct{ name, origin, ca, crt, key string }{
		{"missing-ca", "https://mesh.test", "", cert, key},
		{"missing-origin", "", cert, cert, key},
		{"missing-tls", "https://mesh.test", cert, "", ""},
		{"http", "http://mesh.test", cert, cert, key},
		{"path", "https://mesh.test/path", cert, cert, key},
		{"host-mismatch", "https://wrong.test", cert, cert, key},
		{"wrong-ca", "https://mesh.test", other, cert, key},
		{"wrong-private-key", "https://mesh.test", cert, cert, otherKey},
		{"expired", "https://mesh.test", expired, expired, expiredKey},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := loadOnboarding(tc.origin, tc.ca, repository, tc.crt, tc.key); err == nil {
				t.Fatal("invalid trust configuration accepted")
			}
		})
	}
}
