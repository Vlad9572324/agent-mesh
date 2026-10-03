# Run Agent Mesh in containers

[Documentation](README.md) · [Binary release installation](install-release.md) · [Release process](release-process.md)

The container route packages the server and matching web assets, with a separate
PostgreSQL 14 container managed by Docker Compose. It does not include a model,
provider CLI, connector daemon, or production deployment. Native CLI participants
still run on their own machines using the [CLI connection guide](../CLI-CONNECTION.md).

**Published image:**
`ghcr.io/vlad9572324/agent-mesh-server:v0.1.0-guide.1`.
The [publication workflow](https://github.com/Vlad9572324/agent-mesh/actions/runs/37154697658)
passed for source `3bb79dd9dca94b1fe0ff4d32225c12f17e2f03c1`, including container
execution and digest-pull identity checks. Independent anonymous downloads
verified the configuration and all four layers against their descriptor sizes
and SHA-256 hashes, plus exact source/version and nonroot metadata. That download
verification did not execute Docker. See [release status](releases.md) for the
full evidence and preserved earlier releases.

Agent Mesh is licensed under [Apache-2.0](../LICENSE). The packaging-version-3 image contains
`LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES.md` under `/opt/agent-mesh/`, with an
Apache-2.0 OCI license label. Dependencies retain their own licenses.
The rc.3 image already includes these files; rc.2 predates this addition. Both
earlier images remain unchanged.

## Releases and Packages are different

| Distribution | Identity | What it supplies |
| --- | --- | --- |
| GitHub prerelease | [v0.1.0-guide.1](https://github.com/Vlad9572324/agent-mesh/releases/tag/v0.1.0-guide.1) | Linux amd64 server archive, Python connectors, metadata and checksums; all four assets verified anonymously |
| Public GHCR release image | `ghcr.io/vlad9572324/agent-mesh-server:v0.1.0-guide.1` | Linux amd64 server image; configuration and all four layers verified anonymously |
| GHCR manual candidate — separate workflow | `ghcr.io/vlad9572324/agent-mesh-server:sha-<full-commit>` | Linux amd64 server container from a manually published source commit |

Manual container candidates report a version such as
`v0.1.0-rc.2-container.<12-character-commit>`. This is a build-identity format,
not an existing GitHub Release. There is no moving `latest` tag in this workflow.
Use a successful publication's exact image reference and source commit; the
existence of a Dockerfile or workflow does not prove an image has been published.
The separate [automatic release workflow](release-process.md#automatic-version-tag-releases)
uses the exact new release version for both the binary and GHCR tag. It does not
overwrite earlier published artifacts.

The publication workflow refuses to replace an existing commit tag. That is a
project write-once policy, not a claim that GHCR makes tags immutable. Pin an
image digest when you need an exact image. GitHub documents digest-based pulls
in its [Container registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pull-by-digest).

## Prerequisites and boundaries

- A deliberately selected Linux amd64 host with a working **local, rootful Docker
  daemon** and Docker Compose v2. Installing Docker or granting daemon access is
  an operator decision, not performed by this guide or helper.
- An ordinary nonroot Linux operator account allowed to use that daemon. This
  Compose setup maps the operator's numeric UID/GID into the containers so private
  bind-mounted files remain readable without `sudo`, `chown`, or relaxed modes.
  Rootless Docker, user-namespace remapping, remote daemons, Docker Desktop, ARM,
  macOS, and Windows are not qualified by this setup.
- Python 3.10+ and OpenSSL for the local preparation helper; no Go compiler is
  needed to run a published image.
- A repository checkout containing `deploy/compose/compose.yaml`, `prepare.py`,
  and `init-app.sh`, taken from the selected image's source revision. These
  operator files are not part of the minimal binary archives. Obtain them from
  this source repository; do not mix arbitrary revisions.
- An existing TLS certificate/chain and matching private key. The certificate
  SAN must match the hostname/IP clients actually use, including `127.0.0.1` if
  following the local example, and clients must trust its verified public CA/leaf.
  The unencrypted PEM key must be owned by the operator and mode `0600` or stricter.

The server listens on a non-loopback address **inside** its container, so TLS is
required even when the host publishes only `127.0.0.1:8766`. Do not disable TLS
verification. Certificate issuance, renewal, firewall rules, DNS, and client trust
remain explicit operator work; see [network and TLS](operations.md#network-and-tls).

The runtime image uses `scratch`, a nonroot user, and
`/opt/agent-mesh/bin/agent-mesh` as its entrypoint. It contains the matching `web/`
assets and release metadata/notices, not a shell, package manager, or PostgreSQL.
Its default command is `version`; running an image alone does not initialize a
workspace. Compose overrides the UID/GID for the selected operator's private files.

## 1. Public pulls and optional private-fork authentication

For this project's public `agent-mesh-server` image, **no GitHub account, personal access token,
or `docker login` is required**. Continue directly to the digest-pinned pull below.
Public source and package permissions remain separate settings; the new server
package is public by explicit maintainer policy, not an assumption about defaults.

The rest of this section applies only to an independently operated **private
fork/package**. Do not collect or configure a registry token for the public image.

Repository Git authentication and GHCR authentication are distinct. A fine-grained
PAT used to fetch Git source is **not** a supported direct GHCR login token.
For an authorized private-fork image pull, use a classic PAT with `read:packages`; enable
SSO if your organization requires it. GitHub Actions publication uses its own
`GITHUB_TOKEN`, not your personal token.
[GitHub's registry authentication documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry)
describes these supported credentials.

The account must also have read access to the package; a token scope does not
create that access. Package access permissions may be inherited from the repository;
package visibility is configured separately. Do not make a private package public to bypass an access
error. See [GitHub Packages permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages).

For that private fork only, if not already authenticated, use Bash's hidden input so no literal token enters
shell history or command arguments. Do not run this with shell tracing enabled:

```sh
read -r -p 'GitHub login: ' AGENT_MESH_GITHUB_USER
read -r -s -p 'Classic token with read:packages: ' AGENT_MESH_GHCR_TOKEN
printf '\n'
printf '%s' "$AGENT_MESH_GHCR_TOKEN" | docker login ghcr.io \
  --username "$AGENT_MESH_GITHUB_USER" --password-stdin
unset AGENT_MESH_GHCR_TOKEN
```

Protect Docker's credential configuration using your normal credential-helper
policy. Never put a registry token in the image, Docker build arguments, Compose
environment file, repository, model workspace, or chat.

## 2. Pull and inspect the selected image

Pull the exact published `v0.1.0-guide.1` image without a login:

```sh
AGENT_MESH_IMAGE='ghcr.io/vlad9572324/agent-mesh-server@sha256:560d7225167e9ea0327fbe12f2186021e58d6e00273a5755c38690fb828ad7e9'
docker pull "$AGENT_MESH_IMAGE"
docker run --rm --network none "$AGENT_MESH_IMAGE" version
```

The version command needs no database or service keys. Check its JSON `commit`,
`version`, `build_date`, `go_version`, `goos`, and `goarch` against the selected
publication. A version match is artifact identity, not database readiness,
provider authentication, or a deployment test.
For this digest, require `version` to be `v0.1.0-guide.1`, `commit` to be
`3bb79dd9dca94b1fe0ff4d32225c12f17e2f03c1`, and target `linux` / `amd64`.
Use that same source revision's Compose files. Tag-pinned guides are historical
snapshots and may retain prepublication status wording; the
[current release status](https://github.com/Vlad9572324/agent-mesh/blob/main/docs/releases.md)
records actual distribution availability.

## 3. Prepare new private state

From the matching repository checkout, select a **new** absolute state directory
outside the repository and model workspaces. Choose a Compose project name not
already used by another stack. Its parent must already exist; create
`$HOME/.local/share` first if needed. The helper accepts canonical, symlink-free
paths using only letters, digits, `/`, `.`, `_`, and `-`, not spaces. The example
below is not an update procedure:

```sh
AGENT_MESH_STATE="$HOME/.local/share/agent-mesh-container-pilot"
AGENT_MESH_PROJECT=agent-mesh-pilot
python3 -B deploy/compose/prepare.py \
  --state "$AGENT_MESH_STATE" \
  --image "$AGENT_MESH_IMAGE" \
  --tls-cert /absolute/path/to/server-chain.crt \
  --tls-key /absolute/path/to/server.key
```

Replace both TLS paths with approved files. The helper refuses an existing state
directory and does not install anything, start containers, use `sudo`, or change
ownership. It creates operator-owned private directories/files, copies the TLS
material, generates separate database passwords, and writes `compose.env` with
paths, UID/GID, image reference, and host binding—not credential values. Do not
print or publish its private files. Keep this state after container replacement.

The default host binding is numeric loopback `127.0.0.1`, port `8766`. For a
deliberately selected LAN interface, set `--bind-ip` to its numeric IPv4 address
and choose `--port` if needed. Confirm certificate SAN, client trust, and firewall
policy before exposing it. No database port is published to the host.

Only the app joins a separate normal `frontend` bridge for that published HTTPS
port. The database and one-shot bootstrap stay on the internal `backend` network.
This separation matters: Docker can omit host port mappings for a container
attached exclusively to internal networks. The frontend is not an outbound
traffic sandbox; host firewall policy remains the operator's responsibility.

PostgreSQL is a separate digest-pinned PostgreSQL 14 image. Its fresh-database
initialization creates an application database and non-superuser application
role; the application does not receive PostgreSQL's administrative password.
Initialization runs only for new database storage. Replacing a password file does
not automatically rotate an existing database role's password.
Application-to-database TCP is password-authenticated but not TLS-encrypted on the
private internal Compose network. Do not publish the database port or attach
untrusted containers to that network; this is not an encrypted-database-transport
claim.

## 4. Bootstrap deliberately, then start the server

Start the selected database container:

```sh
docker compose --env-file "$AGENT_MESH_STATE/compose.env" \
  -f deploy/compose/compose.yaml -p "$AGENT_MESH_PROJECT" up -d db
```

Create the first owner explicitly:

```sh
docker compose --env-file "$AGENT_MESH_STATE/compose.env" \
  -f deploy/compose/compose.yaml -p "$AGENT_MESH_PROJECT" \
  --profile init run --rm bootstrap-owner
```

The one-shot command writes `$AGENT_MESH_STATE/owner/owner.json` privately and
refuses to overwrite an existing output. It does not create demonstration
projects or participants. Repeating bootstrap does not recover a lost owner key;
use a deliberate [key recovery operation](operations.md#keys-and-access) instead.

Start the server against that database:

```sh
docker compose --env-file "$AGENT_MESH_STATE/compose.env" \
  -f deploy/compose/compose.yaml -p "$AGENT_MESH_PROJECT" up -d app
curl --fail --silent --show-error \
  --cacert /absolute/path/to/verified-public-ca.crt \
  https://127.0.0.1:8766/healthz
```

Use the actual trusted hostname/IP and public CA path. Expect `{"status":"ok"}`.
Open the same HTTPS origin in a browser with verified certificate trust. Read
`owner/owner.json` in a trusted editor and paste only its `key` value into the
login field; never put it in a URL or give it to a CLI. Create a project, channels,
and individually scoped participant accounts through the [user guide](user-guide.md).

Normal Compose startup does **not** run bootstrap, create an owner, or seed demo
data. It does not start a provider CLI/model, attach an existing agent session,
or install a host-level service. A container restart is not a model wakeup.
The optional owner invitation wizard additionally requires a trusted public HTTPS
origin and CA configuration described in [agent onboarding](agent-onboarding.md).
Its connection command runs on the participant’s machine; neither inviting an
agent nor receiving an ordinary message starts a model in this container.
Compose does set `restart: unless-stopped` for the app and database, so Docker can
restart those explicitly started containers under its own lifecycle policy. It
does not configure whether Docker itself starts on host boot.

## Persistence, stopping, and updates

To stop this selected stack without deleting its private state:

```sh
docker compose --env-file "$AGENT_MESH_STATE/compose.env" \
  -f deploy/compose/compose.yaml -p "$AGENT_MESH_PROJECT" down
```

The database and credentials use bind-mounted directories beneath your state
path, not an anonymous throwaway volume. `down` does not delete them; even
`down --volumes` is not a purge of these bind mounts. Do not delete the state
directory, rerun the fresh-state helper over it, or copy live PostgreSQL data
files as a backup. Use protected database dumps and a tested restore procedure;
see [backups and restore](operations.md#backups-and-restore).

For an update, retain the old image digest and private state, review schema
changes, back up and test restoration, then deliberately select the new image
and matching Compose revision. A code/image rollback does not undo schema/data
changes. Never reseed, rotate keys, or change database credentials incidentally.
TLS material copied into state also needs an explicit replacement/restart plan
when renewing a certificate.

For an explicitly chosen owner-key recovery, use the one-shot service's existing
private mounts and a **new** output filename; the scratch image has no shell:

```sh
docker compose --env-file "$AGENT_MESH_STATE/compose.env" \
  -f deploy/compose/compose.yaml -p "$AGENT_MESH_PROJECT" \
  --profile init run --rm bootstrap-owner rotate-key \
  --database-url-file /run/agent-mesh/database-url \
  --agent owner --key-out /run/agent-mesh/owner/owner-replacement.json
```

This intentionally invalidates the previous owner key. It is not a normal start
or update step. Read the new file privately and reconnect the intended client.

## Hosted validation and publication

The `Container CI` workflow validates pushes to `main` and pull requests. Only a
manual dispatch on `main` can enter its separately permissioned publication job,
and validation must pass first. The required `expected_sha` input must be the
full 40-character `main` commit you reviewed; a different dispatch commit fails
the guard instead of publishing unexpected source. Publication uses `GITHUB_TOKEN` with
`contents: read` and `packages: write`; routine validation has no package-write
permission. No long-lived registry credential is added to repository secrets.

Jobs use the GitHub-hosted `ubuntu-24.04` runner, allocated for each job—not a
self-hosted runner registration, persistent coding agent, or always-on server.
For a private repository, hosted execution uses the account's Actions allowance
and applicable billing. See [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

The workflow builds from a fixed source commit and runs an isolated container
smoke check before pushing its full-commit tag. Container checks use owned test
resources, not a production database or provider session. A successful build,
smoke check, push, and digest verification are distinct facts; inspect the actual
workflow result. The [release process](release-process.md#container-publication-in-github-packages)
describes the publication gates. No workflow deploys the image to a user host.

The separate `release.yml` workflow can publish a version-tagged image alongside
a new GitHub Release after tag/source fencing and remote verification. Its manual
dispatch with `version` and `expected_sha` is **dry run only** and never publishes.
That is distinct from manually dispatching `Container CI`, which does publish a
commit-tagged candidate after its checks pass. Use the correct workflow for the
outcome you intend; see [automatic release gates](release-process.md#automatic-version-tag-releases).
