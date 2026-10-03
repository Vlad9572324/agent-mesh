package link

import (
	"context"
	"net/http"
	"net/url"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// NativeReceipt summarizes immutable, attributed inbox reports. Each timestamp
// is independent: acceptance does not invent an offer, view, or completion.
// These reports never modify the legacy delivery receipt protocol.
type NativeReceipt struct {
	MessageID      string     `json:"message_id"`
	AgentID        string     `json:"agent_id"`
	OfferedAt      *time.Time `json:"offered_at"`
	SeenAt         *time.Time `json:"seen_at"`
	AcceptedAt     *time.Time `json:"accepted_at"`
	Provenance     string     `json:"provenance"`
	ServerVerified bool       `json:"server_verified"`
}

const nativeReceiptBatchLimit = 100

const nativeReceiptQuery = `SELECT n.message_id,n.actor_id,
 min(n.created_at) FILTER (WHERE n.event_type='inbox.offered'),
 min(n.created_at) FILTER (WHERE n.event_type='inbox.seen'),
 min(n.created_at) FILTER (WHERE n.event_type='inbox.accepted')
 FROM native_activity n JOIN messages m ON m.id=n.message_id AND m.channel_id=n.channel_id
 WHERE n.channel_id=$1 AND n.message_id=ANY($2::text[])
 AND m.recipient_ids ? n.actor_id
 AND n.event_type IN ('inbox.offered','inbox.seen','inbox.accepted')
 GROUP BY n.message_id,n.actor_id ORDER BY n.message_id,n.actor_id`

func nativeReceiptIDs(rawQuery string) ([]string, bool) {
	query, err := url.ParseQuery(rawQuery)
	if err != nil || len(query) != 1 {
		return nil, false
	}
	ids := query["message_id"]
	if len(ids) < 1 || len(ids) > nativeReceiptBatchLimit {
		return nil, false
	}
	sort.Strings(ids)
	for index, id := range ids {
		if !validID(id) || (index > 0 && id == ids[index-1]) {
			return nil, false
		}
	}
	return ids, true
}

func (s *Server) nativeReceipts(w http.ResponseWriter, r *http.Request) {
	ids, ok := nativeReceiptIDs(r.URL.RawQuery)
	if !ok {
		fail(w, 400, "expected 1 to 100 unique message_id values")
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
	// Bind every requested ID to this authorized channel in the same snapshot.
	// A mixed or stale batch fails as a whole without identifying the hidden ID.
	var count int
	if tx.QueryRow(ctx, `SELECT count(*) FROM messages WHERE channel_id=$1 AND id=ANY($2::text[])`, channel, ids).Scan(&count) != nil {
		internal(w)
		return
	}
	if count != len(ids) {
		fail(w, 404, "not found")
		return
	}
	// One aggregate query per bounded batch, never one query per message/actor.
	rows, err := tx.Query(ctx, nativeReceiptQuery, channel, ids)
	if err != nil {
		internal(w)
		return
	}
	defer rows.Close()
	receipts := []NativeReceipt{}
	for rows.Next() {
		item := NativeReceipt{Provenance: "client_reported"}
		if rows.Scan(&item.MessageID, &item.AgentID, &item.OfferedAt, &item.SeenAt, &item.AcceptedAt) != nil {
			internal(w)
			return
		}
		receipts = append(receipts, item)
	}
	if rows.Err() != nil {
		internal(w)
		return
	}
	respond(w, 200, map[string]any{"receipts": receipts})
}

// MessageDeliveryStatus is a convenience view of independent source facts.
// Native reports never backfill legacy timestamps or prove task completion.
type MessageDeliveryStatus struct {
	AgentID string               `json:"agent_id"`
	Status  string               `json:"status"`
	Native  NativeDeliveryStatus `json:"native"`
	Legacy  LegacyDeliveryStatus `json:"legacy"`
	Reply   *DeliveryReply       `json:"reply"`
}
type NativeDeliveryStatus struct {
	OfferedAt      *time.Time `json:"offered_at"`
	SeenAt         *time.Time `json:"seen_at"`
	AcceptedAt     *time.Time `json:"accepted_at"`
	Provenance     string     `json:"provenance"`
	ServerVerified bool       `json:"server_verified"`
}
type LegacyDeliveryStatus struct {
	DeliveredAt *time.Time `json:"delivered_at"`
	AcceptedAt  *time.Time `json:"accepted_at"`
	UncertainAt *time.Time `json:"uncertain_at"`
}
type DeliveryReply struct {
	MessageID string    `json:"message_id"`
	CreatedAt time.Time `json:"created_at"`
}

const messageDeliveryQuery = `SELECT recipient.agent_id,n.offered_at,n.seen_at,n.accepted_at,reply.id,reply.created_at
 FROM unnest($4::text[]) AS recipient(agent_id)
 LEFT JOIN LATERAL (
 SELECT min(created_at) FILTER (WHERE event_type='inbox.offered') AS offered_at,
 min(created_at) FILTER (WHERE event_type='inbox.seen') AS seen_at,
 min(created_at) FILTER (WHERE event_type='inbox.accepted') AS accepted_at
 FROM native_activity WHERE message_id=$1 AND channel_id=$2 AND actor_id=recipient.agent_id
 AND event_type IN ('inbox.offered','inbox.seen','inbox.accepted')
 ) n ON true
 LEFT JOIN LATERAL (
 SELECT id,created_at FROM messages WHERE reply_to=$1 AND channel_id=$2
 AND author_id=recipient.agent_id AND recipient_ids ? $3 ORDER BY created_at,id LIMIT 1
 ) reply ON true ORDER BY recipient.agent_id`

func loadMessageDelivery(ctx context.Context, q querier, m *Message) error {
	statuses := []MessageDeliveryStatus{}
	m.DeliveryStatus = &statuses
	rows, err := q.Query(ctx, messageDeliveryQuery, m.ID, m.ChannelID, m.AuthorID, m.RecipientIDs)
	if err != nil {
		return err
	}
	defer rows.Close()
	legacy := map[string]Receipt{}
	for _, r := range m.Receipts {
		legacy[r.AgentID] = r
	}
	for rows.Next() {
		item := MessageDeliveryStatus{Status: "stored", Native: NativeDeliveryStatus{Provenance: "client_reported"}}
		var replyID *string
		var repliedAt *time.Time
		if err := rows.Scan(&item.AgentID, &item.Native.OfferedAt, &item.Native.SeenAt, &item.Native.AcceptedAt, &replyID, &repliedAt); err != nil {
			return err
		}
		r := legacy[item.AgentID]
		item.Legacy = LegacyDeliveryStatus{DeliveredAt: r.DeliveredAt, AcceptedAt: r.AcceptedAt, UncertainAt: r.UncertainAt}
		if item.Native.OfferedAt != nil {
			item.Status = "offered"
		}
		if r.DeliveredAt != nil {
			item.Status = "delivered"
		}
		if item.Native.SeenAt != nil {
			item.Status = "viewed"
		}
		if item.Native.AcceptedAt != nil || r.AcceptedAt != nil {
			item.Status = "accepted"
		}
		if replyID != nil && repliedAt != nil {
			item.Reply = &DeliveryReply{MessageID: *replyID, CreatedAt: *repliedAt}
			item.Status = "replied"
		}
		statuses = append(statuses, item)
	}
	return rows.Err()
}
