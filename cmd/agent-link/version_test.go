package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"runtime"
	"testing"
)

func TestVersionJSON(t *testing.T) {
	var output bytes.Buffer
	if err := writeVersion(&output); err != nil {
		t.Fatal(err)
	}
	var info buildInformation
	if err := json.Unmarshal(output.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.Version != version || info.Commit != commit || info.BuildDate != buildDate ||
		info.GoVersion != runtime.Version() || info.GOOS != runtime.GOOS || info.GOARCH != runtime.GOARCH {
		t.Fatalf("unexpected build information: %+v", info)
	}
}

type failingVersionWriter struct{}

var errVersionWrite = errors.New("version output unavailable")

func (failingVersionWriter) Write([]byte) (int, error) { return 0, errVersionWrite }

func TestVersionPropagatesWriteError(t *testing.T) {
	if err := writeVersion(failingVersionWriter{}); !errors.Is(err, errVersionWrite) {
		t.Fatalf("expected output error, got %v", err)
	}
}

func TestVersionRequiresNoDatabase(t *testing.T) {
	t.Setenv("AGENT_LINK_DATABASE_URL", "not-a-valid-database-url")
	oldArgs, oldStdout := os.Args, os.Stdout
	t.Cleanup(func() { os.Args, os.Stdout = oldArgs, oldStdout })
	for _, command := range []string{"version", "--version"} {
		output, err := os.CreateTemp(t.TempDir(), "version-output-")
		if err != nil {
			t.Fatal(err)
		}
		os.Args, os.Stdout = []string{"agent-link", command}, output
		err = run()
		os.Stdout = oldStdout
		if closeErr := output.Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
		if err != nil {
			t.Fatalf("%s should not access the database: %v", command, err)
		}
		body, err := os.ReadFile(output.Name())
		if err != nil {
			t.Fatal(err)
		}
		var info buildInformation
		if err := json.Unmarshal(body, &info); err != nil || info.Version != version {
			t.Fatalf("invalid version response: %v", err)
		}
		os.Args = []string{"agent-link", command, "unexpected"}
		if err := run(); err == nil || err.Error() != "version accepts no additional arguments" {
			t.Fatalf("%s must reject extra arguments before database access: %v", command, err)
		}
	}
}
