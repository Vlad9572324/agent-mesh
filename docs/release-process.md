# Release process

[Documentation](README.md) · [Install a release](install-release.md) · [Release notes](releases.md)

The current published prerelease is `v0.1.0-reliability.1`, frozen at source
`2d0318a1c8aa6f5d87fa1d69aa83229ebcf31477`, using packaging version 3.
[Container CI](https://github.com/Vlad9572324/agent-mesh/actions/runs/37119205037)
and the [publication-free release dry run](https://github.com/Vlad9572324/agent-mesh/actions/runs/37119245631)
passed. The [version-tag release run](https://github.com/Vlad9572324/agent-mesh/actions/runs/37119530862)
completed validation and publication. All four published assets were downloaded
anonymously and matched the approved local and hosted dry-run builds byte for
byte. See [release status](releases.md) for image verification and preserved
receipts.1/rc.3/rc.2 evidence. Packaging targets Linux amd64 only; workflow
definitions or dry-run success alone do not establish publication.
New version tags use the hosted
[automatic release workflow](#automatic-version-tag-releases). Its manual
dispatch is a **dry run only**. The separate
[container candidate workflow](#container-publication-in-github-packages) retains
its manual, commit-tagged GHCR publication path.

Publication requires appropriate repository permissions. Source visibility and
package access are separate: the new `agent-mesh-server` GHCR package must be
**public**, with its exact package name/type and immutable repository ID/name
verified. Private or internal visibility is not accepted for this distribution.
No workflow changes visibility, deploys a service, or changes
an operator's running version. Start with a publication-free dry run against a
reviewed commit from this repository's fresh history.

| Workflow invocation | Result |
| --- | --- |
| Push `main` (`Release` workflow) | Permission-free registration job only; no build, tag, release, archive or package publication |
| Push a new validated `v*` version tag | Build/test archives and image; verify remote assets and image; publish the release last |
| Manually dispatch `release.yml` on `main` with `version` and `expected_sha` | Build/test dry run; no tag, GitHub Release, or package publication |
| Manually dispatch `Container CI` on `main` with `expected_sha` | Separate commit-tagged GHCR candidate, not a formal GitHub Release |

## Artifact contract

The table describes the `v0.1.0-reliability.1` packaging-version-3 contract. It
extends the connector bundle with the opt-in task listener, its coordination and
artifact modules, and its guide/contract. The server embeds reviewed connector
sources for owner-issued invitations. Both archives retain root `LICENSE`
(Apache-2.0), `NOTICE` and `THIRD_PARTY_NOTICES.md`. The four asset types are
unchanged. Existing rc.3 packaging-version-2 and rc.2 packaging-version-1 archives
remain unchanged; never overwrite an already published version.

| Artifact | Included files |
| --- | --- |
| `agent-mesh_v0.1.0-reliability.1_linux_amd64.tar.gz` | `bin/agent-mesh`, `web/index.html`, `web/app.js`, `web/app.css`, `INSTALL.md`, `RELEASE.json`, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md` |
| `agent-mesh_v0.1.0-reliability.1_connectors.tar.gz` | The native Python runtime files listed below, `INSTALL.md`, `RELEASE.json`, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md` |
| `RELEASE.json` | The same release/build metadata included in each archive |
| `SHA256SUMS` | SHA-256 checksums for both archives and external `RELEASE.json` |

Each archive has exactly one top-level directory, named like that archive without
`.tar.gz`. The server binary and matching web assets are an indivisible release.
Public product/binary names are Agent Mesh / `agent-mesh`; internal Go
`cmd/agent-link`, native `agent-link-*.py` filenames, `AGENT_LINK_*` variables,
state directories, and existing service identifiers remain compatible.
The connector runtime closure is:

```text
scripts/agent-link-cli.py
scripts/native_launch.py
scripts/agent-link-hook.py
scripts/agent-link-mcp.py
adapters/native_bridge.py
adapters/native_hooks.py
adapters/native_mcp.py
scripts/agent-link-listener.py
adapters/task_listener.py
adapters/coordination.py
scripts/dev_trial_runtimes.py
scripts/artifact_client.py
scripts/agent-link-artifacts.py
docs/task-listener.md
listener-contract.json
```

Including the listener does not enable it. A participant must create its private
policy and explicitly authorize bounded model execution. Ordinary messages do
not start models, and the server has no model scheduler. The separate owner-issued
[connection installer](agent-onboarding.md) uses the server’s embedded sources;
it starts a normal local CLI only when the recipient runs the generated command.

The install guide is rendered from `docs/install-release.md` to root `INSTALL.md`
in both archives. A single explicit version marker declares the source guide's
example version; the builder replaces only that declared version in the bundled
copy, including archive names, expected binary identity, and version-pinned links.
It refuses a missing, malformed, or duplicate marker and does not rewrite the
repository guide or old published assets. Its supplementary links are GitHub URLs,
not relative references to omitted files. Dry-run and commit-candidate builds do
not create the referenced version tags/releases; generated links are not
publication evidence. Bundled and tag-pinned guides are immutable build-time
snapshots; their status text can predate publication. Record actual availability
in [current release status](https://github.com/Vlad9572324/agent-mesh/blob/main/docs/releases.md),
without rewriting a tag or archive. These are runtime bundles, not copies of
the whole repository: no test harness, deployment script, engineering archive,
private runtime state, database dump, keys, logs, or provider credentials belongs
in an archive.

`RELEASE.json` records `schema_version`, `version`, `source_commit`,
`source_date_epoch`, `build_date`, `target` (`goos` and `goarch`), `builder_version`,
and `packaging_version`. `bin/agent-mesh version` returns the embedded version,
commit, build date, Go version, OS, and architecture without requiring PostgreSQL.
The manifest's source commit must match the binary's embedded commit.

Only **Linux amd64** is targeted by this packaging and its runtime smoke checks.
Report actual candidate results rather than assuming qualification from a recipe.
The Python connector bundle does not establish Windows/macOS/ARM compatibility.
Do not add untested binaries or describe a cross-compilation as runtime evidence.

## Automatic version-tag releases

`.github/workflows/release.yml` also runs a registration-only job on `main`
pushes so GitHub can register the workflow. That job has `permissions: {}`, a
two-minute timeout and static output only; validation and publication are skipped.
It does not build archives or create tags, releases or packages. A successful
registration run is not a successful release dry run.
The separate `Container CI` workflow can still validate the same `main` push;
the registration-only restriction applies to `Release`.

Actual version releases start from pushed tags matching `v*`. That broad
trigger is not an authorization shortcut: the workflow accepts only its supported
canonical version subset, verifies the exact tag's live source commit, and requires
that commit to belong to `main` history. Validation and publication use the fenced commit,
not a subsequently changed branch or tag. Do not force-move a release tag.

The pipeline validates source checks, builds the four archives/metadata assets,
and exercises the real isolated Docker Compose stack. Publication rebuilds the
exact commit and requires its `SHA256SUMS` to match validation before continuing.
The container's binary version and GHCR tag both equal the release version:
`ghcr.io/vlad9572324/agent-mesh-server:<version>`. It does not publish a moving
`latest` tag or rewrite a prior candidate.
Versions with a prerelease suffix produce prereleases; an accepted version
without that suffix produces a normal release.
Prereleases are not marked "Latest". Stable releases use GitHub's `legacy`
date/version-based Latest selection; this is separate from an image `latest`
alias, which is never pushed. See the
[GitHub release API](https://docs.github.com/en/rest/releases/releases#update-a-release)
for that selection policy.

### Manual dry run without publication

Select `release.yml` in Actions and dispatch it on `main` with:

- `version`: the canonical candidate version to validate.
- `expected_sha`: the full 40-character `main` commit you reviewed.

The commit must match the dispatched source; a different SHA fails the fence.
This invocation builds and tests but does **not** create a tag, draft or published
GitHub Release, or GHCR package. It is the safe workflow-verification path before
an explicitly authorized new release. A passing dry run is not evidence that
tag-triggered publication, remote asset upload, or registry publication occurred.

### Publication gates and permissions

Validation has `contents: read`. Only the tag-push publication job, after
successful validation, receives `contents: write` and `packages: write` through
its job-scoped `GITHUB_TOKEN`. A manual dry run cannot enter that job. Both jobs
use temporary GitHub-hosted Ubuntu 24.04 runners; no self-hosted runner,
persistent coding agent, provider credential, or production deployment is added.

The publisher proceeds in this order:

1. Recheck the fenced source/tag and require no existing release or draft for
   that version and no existing matching GHCR image tag.
2. Create a draft GitHub Release and upload exactly the server archive, connector
   archive, `RELEASE.json`, and `SHA256SUMS`.
3. Verify asset metadata and download the remote assets to compare their SHA-256
   hashes with the tested local files.
4. Push the matching version-qualified image, pull its digest, and verify the
   pulled binary's exact release/source identity.
5. Recheck the live source, draft identity, canonical asset metadata, public
   package visibility and exact repository association; publish the draft
   **last** after every check succeeds.

There is no automatic overwrite, asset replacement, tag movement, deletion, or
package-visibility change. The required public-package policy is checked
independently of source visibility; report actual checks rather than assuming
defaults. This workflow does not make
the release transaction atomic across GitHub Releases and GHCR.

### Failed runs and retries

Any existing release **or draft** for the same version causes publication to
refuse; it does not silently resume, even if that object came from a previous
failed attempt. Failure after draft creation can leave that draft and uploaded
assets. Failure after image push can also leave an image while the release is
still unpublished. Preserve those facts and inspect the recorded IDs, commit,
hashes, and digest before choosing an explicit recovery action.
A lost response to the final publish request can also mean the release was
published even though the job reports failure; inspect remote state before retrying.

Do not blindly rerun, overwrite/delete partial results, or force-move a tag to
turn an uncertain outcome into a pass. A separately reviewed reconciliation or
new version may be needed. Record the actual run URL and distinguish validation,
draft creation, remote asset verification, image verification, and final release
publication. Merely installing this workflow does not prove its publish path has
been exercised.

The hosted ordinary Go test phase can skip database integration tests when no
test URL is configured. Real Compose smoke validates its specific database-backed
scenarios, not the entire Go integration/race suite. Use the broader checks below
when needed and report skips explicitly.

## Local build and verification reference

The commands below describe reproducible local packaging and verification.
Examples use `v0.1.0-reliability.1`; select a new version before a new publication. Local builds
do not create tags or publish assets. For publication, use the guarded tag/dry-run
workflow above and its exact reviewed version.

## 1. Review and test the candidate

Use a clean, committed checkout of the exact intended release source. Review
`git status` and the diff before committing; generated archives and private
evidence must remain outside the source tree. Verify the versioned install links
and release notes, and ensure the chosen version/tag is not already published
with different contents.

Follow [Contributing](../CONTRIBUTING.md) for source checks, including Go vet/tests,
Python adapter/script tests, JavaScript syntax/runtime checks, and:

```sh
node scripts/check-docs.mjs
```

Use a dedicated PostgreSQL test database for real integration and race tests.
Record pass/fail/skips honestly: `go test ./...` without a test database skips the
database suite. Provider/model jobs, production fixture writes, TLS changes, and
deployment are not implicit parts of building a release.

## 2. Build from the frozen source

Build prerequisites are Go 1.23+ with dependencies already available locally,
Python 3.10+, Git, and a Linux release-build environment. The builder does not
fetch missing Go dependencies, install packages, authenticate to a provider, or
run a deployment. Unlike the build host, an installed prebuilt server needs
neither Go nor Python.

From the clean source checkout:

```sh
python3 -B scripts/build-release.py \
  --version v0.1.0-reliability.1 \
  --output /absolute/path/to/new-release-output
```

Replace the output path with a new directory whose parent already exists. The
builder refuses to overwrite an existing output directory and rejects a dirty
source tree. It uses explicit runtime-file allowlists, not a recursive copy of
the working directory. Ignored credentials and caches are not release inputs.

The commit timestamp supplies the build date and normalized archive metadata.
The builder pins the target, disables CGO, and sets embedded version fields.
These controls support reproducible packaging; claim a byte-for-byte repeat
only when a second build with the same inputs and Go/Python/zlib toolchain has
actually matched.
A checksum file is integrity metadata, not a cryptographic signature or SBOM.

Inspect the output archive member lists and checksums. Confirm that both manifests
match the external `RELEASE.json`, and that `bin/agent-mesh version` identifies the
same commit, version, date, and target. Do not rebuild from a different commit
between verification and upload.

## 3. Smoke-test the actual archives

Use an explicitly dedicated local database named `agentlink_test` or
`agent_link_test` and a mode-`0600` URL file outside the repository. The smoke tool
requires a numeric loopback database host or an explicit absolute Unix-socket
directory and an explicit database user in the URL. For example,
`postgresql:///agent_link_test?host=/var/run/postgresql&user=your_nonroot_role`
uses peer authentication with a placeholder role name; unlike the source
quickstart's URL, it does not rely on an implicit username. Keep any actual
password only in the private URL file, not command arguments or documentation.
The smoke tool must never receive a production/shared workspace DSN.

```sh
python3 -B scripts/smoke-release.py \
  --server /absolute/path/to/new-release-output/agent-mesh_v0.1.0-reliability.1_linux_amd64.tar.gz \
  --connectors /absolute/path/to/new-release-output/agent-mesh_v0.1.0-reliability.1_connectors.tar.gz \
  --checksums /absolute/path/to/new-release-output/SHA256SUMS \
  --database-url-file /private/path/to/test-database-url
```

Use `--psql /absolute/path/to/psql` when the PostgreSQL client is not on `PATH`.
Keep the external `RELEASE.json` beside `SHA256SUMS`; the smoke test checks that
copy as well as both embedded manifests.
The smoke test validates checksums, safe archive layout, metadata agreement, the
packaged version command, and connector help/import closure. It starts the
packaged server on owned numeric loopback, creates an owner in a random owned
`release_smoke_*` schema, and checks health, matching web assets, authentication,
the owner identity, and an empty workspace. It cleans up only its owned process,
temporary files, and schema. It does not start a provider/model, install a CLI,
or operate a deployed workspace.

Keep raw diagnostic evidence private. Publish only sanitized outcomes, exact
artifact hashes, source commit, toolchain/platform, and scope. Artifact smoke
verification is not LAN TLS/browser qualification, a production update, or an
end-to-end provider test. If any step fails or cleanup fails, resolve that issue
before publication; do not convert a skipped check into a pass.

## 4. Record the verified publication

After the authorized automatic workflow completes, verify the exact tag and
source identity, download the four published assets into a fresh directory,
compare their hashes with the tested output, and confirm the pulled image digest.
Record the actual run and release URLs only after those checks succeed. Include
Linux amd64 scope, prerequisites, measured results, skips and known limits.
Do not upload private logs or fixtures, move an existing tag, or silently replace
artifacts. There is no earlier release record imported into this fresh history.

The archive source commit is the release identity. If documentation or code
changes before tagging, commit them, rebuild, and rerun the artifact checks from
that new frozen commit. Do not edit a manifest to make mismatched artifacts appear
to belong to a different source snapshot. Once published, corrections should be
explicit; a new candidate version is preferable to silently replacing binaries.

## Not performed by a release

This process does not install PostgreSQL, provision LAN TLS, bootstrap an
operator's real owner account, configure autostart, update production, migrate
live data, install provider CLIs, or launch model work. Those steps require the
separate, explicitly selected operational workflow. Start with
[release installation](install-release.md) and [operations](operations.md).

Automatic version-tag publication is artifact distribution, not permission for
deployment.

## Container publication in GitHub Packages

Container candidates are separate from GitHub Release archives. The workflow in
`.github/workflows/container.yml`, named `Container CI`, validates `main` pushes
and pull requests. A manual `workflow_dispatch` on `main` is the only publication
trigger; routine pushes and pull requests cannot publish packages. It does not
create/move version tags, replace release assets, or create a GitHub Release.

Dispatch requires `expected_sha`: the exact 40-character source commit reviewed
for publication. It must equal the dispatched `main` commit, or validation stops
before building. The publication job checks the same identity again. Do not pass
a branch name or abbreviated hash, and do not silently substitute a newer commit
if `main` changes between review and dispatch.

After a successful publication, the reference format is
`ghcr.io/vlad9572324/agent-mesh-server:sha-<full-40-character-source-commit>`.
The binary version is `v0.1.0-rc.2-container.<first-12-commit-characters>`.
`VERSION`, `REVISION`, and `CREATED` build arguments carry that identity into the
runtime image; the source OCI label links the image to its repository. New images
built from the licensed source declare `org.opencontainers.image.licenses=Apache-2.0`
and include `LICENSE` and `NOTICE` alongside the dependency notices under
`/opt/agent-mesh/`. The published rc.2 image predates this addition and is unchanged.

Publication refuses an existing commit tag. Only an explicit registry
manifest-not-found response permits a new push; authentication or network failure
is not permission to overwrite a tag. This is a write-once workflow policy, not
registry-enforced tag immutability. Record the resulting digest and use a
digest-pinned reference for an exact installation.

### Permissions and runner scope

Workflow-default access is `contents: read`. A distinct, manually gated
publication job alone receives `packages: write`, using its short-lived
`GITHUB_TOKEN` for registry login/push. Login uses standard input and a temporary
Docker configuration; no personal registry token, provider credential, or
production secret is required. GitHub recommends `GITHUB_TOKEN` for publishing
repository-associated packages from Actions.
[GitHub registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-in-a-github-actions-workflow)
documents that flow.

Both jobs run on GitHub-hosted `ubuntu-24.04` Linux amd64 VMs, not a self-hosted
service. They do not install a persistent agent on a developer or production host.
The publication job builds and verifies its own fixed checkout, rather than
trusting a pull-request artifact. A passing PR check does not authorize registry
writes or production deployment.

### Build and verification gates

The workflow prepares Go dependencies in the hosted job, then uses the offline
release builder on a clean committed snapshot. It builds the container from those
verified inputs and runs the container smoke harness. The smoke checks image and
archive identity, the actual Compose TLS server and matching web assets,
unauthenticated denial, explicit owner bootstrap, database stop/restart behavior,
and owned-resource cleanup. It does not install or start a provider CLI/model.
The ordinary hosted `go test ./...` phase does not configure a PostgreSQL test
URL, so database integration tests in that phase skip; the separate Compose smoke
exercises its documented database-backed scenarios, not the entire Go database
or race suite. Do not describe this workflow as replacing those broader checks.

Before dispatching publication, review the source commit, workflow diff, image
contents, Compose changes, and the explicit public-package policy. After dispatch, inspect
validation and publication separately and record the run URL, exact source
commit, candidate version, full image reference, and digest. Confirm package
visibility is public and the package belongs to the exact current repository.
Download/pull verification must be reported
only after it actually succeeds; a checked-in workflow is not publication proof.

The public image requires no GHCR login. The
[container guide](container.md#1-public-pulls-and-optional-private-fork-authentication)
keeps optional private-fork authentication separate, then describes
[fresh operator state](container.md#3-prepare-new-private-state)
only on an explicitly selected host. Package publication itself performs no
owner bootstrap, LAN TLS installation, autostart setup, production rollout, or
live database migration.
