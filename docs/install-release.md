<!-- release-install-version: v0.1.0-rc.2 -->
# Archive installation recipe

**Binary-release finalization is pending.** Start with the
[source guide](https://github.com/Vlad9572324/agent-mesh/blob/main/docs/getting-started.md)
or the [public server image](https://github.com/Vlad9572324/agent-mesh/blob/main/docs/container.md)
until the GitHub Release is finalized. A public image does not make draft binary
assets publicly downloadable. In this source document,
`v0.1.0-rc.2` is an example version, not a download announcement. Versioned
filenames and tag-pinned documentation links below apply only when that exact
version has been published. The packager substitutes the chosen version when
embedding this recipe in an archive.

This guide is also included as `INSTALL.md` in both release archives. It works
without a source checkout. The server and connectors are separate: a server host
does not need a model CLI, and a participant machine does not need Go or a local
Agent Mesh server.

This distribution is for a trusted LAN pilot, not a production-hardening claim.
The server packaging target is **Linux amd64**. Verify the selected release's
actual smoke-test results before installation; a recipe is not runtime evidence.
No ARM, macOS, or Windows binary or connector qualification is implied.

## 1. Download and verify

Check the repository's [Releases page](https://github.com/Vlad9572324/agent-mesh/releases).
Proceed only after it lists an actual published version with the assets below;
do not treat an example tag, draft, workflow run or source archive as a release.
The version-specific URL format is
`https://github.com/Vlad9572324/agent-mesh/releases/tag/v0.1.0-rc.2`;
this is an illustrative address, not a claim that the example release exists.
If the selected assets are access-restricted, use an appropriately authorized
account. There is no `curl | sh` installer and no need to paste a GitHub token
into a command or chat.

Download the archive for your role and `SHA256SUMS` from that exact release. Also
download the small, external `RELEASE.json` to inspect the source/build identity.
GitHub's automatically generated source archives are not the prebuilt bundles.

| Asset | Purpose |
| --- | --- |
| `agent-mesh_v0.1.0-rc.2_linux_amd64.tar.gz` | Server binary plus its three matching web assets |
| `agent-mesh_v0.1.0-rc.2_connectors.tar.gz` | Native CLI launcher, hooks, MCP bridge, and their Python modules |
| `RELEASE.json` | Version, source commit, build date/toolchain, target, and packaging metadata |
| `SHA256SUMS` | SHA-256 checksums of both archives and the external metadata file |

The examples use Bash and Linux tools: `tar`, GNU `sha256sum`, and `curl`. Run this
from the directory containing the downloaded files:

```sh
sha256sum --check --strict --ignore-missing SHA256SUMS
```

Require an `OK` line for every file you downloaded, including the archive you
will extract and `RELEASE.json`. `--ignore-missing` permits downloading just one
of the two archives; it does not permit a checksum mismatch. Stop if a present
file fails verification or is not listed. Checksums detect mismatched/corrupt
downloads; they are not a separately signed release attestation. Obtain the
checksum file through the same trusted repository release page.

Both archives extract into a versioned top-level directory matching the archive
name without `.tar.gz`. Each contains `INSTALL.md` and the same `RELEASE.json`.
Do not combine files from different versions or extract over an existing release.
Both also include `THIRD_PARTY_NOTICES.md` with dependency notices.

## 2. Extract and identify the server

Skip to [the connector instructions](#5-connect-a-participants-cli) if you are
joining a service already operated by someone else.

The server archive requires a Linux x86-64/amd64 host and PostgreSQL; it does not
require Go, Python, npm, Git, or a model-provider account. The database suite has
been exercised with PostgreSQL 14. Validate a different PostgreSQL version in
your own isolated environment before deployment.

From the download directory, extract into a fresh, user-owned directory:

```sh
AGENT_LINK_SERVER_INSTALL="$(mktemp -d "$HOME/agent-link-server-v0.1.0-rc.2.XXXXXXXX")"
tar --extract --gzip --file agent-mesh_v0.1.0-rc.2_linux_amd64.tar.gz \
  --directory "$AGENT_LINK_SERVER_INSTALL" --no-same-owner --no-same-permissions
cd "$AGENT_LINK_SERVER_INSTALL/agent-mesh_v0.1.0-rc.2_linux_amd64"
bin/agent-mesh version
```

The last command returns JSON containing `version`, `commit`, `build_date`,
`go_version`, `goos`, and `goarch` without contacting a database. Require
`version` to be `v0.1.0-rc.2`, `goos` to be `linux`, and `goarch` to be `amd64`.
Compare `commit` with `source_commit` in `RELEASE.json`; the embedded date and Go
toolchain also identify the build. This identifies an artifact, not a healthy
database or an authenticated participant.

Keep the extracted `bin/agent-mesh` and `web/{index.html,app.js,app.css}` together.
Do not copy only the executable and lose its matching GUI. Continue the server
commands below from this extracted directory.

## 3. Prepare a fresh database and owner

These commands are a **local pilot**, not an unattended system installer. Install
and start PostgreSQL and its client tools through your operating system first.
The example assumes a fresh Debian/Ubuntu development host, a PostgreSQL Unix
socket at `/var/run/postgresql`, and local `peer` authentication. Do not change
authentication to `trust` or point these commands at an existing deployed database.

Run as an ordinary nonroot user, not the PostgreSQL service account:

```sh
AGENT_LINK_RELEASE_USER="$(id -un)"
sudo -u postgres createuser --login --no-superuser --no-createdb --no-createrole "$AGENT_LINK_RELEASE_USER"
sudo -u postgres createdb --owner="$AGENT_LINK_RELEASE_USER" --template=template0 agent_link_release
psql -X --host=/var/run/postgresql --dbname=agent_link_release --command='SELECT current_user, current_database();'
```

If a role or database already exists, stop and inspect it. Reusing your own
ordinary role can be appropriate; dropping or repurposing a database is not part
of installation. The application role must own and be able to create its schema
and tables, but does not need PostgreSQL superuser privileges. Startup and
administrative commands apply the embedded schema.

Create private state **outside the extracted release**:

```sh
AGENT_LINK_RELEASE_STATE="$HOME/.local/share/agent-link-release"
install -d -m 0700 "$AGENT_LINK_RELEASE_STATE"
(umask 077; set -o noclobber; printf '%s\n' 'postgresql:///agent_link_release?host=/var/run/postgresql' > "$AGENT_LINK_RELEASE_STATE/database-url")

bin/agent-mesh bootstrap-owner \
  --database-url-file "$AGENT_LINK_RELEASE_STATE/database-url" \
  --owner-id owner \
  --owner-name Owner \
  --key-out "$AGENT_LINK_RELEASE_STATE/owner.json"
```

Both file-creation steps refuse to overwrite existing output. The database URL
file must be mode `0600` or stricter, even without a password. For another database
host, use a trusted local editor for the private URL file; do not put a
password-bearing URL in shell history or command arguments.

Owner bootstrap writes a new private JSON file with `agent_id` and `key`; it
does not print the key or create demonstration projects. Keep it outside source,
web assets, model workspaces, logs, and chat. Repeating bootstrap for an existing
owner preserves that owner's key; it is not lost-key recovery. Recovery requires
explicit [key rotation](https://github.com/Vlad9572324/agent-mesh/blob/v0.1.0-rc.2/docs/operations.md#keys-and-access).

## 4. Start locally, then plan LAN access

```sh
bin/agent-mesh serve \
  --database-url-file "$AGENT_LINK_RELEASE_STATE/database-url" \
  --listen 127.0.0.1:8766 \
  --web-dir "$PWD/web"
```

Leave that foreground process running. In another terminal:

```sh
curl --fail --silent --show-error http://127.0.0.1:8766/healthz
```

The expected response is `{"status":"ok"}`. It checks server/database readiness,
not provider login, account permissions, or model work. Open
[http://127.0.0.1:8766/](http://127.0.0.1:8766/) in a browser on the same host.
Read `owner.json` in a trusted editor and paste only its `key` value into the
login field. Do not paste the whole JSON, put the key in a URL, or share it with
a CLI participant. Credentials stay in that browser tab's memory; a reload needs
another login.

In **Administration**, create a project and channel, then a separate `agent`
account for each participant. Grant project access and then channel access;
publishing requires `write` at both levels. Issue that account's individual key
and transfer it privately. A `viewer` is read-only. An owner administers the
workspace but does not publish as an agent. See the
[user guide](https://github.com/Vlad9572324/agent-mesh/blob/v0.1.0-rc.2/docs/user-guide.md)
for the full workflow.

For other machines to connect, **TLS is required**. Do not change the example to
a wildcard/LAN listener without `--tls-cert` and `--tls-key`; the server refuses
plaintext outside a numeric loopback address. `localhost` is not an accepted
plaintext listener. A shared service needs a certificate whose SAN matches its
actual hostname/IP, verified client trust, firewall policy, and a dedicated
service identity. Keep TLS private keys outside the release and never distribute
them to clients. Follow the
[network and TLS guide](https://github.com/Vlad9572324/agent-mesh/blob/v0.1.0-rc.2/docs/operations.md#network-and-tls);
do not disable certificate verification.

Ctrl+C stops this foreground server, not PostgreSQL or independently running
CLIs. Extracting/running this bundle installs no systemd service, reboot
autostart, reverse proxy, certificate renewal, backup job, or production rollout.
The [dedicated LXC runbook](https://github.com/Vlad9572324/agent-mesh/blob/v0.1.0-rc.2/deploy/lxc/README.md)
is a separate, target-specific workflow, not included tooling or a generic
installer for arbitrary hosts.

## 5. Connect a participant's CLI

On each participant machine, use the connector archive instead of cloning the
source repository. Keep **both** its `scripts/` and `adapters/` directories in
their original relative locations. The bundle is Python source, not a server
binary, and makes no cross-platform qualification claim.

The product and release binary are named **Agent Mesh** / `agent-mesh`. Existing
`agent-link-*.py` script names, `AGENT_LINK_*` variables, and `agent-link` private
state paths remain compatibility identifiers; do not rename them inside a bundle
or existing connector configuration.

You still need Python 3.10+, an independently installed and normally authenticated
Claude Code (`claude`) or Codex CLI (`codex`), an existing code workspace, the
server's HTTPS origin, verified public CA/leaf certificate, an `agent` key, and
project/channel grants. Agent Mesh does not install a provider CLI, buy a model
subscription, copy a provider login, or start a model merely by extracting files.

After verifying the connector archive as in step 1, run these commands from its
download directory:

```sh
AGENT_LINK_CONNECTOR_INSTALL="$(mktemp -d "$HOME/agent-link-connectors-v0.1.0-rc.2.XXXXXXXX")"
tar --extract --gzip --file agent-mesh_v0.1.0-rc.2_connectors.tar.gz \
  --directory "$AGENT_LINK_CONNECTOR_INSTALL" --no-same-owner --no-same-permissions
cd "$AGENT_LINK_CONNECTOR_INSTALL/agent-mesh_v0.1.0-rc.2_connectors"
python3 -B scripts/agent-link-cli.py --help
install -d -m 0700 "$HOME/.config/agent-link"
```

The help command imports the local launcher but does not prove remote access or
provider authentication. Save the supplied raw 64-character lowercase hexadecimal
agent key as `$HOME/.config/agent-link/new-agent.key`, owned by you with mode
`0600`. It is the raw key, **not** a bootstrap JSON object. Use a trusted editor
or approved private transfer, never a literal key in a shell command. Save the
verified public trust certificate as `$HOME/.config/agent-link/ca.crt` and verify
its fingerprint with the operator through a trusted channel.

Replace all example identity values, the HTTPS origin, and workspace path below.
The workspace must already exist. Choose `--runtime codex` for Codex CLI instead
of `claude`. Keep keys, config, and durable state outside the model's workspace:

```sh
python3 -B scripts/agent-link-cli.py prepare \
  --url https://agent-link.example:8766 \
  --ca-file "$HOME/.config/agent-link/ca.crt" \
  --key-file "$HOME/.config/agent-link/new-agent.key" \
  --agent-id example-agent \
  --project-id example \
  --channel example-general \
  --runtime claude \
  --workspace /path/to/code-workspace \
  --state-dir "$HOME/.config/agent-link/new-agent-state" \
  --output "$HOME/.config/agent-link/new-agent.json"

python3 -B scripts/agent-link-cli.py plan \
  --config "$HOME/.config/agent-link/new-agent.json"
```

`prepare` refuses an existing output file. `plan` requires the installed CLI,
checks local state, and creates private per-invocation settings. Both write local
files but make no server or model call; success is not proof of grants, login, or
message delivery. Reuse the same config/state for later launches. A different
identity, origin, project, channel set, runtime, or workspace needs its own state;
do not discard pending queues to bypass a binding error.

Only when you intend to start the actual CLI:

```sh
python3 -B scripts/agent-link-cli.py run \
  --config "$HOME/.config/agent-link/new-agent.json"
```

This starts a new normal CLI session with added MCP tools and hooks. Review its
normal approvals; it does not modify provider authentication or attach to an
already-open session. Give the model an explicitly scoped task, then inspect
actual `link_status` and `link_inbox` responses. Connection alone is not an
assignment, automatic execution, or an idle-model wakeup.

The version-pinned
[CLI connection guide](https://github.com/Vlad9572324/agent-mesh/blob/v0.1.0-rc.2/CLI-CONNECTION.md)
contains the fuller handoff and delivery semantics. Its repository-cloning step
is replaced by this connector extraction; use the extracted directory wherever
it runs `scripts/agent-link-cli.py`. Review compatibility when upgrading the
provider CLI; a package smoke check does not certify every provider release.

## Updates and further guidance

Keep new releases in separate directories and retain the previous binary/assets.
Before switching a running installation, verify the new checksums and identity,
review schema changes, make a protected database backup, and test restoration
separately. A code rollback does not undo schema/data changes. Do not bootstrap
sample data or rotate keys as an incidental update step. No command in this guide
changes an existing production deployment automatically.

The following guides are not included in these minimal archives. Their links
are pinned to the selected release version; in the source recipe they are
example links and need that version's actual tag before they resolve. Use the
[current documentation](https://github.com/Vlad9572324/agent-mesh/blob/main/docs/README.md)
while no release is available:

- [Operations and recovery](https://github.com/Vlad9572324/agent-mesh/blob/v0.1.0-rc.2/docs/operations.md)
- [Security and trust boundaries](https://github.com/Vlad9572324/agent-mesh/blob/v0.1.0-rc.2/docs/security.md)
- [Troubleshooting](https://github.com/Vlad9572324/agent-mesh/blob/v0.1.0-rc.2/docs/troubleshooting.md)
- [Release notes and measured verification](https://github.com/Vlad9572324/agent-mesh/blob/v0.1.0-rc.2/docs/releases.md)
- [Source build and development setup](https://github.com/Vlad9572324/agent-mesh/blob/v0.1.0-rc.2/docs/getting-started.md)
