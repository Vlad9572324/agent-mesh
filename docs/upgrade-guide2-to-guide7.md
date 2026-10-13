# Upgrade v0.1.0-guide.2 to v0.1.0-guide.7

[Documentation](README.md) · [Container install](container.md) · [Operations](operations.md) · [Release status](releases.md)

This runbook covers an existing container deployment using the published
`v0.1.0-guide.2` image. It does not authorize an update of an unknown deployment,
replace the operator's backup policy, or enable the optional monitor/doorbell.

## Fixed identities

| Item | v0.1.0-guide.2 | v0.1.0-guide.7 |
| --- | --- | --- |
| Source | `faf92e630731b5f90bd5fa3a0b80c205f84660e4` | `984e62fab32efb11b8c38db0f00c9bc4739e1dd5` |
| Image digest | `sha256:2b6a83a580a172c75c6f228beba0b93c2005806ae0d74e5d50bb523bcf4afd60` | `sha256:34c3dac1f167be490bd3bfe2ebc21a5f3dba5779c8a1391d512e9b8b431c0cfd` |

Use the immutable guide.7 digest, not `main`, `latest`, or a tag without a
matching published Release. Keep the guide.2 digest available for application
rollback.

## Before cutover

1. Record the effective Compose configuration and preserve operator-local
   options such as `--public-url`, `--onboarding-ca-file`, CA mounts, bind address,
   state directory and project name. Do not replace a working local Compose file
   blindly with a repository copy.
2. Confirm the running image digest and `/v1/health`/authenticated `/v1/me`.
3. Create a logical PostgreSQL dump using the deployment's private libpq
   credentials. Copy it off the database container, checksum it privately, and
   restore it into a separate empty test database. A copied live `PGDATA`
   directory is not a backup.
4. Record bounded counts for principals, projects, channels, messages, tasks,
   memory, artifacts and grants without printing keys, hashes or message bodies.
5. Pull the guide.7 image by digest and verify its `version` output reports the
   guide.7 version, source commit, Linux and amd64.

## Migration and cutover

The guide.7 server startup applies one additive PostgreSQL migration: the
`agent_wake_profiles` table and two lookup indexes. It does not rewrite existing
accounts, keys, grants, projects or messages.

1. Establish a short write-free window; stop only the application container.
2. Select the guide.7 digest in the private Compose environment while preserving
   the existing state mounts, PostgreSQL image, credentials, TLS files and local
   command arguments.
3. Start the application and wait for a healthy response. Do not reseed the
   database, bootstrap another owner, rotate keys or recreate PostgreSQL.
4. Verify owner login, the existing project/channel, participant access,
   historical messages, an addressed-message round trip, invitation generation,
   and matching server build identity.
5. Compare the bounded record counts captured before cutover. The new wake-profile
   table may be empty; existing records must remain present.

## Connector boundary

Updating the server does not update a running participant connector. Install the
published guide.7 connector bundle separately, preserving each connection's
private key, `config.json`, workspace binding and durable SQLite inbox/outbox.
Restart that participant's MCP/CLI invocation and confirm `link_status` reports
guide.7 for both connector and server. Never delete connector state merely to
bypass a binding or migration error.

## Rollback

If application acceptance fails before new guide.7-only operations are used,
stop the application and reselect the preserved guide.2 image digest. The
additive table and indexes remain in PostgreSQL and are ignored by guide.2.
Do not drop them during an incident. A code rollback is not a database restore.
If data integrity changed, keep the service write-fenced and follow the tested
restore plan instead of repeatedly restarting different versions.

The monitor, systemd timer, Telegram hook and tmux doorbell are opt-in components.
Treat their installation as a separate reviewed change after the core upgrade is
accepted.
