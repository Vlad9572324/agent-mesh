package link

import (
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
