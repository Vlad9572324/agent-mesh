# Release status and source capabilities

[Documentation](README.md) · [Contributing](../CONTRIBUTING.md) · [Release process](release-process.md)

## Current status: v0.1.0-receipts.1 prerelease published

Source: `6ea712e7c3bcfeafc3a4e20429766833dbf52caa`; packaging version: **3**.
The version-tag workflow completed validation and publication successfully.
All four release assets were downloaded anonymously, their SHA-256 hashes matched
the approved hosted dry-run build, and their bytes matched both the local release
artifacts used for deployment and the hosted build. Existing releases were not
replaced.

| Verification | Result |
| --- | --- |
| Version-tag release run | [37113695805](https://github.com/Vlad9572324/agent-mesh/actions/runs/37113695805) — validation and publication passed |
| Published GitHub prerelease | [v0.1.0-receipts.1](https://github.com/Vlad9572324/agent-mesh/releases/tag/v0.1.0-receipts.1), release ID `402439670` |
| Four release asset downloads and SHA-256 comparison | Passed anonymously; byte-for-byte match to the local and approved hosted builds |
| Published image tag | `ghcr.io/vlad9572324/agent-mesh-server:v0.1.0-receipts.1` |
| Anonymous image descriptor/layer verification | Passed for the configuration and all four layers; every size and SHA-256 matched |

The published image digest is
`sha256:ebc930e9709f037941c2d33120bb11d814f9fbe2aa6b83940fbd36907169d78b`.
Anonymous verification confirmed tag-to-digest identity, every descriptor’s size
and SHA-256, exact version/source, Linux amd64, the Apache-2.0 label and nonroot
configuration. That was a byte-download check, not a separate Docker execution.
The successful hosted workflow supplies the container execution, Compose smoke
and digest-pull identity checks.

The [prerelease](https://github.com/Vlad9572324/agent-mesh/releases/tag/v0.1.0-receipts.1)
adds changes since rc.3:

- Chat displays each recipient’s offered, viewed and accepted connector reports
  separately from adapter confirmations. Times identify the first server record
  of each report. Acceptance does not establish task completion.
- Owners can issue scoped, expiring, one-time participant invitations. The
  generated connection command prepares a private connector and starts a normal
  local CLI when the recipient explicitly runs it. `--check` starts no model.
- Sidebar counts persist each account’s unread messages. Quiet activity views
  hide routine technical reports by default with a reversible reveal control;
  the history and transport cursors are retained.
- The connector bundle includes an opt-in local task listener with explicit
  creator/file policy, bounded execution and durable artifact/review handoff.
  Ordinary messages do not start models, and this is not a central scheduler.

This release remains a Linux amd64 trusted-LAN pilot. The immutable release
source is the commit above; later documentation corrections do not change its
tag, binary, archives or image.

The [publication-free release dry run](https://github.com/Vlad9572324/agent-mesh/actions/runs/37113513604)
and [Container CI validation](https://github.com/Vlad9572324/agent-mesh/actions/runs/37113498441)
passed for this source. The hosted default Go run skips database integration
without a test DSN; hosted Compose smoke covers its separate isolated scenarios.
Local validation ran the full Go suite with a dedicated database: **115 tests,
no skips**. Focused native-receipt checks passed **25 JavaScript runtime cases**
and **6 isolated browser cases**, including real SSE refresh, localization,
unavailable status, stale-response rejection and cleanup. Local archive checks
covered five help entrypoints and eight imports; hosted container checks covered
three help entrypoints and four imports. These are distinct test scopes, and
none establishes that a provider model executed a task.

## Earlier release: v0.1.0-rc.3

The [v0.1.0-rc.3 prerelease](https://github.com/Vlad9572324/agent-mesh/releases/tag/v0.1.0-rc.3)
is published from source `cc683249e7b904cefc0fa71d7da444dc8f8099dd`.
The [version-tag release run](https://github.com/Vlad9572324/agent-mesh/actions/runs/37026132189)
completed successfully through validation and publication, without the manual
recovery required by rc.2. Public release metadata was verified, and all four
release assets were downloaded without authentication and matched the approved
dry-run build's hashes.

The public image is `ghcr.io/vlad9572324/agent-mesh-server:v0.1.0-rc.3`, with digest
`sha256:dbf1eefe1032ff84684968b0e673d3e30db40685f87953e3ccbbea6d46e757ed`.
Its configuration and all four layers were downloaded anonymously; descriptor
sizes/hashes, tag-to-digest identity, source commit, Apache-2.0 label, Linux amd64
target and nonroot configuration were verified. This was byte-level download
verification, not a separate Docker execution; the successful hosted run provided
the container execution and Compose smoke evidence.
Packaging version 2 includes `LICENSE` (Apache-2.0), `NOTICE` and
`THIRD_PARTY_NOTICES.md` in both archives and the server image. Dependencies
retain their own licenses. Use [archive installation](install-release.md) or
the [public container guide](container.md); runtime qualification remains Linux
amd64 and the trusted-LAN pilot scope.

## Earlier release: v0.1.0-rc.2 and its recovery

This repository starts with a sanitized source snapshot and a fresh, independent
Git history. Earlier repository commits, tags, release records and container
publications are not imported here. **The
[v0.1.0-rc.2 prerelease](https://github.com/Vlad9572324/agent-mesh/releases/tag/v0.1.0-rc.2)
is published, with Linux amd64 server archives, Python connectors and a public
server image.** The four release assets were downloaded without authentication
and their hashes matched the audited build. The downloaded server's version
identity also matched.

The [tag publication run](https://github.com/Vlad9572324/agent-mesh/actions/runs/36987513835)
validated source `c42ca369bf529773e8efec8e7872bba23cceb7b5`, rebuilt matching
archives and uploaded four hash-verified assets to the draft. It also pushed and
pulled the image, verifying digest
`sha256:45f6f7a7180c89299407c2c46a9b27a5d0c790023a570248cfb0e6b08697a2c0`.

The original final package guard failed because the new
`ghcr.io/vlad9572324/agent-mesh-server:v0.1.0-rc.2` image is publicly readable,
while that run required private package visibility. A separate
[metadata diagnostic](https://github.com/Vlad9572324/agent-mesh/actions/runs/36988549817)
confirmed that its package name/type and repository association are correct;
visibility was the only failed policy check. The maintainer has now explicitly
approved **public distribution of this new image**, and the publication policy
requires public visibility with the exact current repository association.
Anonymous pulls are supported; no GHCR login is needed.

After the policy update, [hosted CI](https://github.com/Vlad9572324/agent-mesh/actions/runs/36998644300)
and the [read-only package diagnostic](https://github.com/Vlad9572324/agent-mesh/actions/runs/36998656594)
passed. The existing draft was then explicitly finalized after all four assets
were independently downloaded and hash-verified again. Public release metadata
confirmed publication as a prerelease. The source tag, assets and image were not
moved or replaced. **This was a verified recovery; the original tag run remains
failed**, not retroactively successful.

Anonymous download of the image configuration and all four layers also verified
every descriptor's size and digest, with the expected version, source, Linux
amd64 target and nonroot configuration. This byte-level check was not a new Docker
execution; container execution and Compose smoke were verified by the original
hosted run.

Use [archive installation](install-release.md), the [public container](container.md),
or [source setup](getting-started.md), then [your first handoff](first-session.md).
Only **Linux amd64** is runtime-qualified; no ARM, macOS or Windows binary
qualification is implied.

The tag-pinned documentation and bundled `INSTALL.md` are historical source/build
snapshots and still contain prepublication status wording. This
[current release status](https://github.com/Vlad9572324/agent-mesh/blob/main/docs/releases.md)
records actual distribution availability. The immutable tag and archives are not
rewritten to update documentation status.

Public source availability is separate from deployment security and package
permissions. Agent Mesh remains a trusted-LAN pilot, not an Internet-facing
production service. The current source is licensed under [Apache-2.0](../LICENSE),
with [NOTICE](../NOTICE) and separate [dependency notices](third-party-notices.md).

### License adoption after rc.2

Apache-2.0 was added to the current source after `v0.1.0-rc.2` was published.
That release's tag, archives and image are unchanged: the archives do not include
the new `LICENSE` and `NOTICE` files. The rc.3 release now includes them alongside
`THIRD_PARTY_NOTICES.md`, without replacing rc.2 artifacts. Dependencies retain
their own licenses.

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
  The new server package must be public and associated with this exact repository;
  workflows verify that policy but never change package visibility themselves.

These describe workflow capabilities; the run and explicit recovery above record
the actual publication outcome. A passing
dry run does not qualify the remote publication path. Partial publication can
leave a draft or image requiring an explicit recovery decision; existing
versions are not overwritten. See the [publication gates](release-process.md).

## Published artifact contract

The builder produces a Linux amd64 server archive, a separate Python connector
archive, `RELEASE.json`, and `SHA256SUMS`. Both archives contain a version-rendered
`INSTALL.md`, release metadata and dependency notices. Packaging version 3 retains
the `LICENSE` and `NOTICE` introduced by rc.3 packaging version 2. The server
bundle includes `bin/agent-mesh` and the three matching browser assets; the
connector bundle contains the launcher, hooks, MCP bridge, opt-in listener,
coordination/artifact modules and listener documentation. The
[release process](release-process.md#artifact-contract) lists its complete runtime
closure. Owner invitation packages are generated privately from the server’s
embedded connector sources; no invitation, service key or runtime state is
included in public release assets.

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
The hosted checks, explicit recovery and anonymous downloads above establish
the recorded artifact publication, not live-model or production qualification.
Operator-specific evidence stays outside the repository.

- No central scheduler, automatic idle wakeup, merge/deploy or external process
  stopping. The opt-in listener uses local workspace locking and explicit file
  scope; the server itself does not hold filesystem locks or sandbox a CLI.
- Attributed reports are not independent correctness certification; the server
  does not execute reported tests or import private model memory.
- Owners can read published workspace content; service keys are not end-to-end
  encryption against the operator.
- Bounded collections and no general per-account stream/request quota or
  large-fleet qualification.
- Chromium viewport captures do not establish real-phone or Firefox qualification.

For the portable capability history, see the
[sanitized engineering summary](history/development-log.md).
