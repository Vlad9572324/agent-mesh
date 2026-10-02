package link

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schema string

type Store struct{ Pool *pgxpool.Pool }

func Open(ctx context.Context, dsn string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, errors.New("invalid database configuration")
	}
	cfg.MaxConns = 12
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "10000"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, errors.New("cannot initialize database pool")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("database unavailable")
	}
	s := &Store{Pool: pool}
	if err = s.Migrate(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return s, nil
}
func (s *Store) Close() { s.Pool.Close() }
func (s *Store) Migrate(ctx context.Context) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return errors.New("cannot begin schema initialization")
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(731840593)"); err == nil {
		_, err = tx.Exec(ctx, schema+"\n"+artifactsSchema+"\n"+sessionsSchema+"\n"+tasksSchema+"\n"+memorySchema+"\n"+nativeActivitySchema+"\n"+onboardingSchema)
	}
	if err != nil {
		return errors.New("schema initialization failed")
	}
	return tx.Commit(ctx)
}
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
func digest(key string) []byte { h := sha256.Sum256([]byte(key)); return h[:] }

// AtomicPrivateJSON never exposes key material through stdout and never follows a target symlink.
func AtomicPrivateJSON(path string, v any, replace bool) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".agent-link-credentials-*")
	if err != nil {
		return errors.New("cannot create private credentials file")
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return errors.New("cannot write private credentials file")
	}
	if !replace {
		err = os.Link(tmp, path)
	} else {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		return errors.New("cannot publish credentials file (destination may already exist)")
	}
	return nil
}

type Credentials struct {
	Keys map[string]string `json:"keys"`
}

// Bootstrap preserves existing accounts, keys, leases, messages and notes. New keys
// are written before commit; a failed commit may leave unusable credentials, never
// silently rotate an already active account. Existing seed means no write at all.
func (s *Store) Bootstrap(ctx context.Context, path string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = managementLock(ctx, tx, false); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(731840594)"); err != nil {
		return err
	}
	var count int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM principals WHERE id = ANY($1)", []string{"claude-pilot", "codex-pilot", "viewer-pilot", "deny-pilot"}).Scan(&count); err != nil {
		return err
	}
	if count == 4 {
		return tx.Commit(ctx)
	}
	// Partial seed should be inspected explicitly instead of creating incomplete key exports.
	if count != 0 {
		return errors.New("partial seed exists; refusing to replace credentials or accounts")
	}
	var retired bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM retired_project_ids WHERE id IN ('pilot','isolated')) OR EXISTS(SELECT 1 FROM retired_channel_ids WHERE id IN ('general','isolated'))`).Scan(&retired); err != nil {
		return err
	}
	if retired {
		return errors.New("seed identifiers were permanently retired; refusing to recreate deleted projects or channels")
	}
	if _, err = os.Lstat(path); !os.IsNotExist(err) {
		return errors.New("credentials destination exists or cannot be inspected")
	}
	if _, err = tx.Exec(ctx, `INSERT INTO projects(id,name) VALUES ('pilot','Agent Mesh pilot'),('isolated','Isolated project') ON CONFLICT DO NOTHING;
 INSERT INTO channels(id,project_id,name) VALUES ('general','pilot','general'),('isolated','isolated','isolated') ON CONFLICT DO NOTHING`); err != nil {
		return err
	}
	creds := Credentials{Keys: map[string]string{}}
	for _, p := range []struct{ id, name, kind, runtime, project, channel string }{
		{"claude-pilot", "Claude · pilot", "agent", "claude", "pilot", "general"},
		{"codex-pilot", "Codex · pilot", "agent", "codex", "pilot", "general"},
		{"viewer-pilot", "Observer · pilot", "viewer", "", "pilot", "general"},
		{"deny-pilot", "Isolated · pilot", "agent", "test", "isolated", "isolated"},
	} {
		key, e := randomHex(32)
		if e != nil {
			return e
		}
		creds.Keys[p.id] = key
		if _, err = tx.Exec(ctx, "INSERT INTO principals(id,name,kind,runtime,key_hash) VALUES($1,$2,$3,$4,$5)", p.id, p.name, p.kind, p.runtime, digest(key)); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO project_members VALUES($1,$2,$3)", p.project, p.id, p.kind == "agent"); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO channel_members VALUES($1,$2,$3)", p.channel, p.id, p.kind == "agent"); err != nil {
			return err
		}
	}
	if err = AtomicPrivateJSON(path, creds, false); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) Revoke(ctx context.Context, id string) error {
	if !validID(id) {
		return errors.New("invalid agent identifier")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return errors.New("key revocation failed")
	}
	defer tx.Rollback(ctx)
	if err = managementLock(ctx, tx, false); err != nil {
		return errors.New("key revocation failed")
	}
	var kind string
	var active bool
	if err = tx.QueryRow(ctx, "SELECT kind,key_hash IS NOT NULL FROM principals WHERE id=$1 FOR UPDATE", id).Scan(&kind, &active); err != nil {
		return errors.New("principal not found")
	}
	if kind == "owner" && active {
		var otherOwners int
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM principals WHERE kind='owner' AND key_hash IS NOT NULL AND id<>$1", id).Scan(&otherOwners); err != nil {
			return errors.New("cannot check owner recovery access")
		}
		if otherOwners == 0 {
			return errors.New("cannot revoke the last active owner; rotate its key instead")
		}
	}
	result, err := tx.Exec(ctx, "UPDATE principals SET key_hash=NULL WHERE id=$1", id)
	if err != nil {
		return errors.New("key revocation failed")
	}
	if result.RowsAffected() != 1 {
		return errors.New("agent not found")
	}
	if err = revokeAgentInvitations(ctx, tx, id); err != nil {
		return errors.New("invitation revocation failed")
	}
	if err = writeAudit(ctx, tx, "local-cli", "key.revoke", "principal", id, auditDetails{}); err != nil {
		return errors.New("key revocation audit failed")
	}
	return tx.Commit(ctx)
}
func (s *Store) Rotate(ctx context.Context, id, path string) error {
	if !validID(id) {
		return errors.New("invalid agent identifier")
	}
	key, err := randomHex(32)
	if err != nil {
		return err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = managementLock(ctx, tx, false); err != nil {
		return errors.New("key rotation failed")
	}
	result, err := tx.Exec(ctx, "UPDATE principals SET key_hash=$1 WHERE id=$2", digest(key), id)
	if err != nil {
		return errors.New("key rotation failed")
	}
	if result.RowsAffected() != 1 {
		return errors.New("agent not found")
	}
	if err = revokeAgentInvitations(ctx, tx, id); err != nil {
		return errors.New("invitation revocation failed")
	}
	if err = writeAudit(ctx, tx, "local-cli", "key.rotate", "principal", id, auditDetails{}); err != nil {
		return errors.New("key rotation audit failed")
	}
	if err = AtomicPrivateJSON(path, map[string]string{"agent_id": id, "key": key}, false); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return errors.New("rotation commit failed; output key may be unusable")
	}
	return nil
}

// BootstrapOwner is local-only. An existing owner is a no-op, including when its
// output file is missing: raw keys are not retained and must never be regenerated.
func (s *Store) BootstrapOwner(ctx context.Context, id, name, path string) error {
	if !validID(id) || !validText(name, 200) || path == "" {
		return errors.New("invalid owner bootstrap fields")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = managementLock(ctx, tx, false); err != nil {
		return err
	}
	var kind string
	err = tx.QueryRow(ctx, "SELECT kind FROM principals WHERE id=$1 FOR UPDATE", id).Scan(&kind)
	if err == nil {
		if kind != "owner" {
			return errors.New("identifier belongs to a non-owner; refusing role elevation")
		}
		return tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return errors.New("owner lookup failed")
	}
	key, err := randomHex(32)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO principals(id,name,kind,key_hash) VALUES($1,$2,'owner',$3)", id, name, digest(key)); err != nil {
		return errors.New("owner creation failed")
	}
	if err = writeAudit(ctx, tx, "local-cli", "owner.bootstrap", "principal", id, auditDetails{}); err != nil {
		return errors.New("owner bootstrap audit failed")
	}
	if err = AtomicPrivateJSON(path, map[string]string{"agent_id": id, "key": key}, false); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return errors.New("owner bootstrap commit failed; output key may be unusable")
	}
	return nil
}

type Principal struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}
type Agent struct {
	Principal
	Runtime    string     `json:"runtime"`
	SessionID  string     `json:"session_id"`
	LastSeenAt *time.Time `json:"last_seen_at"`
	Activity   string     `json:"activity"`
	Freshness  string     `json:"freshness"`
}
type Project struct {
	ID               string     `json:"id"`
	Name             string     `json:"name"`
	ArchivedAt       *time.Time `json:"archived_at"`
	LifecycleVersion int64      `json:"lifecycle_version"`
}
type Channel struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	Name      string `json:"name"`
}
type Receipt struct {
	AgentID     string     `json:"agent_id"`
	DeliveredAt *time.Time `json:"delivered_at"`
	AcceptedAt  *time.Time `json:"accepted_at"`
	UncertainAt *time.Time `json:"uncertain_at"`
	SessionID   string     `json:"session_id"`
}
type Message struct {
	ID           string    `json:"id"`
	ChannelID    string    `json:"channel_id"`
	Seq          int64     `json:"seq"`
	AuthorID     string    `json:"author_id"`
	ClientID     string    `json:"client_id"`
	Body         string    `json:"body"`
	RecipientIDs []string  `json:"recipient_ids"`
	ReplyTo      *string   `json:"reply_to"`
	CreatedAt    time.Time `json:"created_at"`
	Receipts     []Receipt `json:"receipts"`
}
type Event struct {
	Seq       int64     `json:"seq"`
	ChannelID string    `json:"channel_id"`
	Kind      string    `json:"kind"`
	EntityID  string    `json:"entity_id"`
	CreatedAt time.Time `json:"created_at"`
}
type Note struct {
	ID              string    `json:"id"`
	ProjectID       string    `json:"project_id"`
	AuthorID        string    `json:"author_id"`
	Title           string    `json:"title"`
	Body            string    `json:"body"`
	SourceMessageID *string   `json:"source_message_id"`
	Version         int       `json:"version"`
	CreatedAt       time.Time `json:"created_at"`
}

type querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

const messageSelect = `SELECT id,channel_id,seq,author_id,client_id,body,recipient_ids,reply_to,created_at FROM messages `

func loadMessage(ctx context.Context, q querier, id string) (Message, error) {
	var m Message
	err := q.QueryRow(ctx, messageSelect+"WHERE id=$1", id).Scan(&m.ID, &m.ChannelID, &m.Seq, &m.AuthorID, &m.ClientID, &m.Body, &m.RecipientIDs, &m.ReplyTo, &m.CreatedAt)
	if err != nil {
		return m, err
	}
	m.Receipts = []Receipt{}
	rows, err := q.Query(ctx, "SELECT agent_id,delivered_at,accepted_at,uncertain_at,session_id FROM receipts WHERE message_id=$1 ORDER BY agent_id", id)
	if err != nil {
		return m, err
	}
	defer rows.Close()
	for rows.Next() {
		var r Receipt
		if err = rows.Scan(&r.AgentID, &r.DeliveredAt, &r.AcceptedAt, &r.UncertainAt, &r.SessionID); err != nil {
			return m, err
		}
		m.Receipts = append(m.Receipts, r)
	}
	return m, rows.Err()
}
func addEvent(ctx context.Context, tx pgx.Tx, channel, kind, id string) (int64, error) {
	var seq int64
	if err := tx.QueryRow(ctx, "UPDATE channels SET cursor=cursor+1 WHERE id=$1 RETURNING cursor", channel).Scan(&seq); err != nil {
		return 0, err
	}
	_, err := tx.Exec(ctx, "INSERT INTO events(channel_id,seq,kind,entity_id) VALUES($1,$2,$3,$4)", channel, seq, kind, id)
	return seq, err
}
func fresh(last *time.Time, now time.Time) string {
	if last == nil {
		return "unknown"
	}
	if now.Sub(*last) < 30*time.Second {
		return "fresh"
	}
	return "stale"
}
