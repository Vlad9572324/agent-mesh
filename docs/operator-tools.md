# Operator and verification tools

[Documentation](README.md) · [Contributing](../CONTRIBUTING.md) · [Operations](operations.md)

Operator helpers and browser acceptance suites require explicit local settings.
They do not discover a previous operator's machine, credentials, browser cache,
or deployment. The source checkout is located from the tool's own file; private
state and evidence belong outside it.

Configuration is not authorization. Some tools start services, write fixtures,
back up databases, or invoke provider CLIs. Inspect the chosen script and agree
on its exact target, permitted actions, cost and cleanup before running it.
Nothing in this guide instructs you to run a live-service or model experiment.

## Shared settings

Set the variables used by the selected tool explicitly in its environment.
Required values must be nonempty, without surrounding whitespace or control
characters. Paths must be absolute; a literal `~` is not expanded by the helpers.

| Variable | Meaning |
| --- | --- |
| `AGENT_LINK_RUNTIME_DIR` | A dedicated private runtime directory outside the source checkout; neither the filesystem root, your home itself, nor a parent containing the checkout is accepted. Symlink aliases do not bypass this boundary. |
| `AGENT_LINK_ORIGIN` | The intended bare HTTPS origin, including a port when needed; no user information, path prefix, query or fragment. |
| `AGENT_LINK_CA_FILE` | Absolute path to the independently verified public trust certificate. Never a TLS private key. |
| `AGENT_LINK_CHROME` | Absolute path to the browser executable selected for the check; no developer-cache path is assumed. |

These are example values, not an existing service or a command to provision one:

```sh
export AGENT_LINK_RUNTIME_DIR=/private/agent-mesh/operator-runtime
export AGENT_LINK_ORIGIN=https://agent-mesh.example:8766
export AGENT_LINK_CA_FILE=/private/agent-mesh/trust/ca.crt
export AGENT_LINK_CHROME=/usr/bin/chromium
```

Replace each with an operator-approved value. Choose a writable private runtime
directory with mode `0700`; credentials, dumps and evidence files should be
restricted to their intended owner. Keep environment files out of Git and do not
put raw keys or password-bearing database URLs into command arguments or examples.
The shared configuration readers validate settings; importing them does not
create directories, read credentials or contact a service.

## Local service and database helpers

`scripts/local-runtime.mjs` and `scripts/backup-local.mjs` use the explicitly
selected runtime directory. The local PostgreSQL layout and numeric-loopback
port `55439` are harness conventions, not settings for a remote server. Confirm
that the intended directory is new or belongs to this exact local instance;
never point a helper at an unrelated database tree.

`scripts/serve-local.mjs` also requires `AGENT_LINK_BIND_IP`, an explicitly
selected IPv4 address. Its HTTPS origin must name that same address; the
origin's port supplies the listener port. Provide matching TLS SANs and the
expected private runtime files before starting it. Selecting settings does not
install packages, establish certificate trust or authorize service startup.

The local service helper binds its ownership record to the runtime, full process
arguments and process start identity. A live mismatching PID or an older record
without that identity is an inspection error, not permission to start another
server or stop an unrelated process. Do not delete or fabricate the record to
bypass this check; inspect the existing process and arrange an explicit migration.
Start/stop operations also take an exclusive private lifecycle lock. A lock left
after an interrupted operation requires inspection; the helper never guesses
that a stale-looking lock is safe to remove.

For portable server installation, prefer the [release guide](install-release.md),
[container guide](container.md), or [source quickstart](getting-started.md).
These have their own explicit preparation steps and are not interchangeable with
an operator's established local runtime layout.

## Browser, staging and provider boundaries

- Isolated acceptance suites may create their own test schema, TLS server and
  temporary browser profile. They still need their documented local dependencies
  and dedicated test database; never substitute a production DSN.
- Shared staging suites require exclusive use of the agreed loopback fixture
  service and its private fixture credentials. Preserve their target and
  database guards rather than pointing them at a deployment.
- GET-only deployment checks require explicit origin, trust and credentials.
  "Read-only" describes their API requests, not permission to expose screenshots,
  returned project content or local evidence publicly.
- Provider experiments can start paid model work or publish project records.
  Their purpose-specific target and workspace settings require separate review;
  they are not a generic connection test or part of an offline documentation check.

Use only owned temporary processes/profiles and retain evidence privately.
Certificate pinning or relaxed browser flags inside an isolated harness do not
establish production browser trust. Record skips and cleanup failures as well as
assertion results. See [Contributing](../CONTRIBUTING.md#browser-and-end-to-end-tests)
for suite categories and [CLI connection](../CLI-CONNECTION.md) for normal use.

### Purpose-specific settings

The following tools require additional explicit settings. All variable names in
this table include the `AGENT_LINK_` prefix; none supplies an implicit target.

| Tool or category | Additional configuration and boundary |
| --- | --- |
| `scripts/check-lifecycle-rollout.mjs` | `AGENT_LINK_SOURCE_DB_PORT`: explicitly selected port in `1..65535`; the source database remains numeric-loopback-only with its existing database-name guard. |
| `scripts/check-lxc-migration.mjs` | `AGENT_LINK_SOURCE_DB_PORT`, absolute `AGENT_LINK_KNOWN_HOSTS`, explicit `AGENT_LINK_SSH_HOST` (`[user@]hostname`) and `AGENT_LINK_EXPECTED_HOSTNAME`, plus the required `--vmid` argument. Existing target marker, exact hostname and read-only SQL checks remain mandatory. |

There are no implicit host, runtime or trust-file defaults. A configured
environment does not make a tool read-only: checks can contact the explicitly
selected service and write private local evidence. Review each current command
interface and its preconditions before use. The explicit browser watchers below
are the documented route for scoped GUI observations.

### Browser and cross-machine inputs

Browser-spawning suites and screenshot capture require the shared runtime,
browser and CA settings. Their local fixture leaf/key remain at
`secrets/server.crt` and `secrets/server.key` beneath the selected runtime
directory; provide a matching public trust chain through `AGENT_LINK_CA_FILE`.
These are layout conventions, not bundled credentials. Live GUI suites also
require the explicit origin; the legacy wrapper passes only its owned loopback
origin to child suites.

The GET-only native, project-map, project-native and redesign-preview watchers
require `AGENT_LINK_TEST_PROJECT_ID`, `AGENT_LINK_TEST_OWNER_ID` and
`AGENT_LINK_TEST_KEY_FILE`, an absolute private file containing the raw owner key.
Do not use bootstrap JSON as a raw key or copy its contents into an environment
variable. Their additional settings describe already existing records:

| Watcher | Additional required settings |
| --- | --- |
| `tests/native_gui_readonly_live.mjs` | `AGENT_LINK_TEST_CHANNEL_ID`, `AGENT_LINK_TEST_CODEX_ACTOR_ID`, and `AGENT_LINK_TEST_BASELINE_EVENT_ID` identifying an existing `session.ended` event. |
| `tests/project_map_readonly_live.mjs` | `AGENT_LINK_TEST_DEPLOYMENT_FILE`, an absolute path to the private existing JSON record with `release` and `web_artifacts`. |
| `tests/project_native_readonly_live.mjs` | The same deployment file; `AGENT_LINK_TEST_CODEX_ACTOR_ID`, `AGENT_LINK_TEST_CLAUDE_ACTOR_ID`, `AGENT_LINK_EXPECTED_CODEX_SESSION` and `AGENT_LINK_EXPECTED_CLAUDE_SESSION`. |
| `tests/redesign_preview_live.mjs` | `AGENT_LINK_TEST_CHANNEL_ID` and absolute `AGENT_LINK_TEST_WEB_DIR` for the exact candidate assets. |

`tests/crossvm_artifacts.py` is not a passive watcher. Its explicit `--run-probe`
mode starts owned test work and a remote receiver through SSH/container tools.
In addition to runtime/origin/CA, it requires `AGENT_LINK_TEST_BIND_IP` (IPv4,
matching the origin host), `AGENT_LINK_TEST_SSH_TARGET` (`account@host`),
`AGENT_LINK_TEST_LXC_VMID` (positive decimal),
`AGENT_LINK_TEST_RECEIVER_HOSTNAME` (approved short hostname),
`AGENT_LINK_TEST_RECEIVER_MARKER_FILE` (absolute path) and
`AGENT_LINK_TEST_RECEIVER_MARKER` (expected identifier). Reserve the dedicated
test resources and approve that remote work separately. Strict SSH host-key,
hostname and marker guards are not optional configuration conveniences.

None of these settings means a live watcher, provider experiment or cross-machine
probe has passed on a new operator's environment. The screenshot script's
`--check-safety` mode remains an offline synthetic check with no environment
configuration required.

## Dedicated-LXC updates

The [LXC updater](../deploy/lxc/README.md#code-only-release-update) separately
requires `AGENT_LINK_EXPECTED_HOSTNAME`: the independently verified short DNS
hostname of the approved target. There is no host default. The comparison with
the actual hostname remains mandatory, alongside LXC detection, the root-owned
private target marker, expected release, checksum and health checks.

Do not populate this setting by simply reading the current machine's hostname:
that defeats the independent target decision. Never weaken a guard to make a
command pass. Deployment, key rotation, data migration and provider execution
remain separately authorized operations.

## Privacy checks are current-tree checks

Keep operational addresses, host/container IDs, private domains, local paths,
raw credentials, unfiltered logs, and data/certificate fingerprints outside the
repository. Public build checksums and deliberately fictional fixtures have a
different purpose; retain their documented provenance.

A sanitized current checkout does not remove earlier Git revisions, tags,
release source archives, workflow artifacts or external copies. Review those
surfaces separately before changing visibility. No tool configuration or privacy
check in this guide authorizes rewriting Git history or publishing a repository.

The following checks use source files and synthetic fixtures; they do not start
services or provider sessions:

```sh
node scripts/check-privacy.mjs
node tests/privacy_gate.mjs
node tests/operator_config.mjs
python3 -B -m unittest discover -s scripts -p test_operator_config.py
```

The privacy gate checks supported current-tree text for configured disclosure
patterns and HEAD author/committer fields for common personal-email patterns.
It is not a secret-detection guarantee or clearance of earlier Git history,
images, release artifacts, hosted logs or external copies.
