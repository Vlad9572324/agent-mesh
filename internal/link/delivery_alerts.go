package link

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
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

//go:embed delivery_alerts_schema.sql
var deliveryAlertsSchema string

type deliveryPolicy struct {
	Enabled             bool       `json:"enabled"`
	AckTimeoutSeconds   int        `json:"ack_timeout_seconds"`
	ReplyTimeoutSeconds int        `json:"reply_timeout_seconds"`
	EnabledAt           *time.Time `json:"enabled_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
	Version             int64      `json:"version"`
}

const deliveryPolicyColumns = `enabled,ack_timeout_seconds,reply_timeout_seconds,enabled_at,updated_at,version`

func scanDeliveryPolicy(row pgx.Row) (deliveryPolicy, error) {
	var p deliveryPolicy
	err := row.Scan(&p.Enabled, &p.AckTimeoutSeconds, &p.ReplyTimeoutSeconds, &p.EnabledAt, &p.UpdatedAt, &p.Version)
	return p, err
}

// Each deadline read uses one bounded snapshot and rechecks both the actual role
// and current key. The caller's middleware role alone is never authority.
func (s *Server) deliveryReadTx(w http.ResponseWriter, r *http.Request) (pgx.Tx, bool) {
	tx, err := s.Store.Pool.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		internal(w)
		return nil, false
	}
	var kind string
	err = tx.QueryRow(r.Context(), `SELECT kind FROM principals WHERE id=$1 AND key_hash=$2`, principal(r).ID, digest(bearer(r))).Scan(&kind)
	if err != nil || kind != "owner" {
		_ = tx.Rollback(r.Context())
		if errors.Is(err, pgx.ErrNoRows) {
			fail(w, 401, "invalid or revoked key")
		} else if err != nil {
			internal(w)
		} else {
			fail(w, 403, "owner access required")
		}
		return nil, false
	}
	return tx, true
}

func (s *Server) adminDeliveryPolicy(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	if r.URL.RawQuery != "" {
		fail(w, 400, "unexpected policy query")
		return
	}
	tx, ok := s.deliveryReadTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(ctx)
	p, err := scanDeliveryPolicy(tx.QueryRow(ctx, `SELECT `+deliveryPolicyColumns+` FROM delivery_alert_policy WHERE singleton`))
	if err != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"policy": p})
}

func (s *Server) adminUpdateDeliveryPolicy(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	if r.URL.RawQuery != "" {
		fail(w, 400, "unexpected policy query")
		return
	}
	var in struct {
		Enabled *bool  `json:"enabled"`
		Ack     *int   `json:"ack_timeout_seconds"`
		Reply   *int   `json:"reply_timeout_seconds"`
		Version *int64 `json:"expected_version"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Enabled == nil || in.Ack == nil || in.Reply == nil || in.Version == nil || *in.Version < 0 || *in.Ack < 60 || *in.Ack > 86400 || (*in.Reply != 0 && (*in.Reply < *in.Ack || *in.Reply > 604800)) {
		fail(w, 400, "invalid delivery policy fields")
		return
	}
	tx, ok := s.adminTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(ctx)
	p, err := scanDeliveryPolicy(tx.QueryRow(ctx, `UPDATE delivery_alert_policy SET
 enabled=$1,ack_timeout_seconds=$2,reply_timeout_seconds=$3,
 enabled_at=CASE WHEN $1 AND NOT enabled THEN clock_timestamp() ELSE enabled_at END,
 updated_at=clock_timestamp(),version=version+1 WHERE singleton AND version=$4
 RETURNING `+deliveryPolicyColumns, *in.Enabled, *in.Ack, *in.Reply, *in.Version))
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 409, "delivery policy version conflict")
		return
	}
	if err != nil {
		internal(w)
		return
	}
	if adminCommit(w, r, tx, "delivery_policy.update", "delivery_policy", "global", auditDetails{}) {
		respond(w, 200, map[string]any{"policy": p})
	}
}

type deliveryAlert struct {
	MessageID        string     `json:"message_id"`
	MessageSeq       int64      `json:"message_seq"`
	ProjectID        string     `json:"project_id"`
	ChannelID        string     `json:"channel_id"`
	AuthorID         string     `json:"author_id"`
	RecipientID      string     `json:"recipient_id"`
	CreatedAt        time.Time  `json:"created_at"`
	DueAt            time.Time  `json:"due_at"`
	Reason           string     `json:"reason"`
	OfferedAt        *time.Time `json:"offered_at"`
	SeenAt           *time.Time `json:"seen_at"`
	AcceptedAt       *time.Time `json:"accepted_at"`
	DeliveredAt      *time.Time `json:"delivered_at"`
	LegacyAcceptedAt *time.Time `json:"legacy_accepted_at"`
	AnsweredAt       *time.Time `json:"answered_at"`
}

type deliveryAlertCursor struct {
	Format        int       `json:"format"`
	Reader        string    `json:"reader"`
	PolicyVersion int64     `json:"policy_version"`
	AsOf          time.Time `json:"as_of"`
	CreatedAt     time.Time `json:"created_at"`
	MessageID     string    `json:"message_id"`
	RecipientID   string    `json:"recipient_id"`
}

// Authentication-key MAC binds pagination to this reader/key across restarts,
// without another persisted secret or an unauthenticated editable page offset.
func encodeDeliveryCursor(c deliveryAlertCursor, key string) string {
	b, _ := json.Marshal(c)
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write(b)
	return base64.RawURLEncoding.EncodeToString(b) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func decodeDeliveryCursor(raw, key, reader string) (deliveryAlertCursor, bool) {
	var c deliveryAlertCursor
	if len(raw) > 2048 {
		return c, false
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 {
		return c, false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if err != nil {
		return c, false
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if err != nil {
		return c, false
	}
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write(b)
	if !hmac.Equal(signature, mac.Sum(nil)) || json.Unmarshal(b, &c) != nil {
		return c, false
	}
	return c, c.Format == 1 && c.Reader == reader && c.PolicyVersion >= 0 && !c.AsOf.IsZero() && !c.CreatedAt.IsZero() && !c.CreatedAt.After(c.AsOf) && validID(c.MessageID) && validID(c.RecipientID)
}

// A direct answer is an immutable same-channel reply by the exact recipient,
// explicitly directed back to the original author. Broadcasts, quotations,
// other authors and matching text/session strings never satisfy it.
// All evidence stages remain independent. An offer alone is not acknowledgement.
const deliveryAlertQuery = `WITH evidence AS (
 SELECT m.id AS message_id,m.seq AS message_seq,c.project_id,m.channel_id,m.author_id,
 recipient.id AS recipient_id,m.created_at,n.offered_at,n.seen_at,n.accepted_at,
 r.delivered_at,r.accepted_at AS legacy_accepted_at,a.answered_at,
 (n.seen_at IS NOT NULL OR n.accepted_at IS NOT NULL OR r.delivered_at IS NOT NULL OR r.accepted_at IS NOT NULL) AS acknowledged
 FROM messages m JOIN channels c ON c.id=m.channel_id JOIN projects p ON p.id=c.project_id
 CROSS JOIN LATERAL jsonb_array_elements_text(m.recipient_ids) AS recipient(id)
 LEFT JOIN receipts r ON r.message_id=m.id AND r.agent_id=recipient.id
 LEFT JOIN LATERAL (
  SELECT min(created_at) FILTER(WHERE event_type='inbox.offered') AS offered_at,
   min(created_at) FILTER(WHERE event_type='inbox.seen') AS seen_at,
   min(created_at) FILTER(WHERE event_type='inbox.accepted') AS accepted_at
  FROM native_activity WHERE message_id=m.id AND channel_id=m.channel_id AND actor_id=recipient.id
   AND event_type IN ('inbox.offered','inbox.seen','inbox.accepted')
 ) n ON true
 LEFT JOIN LATERAL (
  SELECT min(created_at) AS answered_at FROM messages reply
  WHERE reply.reply_to=m.id AND reply.channel_id=m.channel_id AND reply.author_id=recipient.id
   AND reply.recipient_ids ? m.author_id
 ) a ON true
 WHERE p.archived_at IS NULL AND m.created_at >= $1 AND m.created_at <= $2
), alerts AS (
 SELECT message_id,message_seq,project_id,channel_id,author_id,recipient_id,created_at,
 created_at+make_interval(secs => CASE WHEN acknowledged THEN $4::integer ELSE $3::integer END) AS due_at,
 CASE WHEN acknowledged THEN 'unanswered' ELSE 'unacknowledged' END AS reason,
 offered_at,seen_at,accepted_at,delivered_at,legacy_accepted_at,answered_at
 FROM evidence WHERE answered_at IS NULL AND
 ((NOT acknowledged AND created_at+make_interval(secs=>$3::integer)<=$2) OR
 (acknowledged AND $4>0 AND created_at+make_interval(secs=>$4::integer)<=$2))
), page AS (
 SELECT * FROM alerts WHERE ($5::timestamptz IS NULL OR (created_at,message_id,recipient_id)>($5,$6,$7))
 ORDER BY created_at,message_id,recipient_id LIMIT $8
)
 SELECT (SELECT count(*) FROM alerts),
 COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at,message_id,recipient_id) FROM page),'[]'::jsonb)`

func loadDeliveryAlerts(ctx context.Context, tx pgx.Tx, p deliveryPolicy, asOf time.Time, c *deliveryAlertCursor, limit int) ([]deliveryAlert, int64, error) {
	var after *time.Time
	message, recipient := "", ""
	if c != nil {
		after = &c.CreatedAt
		message = c.MessageID
		recipient = c.RecipientID
	}
	var count int64
	var raw []byte
	err := tx.QueryRow(ctx, deliveryAlertQuery, p.EnabledAt, asOf, p.AckTimeoutSeconds, p.ReplyTimeoutSeconds, after, message, recipient, limit).Scan(&count, &raw)
	if err != nil {
		return nil, 0, err
	}
	var alerts []deliveryAlert
	err = json.Unmarshal(raw, &alerts)
	return alerts, count, err
}

func (s *Server) adminDeliveryAlerts(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	if len(r.URL.RawQuery) > 4096 {
		fail(w, 400, "invalid delivery alerts query")
		return
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		fail(w, 400, "invalid delivery alerts query")
		return
	}
	limit := 50
	var cursor *deliveryAlertCursor
	for name, values := range query {
		if len(values) != 1 || values[0] == "" {
			fail(w, 400, "invalid delivery alerts query")
			return
		}
		switch name {
		case "limit":
			limit, err = strconv.Atoi(values[0])
			if err != nil || limit < 1 || limit > 100 {
				fail(w, 400, "invalid delivery alerts limit")
				return
			}
		case "cursor":
			c, ok := decodeDeliveryCursor(values[0], bearer(r), principal(r).ID)
			if !ok {
				fail(w, 400, "invalid delivery alerts cursor")
				return
			}
			cursor = &c
		default:
			fail(w, 400, "invalid delivery alerts query")
			return
		}
	}
	tx, ok := s.deliveryReadTx(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(ctx)
	p, err := scanDeliveryPolicy(tx.QueryRow(ctx, `SELECT `+deliveryPolicyColumns+` FROM delivery_alert_policy WHERE singleton`))
	if err != nil {
		internal(w)
		return
	}
	var now time.Time
	if tx.QueryRow(ctx, `SELECT transaction_timestamp()`).Scan(&now) != nil {
		internal(w)
		return
	}
	asOf := now
	if cursor != nil {
		if cursor.PolicyVersion != p.Version {
			fail(w, 409, "delivery policy changed; refresh alerts")
			return
		}
		if cursor.AsOf.After(now) {
			fail(w, 400, "invalid delivery alerts cursor")
			return
		}
		asOf = cursor.AsOf
	}
	alerts := []deliveryAlert{}
	var total int64
	if p.Enabled {
		alerts, total, err = loadDeliveryAlerts(ctx, tx, p, asOf, cursor, limit+1)
		if err != nil {
			internal(w)
			return
		}
	}
	more := len(alerts) > limit
	var next *string
	if more {
		alerts = alerts[:limit]
		last := alerts[len(alerts)-1]
		value := encodeDeliveryCursor(deliveryAlertCursor{Format: 1, Reader: principal(r).ID, PolicyVersion: p.Version, AsOf: asOf, CreatedAt: last.CreatedAt, MessageID: last.MessageID, RecipientID: last.RecipientID}, bearer(r))
		next = &value
	}
	respond(w, 200, map[string]any{"alerts": alerts, "total": total, "truncated": more, "next_cursor": next, "generated_at": now, "as_of": asOf, "policy": p})
}
