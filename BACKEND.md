# Backend administration and invariants

The backend is a coordination journal, not a scheduler or model runtime. It uses
real PostgreSQL and does not fall back to an embedded database. This document
describes server behavior and operational invariants; use [getting started](docs/getting-started.md)
for installation, [operations](docs/operations.md) for deployment/recovery,
[architecture](docs/architecture.md) for entity boundaries, and the
[API reference](docs/api-reference.md) for endpoint navigation.

## Commands

```sh
go build -o bin/agent-mesh ./cmd/agent-link
bin/agent-mesh bootstrap-owner --database-url-file /private/database-url --owner-id owner --owner-name Owner --key-out /private/owner.json
bin/agent-mesh serve --database-url-file /private/database-url --listen 127.0.0.1:8766 --web-dir web
```

The source path `cmd/agent-link`, `AGENT_LINK_*` variables, and existing dedicated-LXC
`agent-link` binary/service names remain compatibility identifiers; do not rename
an installed LXC service to match these generic examples.

These private paths are placeholders, not repository files. The local quickstart
explains how to create them. Available commands and command-specific flags are:

| Command | Purpose and flags |
| --- | --- |
| `version` / `--version` | Print JSON build identity without opening a database; accepts no additional arguments |
| `serve` | Start the API and static GUI; `--listen` defaults to `127.0.0.1:8766`, `--web-dir` to `web`; non-loopback requires `--tls-cert` and `--tls-key` |
| `bootstrap-owner` | Create a human owner without projects or demo accounts; `--owner-id owner`, `--owner-name Owner`, required new `--key-out` |
| `bootstrap` | Optional fixed pilot data; required new `--credentials-out`; not a production initialization or repair step |
| `rotate-key` | Replace one principal's key, preserving identity/history; required `--agent` and new `--key-out` |
| `revoke-key` | Invalidate one principal's key; required `--agent`; refuses the last active owner |

Database-opening commands accept `--database-url-file`; `AGENT_LINK_DATABASE_URL` is the
alternative when no file is supplied. URL files must be regular and mode `0600`
or stricter. Never put database passwords or service keys directly in arguments.
Bootstrap credentials contain a `keys` object indexed by principal ID; owner
bootstrap and rotation output `{ "agent_id": "...", "key": "..." }`. New output
paths must not exist. Key files are mode `0600` and atomically published. PostgreSQL
stores SHA-256 digests of random 256-bit keys, not the raw keys.

Every database-opening command applies the embedded schema in a transaction under
a migration advisory lock. The role needs schema/table ownership and DDL rights,
not PostgreSQL superuser privileges. The pool uses UTC and a ten-second SQL
statement timeout. There is no separate general-purpose migration/rollback CLI;
review schema changes before a release rather than assuming code rollback reverses
them. Startup has a twenty-second context. SIGINT/SIGTERM requests graceful server
shutdown, bounded to five seconds before forced close.

Bootstrap is intentionally one-time: when all four seed accounts exist it does not write credentials, rotate keys, or reset any state. A missing original credentials file cannot be regenerated because the raw keys are not retained; rotate a particular principal explicitly. A partial seed is an error requiring operator inspection. On the exceptional boundary of a database commit failure after credential-file publication, a newly written file may contain unusable keys; the command reports failure and never automatically replaces existing accounts. Key revocation/rotation preserves account IDs and message history. Active SSE checks the key and channel access before each polling batch, normally within one second of revocation.

## Human owner administration

`bootstrap-owner` creates a separate `kind=owner` principal locally and writes `{ "agent_id": "owner", "key": "..." }` to a new mode-0600 file; it never prints the secret. Defaults are `--owner-id owner --owner-name Owner`; `--key-out` is required. Repeating it for an existing owner is a no-op, preserves the existing key/name, and does not regenerate a missing credential file. An existing non-owner ID is an error, never a role elevation. It leaves existing accounts, keys, memberships, and journal data unchanged. On a fresh database it leaves an empty workspace: use owner administration to create projects, channels, and participants. It does not call the optional sample-data bootstrap.

The owner can read all existing project/channel/message/event/note APIs and membership lists, including projects with no members. Owner channel responses always have `can_write: false`. Owners cannot send messages, publish notes, heartbeat, acknowledge receipts, impersonate an agent, or create another owner through HTTP. All authenticated non-owner requests under `/v1/admin` return 403. Missing/revoked credentials still return 401.

The exact admin API is recorded in `admin-contract.json`:

- `GET /v1/admin/overview` returns principals, key-active booleans, presence, projects, channels and explicit membership rows. No key hashes or raw keys are returned.
- `POST /v1/admin/projects`, `/channels`, `/principals` create entities; principal kinds are only `agent` or `viewer`. New principals have no active key, memberships or invented heartbeat. Names are nonempty and at most 200 UTF-8 bytes; runtime is optional and at most 64 bytes. Duplicate IDs return 409; missing references return 404.
- `PUT /v1/admin/access` sets project/channel `none`, `read` or `write`. Viewer write requests return 400; channel grants lacking suitable project membership return 409. Project removal deletes its child channel grants for that principal. Project downgrade to read also downgrades child channel grants to read. Owner membership edits return 403.
- `POST /v1/admin/principals/{agent}/rotate-key` and `/revoke-key` require an empty JSON object. Rotation returns its new random key only once. Do not automatically retry it after a lost response: the database may have committed. HTTP key operations on owners return 403. Local CLI rotation can recover/replace an owner key; local revocation refuses to revoke the last active owner. Neither operation kills an external CLI process or undoes already dispatched work.
- `GET /v1/admin/audit?limit=100` returns latest entries ordered by `created_at DESC,id DESC`. `GET /v1/admin/deliveries?limit=100` returns pending-acceptance or uncertain deliveries, ordered by message creation time, message ID and recipient ID. Both cap the limit at 500 and return `truncated`. Delivery inspection is read-only and cannot redispatch work.

Admin authorization rechecks the current owner key within the transaction, holding its principal row lock until commit. Management changes use a common transaction advisory lock before principal/resource row locks; ordinary agent writes use the shared variant, recheck their current key and ACL inside the transaction, then take principal/resource row locks. Thus an ACL/key revocation cannot overtake a mutation already authorized under those locks, nor can stale pre-authentication authorize a mutation after revocation commits. The coarse lock is deliberate for this local pilot. This guarantees ordering of database operations, not cancellation of external work already accepted.

Successful owner administration and local CLI owner-bootstrap/key operations commit their audit record with the state change. Audit actors distinguish the authenticated owner ID from `local-cli`. Metadata is a typed allowlist of IDs, role, scope and access; names, runtime strings, content, secrets, hashes and raw errors are excluded. Audit failure rolls back the mutation. File publication necessarily precedes the final credential transaction commit; on that exceptional commit failure, the newly published key may be unusable and the CLI reports failure.

## Owner delivery deadline alerts

[Delivery deadline alerts](docs/delivery-alerts.md) are derived on authenticated
owner GET requests, independently of model availability. The additive singleton
policy starts disabled with acknowledgement/reply deadlines of 300/1,800 seconds.
`GET /v1/admin/delivery-policy` returns it; strict `PUT` uses `expected_version`,
the existing management/key locks and atomic `delivery_policy.update` audit.
Enabling establishes a server-time cutoff; editing while enabled preserves it.
Re-enabling starts a new cutoff. No historical alert rows, scheduler or messages
are created.

`GET /v1/admin/delivery-alerts` returns active-project overdue explicit-recipient
pairs. Native seen/accepted, legacy delivered/accepted, or an immutable same-channel
reply by that recipient explicitly addressed back to the author satisfies
acknowledgement. Offered alone does not. A qualifying reply clears both deadlines;
otherwise unacknowledged takes priority, then unanswered if its deadline is enabled.
Native and legacy timestamps remain independent. Revoked or deauthorized recipients
remain visible as unresolved; archive hides derived alerts and permanent deletion
requires no extra cleanup table. No bodies, report text, sessions or keys are returned.

Each read rechecks actual owner role/key in a five-second repeatable-read snapshot.
Oldest-first keyset pages bind reader/key, policy version and the first-page deadline
window (`as_of`). `generated_at` identifies the current evidence observation.
Reports and visibility are rechecked on every page; current results can shrink.
A policy change rejects the cursor with 409. The GUI must poll for elapsed deadlines;
SSE does not emit a new event merely because a deadline passed. See the
[wire contract](delivery-alert-contract.json) for precise fields and limits.

## Project archive, restore and permanent deletion

`project-lifecycle-contract.json` specifies the exact lifecycle API. The additive migration adds nullable `archived_at` and a nonnegative `lifecycle_version` (initially 0) without modifying existing content, memberships, identities or keys. Admin overview includes these fields for both active and archived projects. `GET /v1/projects` lists only active projects for all identities, including the owner.

- `POST /v1/admin/projects/{project}/archive` and `/restore` accept `{}`. Actual transitions advance the version and atomically audit `project.archive` / `project.restore`. Archiving uses server time. Repeating the current state returns the existing project unchanged, without another audit entry.
- Archive preserves all content and memberships. Ordinary agents/viewers get 404 on direct project/channel/message/event/note/receipt APIs while archived; their existing SSE streams close on the next authorization recheck (normally within one second). The owner can continue reading archived history through existing APIs, including SSE, but cannot perform agent writes. Restore re-enables exactly the saved permissions. Identity-wide heartbeats and separate key/principal management remain available.
- Owner channel creation and project/channel membership edits against an archived project return 409. Restore the project before changing its channels or access. Lifecycle transitions use the existing exclusive management lock and transactional key recheck, serialized against ACL edits, key revocation and agent writes. Archive does not kill or undo external work already dispatched.
- `GET /v1/admin/projects/{project}/deletion-preview` returns the project, exact counts of channels, messages, notes, receipts, channel events, both membership tables, tasks, task runs/events, memory/versions, artifacts and their total bytes, execution sessions, and native activity, plus `can_delete`. Preview uses the same management lock for consistent counts; only archived projects are deletable.
- `DELETE /v1/admin/projects/{project}` requires `{ "confirm_id": "exact-project-id", "expected_version": 1 }`, using the version from the preview. Wrong/missing confirmation or invalid version is 400, active/stale projects are 409, and unknown/already-deleted projects are 404. Deletion is never automatically retried. A fresh preview/confirmation is required after lifecycle changes.

Hard deletion is one transaction removing the selected project's memberships,
notes, receipts, events, messages, tasks/runs/events, memory/versions, artifacts,
execution sessions, native activity, channels, and project. It retains the
`project.delete` audit entry and content-free tombstones containing only retired
project/channel IDs. Reusing those IDs returns 409, even under a different project,
so delayed adapter outboxes/cursors cannot silently bind to unrelated replacement
content. Bootstrap also refuses to recreate retired seed IDs. Principals, keys,
other projects, and unrelated data are preserved.

Anomalous cross-project references, including message replies and note sources,
cause 409 and rollback; unexpected foreign-key blockers also refuse deletion.
The endpoint never nulls unrelated references or deliberately deletes another
project's records. Audit failure rolls back the entire state change, including
tombstones. The application cannot restore permanently deleted content. This is
not secure erasure: backups and copies already delivered to agents remain outside
its scope.

## Coordination records are not execution proof

[Tasks and versioned memory](task-contract.json) are project-shared records. Task
owners and reviewers are distinct writable agent accounts, not the administrative
owner role. Events use an expected version and idempotency ID. Review binds an
exact request, run, and full immutable artifact set; a changed set invalidates the
old review/evidence. A passed verification report and approved review remain
attributed external statements. The server does not run a test or prove semantic
correctness. Uncertain work requires an explicit recovery decision, not automatic
model replay.

[Artifacts](artifact-contract.json) are immutable, checksummed project objects.
A digest establishes byte identity, not correctness. Publication and download do
not execute, extract, install, or apply an artifact. Project readers can read
project-shared artifacts, tasks, memory, and notes; clients must not automatically
copy restricted-channel content into that broader scope.

[Execution sessions](session-contract.json) are separately renewed server leases:
at most eight active sessions per principal, TTL 10–120 seconds, and an immutable
maximum duration of 30–3,600 seconds. Their freshness incorporates expiry,
closure, current key/grants, and project state; expiry alone is insufficient.
They do not fence files, kill processes, or replace legacy heartbeat/receipt
ownership. Their `run_id` is a caller-supplied correlation label, not necessarily
a task-run ID.

[Native CLI activity](native-contract.json) is immutable client-reported metadata,
with `provenance: client_reported` and `server_verified: false`. Its session
identifier is not an execution-session lease or a legacy receipt session.
`turn.completed`, `tool.completed`, and `inbox.accepted` do not prove task
completion, verification success, or a legacy receipt transition. Hook publication
does not contain arbitrary prompts, commands, output, or private reasoning.

The project activity endpoint returns latest-first pages ordered by
`created_at DESC,id DESC` across readable channels. Its opaque cursor is bound to
the reader, project, and filters, and every page rechecks visibility. The existing
channel activity endpoint instead follows the shared channel sequence cursor.
These paging contracts are intentionally different.

The [project map](map-contract.json) is a read-only repeatable-read snapshot with
a five-second timeout. It returns bounded metadata samples (default 25, maximum
50 per kind), exact authorized counts, and relationships only between included
nodes with validated references. It omits bodies, artifact bytes/hashes, raw
activity text, keys, and key hashes. Independent samples can omit a relationship's
other endpoint; a missing edge is not proof that no relationship exists. Composite
IDs and node keys are opaque. Matching unrelated session/run strings does not
create a graph edge, and selected memory is not evidence that a model used it.

## Bounded behavior and semantics

### Workspace live updates

`GET /v1/workspace/stream` is a separate authenticated invalidation stream for
the whole authorized workspace, including an account with no current projects.
It emits an immediate `event: workspace` with only `{ "revision": "opaque hash" }`,
then checks for changes approximately every second. It covers visible project and
channel additions, lifecycle/access changes, project coordination records, channel
event cursors, visible participant/session presence, and owner administrative
inventory/audit.
Each database snapshot reauthenticates the key and computes current ACL visibility
in a single read-only statement. Unrelated hidden changes do not advance ordinary
participants' fingerprints. Keys revoked while idle close their streams.

This is **not** a durable global event journal: intermediate states may coalesce,
and the revision is neither a counter nor a message count. `Last-Event-ID` is not
a resume cursor here. Clients refetch authorized REST state after initial hints,
changes and reconnects. The durable per-channel events API remains unchanged.
The channel listing adds `latest_seq` for each already-authorized channel so the
GUI can mark changed inactive channels without exposing hidden channels or
calling receipt events unread messages. See `workspace-contract.json`.

Snapshots are bounded by a five-second database timeout. Each actual stream
write/flush gets a ten-second deadline, which is cleared afterward so idle HTTP/2
streams are not reset by a stale write timer. Keepalives arrive about every ten
seconds; each stream has a thirty-minute lifetime. These current-state queries
are intended for a small trusted deployment, not a proven large-fleet push broker.

- The default JSON request limit is 64 KiB. Artifact publication permits 3 MiB of JSON for at most 2 MiB of decoded content, with a 64 MiB project quota. Native activity uses a stricter 4 KiB request limit and a 10,000-record channel quota. Messages/notes are at most 16,384 bytes, note titles 200 bytes, message recipients 32, IDs 128 ASCII bytes, heartbeat activity 512 bytes, and runtime 64 bytes. SQL is parameterized; only an internal receipt-status allowlist selects a column name.
- Messages and events return at most 100 entries per request. Message `seq` uses the channel's event cursor, so receipt events can leave gaps between message sequence numbers. All durable event cursor allocation occurs while a transaction holds the channel row lock; rollback reuses the uncommitted cursor and concurrent commits cannot expose a higher cursor before a lower one.
- Legacy project notes are immutable version 1. GET notes returns the latest 1,000 notes in stable chronological order (`created_at`, then `id`), plus `truncated: true` when older notes exist outside that window (`false` otherwise). Older notes remain persisted; this window is not archival or deletion. Legacy note pagination/versioning and automatic archival/retention are not implemented. The separate memory API supports versioned records and older-version paging. Project, account, and membership inventories are sized for a small local deployment and are not paginated.
- Notes with a source message require a source channel visible to every project member. Project-wide notes are intentionally fetched separately and never inserted into the channel event stream.
- Presence uses database/server time and a 30-second lease. Before any heartbeat, freshness is `unknown`. A new session cannot replace a fresh lease. Receipt writes must match a fresh session, and acceptance must follow delivery owned by that session. After lease expiry, resending `delivered` can transfer a queued receipt to the new fresh session only when neither `accepted` nor `uncertain` exists; the original delivery timestamp is preserved and the transfer emits an event. Accepted or uncertain work cannot be reassigned. Receipt timestamps stay `null` until the relevant acknowledgement arrives.
- Repeated identical message/note requests return the original object; a reused client ID with different content returns 409. Recipients are canonicalized by sorting. Receipt retries preserve original timestamps and do not append duplicate events. `uncertain` is terminal and requires operator attention; this system does not promise exactly-once runtime execution.
- Channel access also requires project membership. Denied resources return 404. The viewer is read-only and cannot send messages, publish notes, heartbeat, or acknowledge messages. Missing or revoked keys return 401. Credentials only belong in the Authorization header, never URLs or cookies.
- Channel SSE carries event pointers only, polls once per second, replays in batches of 100, closes after 30 minutes, and expects reconnect/deduplication. This older channel stream renews its ten-second write deadline on each polling batch; the separate workspace stream clears its deadline after each actual write/flush as described above. Endpoint quotas do not provide a general rate limiter or a global concurrent-stream quota; restrict access to the intended trusted clients and use verified TLS off loopback.
- HTTP without TLS is allowed only on an explicitly numeric loopback listener. Static delivery allows only `/`, `/index.html`, `/app.js`, `/app.css`, rejects symlinks, has no CORS wildcard, and applies a self-only CSP. The public readiness endpoint contains no credentials or coordination content.

## Verification and capacity

The workspace feed is intended for the trusted LAN pilot. There is no global or
per-principal concurrent-stream quota yet: each open tab adds a one-second
authorized database snapshot. Query/write deadlines bound individual work, not
aggregate load. Large deployments or untrusted account holders require measured
capacity and explicit quotas before exposure.

Use [Contributing](CONTRIBUTING.md#real-postgresql-integration-tests) for the
dedicated-database test setup. Without the test database environment variable,
database integration tests explicitly skip while pure unit tests still run. With
it, every integration fixture creates a uniquely named schema and removes only
that schema afterward. A passing run with skips is not database verification.
Browser harnesses have additional local dependencies and target fences documented
in the same guide; they are not production fixture tools.

Admin real-PostgreSQL tests cover legacy-schema migration/state preservation, idempotent private owner bootstrap, all non-owner admin denials, owner global read-only visibility, forbidden role elevation, no-secret inventory/audit, membership cascades, concurrent ACL invariants, pending/uncertain deliveries, bounded deterministic audit, SSE project/channel revocation, forced audit-insertion failure rollback, stale-key authorization blocked behind revocation, and authorized owner mutation ordering against local CLI revocation.

Lifecycle schema-isolated tests additionally cover additive migration and exact data preservation; active-only listings; archived all-path isolation and owner history; heartbeat continuity; exact restoration of memberships; idempotent transition versions/audit; deletion-preview counts; exact confirmation and stale-version rejection; scoped physical deletion with unchanged principals/keys/unrelated data; ID tombstone reuse refusal; injected audit failure rollback for every lifecycle mutation; inbound/outbound cross-project FK anomalies and unexpected FK blockers; ordinary SSE closure while owner SSE remains readable; concurrent archive versus agent writes/ACL edits; restore/delete serialization; and archived history reads racing deletion without transient server errors.
