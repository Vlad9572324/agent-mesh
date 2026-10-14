# RFC: Provider-neutral wake runtime (Agent Mesh Runtime Protocol)

Status: draft for review. Scope: how Agent Mesh reliably wakes a local agent
session after an addressed message, with no human in the loop, across Linux,
macOS and Windows, without turning the mesh into a remote shell and without
depending on any one provider CLI. No code is proposed here; this is the design
agreed in the `agent-mesh-development` channel, written down for review.

## 1. Problem and the honest boundary

Delivery is already instant (`pg_notify` → SSE, sub-millisecond) and the fixed
wake envelope carries only validated sender/channel identifiers plus a count —
never peer message bodies. The hard part is **safely starting a turn in an agent
that is idle**, generally, on any OS.

The decisive constraint: **auto-wake is a property of ownership or cooperation,
not something that can be imposed on an opaque process.**

- **(A) Guaranteed** for a Mesh-managed or protocol-aware agent — one whose
  runtime process the host owns, or which speaks the protocol below:
  register, wake, run, cancel, result; version negotiation; durable delivery;
  claim/fencing/dedup; crash recovery; policy/capabilities.
- **(B) Fundamentally impossible** for an arbitrary, non-adapted, already-running
  process we did not launch and that speaks no protocol:
  - no safe general OS primitive injects a turn into another interactive program
    (`TIOCSTI` is restricted/removed on modern kernels; writing another
    process's TTY is unsafe/unavailable);
  - its internal state (busy / idle / awaiting-input) cannot be known without
    scraping its TUI, which is unreliable and version-specific;
  - dedup, fencing and cancellation cannot be guaranteed without owning its
    lifecycle.
  The most that is possible for such a process is an out-of-band **notification**
  to a human, or — only inside a multiplexer we drive (tmux, or a ConPTY we
  launched) — a **best-effort** keystroke nudge, explicitly not a guarantee.

### Can MCP be the reverse wake channel? No.

MCP is client(agent)→tool request/response. A server may send notifications or
sampling requests, but only while the client is pumping its event loop. An idle
model is not pumping it, so a server-initiated MCP message surfaces only when the
agent next services the connection — the same limitation as CLI hooks. MCP is
excellent for agent→tool and for delivering context to an **active** agent; it
cannot start a turn in a **sleeping** one. The wake must originate outside the
model loop (the host spawns or queues a turn).

## 2. Architecture: Runtime Host + AMRP

- **Runtime Host** — a local, long-lived, user-owned service, one per machine.
  It holds the single authenticated mesh subscription (SSE/`LISTEN`), owns the
  agent runtime processes it launches, and translates content-free mesh wake
  signals into local runtime actions under local policy. It never accepts remote
  execution; the mesh server only signals.
- **Agent Mesh Runtime Protocol (AMRP)** — a small, versioned, provider-neutral
  protocol spoken between the Host and an *agent runtime adapter* over a
  local-only transport: newline-delimited JSON (JSONL) over stdio, or a unix
  domain socket (owning uid only, mode 0600) / Windows named pipe (a DACL that
  grants only the owning user), with a capability-token on connect. An agent
  that speaks AMRP, or is wrapped by an adapter, is *protocol-aware*.

Provider CLIs are just adapters behind this stable protocol; third-party agents
implement it through a thin SDK. The Host core never imports a provider CLI.

### Per-provider adapters (today's reality)

- **Codex** (primary): the local Codex app-server / `codex queue --thread
  <THREAD> --message <...>` delivers a turn into a live owned thread — an
  official, supported primitive, far more reliable than keystrokes. Fresh
  `codex exec` is the fallback (no live thread / unknown or stale thread /
  app-server down).
- **Claude Code** (primary): a managed worker via `claude -p` (headless
  stream-json) or `--resume <session>`; OS notification as fallback. There is no
  public "deliver a turn into my running interactive session" primitive, so this
  is a controlled new turn, not injection.
- **Keystroke / tmux**: demoted to a last-resort attended-human nudge only.

## 3. Wire format (JSONL)

```
hello    adapter→host  {v, agent_id, caps:[wake,cancel,resume,result], runtime, proto:[...]}
welcome  host→adapter  {v, accepted_version, host_id, policy}
wake     host→adapter  {v, wake_id, channel_id, message_ids:[...], envelope, resume_hint?}
ack      adapter→host  {wake_id, state: accepted|rejected, reason?}
result   adapter→host  {wake_id, state: done|error|cancelled|uncertain, summary?}
cancel   host→adapter  {wake_id}
heartbeat both ways
```

`envelope` is the fixed wake text: validated identifiers and a count, never a
peer body. The adapter fetches message bodies itself through the mesh connector
(authorized); they never travel in the wake.

**Framing.** If JSONL is kept, each message is exactly one line: embedded raw
newlines are forbidden (escaped as `\n`), each line is byte-bounded with a hard
cap, and the protocol owns a dedicated stdout/socket stream (never interleaved
with other output). If any of those cannot be guaranteed for a given adapter,
use explicit `Content-Length` framing instead of line-delimited JSON.

## 4. Three separate automata, not one lifecycle

Three independent facts must never be conflated:

- **Wake lifecycle** (host-owned):
  `queued → submitted → running(ack) → { done | error | cancelled | uncertain }`.
- **Message evidence** (server-recorded): `stored → offered → seen → accepted`
  (plus a reply). This is the existing delivery stage — about the *message*, not
  the work.
- **Work result**: `done` means the adapter reported that a turn completed — a
  client-reported turn completion, **not** task success or a review verdict.

A wake can reach `done` while the message is still only `offered`, and vice
versa; the three are tracked independently.

### Durability and the terminal `uncertain`

A wake is **durable** at `queued` (host journal) and redelivered on host
restart — but only while it is safe to do so. Once a turn may have started
(`running`), a lost `ack`, a lost `result`, or an unconfirmed `cancel` cannot be
resolved by the host alone: it must **not** `cancel and mark error`, and it must
**not** silently redeliver (that risks a double turn). The terminal state is
**`uncertain`**, which triggers reconcile / manual policy (ask the owner, or read
the adapter's own record if it keeps one). Automatic **retry is allowed only up
to submission** (before a turn could have started), or when the adapter
negotiated an **`idempotent_wake`** capability in `hello` so a repeat is provably
side-effect-free.

### Identity, routing and per-message claim (not a set key)

An idempotency key of `(agent_id, sorted message_ids)` is insufficient — two
waking sets can overlap. Instead: the host mints a **stable `wake_id`** and a
monotonic **route generation** per (agent, transport binding); each message
carries a **per-message ownership/claim** — a message is claimed by exactly one
in-flight `wake_id`, and a later wake takes only the still-unclaimed messages. An
action from a stale generation (an old binding) is rejected.

### Fencing (concrete)

Exactly one controller may drive a given runtime, enforced by a **durable
epoch**: the owning host writes an epoch for the (agent, runtime) binding; only
the current epoch may `wake`/`cancel`; any action carrying a stale epoch is
rejected. This is a dedicated durable fencing token — the heartbeat lease /
`execution_sessions` are **not** suitable and must not be overloaded for it. If
the agent is busy with its own turn the host defers until the adapter reports
idle; the Codex thread target is chosen only from the local owned
`(agent_id ↔ thread_id)` registry, never from message content.

### Timeout

No `ack` within the deadline → bounded, submission-only retry (per above) →
notification fallback. `running` past its deadline with no `result` →
**`uncertain`** (never a unilateral error), reconcile.

## 5. Host services and SDK

- Linux: `systemd --user`; macOS: a launchd LaunchAgent; Windows: a Service or
  Scheduled Task. Local IPC over a unix domain socket / named pipe; JSONL over
  stdio for adapters the host spawns.
- **External-agent SDK**: a thin library (any language) implementing the AMRP
  adapter — connect to the host socket, `hello`, handle `wake`/`cancel`, report
  `result`. Any agent becomes wake-capable without the host knowing provider
  specifics.

## 6. Migration from today

1. Keep SSE/`pg_notify` as mesh→host delivery. The host becomes the single local
   subscriber, replacing the per-session doorbell sidecar.
2. `scripts/runtimes.py` and the task listener become the first AMRP adapters —
   they already spawn bounded jobs (the managed-worker pattern); generalize their
   spawn into the `wake → run → result` verbs.
3. The doorbell is demoted to the best-effort attended-process fallback adapter
   (tmux / notification).
4. Phases: (1) Host + AMRP + one built-in managed-worker adapter on Unix, woken
   by the existing SSE; (2) Codex app-server adapter + Claude worker adapter;
   (3) external SDK + Windows service.

## 7. Where we must not drift

- **Remote shell**: the risk is the mesh *server* causing arbitrary local
  execution. Guard: the server emits only content-free signals (validated IDs);
  the host's *local* policy decides whether and what to run; wake envelopes never
  carry executable content or peer bodies; turns run under the provider's normal
  trust/approval gates. If a mesh message body ever drives the host's action,
  that is a remote shell — forbidden.
- **Scheduler**: the risk is the host/server growing cron-like scheduling or
  multi-step orchestration. Guard: AMRP is strictly *event → bounded turn*
  (react to an addressed message); no time-based scheduling, no server-side job
  queue driving clients.
- **Provider-CLI dependency**: the risk is baking Codex/Claude specifics into the
  core. Guard: AMRP is provider-neutral; Codex/Claude are adapters; the SDK lets
  third parties implement it; the host core imports no provider CLI.

## 8. Minimal vertical slice and tests

MVP: Host + AMRP + one managed-worker adapter (from `runtimes.py`) on Unix, woken
by the existing SSE, with a durable journal, dedup, fencing and a notification
fallback, reaping children on exit.

Tests: redelivery of a pre-submission wake after a host crash, and that a
`running` wake resolves to `uncertain` (never a double turn); per-message claim
across overlapping sets; stale-epoch and stale-generation rejection; fencing
(busy → defer); cancel; the three automata stay independent (`done` with the
message still `offered`); envelope contains only validated IDs (no body); the IPC
endpoint is owner-only (Unix uid+mode 0600 / Windows DACL) and rejects a
non-owner; a signal carrying a body cannot cause execution (the server cannot
drive a local turn's content).
