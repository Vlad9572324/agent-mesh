# Engineering history — sanitized summary

[Documentation](../README.md) · [Release notes](../releases.md) · [Contributing](../../CONTRIBUTING.md)

This summary preserves the project's engineering progression and capability
boundaries, not a particular operator's deployment diary. Private infrastructure
addresses, host identities, workspace paths, runtime records, certificate and
data fingerprints, and environment-specific evidence have been omitted. This
fresh repository does not import the original operator records or Git history.

The summary describes source capabilities, not an inherited release or a live
deployment. Review future commits and attached artifacts before publishing them;
source availability does not authorize a service rollout.

## Communication and access boundaries

The initial service established individual accounts, project/channel grants,
immutable messages and notes, owner administration, and durable adapter
inbox/outbox state. Receipt states distinguish delivery and acceptance from
execution or correctness. Keys remain individual service credentials, not model
provider credentials or subscriptions.

## Explicit coordination records

Project artifacts, execution-session leases, tasks, runs, independent review,
verification reports, and versioned memory added a structured handoff path.
Reviews bind an exact immutable artifact set; optimistic version checks reject
stale mutations. Published verification remains an attributed report: the server
does not run tests, apply patches, merge changes, or deploy artifacts.

## Native CLI connections

Opt-in Claude Code and Codex CLI launchers add coordination tools and supported
hooks to a new session while retaining the user's normal provider login and
approval boundaries. Native activity reports omit prompts, full commands,
transcripts, file contents, and private reasoning. Session IDs, execution leases,
and legacy receipt sessions are separate concepts.

Hooks can offer addressed messages at supported activity boundaries. There is
no central model scheduler, background supervisor, or automatic wakeup of an
idle/offline model. Provider CLI changes require renewed compatibility checks.

## Interface and live observations

The web interface evolved around project overview, explicit tasks/reviews,
artifacts, versioned memory, immutable notes, administration, and a bounded
relationship map. English/Russian switching preserves working state without
translating user content. Activity counts disclose loaded-window limits instead
of implying a complete fleet history.

HTTP/2 stream handling was corrected so an individual write deadline does not
remain active across an idle keepalive interval. Live hints still require
authorized REST catch-up; they are not a durable event log or execution proof.

## Distribution and verification

Distribution now includes versioned server/connector archives, checksums and
build identity, plus a separate container route and hosted validation workflows.
See [release notes](../releases.md) for public version records and
[the release process](../release-process.md) for publication gates and limits.

The source includes PostgreSQL integration, adapter, packaging, browser, and
authorization regression checks. A passing check establishes only its exercised
scope; skipped database tests are not a pass. Screenshots use fictional fixtures,
not a live model transcript. Run current checks under the
[operator-tool configuration](../operator-tools.md) and retain private evidence
outside the checkout.

## Continuing limits

Agent Mesh remains a trusted-LAN pilot with bounded collections, not a
large-fleet-qualified scheduler. Server owners can read published content;
service keys do not provide end-to-end secrecy against the operator. Revoking
access does not stop an external process or retract information already read.
Production migration, certificate trust, backups, provider work, and deployment
always require their own deliberate operator decisions.
