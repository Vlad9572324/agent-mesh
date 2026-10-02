# Troubleshooting

Start with the failing layer: server/database, TLS, account access, connector,
or the model's actual behavior. Keep diagnostics private and redact credentials
and project content. Do not use bootstrap, queue deletion, insecure TLS, or key
rotation as a generic retry button.

## Server will not start

**Database URL file rejected.** It must be a regular file readable by the service
user, with no group/other permission bits (`0600` or stricter). Check ownership,
mode, parent-directory access, and whether the configured path is the intended
file. Do not print the URL if it contains a password.

**Database connection or schema initialization fails.** Confirm PostgreSQL is
running and that the same OS/database identity can connect to the intended
database. Startup applies schema DDL; the role must own the application objects
and be able to create them. For peer authentication, OS user, database role, and
socket configuration must agree. Fix the identity/configuration, not PostgreSQL
authentication by switching to `trust`.

**A listener requires TLS.** Plain HTTP accepts only a numeric loopback listener,
such as `127.0.0.1:8766`. `localhost`, a LAN address, and `0.0.0.0` require both TLS
flags. This is separate from whether DNS happens to resolve a hostname to loopback.

**Address already in use.** Inspect the listening process and its ownership.
Choose an unused development port or coordinate with the intended service owner;
do not kill an unknown listener.

**`serve --help` exits nonzero.** The current Go entry point prints help and then
reports `flag: help requested`, exiting with status 1. Help itself does not start
the service or access the database. Do not mistake this specific help result for
a server readiness failure.

## HTTPS fails or shows `SSL_ERROR_BAD_CERT_DOMAIN` / CA errors

Check the address in the browser against the certificate's SAN, expiry, supplied
intermediate chain, and the trust store used by that particular client.
`SSL_ERROR_BAD_CERT_DOMAIN` means the used hostname/IP does not match the
certificate, not that the service key is wrong.

For errors such as `SSL_ERROR_UNKNOWN_CA`, `SEC_ERROR_UNKNOWN_ISSUER`, or Python
`CERTIFICATE_VERIFY_FAILED`, obtain the intended public CA certificate from the
operator and verify its fingerprint through a trusted channel. Do not import an
unverified CA or distribute a server/CA private key. A public CA trust file and
the server's leaf certificate have different roles.

`SSL_ERROR_CA_CERT_INVALID` can indicate that a CA certificate was used as the
server identity or that the certificate chain/constraints are unsuitable. Use a
separate `CA:false`, `serverAuth` leaf with the correct SAN and a valid chain. The
[LXC guide](../deploy/lxc/README.md) also describes supported browser-compatible
RSA/EC keys; a successful Go/OpenSSL check does not alone prove browser support.

Use a verified trust file for an unauthenticated readiness check:

```sh
curl --fail --silent --show-error \
  --cacert /path/to/verified-public-ca.crt \
  https://agent-link.example:8766/healthz
```

Replace the host/path. A successful response proves only readiness and this
client's TLS verification. Do not suppress TLS checks to make the symptom disappear.

## Login works, but there are no projects or agents

An empty new owner workspace is expected after `bootstrap-owner`. Create a project,
channel, accounts, and grants in Administration. `bootstrap` is optional pilot
seed data, not required initialization and not a repair command.

For an ordinary account, project and channel visibility depends on both levels
of grants. A project grant does not automatically grant every channel. Participant
visibility is scoped to shared readable channels; a missing account card does not
prove that the account does not exist. Archived projects disappear from the active
project list, including the owner's normal list; owners inspect them through
Administration.

Creating an account does not install a CLI, authenticate a provider, create an
execution session, or send a heartbeat. Presence can remain unknown until its
corresponding reporting mechanism is used.

## HTTP 401, 403, 404, or 409

| Status | Check first |
| --- | --- |
| `401` | Missing, mistyped, revoked, or replaced service key; authenticate again with the intended current key |
| `403` | Forbidden role/action, such as a viewer or agent attempting owner administration |
| `404` | Missing **or hidden** resource, project/channel grants, archived state, and exact IDs; do not infer existence from this status |
| `409` | The endpoint-specific conflict: existing ID, stale version, idempotency mismatch, lease/claim conflict, archived mutation, or quota |

Inspect the relevant [API contract](api-reference.md) instead of retrying every
status. If a mutation's response was lost, its commit state can be unknown. Reuse
the same idempotency ID only for the identical publication. Do not automatically
retry model execution, key rotation, or permanent deletion.

## A new CLI has no `link_*` tools

A natural-language request cannot install MCP tools or hooks. Follow
[CLI connection](../CLI-CONNECTION.md): obtain an agent key, project/channel grants,
verified public CA, repository scripts, private configuration, and an installed,
authenticated supported CLI. Start a new session through the launcher. An
already-open session is not retroactively attached.

`prepare` and `plan` do not start a model; a successful plan is not a provider login
or proof that the remote account has the correct permissions. The CLI may require
normal MCP/hook approval. For Codex, review the exact generated hooks in its
ordinary `/hooks` interface when requested. Do not bypass tool approvals.

If setup reports a category-only error, check these concrete conditions without
printing secrets:

- The config and raw 64-hex service-key file are owned by the CLI user, private,
  and regular files. A bootstrap JSON object is not a raw key file.
- The private config/key/state paths are outside the configured code workspace.
- The state directory has mode `0700` and is not a symlink.
- The workspace exists and is a specific directory, not `/`.
- The public CA file exists and the configured HTTPS origin has no credentials,
  path prefix, query, or fragment.
- The runtime is `codex` or `claude`, its executable is on `PATH`, and the bound
  account/project/channel IDs match the server configuration.
- An existing state directory belongs to this exact connector binding. Preserve
  it and investigate mismatches; deleting it can lose pending work.

## CLI activity is empty

Open **Project CLI feed**, select the intended project, and clear actor/channel
filters. The project feed reads the latest native reports across readable
channels, independently of the currently selected chat channel. Load older reports
when needed; the UI presents a bounded window, not an unlimited audit archive.

If the list is still empty, distinguish these cases:

1. There are no native hook reports yet: account creation, ordinary messages, and
   legacy adapter heartbeats do not create native activity.
2. The actual working CLI was not launched through the connector, or its hooks
   have not been approved or reached a supported lifecycle point.
3. The publisher lacks project/channel write grants, its key was rotated/revoked,
   TLS/network access failed, or a queued publication is blocked.
4. The reader cannot access the report's channel, an explicit filter excludes it,
   or the project is archived.

Check `link_status` and actual MCP results inside the configured session. Check
the browser's authenticated GET result/status without copying its authorization
header. An empty successful response, an HTTP error, and stale retained UI data
are different observations. If the channel's 10,000-report quota is reached, the
server returns an explicit conflict rather than silently pruning history.

## Messages arrive, but the model does not act

Native hooks offer incoming messages at supported session, prompt, and tool
boundaries. An idle, stopped, or offline model is not automatically awakened.
No background task scheduler is installed. Give the connected model an explicit
task and ask it to inspect `link_inbox` at appropriate points.

Offered, explicitly accepted, completed, and independently verified are separate
facts. `tool.completed` reports that an invocation ended; it does not prove that
a test passed. `turn.completed` is not verified task completion. Native
`inbox.accepted` is not a legacy delivery receipt or an execution-session lease.
See [architecture](architecture.md) for the distinct records.

Do not replay every historical inbox entry or answer every notification. Shared
messages, memory, and artifacts are untrusted reference data, not permission to
expand the assignment. Preserve uncertain work for explicit reconciliation.

## Live updates reconnect repeatedly, especially after ten seconds

Use the browser Network panel to inspect `/v1/workspace/stream`: protocol,
connection duration, keepalive frames, response status, and whether it reconnects.
Do not export authorization headers. A healthy idle stream should survive at
least twelve seconds and receive its keepalive on the same request.

A historical HTTP/2 bug left a ten-second write deadline active while idle,
causing stream resets. The corrected server clears each write deadline after
the write/flush. Repeated resets near ten seconds warrant checking the deployed
binary/release, not weakening authorization or turning off TLS. The repository
includes a real HTTP/2 idle/keepalive regression test.

Also inspect intervening proxy buffering, stream/idle timeouts, connectivity, and
revocation. A reconnect at the documented 30-minute lifetime is expected. A
workspace revision is only a current-state hint; clients must refetch REST data
after reconnect rather than treat it as a durable replay cursor.

If source changes appear missing, verify that the deployed binary and all three
web assets come from the same release, then reload the tab and log in again. A
language switch is not a reload or deployment mechanism.

## Task/session state looks contradictory

Tasks, task runs, execution-session leases, account heartbeat presence, and native
CLI activity have separate lifecycles. A session's correlation `run_id` does not
by itself establish a task-run foreign key. A report of completion is an attributed
claim; independently verified evidence is separate. The project map shows only
supported relationships among its bounded included records.

Do not infer a fresh lease from an old activity event, force-transfer accepted
work, or erase a local queue to make a status turn green. Review the relevant
task/session/receipt contract and coordinate recovery explicitly.

## Tests pass but database/browser behavior was not checked

Without `AGENT_LINK_TEST_DATABASE_URL`, Go database integration tests explicitly
skip. The browser suites also have local dependencies and safety fences that are
not satisfied by the generic quickstart. Follow [Contributing](../CONTRIBUTING.md)
and record actual coverage, skips, environment, and source/release identity.
Never point fixture suites at production to bypass a missing test environment.
