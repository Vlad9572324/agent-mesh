# Release status and source capabilities

[Documentation](README.md) · [Contributing](../CONTRIBUTING.md) · [Release process](release-process.md)

## Current status: partial publication — recovery pending

This repository starts with a sanitized source snapshot and a fresh, independent
Git history. Earlier repository commits, tags, release records and container
publications are not imported here. **The `v0.1.0-rc.2` GitHub Release is still a
draft; its binaries are not publicly released. A candidate container image exists.**

The [tag publication run](https://github.com/Vlad9572324/agent-mesh/actions/runs/36987513835)
validated source `c42ca369bf529773e8efec8e7872bba23cceb7b5`, rebuilt matching
archives and uploaded four hash-verified assets to the draft. It also pushed and
pulled the image, verifying digest
`sha256:45f6f7a7180c89299407c2c46a9b27a5d0c790023a570248cfb0e6b08697a2c0`.

The final package guard then failed: the new
`ghcr.io/vlad9572324/agent-mesh-server:v0.1.0-rc.2` image is publicly readable,
while the workflow requires private package visibility. A separate
[metadata diagnostic](https://github.com/Vlad9572324/agent-mesh/actions/runs/36988549817)
confirmed that its package name/type and repository association are correct;
visibility is the only failed policy check. The maintainer's decision
on that policy mismatch and release recovery is pending. The tag already exists;
do not move it, blindly rerun publication, or overwrite the draft/assets/image.
This is not a successful completed release.

Use [getting started from source](getting-started.md) for an available setup
route, then [your first handoff](first-session.md). The
[archive installation guide](install-release.md) and [container guide](container.md)
remain recipes, not an announcement of public binary downloads or a resolved
container access policy.
The next release candidate is **`v0.1.0-rc.2`**, targeting **Linux amd64**.
Its installation filenames and version checks are prepared, but final publication
and policy reconciliation are still pending. No ARM, macOS or Windows binary is planned
by this candidate's packaging contract. Keep using source setup until verified
release assets are announced here.

Public source availability is separate from deployment security and package
permissions. Agent Mesh remains a trusted-LAN pilot, not an Internet-facing
production service. A project-wide license has not been selected; see
[authorship](../AUTHORS.md) and [dependency notices](third-party-notices.md).

## Release automation included in source

- Within `Release`, a `main` push runs only the permission-free registration job;
  that job does not validate a candidate, build archives or publish anything.
- `release.yml` validates supported version tags, fences the exact source to
  `main` history, tests the candidate and publishes the GitHub Release last,
  after remote archive hashes and the pulled image identity are checked.
- Manual `release.yml` dispatch with `version` and `expected_sha` is a dry run
  only: it creates no tag, release or package.
- `Container CI` validates ordinary source changes. Its separately authorized
  manual publication route produces a commit-tagged container candidate, not a
  formal GitHub Release.
- New images use `ghcr.io/vlad9572324/agent-mesh-server`, with an exact release
  tag or a `sha-<full-commit>` candidate tag. No `latest` alias is published.
  The workflow requires private package visibility; the actual rc.2 candidate is
  public, so finalization halted. Treat policy and observed state separately.

These describe workflow capabilities; the partial attempt above records its
actual outcome, not successful final publication. A passing
dry run does not qualify the remote publication path. Partial publication can
leave a draft or image requiring an explicit recovery decision; existing
versions are not overwritten. See the [publication gates](release-process.md).

## Planned artifact contract

The builder produces a Linux amd64 server archive, a separate Python connector
archive, `RELEASE.json`, and `SHA256SUMS`. Both archives contain a version-rendered
`INSTALL.md`, release metadata and dependency notices. The server bundle includes
`bin/agent-mesh` and the three matching browser assets; the connector bundle
contains the launcher, hooks, MCP bridge and runtime modules.

`agent-mesh version` reports build identity without contacting PostgreSQL.
The bundle does not install PostgreSQL, issue LAN TLS certificates, create a real
owner, configure autostart, install provider CLIs or deploy a service. Packaging
targets Linux amd64; no Windows, macOS or ARM runtime qualification is implied.

## Included product capabilities

- Individual identities, project/channel grants and owner administration.
- Immutable messages and notes, durable connector inbox/outbox, and separate
  delivery, acceptance, review and completion records.
- Project artifacts, scoped tasks/runs, independent review, versioned memory
  and execution-session leases.
- Opt-in Claude Code and Codex CLI connections with explicit coordination tools
  and typed lifecycle metadata, without sharing private reasoning or transcripts.
- English/Russian interface switching, a mobile layout, a bounded project map
  and a project-wide feed of authorized published CLI activity.
- TLS-aware deployment recipes and guarded updates; HTTP/2 idle stream handling
  keeps individual write deadlines separate from idle keepalive intervals.

Documentation screenshots show the real UI with fictional fixtures. Neither
screenshots nor stored activity reports establish that a live model completed
work. Compatibility filenames such as `agent-link-*.py`, `AGENT_LINK_*` settings
and existing service names remain distinct from the public Agent Mesh brand.

## Verification and limits

Source includes PostgreSQL integration, authorization, adapter, packaging,
browser and container smoke checks. Ordinary Go tests skip database integration
when a dedicated test DSN is absent; report that skip rather than calling it a
database pass. Hosted Compose smoke exercises its documented scenarios, not the
entire Go database/race suite or provider compatibility matrix.

Run current gates against the exact candidate and record pass/fail/skips honestly.
The partial hosted outcome above does not establish final release success or
any live-model result.
Operator-specific evidence stays outside the repository.

- No scheduler, automatic idle wakeup, merge/deploy, external process stopping
  or filesystem fencing.
- Attributed reports are not independent correctness certification; the server
  does not execute reported tests or import private model memory.
- Owners can read published workspace content; service keys are not end-to-end
  encryption against the operator.
- Bounded collections and no general per-account stream/request quota or
  large-fleet qualification.
- Chromium viewport captures do not establish real-phone or Firefox qualification.

For the portable capability history, see the
[sanitized engineering summary](history/development-log.md).
