package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"agent-link/internal/link"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, filepath.Base(os.Args[0])+":", err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: %s version|serve|bootstrap|bootstrap-owner|revoke-key|rotate-key [flags]", filepath.Base(os.Args[0]))
	}
	command := os.Args[1]
	if command == "version" || command == "--version" {
		if len(os.Args) != 2 {
			return errors.New("version accepts no additional arguments")
		}
		return writeVersion(os.Stdout)
	}
	if command != "serve" && command != "bootstrap" && command != "bootstrap-owner" && command != "revoke-key" && command != "rotate-key" {
		return errors.New("unknown command")
	}
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	dbFile := fs.String("database-url-file", "", "private file containing PostgreSQL URL (or AGENT_LINK_DATABASE_URL)")
	listen := fs.String("listen", "127.0.0.1:8766", "listener address; non-loopback requires TLS")
	cert := fs.String("tls-cert", "", "TLS certificate path")
	key := fs.String("tls-key", "", "TLS private key path")
	web := fs.String("web-dir", "web", "allowlisted browser assets directory")
	publicURL := fs.String("public-url", os.Getenv("AGENT_LINK_PUBLIC_URL"), "trusted HTTPS origin for onboarding (or AGENT_LINK_PUBLIC_URL)")
	onboardingCA := fs.String("onboarding-ca-file", os.Getenv("AGENT_LINK_ONBOARDING_CA_FILE"), "CA certificate for onboarding packages (or AGENT_LINK_ONBOARDING_CA_FILE)")
	onboardingRepository := fs.String("onboarding-repository", "https://github.com/Vlad9572324/agent-mesh", "trusted HTTPS source repository for onboarding metadata")
	out := fs.String("credentials-out", "", "bootstrap credentials JSON destination; must not exist")
	agent := fs.String("agent", "", "stable agent identifier")
	keyOut := fs.String("key-out", "", "new key JSON destination; must not exist")
	ownerID := fs.String("owner-id", "owner", "stable owner identifier")
	ownerName := fs.String("owner-name", "Owner", "owner display name")
	if err := fs.Parse(os.Args[2:]); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if command == "bootstrap" && *out == "" {
		return errors.New("--credentials-out required")
	}
	if (command == "rotate-key" || command == "revoke-key") && *agent == "" {
		return errors.New("--agent required")
	}
	if (command == "rotate-key" || command == "bootstrap-owner") && *keyOut == "" {
		return errors.New("--key-out required")
	}
	dsn := os.Getenv("AGENT_LINK_DATABASE_URL")
	if *dbFile != "" {
		info, err := os.Stat(*dbFile)
		if err != nil {
			return errors.New("cannot inspect database URL file")
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
			return errors.New("database URL file must be private (0600 or stricter)")
		}
		b, err := os.ReadFile(*dbFile)
		if err != nil {
			return errors.New("cannot read database URL file")
		}
		dsn = strings.TrimSpace(string(b))
	}
	if dsn == "" {
		return errors.New("database URL file or AGENT_LINK_DATABASE_URL required")
	}
	var onboarding *link.OnboardingConfig
	if command == "serve" {
		if (*cert == "") != (*key == "") {
			return errors.New("both --tls-cert and --tls-key required")
		}
		host, _, err := net.SplitHostPort(*listen)
		if err != nil {
			return errors.New("invalid listener address")
		}
		if *cert == "" {
			ip := net.ParseIP(host)
			if ip == nil || !ip.IsLoopback() {
				return errors.New("TLS is required outside numeric loopback")
			}
		}
		onboarding, err = loadOnboarding(*publicURL, *onboardingCA, *onboardingRepository, *cert, *key)
		if err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	store, err := link.Open(ctx, dsn)
	if err != nil {
		return err
	}
	defer store.Close()
	switch command {
	case "bootstrap-owner":
		if err = store.BootstrapOwner(ctx, *ownerID, *ownerName, *keyOut); err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, "owner bootstrap complete; existing owner key preserved")
		return nil
	case "bootstrap":
		if err = store.Bootstrap(ctx, *out); err != nil {
			return errors.New("bootstrap failed: " + err.Error())
		}
		fmt.Fprintln(os.Stderr, "bootstrap complete; existing data and keys preserved")
		return nil
	case "revoke-key":
		if err = store.Revoke(ctx, *agent); err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, "key revoked")
		return nil
	case "rotate-key":
		if err = store.Rotate(ctx, *agent, *keyOut); err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, "key rotated; private output written")
		return nil
	}
	server := &http.Server{Addr: *listen, Handler: (&link.Server{Store: store, WebDir: *web, Onboarding: onboarding,
		Build: link.BuildInformation{Version: version, SourceCommit: commit, BuildDate: buildDate}}).Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stopped)
	done := make(chan error, 1)
	go func() {
		if *cert != "" {
			done <- server.ListenAndServeTLS(*cert, *key)
		} else {
			done <- server.ListenAndServe()
		}
	}()
	fmt.Fprintln(os.Stderr, filepath.Base(os.Args[0]), "listener starting on", *listen)
	select {
	case err = <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("listener failed")
		}
	case <-stopped:
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if err = server.Shutdown(ctx); err != nil {
			_ = server.Close()
		}
	}
	return nil
}
