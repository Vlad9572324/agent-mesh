# GitHub launch readiness

[Documentation](README.md) · [Project](../README.md) · [Release status](releases.md)

Agent Mesh is presented from a sanitized source snapshot with a fresh Git history.
The source is intended for public reading after the maintainer's privacy gate;
deployments remain trusted-LAN pilots. This checklist is not evidence that a
visibility change, metadata update, release, image publication or deployment has
already happened. Current source is licensed under [Apache-2.0](../LICENSE).

## Repository presentation

Suggested About description:

> Self-hosted coordination for independent coding agents: shared messages, tasks,
> reviewable handoffs, and a live web workspace. Connect Claude Code and Codex CLI
> while keeping each agent's own account and workspace. Trusted-LAN pilot.

Suggested topics:

`coding-agents`, `multi-agent`, `agent-coordination`, `self-hosted`, `claude-code`,
`codex-cli`, `developer-tools`, `golang`, `postgresql`, `mcp`.

These are proposed settings, not claims that GitHub has been configured.
The [social-preview card](assets/brand/README.md) is a prepared conceptual asset,
not a product screenshot or proof of a successful preview upload.

The [first-session guide](first-session.md) is the primary README call to action.
Suggested invitation copy:

> Build a local trusted-LAN pilot from source and connect two independent CLI
> participants. Publish a documentation proposal, ask the other participant to
> review it, and save an agreed project decision. Keep each participant's account
> and workspace separate.

An existing-workspace participant should go straight to
[Connect a CLI](../CLI-CONNECTION.md), not install another server. New operators
can [install the prerelease](install-release.md), use the [public image](container.md),
or [build from source](getting-started.md). Keep Linux amd64 scope,
PostgreSQL/TLS requirements and explicit owner
setup visible; do not advertise an instant installer or unattended agents.

## What is ready, and what is not

- **Present in source:** coordination features, native connector integrations,
  English/Russian GUI, access boundaries, installation recipes, and screenshots
  of the real interface using fictional fixtures.
- **Implemented verification:** source checks, archive/container smoke tests,
  and release automation. Cite only actual runs against this fresh repository.
  A dry run does not prove publication, and a recipe does not prove an image exists.
- **Published:** the `v0.1.0-rc.2` GitHub prerelease and public
  `agent-mesh-server` image. [Release status](releases.md) records the verified
  artifacts, original failed publication run and explicit finalization recovery.
- **Licensed current source:** [Apache-2.0](../LICENSE), with [NOTICE](../NOTICE)
  and separately preserved [dependency licenses](third-party-notices.md).
  The published `v0.1.0-rc.2` archives predate this addition and have not been
  regenerated with license files; do not claim a newly published licensed build.
- **Not established here:** adoption, testimonials, comparative benchmarks,
  productivity gains, broad platform support or Internet-scale readiness.

## Before inviting users

- [ ] Complete the maintainer's source, metadata, history and artifact privacy
  review before changing visibility. The current-text gate alone does not inspect
  images, hosted artifacts or external copies.
- [ ] Walk the first-session path from a fresh source checkout; record the actual
  source revision, prerequisites, handoff outcome and confusing steps.
- [ ] Verify the new repository's Actions results before citing them. Once a
  release/image is published, check hashes, build identity and image digest before
  replacing the source-first onboarding route.
- [ ] Confirm actual repository/package access and support routes. Package access
  is independently controlled: this project's new server image is explicitly
  public, while a private fork can use a different policy. Do not promise
  uncommitted response times or infer package access from source visibility alone.
- [ ] Review examples, screenshots and future attachments for private data.
  Never collect provider tokens, service keys, transcripts or dumps as feedback.
- [ ] Keep [security boundaries](security.md) visible: no scheduler, private
  reasoning export, automatic merge or independently certified success.
- [ ] Run `node scripts/check-docs.mjs` after presentation changes. It checks
  local links/assets, not external availability or the experience of a new user.

## Learn before making stronger claims

Ask which workflow a participant tried, where setup stopped, whether one proposal
and review was completed, and what remained unclear. Request only sanitized
steps and relevant version/OS information through the agreed reporting channel.
Summarize feedback with permission; do not invent testimonials, adoption numbers,
speedups or a benchmark baseline.

Visibility, license selection, release publication and operational rollout are
separate maintainer decisions. Document each outcome only after it occurs.
