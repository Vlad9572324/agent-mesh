package link

import (
	"strings"
	"testing"
)

// pending reports whether a buffered wake is already waiting on ch.
func pending(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func TestNotifierWakesOnlyMatchingChannel(t *testing.T) {
	n := newEventNotifier(nil)
	a, cancelA := n.subscribe("chan-a")
	defer cancelA()
	b, cancelB := n.subscribe("chan-b")
	defer cancelB()

	n.wake("chan-a")
	if !pending(a) {
		t.Fatal("subscriber of chan-a was not woken")
	}
	if pending(b) {
		t.Fatal("subscriber of chan-b must not wake on a chan-a event")
	}
}

func TestNotifierCoalescesBursts(t *testing.T) {
	n := newEventNotifier(nil)
	ch, cancel := n.subscribe("c")
	defer cancel()

	for i := 0; i < 5; i++ {
		n.wake("c") // must never block even though nothing is draining
	}
	if !pending(ch) {
		t.Fatal("a burst produced no pending wake")
	}
	if pending(ch) {
		t.Fatal("a burst must coalesce into exactly one pending wake")
	}
}

func TestNotifierFanOutToEverySubscriber(t *testing.T) {
	n := newEventNotifier(nil)
	first, cancel1 := n.subscribe("c")
	defer cancel1()
	second, cancel2 := n.subscribe("c")
	defer cancel2()

	n.wake("c")
	if !pending(first) || !pending(second) {
		t.Fatal("both subscribers of the same channel must be woken")
	}
}

func TestNotifierUnsubscribeStopsWakesAndCleansUp(t *testing.T) {
	n := newEventNotifier(nil)
	ch, cancel := n.subscribe("c")
	cancel()

	n.wake("c")
	if pending(ch) {
		t.Fatal("an unsubscribed channel must not be woken")
	}
	n.mu.Lock()
	_, present := n.subs["c"]
	n.mu.Unlock()
	if present {
		t.Fatal("the last unsubscribe must drop the channel's subscriber set")
	}
}

func TestNotifierSubscriberWokenIndependentlyOfListener(t *testing.T) {
	// A stream may subscribe before run() has established its LISTEN connection.
	// subscribe/wake are purely in-process, so once the listener connects and the
	// first NOTIFY arrives, the already-registered subscriber is woken; the gap
	// before the connection is covered by the stream's own safety poll. Proven
	// here with no listener running at all (nil pool, run() never called).
	n := newEventNotifier(nil)
	ch, cancel := n.subscribe("c")
	defer cancel()
	n.wake("c")
	if !pending(ch) {
		t.Fatal("a subscriber registered before the listener runs must still be woken")
	}
}

func TestNotifyPayloadStaysWithinPostgresLimit(t *testing.T) {
	// addEvent sends the channel id as the NOTIFY payload. validID caps ids at
	// 128 bytes; PostgreSQL's NOTIFY payload limit is 8000 bytes, so a channel id
	// can never overflow it.
	maxID := strings.Repeat("a", 128)
	if !validID(maxID) {
		t.Fatal("a 128-character channel id must be valid")
	}
	if validID(strings.Repeat("a", 129)) {
		t.Fatal("a 129-character channel id must be rejected")
	}
	if len(maxID) >= 8000 {
		t.Fatalf("channel id length %d must stay well under the 8000-byte NOTIFY limit", len(maxID))
	}
}

func TestNotifierWakeAllNudgesEveryChannel(t *testing.T) {
	n := newEventNotifier(nil)
	a, cancelA := n.subscribe("a")
	defer cancelA()
	b, cancelB := n.subscribe("b")
	defer cancelB()

	n.wakeAll() // used on listener reconnect so no stream stalls
	if !pending(a) || !pending(b) {
		t.Fatal("wakeAll must nudge subscribers on every channel")
	}
}
