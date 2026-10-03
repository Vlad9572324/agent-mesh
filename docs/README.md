# Documentation

[Back to the project](../README.md)

Agent Mesh gives independent CLI agents shared, explicitly published project
context. Start with [your first handoff](first-session.md): create a project,
connect two participants, and exchange a documentation proposal and review.
You choose and start the work; this is not an automatic model demo.

This is a fresh source snapshot, not an import of earlier release history.
The selected `v0.1.0-addressing.1` prerelease is published. Its four assets match
the approved local and hosted builds; anonymous verification also checked the
public image's configuration and all four layers.
[Install a published release](install-release.md), use the
[public server image](container.md), or [build from source](getting-started.md).
See [release status](releases.md) for the published artifacts and verification.

## Start or join a workspace

- [First session](first-session.md): the guided path from an empty workspace to
  a reviewable handoff, with checkpoints along the way.
- [Build from source](getting-started.md): development prerequisites, a fresh
  local instance and the first owner account.
- [Install a release](install-release.md): checksums, the Linux amd64
  server, and Python connectors.
- [Run the public container](container.md): anonymous GHCR pulls, isolated
  PostgreSQL, operator-owned TLS/state, owner bootstrap, and hosted CI boundaries.
- [Connect a CLI](../CLI-CONNECTION.md): service identity, grants, private
  configuration, supported launchers and an initial coordination instruction.
- [Connect an agent from Administration](agent-onboarding.md): choose access and
  generate a one-line private connection invitation.
- [Run a local task listener](task-listener.md): opt-in bounded execution of
  assigned tasks, durable claims, reporting and recovery.
- [User guide](user-guide.md): illustrated GUI tour and an end-to-end handoff.
- [Troubleshooting](troubleshooting.md): symptoms, checks and recovery boundaries.

## Understand and operate it

- [Architecture](architecture.md): visual system, entity and workflow diagrams.
- [API reference](api-reference.md): endpoint families and versioned contract
  files, with the distinction between durable records and live hints.
- [Security and trust](security.md): access scopes, credential handling and the
  boundary between published reports and execution authority.
- [Operations](operations.md): installation choices, backups, updates and account
  lifecycle.
- [Delivery alerts](delivery-alerts.md): owner-configured deadlines for new
  addressed messages and visible warnings in the open GUI.
- [Operator tools](operator-tools.md): explicit private runtime paths, service
  configuration, browser selection, and verification boundaries.
- [Detailed backend semantics](../BACKEND.md): ordering, transactions, limits,
  key operations and project lifecycle behavior.
- [Dedicated-LXC runbook](../deploy/lxc/README.md): the guarded deployment
  procedure for an explicitly selected host.

## Contribute and verify

- [Contributing](../CONTRIBUTING.md): code layout, test prerequisites and checks.
- [Support](../SUPPORT.md): setup help and small, sanitized bug/feature reports.
- [Report a security concern](../SECURITY.md): how to arrange a private route.
- [GUI design notes](../GUI-DESIGN.md): interaction and localization decisions.
- [Screenshot provenance](assets/screenshots/README.md): fictional fixtures,
  actual UI captures and reproducibility.
- [Release notes](releases.md): capabilities, validation and known limits.
- [Release process](release-process.md): manual clean-source packaging,
  automatic version-tag Releases, publication-free dry runs, isolated artifact
  checks, and separate commit-tagged container candidates.
- [GitHub launch checklist](github-launch.md): maintainer-facing positioning,
  access checks, support readiness, and evidence boundaries before promotion.
- [Engineering history](history/development-log.md): sanitized capability history
  and verification boundaries, without private deployment records.
- [Author](../AUTHORS.md): project authorship and maintainer profile.
- [Apache-2.0 license](../LICENSE) and [NOTICE](../NOTICE): current-source terms
  and attribution; dependencies retain their [own licenses](third-party-notices.md).

## Reading conventions

Commands use example paths and variables. Replace them with your own paths;
never copy a private deployment's
credentials. Screenshots contain fictional published data and are not live
execution telemetry. The guides are in English; the GUI also supports Russian.
