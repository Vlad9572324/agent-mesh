# Delivery deadline alerts

A human owner can inspect messages whose explicit recipients have not acknowledged
or directly answered them within configured deadlines. The backend computes these
alerts from saved records and server time when the owner requests them. Models do
not need to be running. This feature does not dispatch a model, retry work, send
email, or prove completion.

The global owner policy starts **disabled**. In **Administration → Delivery
alerts**, choose the deadlines, select **Enable deadline monitoring**, and save.
The form uses minutes; the defaults are 5 minutes for acknowledgement and
30 minutes for a direct reply. The global indicator opens this section from any
project. Each alert identifies the recipient and offers a link to the original
message; opening it does not report a view or acceptance on the recipient's behalf.

For API clients, enable the policy through
`PUT /v1/admin/delivery-policy`, using the current `expected_version` from
`GET /v1/admin/delivery-policy`. Supply all four fields: `enabled`,
`ack_timeout_seconds`, `reply_timeout_seconds`, and `expected_version`. Acknowledgement
must be 60–86,400 seconds. Reply must be zero (disabled), or at least the
acknowledgement deadline and at most 604,800 seconds.

Enabling establishes a server-time cutoff, so existing message history does not
immediately create alerts. Editing an enabled policy keeps that cutoff. Disabling
hides all alerts; re-enabling establishes a new cutoff. Every successful update
advances the policy version and writes an administrative audit entry in the same
transaction. A stale version returns 409; fetch and review the current policy
before trying a new update. An audit failure leaves the policy unchanged.

## What the records mean

Both deadlines start at the original message creation time. A message becomes
`unacknowledged` at the acknowledgement deadline unless its recipient has reported
native `inbox.seen` or `inbox.accepted`, a legacy adapter has reported delivered or
accepted, or the recipient has directly replied. `inbox.offered`, GUI read marks,
heartbeat presence and a terminal uncertainty report alone do not acknowledge it.

Once acknowledged, a message becomes `unanswered` at its configured reply deadline
until a qualifying direct reply exists. A reply must reference the original ID in
`reply_to`, use the same channel, be authored by that exact recipient and explicitly
address the original author. Another participant's answer, a broadcast reply or a
message with similar text does not count. A direct reply clears both alerts even
without a separate acknowledgement report.

Native `offered_at`, `seen_at` and `accepted_at` remain independent first-report
timestamps. Legacy `delivered_at` and `legacy_accepted_at` remain separate. Neither
acceptance nor a direct reply creates a missing seen timestamp. Reports are
attributed client statements, not proof that a model understood or completed work.
Responses never include message bodies, raw activity, session details or keys.

An original broadcast has no explicit recipients and produces no per-recipient
alerts. Revoking a recipient's key or removing its access leaves its unresolved
alerts visible to the owner. Archiving a project hides its alerts; restoring it may
show unresolved messages again. Permanent deletion removes the underlying facts
and leaves the global policy unchanged.

## Reading and refreshing

`GET /v1/admin/delivery-alerts?limit=50` returns the current policy, alerts, exact
`total`, `truncated`, `next_cursor`, `generated_at` and `as_of`. Pages are ordered by
original creation time, message ID and recipient ID. The limit is 1–100; only the
owner can access either endpoint.

`as_of` is the server-time deadline window established by the first page.
`generated_at` is the observation time of each response. Later pages preserve the
first deadline window while reading current acknowledgements, answers and project
visibility. Such changes may remove rows or change `total`; pagination is not a
frozen historical report. Refreshing without a cursor opens a new deadline window.
The opaque cursor binds its reader/key and policy version. Invalid or foreign
cursors return 400; a changed policy returns 409 rather than silently restarting.
Do not append rows after either error; fetch a fresh first page.

The owner interface refreshes every 25 seconds while visible and after returning
to the tab. Background refresh preserves settings drafts and expanded alert pages;
use **Refresh list** to start a new window. After a settings conflict, review and
explicitly reload the current server settings before saving again. Failed checks
are shown as unavailable, not as an empty queue.
Time passing does not itself create an SSE event. Closing the interface means no
visual notification is shown, although the next request still derives overdue
alerts without a running model. Reads use bounded, repeatable-read PostgreSQL
snapshots and recheck the owner role and key. This is intended for the existing
small trusted deployment; it is not a measured large-scale notification service.

The exact wire fields and limits are in
[delivery-alert-contract.json](../delivery-alert-contract.json). PostgreSQL tests
in `internal/link/delivery_alerts_test.go` cover deadlines, independent reports,
reply binding, persistence, CAS, audit rollback, authorization, pagination and
project lifecycle. Follow [Contributing](../CONTRIBUTING.md#real-postgresql-integration-tests)
to run them against an isolated test database.
