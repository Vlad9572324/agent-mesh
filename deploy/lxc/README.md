# Agent Mesh in a dedicated unprivileged LXC

These assets install a prebuilt binary and the matching three browser assets on a
new Debian/Ubuntu LXC using systemd and the distribution PostgreSQL package. They
do not use Docker, nesting, privileged containers, source clones, model runtimes,
provider credentials, or package downloads. No source-host service is changed.
`install.sh` is for initial installation, not replacement of an existing node.
`update.sh` separately supports a verified code-only release on an explicitly
approved dedicated node, as described below. Historical `agent-link` service,
binary and filesystem names are compatibility identifiers, not a target host.

## Stage and prepare

Provision the new container and install PostgreSQL, its client tools, OpenSSL and
CA certificates **inside that container**, using the operator's chosen package
source. A working systemd boot is required. Record its IP, container ID, host and
template outside the app. Do not use an existing source, model-runtime, or
unrelated workload node.

Only on that newly provisioned container, root creates
`/etc/agent-link-lxc-target`, owned by root:root, mode 0600, containing exactly
`agent-link-lxc-v1` plus a newline. The installer independently requires LXC
virtualization and systemd; do not create this marker on a source/runtime host.

Copy the three deployment files into a root-owned private directory, with files
mode 0644 (or 0755 for the installer). Stage a root:root mode-0700 bundle directory
with these root-owned regular files, mode 0644 unless specified otherwise:

```text
/root/agent-link-bundle/
  agent-link              # verified prebuilt Linux binary for target architecture
  web/                    # mode 0700; assets from the same release
    index.html
    app.js
    app.css
  server.crt              # leaf certificate, then intermediate CA certificates
  server.key              # unencrypted TLS private key, mode 0600
  ca.crt                  # public issuing root CA certificate, if CA-issued
```

The leaf certificate must cover the **new target IP/DNS in its SAN** and use an
ordinary RSA (`rsaEncryption`) key of at least 2048 bits, or a named-curve EC key
on P-256 (`prime256v1`) or P-384 (`secp384r1`). Preparation and activation reject
Ed25519, Ed448, undersized RSA, RSA-PSS-only public keys, other curves and unknown
key formats. This is a browser-compatibility requirement for this GUI deployment,
not a claim that Ed25519/Ed448 cryptography is weak. A successful Go/Node/OpenSSL
handshake alone does not establish Firefox/browser compatibility. Use a compatible
RSA/ECDSA-signed certificate chain as well, and verify the actual browser before
rollout; the installer checks the leaf's public key, not every chain signature.

`server-certificate.ext` is a documentation template, not a deployment identity.
Its `192.0.2.10` and `agent-mesh.example` SANs are reserved examples. Make a private
operator-owned copy and explicitly replace them with the approved target IP/DNS
before issuing a certificate. The updater's local HTTPS check also requires the
`127.0.0.1` SAN. Do not commit operator SANs, certificates, keys, or fingerprints.

For a CA-issued certificate, `server.crt` contains the leaf first and any necessary
intermediates after it. Distribute the **public root CA certificate**, and public
intermediates if needed, separately to clients; verify the CA fingerprint through
a trusted path before importing it into the intended OS/browser trust store.
Keep that public trust artifact as `ca.crt`; an operator may copy it separately to
`/etc/agent-link/ca.crt` and to private client configuration directories. The
installer installs the server leaf/chain and key only: it does not copy `ca.crt`
or change any OS/browser trust store. The issuing CA's private key stays solely in
the private issuing environment, even when the public `ca.crt` is placed on the
server. Use a separate CA and a `CA:false`, `serverAuth` leaf for a CA-issued GUI
certificate, not the CA certificate itself as the HTTPS server identity.
The server chain file is not itself a trust decision, and trusting a CA is distinct
from accepting a self-signed leaf. For an intentionally self-signed deployment,
verify and explicitly trust that exact public leaf certificate instead. Never
distribute `server.key` or a CA private key to clients. A CA private key belongs in
the private issuing environment, not in the app bundle or service directory.

Do not copy `.git`, model-provider credentials, adapter SQLite queues, the source
PostgreSQL data directory, or raw account keys into the release. Transfer the
source's `pg_dump --format=custom --no-owner --no-acl` archive separately into a
root-owned mode-0600 file. Source PostgreSQL 14 archives can be restored by a
compatible newer distribution `pg_restore`; do not restore into an older major.
Compare the transfer checksum with the source archive before restoring.

Inspect `pg_lsclusters`; the selected cluster must be owned by postgres, on port
5432. Example for a distribution that installed cluster `16/main`:

```sh
bash /root/agent-link-deploy/install.sh prepare candidate-r1 /root/agent-link-bundle 16/main
```

This creates the system account `agent-link` (no shell, no home), installs a
root-owned frozen release under `/opt/agent-link/releases/candidate-r1`, selects it
using `/opt/agent-link/current`, and installs the systemd unit. It does **not**
start or enable the app. `/etc/agent-link` is root:agent-link 0750; the app owns
its database URL and TLS private key files with mode 0600, as its CLI requires.
No database password is needed: Unix-socket peer authentication maps the app's
OS identity to the database role of the same name.

## Restore the existing database without reseeding

The following commands are **target-container-only** operator steps. Substitute
the actual PG version/cluster, and run them only after checking the new cluster
has no existing `agentlink` database or `agent-link` role. `createuser` and
`createdb` deliberately fail if either already exists; investigate such a failure
instead of dropping a database or reusing it. Do not run `bootstrap`,
`bootstrap-owner`, `rotate-key`, or test fixture suites during migration.

Set PostgreSQL to Unix-socket-only and ensure the distro's local authentication
uses `peer` for the `agent-link` role (`local all all peer` is the usual distro
default). Never use `trust`. Keep its socket at `/var/run/postgresql`:

```sh
pg_conftool 16 main set listen_addresses ''
pg_conftool 16 main set unix_socket_directories /var/run/postgresql
systemctl restart postgresql@16-main.service
runuser -u postgres -- psql -X -qAt -c "SELECT datname FROM pg_database WHERE datname = 'agentlink';"
runuser -u postgres -- psql -X -qAt -c "SELECT rolname FROM pg_roles WHERE rolname = 'agent-link';"
runuser -u postgres -- createuser --no-superuser --no-createdb --no-createrole agent-link
runuser -u postgres -- createdb --owner=agent-link --template=template0 agentlink
```

Both inspection queries must return no rows before creating anything. Restore
through root's redirected file descriptor so the archive stays private even
though the PostgreSQL client runs as `postgres`:

```sh
runuser -u postgres -- pg_restore --list < /root/agentlink.dump > /root/agentlink-restore.list
runuser -u postgres -- pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --role=agent-link --dbname=agentlink < /root/agentlink.dump > /root/agentlink-restore.log 2>&1
chmod 0600 /root/agentlink-restore.list /root/agentlink-restore.log
```

Use a private root shell (`umask 077`) before these commands, since table names
and restore errors can be private. Restoration runs as database role `agent-link`
so restored objects belong to it; normal startup applies schema DDL and requires
that ownership. `--single-transaction` avoids a partially restored schema, and
there is no `--clean`, drop, reset, or overwrite operation. If restoration fails,
retain the archive/log/database for inspection; this workflow does not delete it
or retry into an existing database.

Before enabling the app, compare source and target table counts and deterministic
content fingerprints, including principals, key hashes/revocation state, grants,
projects/channels, messages, notes, receipts, events, audit records and retired-ID
tombstones. Do not print raw content, keys or key hashes. Preserve a source
snapshot and state clearly if source writes continued after it: a dump is a
point-in-time migration, not live replication.

For a rehearsal, the source remains authoritative. Restrict access to the target
to verification clients: the application has no global read-only mode, and two
simultaneously writable copies can diverge. Final cutover needs a coordinated
write-free source snapshot, a separate deliberate restore plan, and confirmation
before clients change endpoints; never replace a populated rehearsal database by
silently dropping it or rerunning this initial-install workflow.

## Activate and verify

```sh
bash /root/agent-link-deploy/install.sh activate
curl --fail --silent --show-error --cacert /path/to/verified-public/ca.crt https://NEW_TARGET_IP:8766/healthz
```

For an intentionally self-signed leaf, pass the verified public leaf certificate
as `--cacert` instead. The CA trust file contains public certificates only, never
private keys. A browser may use its own trust store; verify trust and a complete
TLS handshake in the browser that will actually use the GUI.

Activation checks the existing nonempty app schema, database/table ownership and
peer access as `agent-link`, and rejects PostgreSQL TCP listeners. It then enables
and starts the exact PG cluster, PostgreSQL's parent service, and Agent Mesh.
Agent Mesh restarts after unexpected exit; a cluster-specific systemd drop-in
restarts PostgreSQL after failure. The app listens on TLS port 8766 only. There
are no automatic firewall, router, DNS or trust-store changes. Distribute only the
appropriate public CA chain (or explicitly trusted self-signed leaf) to clients
and verify its fingerprint through a trusted path; never distribute `server.key`
or use `curl -k` as certificate verification.

Check both services' enabled/active state, `ss -lntp` (8766, no PostgreSQL TCP
listener), and ownership/modes. Verify the frozen GUI assets and read-only access
with an existing owner/viewer key using an in-memory client or mode-0600 header
file, not a key in command arguments, URLs or shell history. Verify preserved
history and owner administration before directing clients to the new URL. Use an
operator-approved target-container reboot to prove reboot autostart, then repeat
the TLS and read-only checks. Database restore, process start, HTTPS readiness,
credential continuity and reboot survival are distinct checks.
Enable the container's own host-managed boot setting separately: enabled systemd
services do not cause a stopped LXC to start after its host reboots.

Account secrets are not required by the server and remain with their existing
clients. Existing adapter processes and durable inbox/outbox databases stay where
they were; moving or starting adapters requires a separate explicit decision.
The adapter SQLite identity binds the exact API origin, so changing its URL does
not transparently migrate an existing queue. Do not discard pending/uncertain
work or reinitialize those databases to work around the identity check.
Keep the old endpoint and snapshot intact until the operator chooses a cutover.

Inspect logs with `journalctl -u agent-link -u postgresql@16-main`; do not paste
unfiltered database/restore logs into shared channels. The installer does not
create a backup schedule, prune releases, manage certificates, or upgrade the app.
Namespace-based systemd sandbox options are intentionally omitted for compatibility
with unprivileged LXC without nesting; isolation is provided by the container,
nonroot service identity, no capabilities, no-new-privileges, and private files.

## Code-only release update

For a tested backward-compatible release without a database migration, stage
only the new `agent-link` binary, three matching `web/` assets, and `SHA256SUMS`.
The checksum manifest must have exactly one entry for each of `agent-link`,
`web/index.html`, `web/app.js`, and `web/app.css`. Keep the bundle and its `web/`
directory root:root 0700, the binary 0755 and all other files 0644. Do not put
certificates, account keys, database URLs or provider credentials in this bundle.

On the existing dedicated node, after checking its identity and current release:

```sh
export AGENT_LINK_EXPECTED_HOSTNAME=approved-target
bash /root/agent-link-update/update.sh NEW_RELEASE /root/agent-link-update/bundle EXPECTED_OLD_RELEASE
```

Replace `approved-target` with the independently verified short DNS hostname of
the intended node. This setting is required: the script has no target-host
default, and it rejects empty or invalid labels. Do not derive it automatically
from the machine on which a command happens to be running. Staging paths above
are examples; choose private root-owned paths for your installation.

The updater requires that exact `AGENT_LINK_EXPECTED_HOSTNAME`, LXC, the installation marker,
the expected current symlink, valid checksums and a healthy old service. It takes
an exclusive update lock, makes a private custom-format dump of the live local
database, installs an immutable release, briefly stops the app, atomically switches
the symlink, starts it and checks trusted HTTPS health. It does not change TLS,
database credentials, account keys or the systemd unit. Copy the verified dump
off-container afterwards; a backup kept only inside the LXC is not disaster
recovery. A live dump is a consistent snapshot, not a write fence or replica.

On a command failure or HUP/INT/TERM during activation it selects the previous
release and attempts to restart it. It never restores or drops the live database.
SIGKILL/power failure still require checking the symlink and service manually.
Both releases and the dump remain available. This workflow is unsuitable for
irreversible schema migrations; those need a separate reviewed migration plan.

`coordination-release.json` and `native-release.json` are non-authorizing review
templates, not records of a particular deployed host or release. Adapt a private
copy to the exact candidate, its predecessor, migration review and evidence.
They do not make `update.sh` a general-purpose migration validator. Its rollback preserves the
database and restores code only. Avoid project deletion on the previous code:
old deletion previews cannot enumerate the new records even though foreign-key
cascades would remove them. Check existing listeners after the brief outage;
they are not restarted or reinitialized by this updater.

After activation, verify the live frozen assets, workspace SSE, authorization and
existing history with read-only API checks. Already-open browser tabs need one
reload to receive the new JavaScript; after signing in again, workspace updates
do not require further reloads. A service restart may briefly reconnect streams.
