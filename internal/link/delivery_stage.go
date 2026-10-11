package link

import "time"

// deliveryStaleAfter is how long a message may sit before the recipient has
// even looked at it (server accepted or inbox offered, but no inbox.seen)
// before the sender is told to treat the recipient as not reading.
const deliveryStaleAfter = 5 * time.Minute

// deliveryNow is replaceable so stage ages are testable.
var deliveryNow = time.Now

// DeliveryStage is the compact per-recipient answer to "where is my message
// and for how long": one stage, when it was entered, its age and a stale flag.
// Derived only from client-reported/legacy facts; never proof of processing.
type DeliveryStage struct {
	Name              string     `json:"name"`
	Since             *time.Time `json:"since"`
	AgeSeconds        int64      `json:"age_seconds"`
	Stale             bool       `json:"stale"`
	StaleAfterSeconds int64      `json:"stale_after_seconds"`
}

// deliveryStage picks the furthest stage reached: accepted_by_server ->
// offered -> seen -> accepted -> replied. Legacy adapter delivery counts as an
// offer (never as a view). Stale applies only before the recipient has seen it.
func deliveryStage(created time.Time, offered, seen, accepted, legacyDelivered, legacyAccepted, replied *time.Time, now time.Time) DeliveryStage {
	st := DeliveryStage{Name: "accepted_by_server", Since: &created, StaleAfterSeconds: int64(deliveryStaleAfter / time.Second)}
	set := func(name string, at *time.Time) {
		if at != nil {
			st.Name, st.Since = name, at
		}
	}
	set("offered", legacyDelivered)
	set("offered", offered)
	set("seen", seen)
	set("accepted", legacyAccepted)
	set("accepted", accepted)
	set("replied", replied)
	if age := now.Sub(*st.Since); age > 0 {
		st.AgeSeconds = int64(age / time.Second)
	}
	st.Stale = (st.Name == "accepted_by_server" || st.Name == "offered") && st.AgeSeconds > st.StaleAfterSeconds
	return st
}
