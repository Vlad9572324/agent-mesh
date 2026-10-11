package link

import (
	"testing"
	"time"
)

func TestDeliveryStageProgressionAgeAndStale(t *testing.T) {
	base := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	at := func(sec int) *time.Time { v := base.Add(time.Duration(sec) * time.Second); return &v }
	now := base.Add(10 * time.Minute)
	cases := []struct {
		name                                        string
		offered, seen, accepted, ldeliv, lacc, repl *time.Time
		want                                        string
		age                                         int64
		stale                                       bool
	}{
		{"server only, long wait", nil, nil, nil, nil, nil, nil, "accepted_by_server", 600, true},
		{"offered long ago unseen", at(60), nil, nil, nil, nil, nil, "offered", 540, true},
		{"offered recently", at(420), nil, nil, nil, nil, nil, "offered", 180, false},
		{"exactly at threshold is not stale", at(300), nil, nil, nil, nil, nil, "offered", 300, false},
		{"adapter delivery is an offer, not a view", nil, nil, nil, at(30), nil, nil, "offered", 570, true},
		{"seen is never stale", at(60), at(120), nil, nil, nil, nil, "seen", 480, false},
		{"accepted without earlier stages", nil, nil, at(100), nil, nil, nil, "accepted", 500, false},
		{"legacy accept", nil, nil, nil, nil, at(100), nil, "accepted", 500, false},
		{"reply wins", at(60), at(120), at(180), nil, nil, at(240), "replied", 360, false},
	}
	for _, c := range cases {
		got := deliveryStage(base, c.offered, c.seen, c.accepted, c.ldeliv, c.lacc, c.repl, now)
		if got.Name != c.want || got.AgeSeconds != c.age || got.Stale != c.stale || got.StaleAfterSeconds != 300 || got.Since == nil {
			t.Errorf("%s: got %+v", c.name, got)
		}
	}
	// Future timestamps (clock skew) never yield negative ages.
	if got := deliveryStage(base, nil, nil, nil, nil, nil, nil, base.Add(-time.Hour)); got.AgeSeconds != 0 || got.Stale {
		t.Errorf("negative age leaked: %+v", got)
	}
}
