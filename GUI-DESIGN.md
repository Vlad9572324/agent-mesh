# Agent Mesh GUI design

## Scope and design consultation

The usability-focused GUI groups existing project coordination features without
adding model execution authority. Its implementation lives in `web/index.html`,
`web/app.css`, and the state/render functions in `web/app.js`.
No model-provider credentials, infrastructure controls, or private agent reasoning
are exposed by this interface. Documentation screenshots use fictional fixtures.

The central question is: **What is happening in this project, and where should I
look next?** Previously the landing page was a channel underneath a large generic
introduction; tasks, participant presence, and coordination were scattered.

## Implemented information architecture

- Project navigation → overview by default; channels explicitly open discussion.
- Work: overview, tasks/review, files/artifacts, agent sessions.
- Knowledge: versioned memory and immutable notes, labelled separately.
- Overview: four summary cards; tasks requiring attention; participants; recent
  tasks; accessible channels. Each summary/action leads to existing functionality.
- Channel: discussion, delivery events, native CLI activity. Message receipts and
  technical identifiers use a disclosure; uncertainty remains visible collapsed.
- Owner administration: accounts, projects/channels, access, diagnostics.
  Sections remain mounted so navigation and SSE do not destroy form drafts.
- Mobile: explicit navigation toggle, Escape close, responsive single-column
  content; ordinary keyboard navigation and visible focus indicators.

The visual layer uses local system fonts and assets only, neutral surfaces,
graphite navigation, teal interaction accents, readable type, and explicit states.

## Deliberate boundaries

Some consultation suggestions were not adopted literally:

- Channel event sequence changes are **not unread-message counts**. Updates remain
  activity markers because receipts and CLI events also advance the sequence.
- No invented global message feed: existing message state covers one channel,
  not every accessible channel. Overview links to channels without pretending
  that selected-channel messages constitute a project-wide feed.
- Overview task/session summaries require their existing authorized endpoints.
  They load only in overview, using the existing workspace invalidation/polling
  cycle. No additional timer, per-agent polling, or new backend API is introduced.
- Unknown or failed reads are not shown as zero or success. Truncated task lists
  are marked; stale snapshots are explicitly labelled.
- Task attention means published `uncertain`, `review_pending`, or
  `changes_requested`, not an inference that a process is stuck.
- Heartbeat freshness, session lease freshness, client-reported tool events,
  acceptance receipts, and task completion reports remain different facts.
- No process launch/stop, auto-retry of model execution, administrator
  impersonation, permission matrix automation, or orchestration is added.
- Versioned memory and immutable notes are not merged into a misleading single
  editor. Their different write/history semantics remain visible.

## Safety and lifecycle invariants

Existing API keys remain in tab memory only. API content renders through
`textContent`, not HTML. CSP and backend authorization remain unchanged.
Existing DOM IDs, forms, dialogs, byte limits and server-side revision checks are
preserved. Overview data is cleared on leaving the view, logout, project change,
and revoked project access; cached session counts are filtered on channel removal.
Selecting a different task clears its prior bound event draft/history; returning
to the same task retains its draft. Open message disclosures survive refresh.

Rapid revoke/regrant can restore the same sampled SSE revision (A→B→A). After
observing a project/channel loss or denied read, the existing eight-second poll
performs REST catch-up for 30 seconds even if SSE remains connected. Ordinary
idle polling behavior is unchanged. Regrant acceptance allows 12 seconds to cover
that documented fallback; this is not claimed as subsecond SSE delivery.

## Verification

`tests/redesign_gui.mjs` adds isolated browser acceptance for the new navigation,
actual mouse/keyboard operability, overview isolation and live updates, error
states, mobile layouts, safe text, draft/disclosure preservation and logout.
It uses only the dedicated loopback E2E database and owned Chromium, never the
deployed pilot or model jobs. Existing realtime, coordination, native activity,
administration and project-lifecycle suites remain regression gates.

Run against a **freshly built** server and the matching candidate web directory;
do not mistake an outdated staging binary for a frontend regression. Evidence
reports contain asset hashes. See [operator tools](docs/operator-tools.md) for
explicit browser, runtime-directory, and service configuration.

This document describes source behavior, not the status of any deployment.
Operators must verify their own installed release and retain evidence privately.

## Project map — relationship semantics

The dedicated project map answers a different question from the overview:
**What are these objects, and how are the objects I can see related?**

Two layers must remain visually separate:

- **How the system works:** a conceptual, code-native diagram of accounts and
  access, projects/channels/messages/receipts, tasks/runs/review/artifacts,
  memory/versions/notes, execution leases and native CLI reports. Keys and owner
  administration are explained here, not represented by fake live records.
- **This project's objects:** a bounded read-only metadata snapshot with exact
  visible counts, explicit loaded-window limits, a searchable typed entity list,
  and labelled relationships for the selected object. Links open the existing
  relevant view; the map is not a second editor or process controller.

Edges require persisted, authorized references. A matching string is not enough:
native session IDs, execution-session leases and receipt sessions are different
identities. An execution session's free-form run ID does not establish a foreign
key to a task run. There is no inferred task-to-memory dependency. Review requests
and results are task events, not fabricated independent records.

The metadata endpoint excludes message/memory bodies, artifacts' bytes, commands,
prompts, private transcripts, credentials and key hashes. Channel restrictions
apply to messages, receipts, native activity and execution sessions. A note's
source message reference must be suppressed when its channel is not readable.
Global owner inventory is not fetched to build a project map.

The initial per-type window is 25 records (API maximum 50), so the absence of a
line means only that there is no relationship among the loaded objects. It does
not establish that an object has no relationships in the full history. Empty,
limited, stale, failed and not-yet-loaded states must remain distinguishable.
Read errors never convert unknown counts to zero. ACL loss, project changes and
logout invalidate prior snapshots and pending responses; navigation preserves
appropriate same-channel drafts.

## English-first interface and Russian localization

English is the source language for documentation, CLI defaults, newly bootstrapped
sample records, API-generated display labels, and the initial GUI. Existing
projects, account names, channel names and published content are not migrated.

The header language selector is available before and after sign-in, including on
mobile. `?lang=ru` selects Russian; `?lang=en` selects English. The preference is
kept in the page URL only, not browser storage or a server-side account setting.
Sharing a URL can share the language preference but never the in-memory API key.

Localization is restricted to application-owned text and attributes. Static HTML
uses English content with explicit Russian translation annotations. Dynamic UI
messages use an in-file catalog and captured interpolation values. Names, chat
messages, memory, notes, artifact data and user-entered drafts remain verbatim,
even when they happen to match a translated UI label. Stable protocol enum values
and form option values are not translated. Technical server error details remain
verbatim inside localized error framing.

Changing language updates existing owned text nodes, attributes and validation
messages in place. It does not navigate, fetch data, reconnect SSE, clear forms,
recreate dialogs, or re-render entire panels. Dates and numbers use the selected
locale. Application state and access checks remain independent of the language.

`tests/i18n_gui.mjs` uses an isolated database schema, server and owned Chromium
to verify both languages, user-content isolation, form/dialog state, mobile
layouts and repeated switching without new requests or SSE replacement.
Existing Russian-assertion suites explicitly select `?lang=ru`; they continue to
exercise the same API and lifecycle behavior.

The localization acceptance also exposed an independent, pre-existing HTTP/2
idle-stream defect: a ten-second write deadline remained active until a keepalive
scheduled no earlier than ten seconds later. HTTP/2 could reset the stream before
that keepalive. Workspace SSE now clears the deadline after a successful flush;
each actual write still has its ten-second bound. The isolated TLS/HTTP/2 test in
`internal/link/workspace_http2_test.go` covers idle keepalive, a subsequent visible
revision on the same stream, and key revocation while idle. HTTP/1-only fixture
tests did not exercise the HTTP/2 reset behavior.
