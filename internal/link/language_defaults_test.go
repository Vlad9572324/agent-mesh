package link

import (
	"context"
	"testing"
)

// Localization changes presentation and new-install defaults, never persisted
// user data. A fresh seed is English; an existing localized name is retained.
func TestEnglishBootstrapDefaultsPreserveExistingUserText(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	var project, channel, agent string
	if err := f.s.Pool.QueryRow(ctx, `SELECT p.name,c.name,a.name FROM projects p
 JOIN channels c ON c.project_id=p.id JOIN principals a ON a.id='codex-pilot'
 WHERE p.id='pilot' AND c.id='general'`).Scan(&project, &channel, &agent); err != nil {
		t.Fatal(err)
	}
	if project != "Agent Mesh pilot" || channel != "general" || agent != "Codex · pilot" {
		t.Fatal("new-install defaults must be English")
	}
	const userText = "Пользовательское название · Project map"
	if _, err := f.s.Pool.Exec(ctx, `UPDATE projects SET name=$1 WHERE id='pilot'`, userText); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Bootstrap(ctx, f.credentials); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Pool.QueryRow(ctx, `SELECT name FROM projects WHERE id='pilot'`).Scan(&project); err != nil {
		t.Fatal(err)
	}
	if project != userText {
		t.Fatal("bootstrap rewrote an existing user-owned name")
	}
}
