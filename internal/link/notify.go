package link

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// eventNotifier turns a single Postgres LISTEN connection into in-process,
// per-channel wakeups so an SSE stream delivers the instant an event commits
// instead of polling once per second. One dedicated connection serves every
// subscriber in this process; a dropped connection is retried and, while it is
// down, each stream's own safety poll still makes progress. NOTIFY is emitted
// by addEvent inside the writer's transaction, so it fires exactly on COMMIT
// and a rolled-back event never produces a spurious wake.
type eventNotifier struct {
	pool *pgxpool.Pool
	mu   sync.Mutex
	subs map[string]map[chan struct{}]struct{}
}

func newEventNotifier(pool *pgxpool.Pool) *eventNotifier {
	return &eventNotifier{pool: pool, subs: map[string]map[chan struct{}]struct{}{}}
}

// subscribe returns a channel that receives a non-blocking signal whenever an
// event commits on channelID, plus an unsubscribe function. The signal channel
// is buffered to one: a burst of events coalesces into a single pending wake,
// so a slow reader never blocks a writer and never misses that work is waiting.
func (n *eventNotifier) subscribe(channelID string) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	n.mu.Lock()
	if n.subs[channelID] == nil {
		n.subs[channelID] = map[chan struct{}]struct{}{}
	}
	n.subs[channelID][ch] = struct{}{}
	n.mu.Unlock()
	return ch, func() {
		n.mu.Lock()
		if set := n.subs[channelID]; set != nil {
			delete(set, ch)
			if len(set) == 0 {
				delete(n.subs, channelID)
			}
		}
		n.mu.Unlock()
	}
}

// wake signals every subscriber of channelID. The send is non-blocking: a
// subscriber that already has a pending wake keeps exactly one.
func (n *eventNotifier) wake(channelID string) {
	n.mu.Lock()
	for ch := range n.subs[channelID] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	n.mu.Unlock()
}

// wakeAll nudges every subscriber regardless of channel. It is used when the
// listen connection drops: each stream polls once against its own cursor, then
// blocks again, so no stream stalls on a listener that is being re-established.
func (n *eventNotifier) wakeAll() {
	n.mu.Lock()
	for _, set := range n.subs {
		for ch := range set {
			select {
			case ch <- struct{}{}:
			default:
			}
		}
	}
	n.mu.Unlock()
}

// run owns the LISTEN connection for the life of the process, reconnecting with
// a short backoff. It returns only when ctx is cancelled.
func (n *eventNotifier) run(ctx context.Context) {
	for ctx.Err() == nil {
		if err := n.listen(ctx); err != nil && ctx.Err() == nil {
			n.wakeAll()
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
			}
		}
	}
}

func (n *eventNotifier) listen(ctx context.Context) error {
	// A dedicated connection (not a pooled one) so LISTEN never holds a slot the
	// request path needs. It inherits the pool's DSN and runtime params.
	conn, err := pgx.ConnectConfig(ctx, n.pool.Config().ConnConfig.Copy())
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if _, err = conn.Exec(ctx, "LISTEN mesh_events"); err != nil {
		return err
	}
	for ctx.Err() == nil {
		notification, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		n.wake(notification.Payload)
	}
	return ctx.Err()
}
