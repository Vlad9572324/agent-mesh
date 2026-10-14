# Runtime Host MVP contract

The Runtime Host is the local, user-owned bridge between Agent Mesh delivery
and a managed agent process. The normative MVP values are in
[`runtime-host-contract.json`](../runtime-host-contract.json); the architectural
reasoning and future scope are in the [wake runtime RFC](wake-runtime-rfc.md).

## Guarantee and boundary

The Host guarantees wake delivery only for a process that it launched or an
agent that connected through AMRP. It cannot reliably inject a turn into an
unmodified process launched elsewhere. Such a process gets an operating-system
notification, not a false delivery guarantee.

The Mesh server sends identifiers, never executable instructions. The Host
selects an executable, arguments, environment and working directory exclusively
from local configuration. Message text is fetched by the running agent through
its authorized connector; it cannot enter `argv`, environment variables, a
shell command or the control frame.

## Private policy and foreground run

The first release is opt-in and foreground-only. The policy is an owner-only
`0600` JSON file; all paths are absolute and the adapter executable and working
directory must already exist locally:

```json
{
  "version": 1,
  "connector_config": "/etc/agent-mesh/connection/config.json",
  "server_origin": "https://mesh.example:8766",
  "project_id": "my-project",
  "state_dir": "/var/lib/agent-mesh-host",
  "route_id": "local-primary",
  "agent_id": "my-agent",
  "runtime": "reference-echo",
  "argv": ["/usr/bin/python3", "/opt/agent-mesh/scripts/agent-mesh-echo-runtime.py"],
  "working_directory": "/srv/agent-project",
  "env_allowlist": ["HOME"],
  "poll_seconds": 10,
  "handshake_seconds": 10,
  "turn_seconds": 300
}
```

Run one discovery/dispatch cycle while evaluating the MVP:

```sh
python3 scripts/agent-mesh-host.py --policy /absolute/private/host-policy.json --once
```

The reference echo runtime starts no model and reads no message body. A real
adapter must use the same locally reviewed fixed `argv`; the server cannot
replace it. Service installation, external sockets, Windows named pipes and
provider adapters are later phases and are not claimed by this MVP.

## MVP flow

1. The Host persists a content-free wake as `queued` and claims each unclaimed
   message ID for that wake.
2. It checks the current route generation and controller epoch.
3. It starts or contacts the locally configured adapter and sends one bounded
   AMRP frame.
4. Immediately before the Host writes a wake frame it durably records
   `submitted`; adapter acknowledgement then moves the wake to `running`.
5. A reported completion moves the wake to a terminal state. This does not
   imply that the underlying task succeeded.
6. The agent separately records message `seen`/`accepted` evidence through the
   existing Mesh API.

Only `queued` work may be retried automatically. If a crash happens after a
turn may have started, recovery records `uncertain`, unless the adapter
explicitly negotiated a provably idempotent wake operation. A retry retains the
same `wake_id`.

## Security invariants

- Parse UTF-8 JSON with a 65,536-byte frame limit before allocating or acting.
- Reject arrays, scalars, duplicate IDs, unknown frame types and malformed or
  overlong identifiers; do not ignore unsafe fields.
- Reject wake frames containing body, prompt, command, executable, argument,
  environment, working-directory, shell or provider-session fields.
- Never invoke a shell. Launch an exact executable and argument array taken
  from a local owner-controlled allowlist.
- A server flag such as `urgent` affects display or ordering only; it grants no
  capability and cannot bypass local approval.
- Accept control actions only for the current durable controller epoch and
  route generation. A heartbeat lease is not a fencing token.
- On Unix, local sockets and state are owned by the user and mode `0600`. On
  Windows, named-pipe and state ACLs grant the owning SID only. macOS uses the
  Unix rule; service managers do not replace IPC authorization.
- Provider credentials and provider session/thread IDs remain local. An
  optional `resume_hint` is allowed only when the Host derives it from its
  local binding registry; it is never copied from a Mesh event or peer message.

## Crash and concurrency matrix

| Failure or race | Required result | Forbidden result |
| --- | --- | --- |
| Before journal commit | No visible wake | Partial claim |
| After `queued`, before submission | Retry same `wake_id` | New ID or lost wake |
| During/after `submitted`, no proof | `uncertain` | Blind retry |
| While `running`, Host dies | `uncertain` on recovery | Second turn |
| Result committed, ACK lost | Preserve terminal result | Re-run |
| Two wakes overlap | First claims shared IDs; second gets only remainder | One message in two in-flight wakes |
| Old controller acts | Reject stale epoch | Cancel or launch current runtime |
| Old route acts | Reject stale generation | Deliver to former adapter |
| Adapter busy | Defer under the existing claim | Start concurrent turn |
| Malformed/oversized frame | Close/reject without side effect | Partial parse or launch |

## Test matrix

The executable contract test in
[`scripts/test_runtime_host_security.py`](../scripts/test_runtime_host_security.py)
checks the machine-readable contract and an independent reference state model.
An implementation is not complete until black-box tests exercise the same
matrix against its durable journal and process launcher, including forced
termination at every boundary listed above.

Platform acceptance additionally requires:

- Linux: `systemd --user`, owner-only Unix socket and state directory;
- macOS: LaunchAgent, owner-only Unix socket and state directory;
- Windows: per-user Service or Scheduled Task, owner-SID-only named pipe and
  state directory; no command string passed through `cmd.exe` or PowerShell.

CI on one OS may validate the protocol and state machine, but it must not claim
that another OS's ACL boundary passed. Each target must run its native ACL and
process-launch tests.
