package main

import (
	"encoding/json"
	"io"
	"runtime"
)

// Release builds set these from the exact source commit, not wall-clock time.
var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
)

type buildInformation struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildDate string `json:"build_date"`
	GoVersion string `json:"go_version"`
	GOOS      string `json:"goos"`
	GOARCH    string `json:"goarch"`
}

func writeVersion(w io.Writer) error {
	return json.NewEncoder(w).Encode(buildInformation{
		Version: version, Commit: commit, BuildDate: buildDate,
		GoVersion: runtime.Version(), GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
	})
}
