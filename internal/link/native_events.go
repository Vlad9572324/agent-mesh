package link

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed native_events_schema.sql
var nativeActivitySchema string

// Lifecycle/tool telemetry and delivery evidence are bounded separately. Evidence
// (inbox.offered/seen/accepted, i.e. rows with a message_id) feeds receipts and
// deadline alerts, so a telemetry flood must never be able to refuse it.
const nativeActivityQuota = 10000
const nativeEvidenceQuota = 10000
const nativeActivityColumns = `id,channel_id,seq,actor_id,client_id,session_id,runtime,event_type,tool_name,message_id,created_at`

// NativeActivity is an authenticated client's observation, never proof that the
// server executed a CLI, verified a task, or accepted an inbox into a model.
type NativeActivity struct {
	ID             string    `json:"id"`
	ChannelID      string    `json:"channel_id"`
	Seq            int64     `json:"seq"`
	ActorID        string    `json:"actor_id"`
	ClientID       string    `json:"client_id"`
	SessionID      string    `json:"session_id"`
	Runtime        string    `json:"runtime"`
	EventType      string    `json:"event_type"`
	ToolName       *string   `json:"tool_name"`
	MessageID      *string   `json:"message_id"`
	CreatedAt      time.Time `json:"created_at"`
	Provenance     string    `json:"provenance"`
	ServerVerified bool      `json:"server_verified"`
}

type nativeActivityInput struct {
	ClientID  string  `json:"client_id"`
	SessionID string  `json:"session_id"`
	Runtime   string  `json:"runtime"`
	EventType string  `json:"event_type"`
	ToolName  *string `json:"tool_name,omitempty"`
	MessageID *string `json:"message_id,omitempty"`
}

func validNativeActivity(in nativeActivityInput) bool {
	if !validID(in.ClientID) || !validID(in.SessionID) || (in.Runtime != "codex" && in.Runtime != "claude") {
		return false
	}
	switch in.EventType {
	case "session.started", "session.ended", "turn.started", "turn.completed", "tool.started", "tool.completed", "tool.failed", "agent.waiting", "inbox.offered", "inbox.seen", "inbox.accepted":
	default:
		return false
	}
	if in.ToolName != nil && (!strings.HasPrefix(in.EventType, "tool.") || !validID(*in.ToolName)) {
		return false
	}
	if strings.HasPrefix(in.EventType, "inbox.") {
		return in.MessageID != nil && validID(*in.MessageID)
	}
	return in.MessageID == nil
}

func scanNativeActivity(row pgx.Row) (NativeActivity, error) {
	item := NativeActivity{Provenance: "client_reported"}
	err := row.Scan(&item.ID, &item.ChannelID, &item.Seq, &item.ActorID, &item.ClientID, &item.SessionID,
		&item.Runtime, &item.EventType, &item.ToolName, &item.MessageID, &item.CreatedAt)
	return item, err
}

func loadNativeActivity(ctx context.Context, q querier, id string) (NativeActivity, error) {
	return scanNativeActivity(q.QueryRow(ctx, `SELECT `+nativeActivityColumns+` FROM native_activity WHERE id=$1`, id))
}

func (s *Server) nativeActivityRoutes(api *http.ServeMux) {
	api.HandleFunc("GET /v1/channels/{channel}/activity", s.nativeActivity)
	api.HandleFunc("GET /v1/projects/{project}/activity", s.projectNativeActivity)
	api.HandleFunc("POST /v1/channels/{channel}/activity", s.postNativeActivity)
}

// A cursor is a bounded, canonical continuation position, never authorization.
// Bind it to the reader and filters so changing scope requires a fresh page.
type projectActivityCursor struct {
	Project, Reader, Actor, Channel string
	At                              time.Time
	ID                              string
}

func encodeProjectActivityCursor(cursor projectActivityCursor) string {
	data, _ := json.Marshal([]string{"1", cursor.Project, cursor.Reader, cursor.Actor, cursor.Channel, cursor.At.UTC().Format(time.RFC3339Nano), cursor.ID})
	return base64.RawURLEncoding.EncodeToString(data)
}

func decodeProjectActivityCursor(value string, scope projectActivityCursor) (projectActivityCursor, bool) {
	if len(value) == 0 || len(value) > 2048 {
		return scope, false
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(value)
	var fields []string
	if err != nil || json.Unmarshal(data, &fields) != nil || len(fields) != 7 || fields[0] != "1" ||
		fields[1] != scope.Project || fields[2] != scope.Reader || fields[3] != scope.Actor || fields[4] != scope.Channel || !validID(fields[6]) {
		return scope, false
	}
	at, err := time.Parse(time.RFC3339Nano, fields[5])
	if err != nil || at.IsZero() || at.Year() < 1 || at.Nanosecond()%1000 != 0 {
		return scope, false
	}
	scope.At, scope.ID = at, fields[6]
	return scope, encodeProjectActivityCursor(scope) == value
}

func (s *Server) projectNativeActivity(w http.ResponseWriter, r *http.Request) {
	// ParseQuery errors and duplicate/unknown keys must not silently change scope.
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		fail(w, 400, "invalid activity query")
		return
	}
	for key, values := range query {
		if (key != "limit" && key != "before" && key != "actor_id" && key != "channel_id") || len(values) != 1 || values[0] == "" {
			fail(w, 400, "invalid activity query")
			return
		}
	}
	limit := 100
	if value := query.Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 {
			fail(w, 400, "invalid limit")
			return
		}
		if limit > 100 {
			limit = 100
		}
	}
	ctx, reader, project := r.Context(), principal(r), r.PathValue("project")
	scope := projectActivityCursor{Project: project, Reader: reader.ID, Actor: query.Get("actor_id"), Channel: query.Get("channel_id")}
	if (scope.Actor != "" && !validID(scope.Actor)) || (scope.Channel != "" && !validID(scope.Channel)) {
		fail(w, 400, "invalid activity filter")
		return
	}
	var before any
	if value := query.Get("before"); value != "" {
		var ok bool
		scope, ok = decodeProjectActivityCursor(value, scope)
		if !ok {
			fail(w, 400, "invalid activity cursor")
			return
		}
		before = scope.At
	}
	tx, err := s.Store.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	var kind string
	err = tx.QueryRow(ctx, `SELECT kind FROM principals WHERE id=$1 AND key_hash=$2`, reader.ID, digest(bearer(r))).Scan(&kind)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 401, "invalid or revoked key")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	if !projectAccess(ctx, tx, project, reader.ID, false) {
		fail(w, 404, "not found")
		return
	}
	if scope.Channel != "" {
		var belongs bool
		if tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM channels WHERE id=$1 AND project_id=$2)`, scope.Channel, project).Scan(&belongs) != nil {
			internal(w)
			return
		}
		if !belongs || !channelAccess(ctx, tx, scope.Channel, reader.ID, false) {
			fail(w, 404, "not found")
			return
		}
	}
	// Channel ACLs and the key/project checks above share this read-only snapshot.
	// Never use the shared per-channel sequence as a project-history window.
	rows, err := tx.Query(ctx, `SELECT n.`+strings.ReplaceAll(nativeActivityColumns, ",", ",n.")+`
 FROM native_activity n JOIN channels c ON c.id=n.channel_id
 WHERE c.project_id=$1 AND ($3::boolean OR EXISTS (
 SELECT 1 FROM channel_members cm JOIN project_members pm ON pm.agent_id=cm.agent_id
 JOIN projects p ON p.id=pm.project_id
 WHERE cm.channel_id=c.id AND cm.agent_id=$2 AND pm.project_id=c.project_id AND p.archived_at IS NULL))
 AND ($4::text='' OR n.actor_id=$4) AND ($5::text='' OR n.channel_id=$5)
 AND ($6::timestamptz IS NULL OR (n.created_at,n.id)<($6::timestamptz,$7::text))
 ORDER BY n.created_at DESC,n.id DESC LIMIT $8`, project, reader.ID, kind == "owner", scope.Actor, scope.Channel, before, scope.ID, limit+1)
	if err != nil {
		internal(w)
		return
	}
	defer rows.Close()
	items := []NativeActivity{}
	for rows.Next() {
		item, err := scanNativeActivity(rows)
		if err != nil {
			internal(w)
			return
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		internal(w)
		return
	}
	more := len(items) > limit
	var next *string
	if more {
		items = items[:limit]
		last := items[len(items)-1]
		scope.At, scope.ID = last.CreatedAt, last.ID
		value := encodeProjectActivityCursor(scope)
		next = &value
	}
	respond(w, 200, map[string]any{"activity": items, "has_more": more, "next_before": next})
}

func (s *Server) postNativeActivity(w http.ResponseWriter, r *http.Request) {
	if principal(r).Kind != "agent" {
		fail(w, 404, "not found")
		return
	}
	if !s.channelAllowed(w, r, true) {
		return
	}
	var in nativeActivityInput
	if !decodeMax(w, r, &in, 4096) {
		return
	}
	if !validNativeActivity(in) {
		fail(w, 400, "invalid native activity fields")
		return
	}
	canonical, _ := json.Marshal(in)
	hash := digest(string(canonical))
	ctx, actor, channel := r.Context(), principal(r), r.PathValue("channel")
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	if !s.authorizeWrite(w, r, tx, false) {
		return
	}
	if !channelAccess(ctx, tx, channel, actor.ID, true) {
		fail(w, 404, "not found")
		return
	}
	if _, err = tx.Exec(ctx, `SELECT id FROM channels WHERE id=$1 FOR UPDATE`, channel); err != nil {
		internal(w)
		return
	}
	var existing string
	var oldHash []byte
	err = tx.QueryRow(ctx, `SELECT id,request_hash FROM native_activity WHERE channel_id=$1 AND actor_id=$2 AND client_id=$3`, channel, actor.ID, in.ClientID).Scan(&existing, &oldHash)
	if err == nil {
		if !bytes.Equal(oldHash, hash) {
			fail(w, 409, "client_id payload conflict")
			return
		}
		item, loadErr := loadNativeActivity(ctx, tx, existing)
		if loadErr != nil {
			internal(w)
			return
		}
		respond(w, 200, map[string]any{"activity": item, "replayed": true})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		internal(w)
		return
	}
	if in.MessageID != nil {
		var recipient bool
		if tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM messages WHERE id=$1 AND channel_id=$2 AND recipient_ids ? $3)`, *in.MessageID, channel, actor.ID).Scan(&recipient) != nil {
			internal(w)
			return
		}
		if !recipient {
			fail(w, 404, "message not found for this recipient")
			return
		}
	}
	evidence, limit := in.MessageID != nil, nativeActivityQuota
	if evidence {
		limit = nativeEvidenceQuota
	}
	var count int
	if tx.QueryRow(ctx, `SELECT count(*) FROM native_activity WHERE channel_id=$1 AND (message_id IS NOT NULL)=$2`, channel, evidence).Scan(&count) != nil {
		internal(w)
		return
	}
	if count >= limit {
		fail(w, 409, "channel native activity quota exceeded")
		return
	}
	id, err := randomHex(16)
	if err != nil {
		internal(w)
		return
	}
	seq, err := addEvent(ctx, tx, channel, "native.activity", id)
	if err != nil {
		internal(w)
		return
	}
	_, err = tx.Exec(ctx, `INSERT INTO native_activity(id,channel_id,seq,actor_id,client_id,session_id,runtime,event_type,tool_name,message_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		id, channel, seq, actor.ID, in.ClientID, in.SessionID, in.Runtime, in.EventType, in.ToolName, in.MessageID, hash)
	if err != nil {
		internal(w)
		return
	}
	item, err := loadNativeActivity(ctx, tx, id)
	if err != nil || tx.Commit(ctx) != nil {
		internal(w)
		return
	}
	respond(w, 201, map[string]any{"activity": item, "replayed": false})
}

func (s *Server) nativeActivity(w http.ResponseWriter, r *http.Request) {
	after, limit, ok := pagination(w, r, "after_seq")
	if !ok {
		return
	}
	ctx, actor, channel := r.Context(), principal(r), r.PathValue("channel")
	tx, err := s.Store.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	var live bool
	if tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM principals WHERE id=$1 AND key_hash=$2)`, actor.ID, digest(bearer(r))).Scan(&live) != nil {
		internal(w)
		return
	}
	if !live {
		fail(w, 401, "invalid or revoked key")
		return
	}
	if !channelAccess(ctx, tx, channel, actor.ID, false) {
		fail(w, 404, "not found")
		return
	}
	rows, err := tx.Query(ctx, `SELECT `+nativeActivityColumns+` FROM native_activity WHERE channel_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`, channel, after, limit+1)
	if err != nil {
		internal(w)
		return
	}
	defer rows.Close()
	items := []NativeActivity{}
	for rows.Next() {
		item, err := scanNativeActivity(rows)
		if err != nil {
			internal(w)
			return
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		internal(w)
		return
	}
	more := len(items) > limit
	if more {
		items = items[:limit]
	}
	if len(items) > 0 {
		after = items[len(items)-1].Seq
	}
	respond(w, 200, map[string]any{"activity": items, "has_more": more, "next_after_seq": after})
}
