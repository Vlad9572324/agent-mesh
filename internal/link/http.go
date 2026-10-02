package link

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const maxBody = 64 << 10

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$`)

func validID(s string) bool { return identifier.MatchString(s) }
func validText(s string, max int) bool {
	return len(s) > 0 && len(s) <= max && utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}

type Server struct {
	Store          *Store
	WebDir         string
	Onboarding     *OnboardingConfig
	onboardingGate chan struct{}
	onboardingOnce sync.Once
}
type contextKey struct{}

func principal(r *http.Request) Principal { return r.Context().Value(contextKey{}).(Principal) }
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, msg string) {
	respond(w, status, map[string]string{"error": msg})
}
func internal(w http.ResponseWriter) { fail(w, 500, "internal error") }

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	return decodeMax(w, r, v, maxBody)
}

func decodeMax(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	if ct := strings.Split(r.Header.Get("Content-Type"), ";")[0]; ct != "application/json" {
		fail(w, 415, "application/json required")
		return false
	}
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		fail(w, 413, "request body too large")
		return false
	}
	if !utf8.Valid(b) {
		fail(w, 400, "invalid UTF-8 JSON")
		return false
	}
	// Reject duplicate and case-aliased fields before typed decoding; encoding/json
	// alone accepts both, which makes signed/idempotent payloads ambiguous.
	if !strictObject(b, v) {
		fail(w, 400, "JSON object with unique, exact field names required")
		return false
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err = d.Decode(v); err != nil {
		fail(w, 400, "invalid JSON body")
		return false
	}
	if err = d.Decode(new(any)); err != io.EOF {
		fail(w, 400, "single JSON object required")
		return false
	}
	return true
}

func strictObject(b []byte, value any) bool {
	typeOf := reflect.TypeOf(value)
	if typeOf.Kind() != reflect.Pointer || typeOf.Elem().Kind() != reflect.Struct {
		return false
	}
	typeOf = typeOf.Elem()
	allowed := make(map[string]bool, typeOf.NumField())
	for i := 0; i < typeOf.NumField(); i++ {
		name := strings.Split(typeOf.Field(i).Tag.Get("json"), ",")[0]
		if name != "" && name != "-" {
			allowed[name] = true
		}
	}
	d := json.NewDecoder(bytes.NewReader(b))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return false
	}
	seen := make(map[string]bool)
	for d.More() {
		token, err = d.Token()
		if err != nil {
			return false
		}
		key, ok := token.(string)
		if !ok || !allowed[key] || seen[key] {
			return false
		}
		seen[key] = true
		var raw json.RawMessage
		if d.Decode(&raw) != nil {
			return false
		}
	}
	if token, err = d.Token(); err != nil || token != json.Delim('}') {
		return false
	}
	return d.Decode(new(any)) == io.EOF
}

func (s *Server) Handler() http.Handler {
	s.onboardingOnce.Do(func() { s.onboardingGate = make(chan struct{}, 4) })
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if s.Store.Pool.Ping(ctx) != nil {
			fail(w, 503, "not ready")
			return
		}
		respond(w, 200, map[string]string{"status": "ok"})
	})
	api := http.NewServeMux()
	api.HandleFunc("GET /v1/me", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]any{"agent": principal(r)}) })
	api.HandleFunc("GET /v1/workspace/stream", s.workspaceStream)
	api.HandleFunc("GET /v1/projects", s.projects)
	api.HandleFunc("GET /v1/projects/{project}/channels", s.channels)
	api.HandleFunc("GET /v1/projects/{project}/agents", s.agents)
	api.HandleFunc("GET /v1/projects/{project}/map", s.projectMap)
	api.HandleFunc("GET /v1/channels/{channel}/messages", s.messages)
	api.HandleFunc("POST /v1/channels/{channel}/messages", s.postMessage)
	api.HandleFunc("GET /v1/messages/{message}", s.message)
	api.HandleFunc("POST /v1/messages/{message}/receipts", s.receipt)
	api.HandleFunc("POST /v1/heartbeat", s.heartbeat)
	api.HandleFunc("GET /v1/channels/{channel}/events", s.events)
	api.HandleFunc("GET /v1/channels/{channel}/stream", s.stream)
	api.HandleFunc("GET /v1/projects/{project}/notes", s.notes)
	api.HandleFunc("POST /v1/projects/{project}/notes", s.postNote)
	s.artifactRoutes(api)
	s.sessionRoutes(api)
	s.taskRoutes(api)
	s.memoryRoutes(api)
	s.nativeActivityRoutes(api)
	s.adminRoutes(api)
	s.onboardingRoutes(api, mux)
	mux.Handle("/v1/", s.authenticate(api))
	for _, pattern := range []string{"GET /{$}", "GET /index.html", "GET /app.js", "GET /app.css"} {
		mux.HandleFunc(pattern, s.static)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		mux.ServeHTTP(w, r)
	})
}
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	files := map[string]string{"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/app.css": "app.css"}
	name, ok := files[r.URL.Path]
	if !ok || s.WebDir == "" {
		http.NotFound(w, r)
		return
	}
	full := filepath.Join(s.WebDir, name)
	info, err := os.Lstat(full)
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, full)
}
func (s *Server) auth(ctx context.Context, key string) (Principal, error) {
	var p Principal
	if len(key) != 64 {
		return p, pgx.ErrNoRows
	}
	err := s.Store.Pool.QueryRow(ctx, "SELECT id,name,kind FROM principals WHERE key_hash=$1", digest(key)).Scan(&p.ID, &p.Name, &p.Kind)
	return p, err
}
func bearer(r *http.Request) string {
	v := r.Header.Values("Authorization")
	if len(v) != 1 || !strings.HasPrefix(v[0], "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(v[0], "Bearer ")
}
func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, err := s.auth(r.Context(), bearer(r))
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				fail(w, 401, "invalid or revoked key")
			} else {
				fail(w, 503, "authentication temporarily unavailable")
			}
			return
		}
		if (r.URL.Path == "/v1/admin" || strings.HasPrefix(r.URL.Path, "/v1/admin/")) && p.Kind != "owner" {
			fail(w, 403, "owner access required")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), contextKey{}, p)))
	})
}
func projectAccess(ctx context.Context, q querier, id, agent string, write bool) bool {
	if !validID(id) {
		return false
	}
	var ok bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM project_members pm JOIN projects p ON p.id=pm.project_id WHERE project_id=$1 AND agent_id=$2 AND p.archived_at IS NULL AND (NOT $3::boolean OR can_write)) OR
 (NOT $3::boolean AND EXISTS(SELECT 1 FROM principals WHERE id=$2 AND kind='owner') AND EXISTS(SELECT 1 FROM projects WHERE id=$1))`, id, agent, write).Scan(&ok)
	return err == nil && ok
}
func channelAccess(ctx context.Context, q querier, id, agent string, write bool) bool {
	if !validID(id) {
		return false
	}
	var ok bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM channel_members cm JOIN channels c ON c.id=cm.channel_id JOIN projects p ON p.id=c.project_id JOIN project_members pm ON pm.project_id=c.project_id AND pm.agent_id=cm.agent_id WHERE cm.channel_id=$1 AND cm.agent_id=$2 AND p.archived_at IS NULL AND (NOT $3::boolean OR (cm.can_write AND pm.can_write))) OR
 (NOT $3::boolean AND EXISTS(SELECT 1 FROM principals WHERE id=$2 AND kind='owner') AND EXISTS(SELECT 1 FROM channels WHERE id=$1))`, id, agent, write).Scan(&ok)
	return err == nil && ok
}
func (s *Server) projectAllowed(w http.ResponseWriter, r *http.Request, write bool) bool {
	if !projectAccess(r.Context(), s.Store.Pool, r.PathValue("project"), principal(r).ID, write) {
		fail(w, 404, "not found")
		return false
	}
	return true
}
func (s *Server) channelAllowed(w http.ResponseWriter, r *http.Request, write bool) bool {
	if !channelAccess(r.Context(), s.Store.Pool, r.PathValue("channel"), principal(r).ID, write) {
		fail(w, 404, "not found")
		return false
	}
	return true
}

func (s *Server) projects(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Store.Pool.Query(r.Context(), `SELECT p.id,p.name,p.archived_at,p.lifecycle_version FROM projects p WHERE p.archived_at IS NULL AND ($2::boolean OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.agent_id=$1)) ORDER BY p.id`, principal(r).ID, principal(r).Kind == "owner")
	if err != nil {
		internal(w)
		return
	}
	defer rows.Close()
	result := []Project{}
	for rows.Next() {
		var p Project
		if rows.Scan(&p.ID, &p.Name, &p.ArchivedAt, &p.LifecycleVersion) != nil {
			internal(w)
			return
		}
		result = append(result, p)
	}
	if rows.Err() != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"projects": result})
}
func (s *Server) channels(w http.ResponseWriter, r *http.Request) {
	if !s.projectAllowed(w, r, false) {
		return
	}
	// The existing messages(channel_id,seq) unique index serves one descending
	// lookup per visible channel; telemetry never advances this message position.
	rows, err := s.Store.Pool.Query(r.Context(), `SELECT c.id,c.project_id,c.name,c.cursor,
 COALESCE((SELECT m.seq FROM messages m WHERE m.channel_id=c.id ORDER BY m.seq DESC LIMIT 1),0),
 NOT $3::boolean AND COALESCE(cm.can_write AND pm.can_write,false),
 ARRAY(SELECT x.agent_id FROM channel_members x JOIN project_members y ON y.agent_id=x.agent_id AND y.project_id=c.project_id WHERE x.channel_id=c.id ORDER BY x.agent_id)
 FROM channels c LEFT JOIN channel_members cm ON cm.channel_id=c.id AND cm.agent_id=$2 LEFT JOIN project_members pm ON pm.project_id=c.project_id AND pm.agent_id=$2 WHERE c.project_id=$1 AND ($3::boolean OR (cm.agent_id IS NOT NULL AND pm.agent_id IS NOT NULL)) ORDER BY c.id`, r.PathValue("project"), principal(r).ID, principal(r).Kind == "owner")
	if err != nil {
		internal(w)
		return
	}
	defer rows.Close()
	type visibleChannel struct {
		Channel
		LatestSeq        int64    `json:"latest_seq"`
		LatestMessageSeq int64    `json:"latest_message_seq"`
		CanWrite         bool     `json:"can_write"`
		MemberIDs        []string `json:"member_ids"`
	}
	result := []visibleChannel{}
	for rows.Next() {
		var c visibleChannel
		if rows.Scan(&c.ID, &c.ProjectID, &c.Name, &c.LatestSeq, &c.LatestMessageSeq, &c.CanWrite, &c.MemberIDs) != nil {
			internal(w)
			return
		}
		result = append(result, c)
	}
	if rows.Err() != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"channels": result})
}
func (s *Server) agents(w http.ResponseWriter, r *http.Request) {
	if !s.projectAllowed(w, r, false) {
		return
	}
	rows, err := s.Store.Pool.Query(r.Context(), `SELECT p.id,p.name,p.kind,p.runtime,p.session_id,p.last_seen_at,p.activity,
 ARRAY(SELECT c.id FROM channels c JOIN channel_members theirs ON theirs.channel_id=c.id AND theirs.agent_id=p.id WHERE c.project_id=$1 AND ($3::boolean OR EXISTS(SELECT 1 FROM channel_members mine WHERE mine.channel_id=c.id AND mine.agent_id=$2)) ORDER BY c.id),clock_timestamp()
 FROM principals p JOIN project_members pm ON pm.agent_id=p.id AND pm.project_id=$1
 WHERE $3::boolean OR EXISTS(SELECT 1 FROM channels c JOIN channel_members mine ON mine.channel_id=c.id AND mine.agent_id=$2 JOIN channel_members theirs ON theirs.channel_id=c.id AND theirs.agent_id=p.id WHERE c.project_id=$1) ORDER BY p.id`, r.PathValue("project"), principal(r).ID, principal(r).Kind == "owner")
	if err != nil {
		internal(w)
		return
	}
	defer rows.Close()
	type visibleAgent struct {
		Agent
		ChannelIDs []string `json:"channel_ids"`
	}
	result := []visibleAgent{}
	for rows.Next() {
		var a visibleAgent
		var now time.Time
		if rows.Scan(&a.ID, &a.Name, &a.Kind, &a.Runtime, &a.SessionID, &a.LastSeenAt, &a.Activity, &a.ChannelIDs, &now) != nil {
			internal(w)
			return
		}
		a.Freshness = fresh(a.LastSeenAt, now)
		result = append(result, a)
	}
	if rows.Err() != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"agents": result})
}
func pagination(w http.ResponseWriter, r *http.Request, param string) (int64, int, bool) {
	after := int64(0)
	limit := 100
	var err error
	if v := r.URL.Query().Get(param); v != "" {
		after, err = strconv.ParseInt(v, 10, 64)
		if err != nil || after < 0 {
			fail(w, 400, "invalid cursor")
			return 0, 0, false
		}
	}
	if v := r.URL.Query().Get("limit"); v != "" {
		limit, err = strconv.Atoi(v)
		if err != nil || limit < 1 {
			fail(w, 400, "invalid limit")
			return 0, 0, false
		}
		if limit > 100 {
			limit = 100
		}
	}
	return after, limit, true
}
func (s *Server) messages(w http.ResponseWriter, r *http.Request) {
	if !s.channelAllowed(w, r, false) {
		return
	}
	after, limit, ok := pagination(w, r, "after_seq")
	if !ok {
		return
	}
	rows, err := s.Store.Pool.Query(r.Context(), "SELECT id FROM messages WHERE channel_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", r.PathValue("channel"), after, limit)
	if err != nil {
		internal(w)
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) != nil {
			rows.Close()
			internal(w)
			return
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		internal(w)
		return
	}
	result := []Message{}
	for _, id := range ids {
		m, e := loadMessage(r.Context(), s.Store.Pool, id)
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				fail(w, 404, "not found")
				return
			}
			internal(w)
			return
		}
		result = append(result, m)
	}
	respond(w, 200, map[string]any{"messages": result})
}
func (s *Server) authorizedMessage(w http.ResponseWriter, r *http.Request) (Message, bool) {
	id := r.PathValue("message")
	if !validID(id) {
		fail(w, 404, "not found")
		return Message{}, false
	}
	var channel string
	if s.Store.Pool.QueryRow(r.Context(), "SELECT channel_id FROM messages WHERE id=$1", id).Scan(&channel) != nil || !channelAccess(r.Context(), s.Store.Pool, channel, principal(r).ID, false) {
		fail(w, 404, "not found")
		return Message{}, false
	}
	m, err := loadMessage(r.Context(), s.Store.Pool, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			fail(w, 404, "not found")
			return m, false
		}
		internal(w)
		return m, false
	}
	return m, true
}
func (s *Server) message(w http.ResponseWriter, r *http.Request) {
	m, ok := s.authorizedMessage(w, r)
	if ok {
		respond(w, 200, map[string]any{"message": m})
	}
}

type messageInput struct {
	ClientID     string   `json:"client_id"`
	Body         string   `json:"body"`
	RecipientIDs []string `json:"recipient_ids"`
	ReplyTo      *string  `json:"reply_to"`
}

func (s *Server) postMessage(w http.ResponseWriter, r *http.Request) {
	if principal(r).Kind != "agent" || !s.channelAllowed(w, r, true) {
		if principal(r).Kind != "agent" {
			fail(w, 404, "not found")
		}
		return
	}
	var in messageInput
	if !decode(w, r, &in) {
		return
	}
	if !validID(in.ClientID) || !validText(in.Body, 16384) || len(in.RecipientIDs) > 32 || in.RecipientIDs == nil || (in.ReplyTo != nil && !validID(*in.ReplyTo)) {
		fail(w, 400, "invalid message fields")
		return
	}
	sort.Strings(in.RecipientIDs)
	for i, id := range in.RecipientIDs {
		if !validID(id) || (i > 0 && id == in.RecipientIDs[i-1]) {
			fail(w, 400, "invalid or duplicate recipient")
			return
		}
	}
	canonical, _ := json.Marshal(in)
	hash := digest(string(canonical))
	ctx := r.Context()
	channel := r.PathValue("channel")
	p := principal(r)
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	if !s.authorizeWrite(w, r, tx, false) {
		return
	}
	if !channelAccess(ctx, tx, channel, p.ID, true) {
		fail(w, 404, "not found")
		return
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM channels WHERE id=$1 FOR UPDATE", channel); err != nil {
		internal(w)
		return
	}
	var existing string
	var oldHash []byte
	err = tx.QueryRow(ctx, "SELECT id,payload_hash FROM messages WHERE channel_id=$1 AND author_id=$2 AND client_id=$3", channel, p.ID, in.ClientID).Scan(&existing, &oldHash)
	if err == nil {
		if !bytes.Equal(hash, oldHash) {
			fail(w, 409, "client_id payload conflict")
			return
		}
		m, e := loadMessage(ctx, tx, existing)
		if e != nil {
			internal(w)
			return
		}
		respond(w, 200, map[string]any{"message": m, "replayed": true})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		internal(w)
		return
	}
	for _, id := range in.RecipientIDs {
		if !channelAccess(ctx, tx, channel, id, false) {
			fail(w, 404, "recipient not found")
			return
		}
		var kind string
		if tx.QueryRow(ctx, "SELECT kind FROM principals WHERE id=$1", id).Scan(&kind) != nil || kind != "agent" {
			fail(w, 400, "recipient must be an agent")
			return
		}
	}
	if in.ReplyTo != nil {
		var ok bool
		if tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM messages WHERE id=$1 AND channel_id=$2)", *in.ReplyTo, channel).Scan(&ok) != nil {
			internal(w)
			return
		}
		if !ok {
			fail(w, 404, "reply target not found")
			return
		}
	}
	id, err := randomHex(16)
	if err != nil {
		internal(w)
		return
	}
	seq, err := addEvent(ctx, tx, channel, "message.created", id)
	if err != nil {
		internal(w)
		return
	}
	if _, err = tx.Exec(ctx, "INSERT INTO messages(id,channel_id,seq,author_id,client_id,body,recipient_ids,reply_to,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", id, channel, seq, p.ID, in.ClientID, in.Body, in.RecipientIDs, in.ReplyTo, hash); err != nil {
		internal(w)
		return
	}
	for _, recipient := range in.RecipientIDs {
		if _, err = tx.Exec(ctx, "INSERT INTO receipts(message_id,agent_id) VALUES($1,$2)", id, recipient); err != nil {
			internal(w)
			return
		}
	}
	m, err := loadMessage(ctx, tx, id)
	if err != nil {
		internal(w)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		internal(w)
		return
	}
	respond(w, 201, map[string]any{"message": m, "replayed": false})
}

func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request) {
	if principal(r).Kind != "agent" {
		fail(w, 404, "not found")
		return
	}
	var in struct {
		SessionID string `json:"session_id"`
		Activity  string `json:"activity"`
		Runtime   string `json:"runtime"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validID(in.SessionID) || len(in.Activity) > 512 || strings.ContainsRune(in.Activity, 0) || !validText(in.Runtime, 64) {
		fail(w, 400, "invalid heartbeat fields")
		return
	}
	ctx := r.Context()
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	if !s.authorizeWrite(w, r, tx, false) {
		return
	}
	var session string
	var last *time.Time
	var now time.Time
	if err = tx.QueryRow(ctx, "SELECT session_id,last_seen_at,clock_timestamp() FROM principals WHERE id=$1 FOR UPDATE", principal(r).ID).Scan(&session, &last, &now); err != nil {
		internal(w)
		return
	}
	if session != in.SessionID && fresh(last, now) == "fresh" {
		fail(w, 409, "another session holds the fresh lease")
		return
	}
	var a Agent
	if err = tx.QueryRow(ctx, "UPDATE principals SET session_id=$1,activity=$2,runtime=$3,last_seen_at=clock_timestamp() WHERE id=$4 RETURNING id,name,kind,runtime,session_id,last_seen_at,activity", in.SessionID, in.Activity, in.Runtime, principal(r).ID).Scan(&a.ID, &a.Name, &a.Kind, &a.Runtime, &a.SessionID, &a.LastSeenAt, &a.Activity); err != nil {
		internal(w)
		return
	}
	a.Freshness = "fresh"
	if tx.Commit(ctx) != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"agent": a})
}

func (s *Server) receipt(w http.ResponseWriter, r *http.Request) {
	if principal(r).Kind != "agent" {
		fail(w, 404, "not found")
		return
	}
	m, ok := s.authorizedMessage(w, r)
	if !ok {
		return
	}
	var in struct {
		Status    string `json:"status"`
		SessionID string `json:"session_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validID(in.SessionID) || (in.Status != "delivered" && in.Status != "accepted" && in.Status != "uncertain") {
		fail(w, 400, "invalid receipt fields")
		return
	}
	ctx := r.Context()
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	if !s.authorizeWrite(w, r, tx, false) {
		return
	}
	if !channelAccess(ctx, tx, m.ChannelID, principal(r).ID, false) {
		fail(w, 404, "not found")
		return
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM channels WHERE id=$1 FOR UPDATE", m.ChannelID); err != nil {
		internal(w)
		return
	}
	var lease string
	var last *time.Time
	var now time.Time
	if err = tx.QueryRow(ctx, "SELECT session_id,last_seen_at,clock_timestamp() FROM principals WHERE id=$1 FOR UPDATE", principal(r).ID).Scan(&lease, &last, &now); err != nil {
		internal(w)
		return
	}
	if lease != in.SessionID || fresh(last, now) != "fresh" {
		fail(w, 409, "fresh matching session required")
		return
	}
	var receipt Receipt
	err = tx.QueryRow(ctx, "SELECT agent_id,delivered_at,accepted_at,uncertain_at,session_id FROM receipts WHERE message_id=$1 AND agent_id=$2 FOR UPDATE", m.ID, principal(r).ID).Scan(&receipt.AgentID, &receipt.DeliveredAt, &receipt.AcceptedAt, &receipt.UncertainAt, &receipt.SessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "receipt not found")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	if receipt.UncertainAt != nil && in.Status != "uncertain" {
		fail(w, 409, "uncertain receipt is terminal")
		return
	}
	if in.Status == "accepted" && receipt.DeliveredAt == nil {
		fail(w, 409, "delivered receipt required first")
		return
	}
	if in.Status == "accepted" && receipt.SessionID != in.SessionID {
		fail(w, 409, "delivery belongs to another session")
		return
	}
	// A fresh lease may recover a durable delivery that has not been dispatched.
	// Accepted or uncertain work cannot be reassigned to a new session.
	rebind := in.Status == "delivered" && receipt.DeliveredAt != nil && receipt.SessionID != in.SessionID
	if rebind && (receipt.AcceptedAt != nil || receipt.UncertainAt != nil) {
		fail(w, 409, "delivery belongs to another session")
		return
	}
	changed := rebind || in.Status == "delivered" && receipt.DeliveredAt == nil || in.Status == "accepted" && receipt.AcceptedAt == nil || in.Status == "uncertain" && receipt.UncertainAt == nil
	if changed {
		column := map[string]string{"delivered": "delivered_at", "accepted": "accepted_at", "uncertain": "uncertain_at"}[in.Status]
		if _, err = tx.Exec(ctx, "UPDATE receipts SET "+column+"=COALESCE("+column+",clock_timestamp()),session_id=$3 WHERE message_id=$1 AND agent_id=$2", m.ID, principal(r).ID, in.SessionID); err != nil {
			internal(w)
			return
		}
		if _, err = addEvent(ctx, tx, m.ChannelID, "receipt."+in.Status, m.ID); err != nil {
			internal(w)
			return
		}
	}
	updated, err := loadMessage(ctx, tx, m.ID)
	if err != nil {
		internal(w)
		return
	}
	if tx.Commit(ctx) != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"message": updated})
}

func (s *Server) loadEvents(ctx context.Context, channel string, after int64, limit int) ([]Event, error) {
	rows, err := s.Store.Pool.Query(ctx, "SELECT seq,channel_id,kind,entity_id,created_at FROM events WHERE channel_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", channel, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Event{}
	for rows.Next() {
		var e Event
		if err = rows.Scan(&e.Seq, &e.ChannelID, &e.Kind, &e.EntityID, &e.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, e)
	}
	return result, rows.Err()
}
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	if !s.channelAllowed(w, r, false) {
		return
	}
	after, limit, ok := pagination(w, r, "after")
	if !ok {
		return
	}
	result, err := s.loadEvents(r.Context(), r.PathValue("channel"), after, limit)
	if err != nil {
		internal(w)
		return
	}
	cursor := after
	if len(result) > 0 {
		cursor = result[len(result)-1].Seq
	}
	respond(w, 200, map[string]any{"events": result, "cursor": cursor})
}
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	if !s.channelAllowed(w, r, false) {
		return
	}
	after, _, ok := pagination(w, r, "after")
	if !ok {
		return
	}
	if v := r.Header.Get("Last-Event-ID"); v != "" {
		n, e := strconv.ParseInt(v, 10, 64)
		if e != nil || n < 0 {
			fail(w, 400, "invalid Last-Event-ID")
			return
		}
		after = n
	}
	if _, ok := w.(http.Flusher); !ok {
		fail(w, 500, "streaming unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	key := bearer(r)
	channel := r.PathValue("channel")
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	heartbeat := time.Now()
	deadline := time.NewTimer(30 * time.Minute)
	defer deadline.Stop()
	for {
		// Recheck both current key and ACL before each batch, including idle periods.
		p, err := s.auth(r.Context(), key)
		if err != nil || !channelAccess(r.Context(), s.Store.Pool, channel, p.ID, false) {
			return
		}
		events, err := s.loadEvents(r.Context(), channel, after, 100)
		if err != nil {
			return
		}
		_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
		for _, event := range events {
			data, _ := json.Marshal(event)
			if _, err = fmt.Fprintf(w, "id: %d\nevent: hint\ndata: %s\n\n", event.Seq, data); err != nil {
				return
			}
			after = event.Seq
		}
		if len(events) > 0 || time.Since(heartbeat) >= 10*time.Second {
			if len(events) == 0 {
				if _, err = io.WriteString(w, ": keepalive\n\n"); err != nil {
					return
				}
			}
			if controller.Flush() != nil {
				return
			}
			heartbeat = time.Now()
		}
		if len(events) == 100 {
			continue
		}
		// Flush headers immediately even when the channel has no events yet.
		if err = controller.Flush(); err != nil {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-deadline.C:
			return
		case <-ticker.C:
		}
	}
}

const noteSelect = `SELECT id,project_id,author_id,title,body,source_message_id,version,created_at FROM notes `

func scanNote(row pgx.Row) (Note, error) {
	var n Note
	err := row.Scan(&n.ID, &n.ProjectID, &n.AuthorID, &n.Title, &n.Body, &n.SourceMessageID, &n.Version, &n.CreatedAt)
	return n, err
}
func (s *Server) notes(w http.ResponseWriter, r *http.Request) {
	if !s.projectAllowed(w, r, false) {
		return
	}
	rows, err := s.Store.Pool.Query(r.Context(), noteSelect+"WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1001", r.PathValue("project"))
	if err != nil {
		internal(w)
		return
	}
	defer rows.Close()
	result := []Note{}
	for rows.Next() {
		n, e := scanNote(rows)
		if e != nil {
			internal(w)
			return
		}
		result = append(result, n)
	}
	if rows.Err() != nil {
		internal(w)
		return
	}
	truncated := len(result) > 1000
	if truncated {
		result = result[:1000]
	}
	// Select the newest bounded window, but preserve chronological display order.
	for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
		result[left], result[right] = result[right], result[left]
	}
	respond(w, 200, map[string]any{"notes": result, "truncated": truncated})
}
func (s *Server) postNote(w http.ResponseWriter, r *http.Request) {
	if principal(r).Kind != "agent" || !s.projectAllowed(w, r, true) {
		if principal(r).Kind != "agent" {
			fail(w, 404, "not found")
		}
		return
	}
	var in struct {
		ClientID        string  `json:"client_id"`
		Title           string  `json:"title"`
		Body            string  `json:"body"`
		SourceMessageID *string `json:"source_message_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validID(in.ClientID) || !validText(in.Title, 200) || !validText(in.Body, 16384) || (in.SourceMessageID != nil && !validID(*in.SourceMessageID)) {
		fail(w, 400, "invalid note fields")
		return
	}
	canonical, _ := json.Marshal(in)
	hash := digest(string(canonical))
	ctx := r.Context()
	project := r.PathValue("project")
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		internal(w)
		return
	}
	defer tx.Rollback(ctx)
	if !s.authorizeWrite(w, r, tx, false) {
		return
	}
	if !projectAccess(ctx, tx, project, principal(r).ID, true) {
		fail(w, 404, "not found")
		return
	}
	if _, err = tx.Exec(ctx, "SELECT id FROM projects WHERE id=$1 FOR UPDATE", project); err != nil {
		internal(w)
		return
	}
	var id string
	var oldHash []byte
	err = tx.QueryRow(ctx, "SELECT id,payload_hash FROM notes WHERE project_id=$1 AND author_id=$2 AND client_id=$3", project, principal(r).ID, in.ClientID).Scan(&id, &oldHash)
	if err == nil {
		if !bytes.Equal(hash, oldHash) {
			fail(w, 409, "client_id payload conflict")
			return
		}
		n, e := scanNote(tx.QueryRow(ctx, noteSelect+"WHERE id=$1", id))
		if e != nil {
			internal(w)
			return
		}
		respond(w, 200, map[string]any{"note": n, "replayed": true})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		internal(w)
		return
	}
	if in.SourceMessageID != nil {
		var sourceChannel string
		if err = tx.QueryRow(ctx, "SELECT m.channel_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id=$1 AND c.project_id=$2", *in.SourceMessageID, project).Scan(&sourceChannel); err != nil {
			fail(w, 404, "source message not found")
			return
		}
		if !channelAccess(ctx, tx, sourceChannel, principal(r).ID, false) {
			fail(w, 404, "source message not found")
			return
		}
		var restricted bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=$1 AND NOT EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=$2 AND cm.agent_id=pm.agent_id))", project, sourceChannel).Scan(&restricted); err != nil {
			internal(w)
			return
		}
		if restricted {
			fail(w, 400, "restricted source cannot be published project-wide")
			return
		}
	}
	id, err = randomHex(16)
	if err != nil {
		internal(w)
		return
	}
	n, err := scanNote(tx.QueryRow(ctx, "INSERT INTO notes(id,project_id,author_id,client_id,title,body,source_message_id,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,project_id,author_id,title,body,source_message_id,version,created_at", id, project, principal(r).ID, in.ClientID, in.Title, in.Body, in.SourceMessageID, hash))
	if err != nil {
		internal(w)
		return
	}
	if tx.Commit(ctx) != nil {
		internal(w)
		return
	}
	respond(w, 201, map[string]any{"note": n, "replayed": false})
}
