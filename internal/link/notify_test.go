package link

import "testing"

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
