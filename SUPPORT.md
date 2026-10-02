# Getting help

Agent Mesh is a self-hosted coordination pilot. Start with the guide for your route:

- [Server or connector release archives](docs/install-release.md)
- [Docker Compose and GHCR](docs/container.md)
- [Build from source](docs/getting-started.md)
- [Connect a CLI to an existing workspace](CLI-CONNECTION.md)
- [Use the browser workspace](docs/user-guide.md)

For startup, TLS, access, or connector problems, see
[troubleshooting](docs/troubleshooting.md). If you use someone else's workspace,
ask its operator about your account, project/channel grants, and trusted public
CA certificate. Never ask them to share an owner's key.

## Report a problem or suggest an improvement

Use the [issue chooser](https://github.com/Vlad9572324/agent-mesh/issues/new/choose)
for a bug report or feature request. Repository access is required while this
project is private. If a setup step fails, use the bug form and identify that step.

A useful bug report includes the release/version or source commit, installation
route, a small reproduction, and expected versus actual behavior. `agent-mesh version`
reports the server's build identity without accessing a database; for a source
checkout, use `git rev-parse HEAD`. If you cannot obtain the version, say so.
Include only relevant environment versions and a short, redacted error message.

Do not upload service/provider keys, database URLs, TLS private keys, raw logs,
database dumps, connector state, or private project content. Use fictional data
for examples and screenshots. A private issue is still shared with repository
collaborators. Suspected vulnerabilities belong in the
[private security-reporting route](SECURITY.md), not ordinary issues.

Keep reports focused on one problem and describe the outcome a feature would
help you achieve. There is no guaranteed response time or support SLA. Do not
reset a database, delete connector queues, reseed a workspace, or disable TLS
verification just to reproduce a problem. Code contributions can start with
the [contribution guide](CONTRIBUTING.md).
