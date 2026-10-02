package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"io"
	"net/url"
	"os"

	onboard "agent-link"
	"agent-link/internal/link"
)

// The invitation origin and trust material are operator configuration, never
// derived from request Host, Forwarded headers, or a browser-provided URL.
func loadOnboarding(origin, caFile, repository, certFile, keyFile string) (*link.OnboardingConfig, error) {
	if origin == "" && caFile == "" {
		return nil, nil
	}
	if origin == "" || caFile == "" || certFile == "" || keyFile == "" {
		return nil, errors.New("onboarding requires public URL, CA file, TLS certificate and TLS key")
	}
	f, err := os.Open(caFile)
	if err != nil {
		return nil, errors.New("cannot open onboarding CA file")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > 128<<10 {
		return nil, errors.New("onboarding CA must be a bounded regular certificate file")
	}
	ca, err := io.ReadAll(io.LimitReader(f, (128<<10)+1))
	if err != nil || len(ca) > 128<<10 {
		return nil, errors.New("cannot read onboarding CA certificate")
	}
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil || len(pair.Certificate) == 0 {
		return nil, errors.New("cannot load onboarding TLS certificate and key")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, errors.New("cannot parse onboarding TLS certificate")
	}
	spki := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
	cfg := &link.OnboardingConfig{Origin: origin, SPKIPin: "sha256//" + base64.StdEncoding.EncodeToString(spki[:]), Repository: repository, CertificateCA: ca, Installer: onboard.InstallScript()}
	cfg.Package = func(ctx context.Context, p link.OnboardingPackage) ([]byte, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		body, err := onboard.BuildPackage(onboard.Spec{AgentID: p.AgentID, ProjectID: p.ProjectID, ChannelIDs: p.ChannelIDs,
			Runtime: p.Runtime, ServiceKey: p.ServiceKey, Origin: p.Origin, SPKIPin: p.SPKIPin, Repository: p.Repository, CertificateCA: p.CertificateCA})
		if err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return body, nil
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(ca) // Validate has already checked the configured CA.
	intermediates := x509.NewCertPool()
	for _, der := range pair.Certificate[1:] {
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			return nil, errors.New("invalid onboarding TLS certificate chain")
		}
		intermediates.AddCert(cert)
	}
	parsed, _ := url.Parse(origin)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, DNSName: parsed.Hostname()}); err != nil {
		return nil, errors.New("onboarding TLS certificate must cover the public origin and verify with the configured CA")
	}
	return cfg, nil
}
