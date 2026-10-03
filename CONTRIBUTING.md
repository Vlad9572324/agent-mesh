# Contributing to Agent Mesh

Agent Mesh is a communication and coordination workspace, not a central model
scheduler. Keep transport facts, attributed client reports, and independently
verified results distinct. Do not implicitly add automatic execution, production
rollout, credential sharing, or authority for peer messages.

Start with the [architecture](docs/architecture.md), [API reference](docs/api-reference.md),
and [backend invariants](BACKEND.md). [Getting started](docs/getting-started.md)
provides a fresh local development setup.

## License and contributions

Agent Mesh is licensed under [Apache License 2.0](LICENSE). Unless you explicitly
state otherwise, contributions intentionally submitted for inclusion are under
that license, as described in its Section 5. You retain copyright in your work;
no copyright assignment is required. Submit only material you are authorized to
contribute, and preserve applicable third-party licenses and attribution notices.

## Language and contribution scope

Source comments, documentation, command help, API examples, and default names use
English. The GUI also offers Russian as an explicit presentation choice. Existing
record content, user names, titles, stable IDs, and history are never automatically
translated.

Keep changes focused. Describe the problem, scope, security implications, and
verification in a merge request. Update the relevant machine-readable contract
and documentation when behavior changes. Preserve unrelated work and do not
force-push shared history. Do not assume permission to operate live systems or
start paid/provider model jobs just because a source change needs testing.

## Repository hygiene

Commit source, tests, contracts, and public documentation only. Keep service/provider
keys, password-bearing database URLs, TLS private keys, runtime state, SQLite
journals, database dumps, logs, and private acceptance evidence outside Git.
Ignored files are not a substitute for checking what is staged.

Generated binaries and Python caches are ignored. Published screenshots must come
from synthetic fixture data and must not show account keys, browser authorization
headers, private project content, real filesystem paths, or operational secrets.
A deployed release is a frozen binary plus its matching three web assets;
editing the source directory is not deployment.

## Portable local checks

Use Go 1.23+, Python 3.10+, and a recent Node.js (Node 22+ provides the browser
harness APIs used here). There is no npm dependency installation or frontend build.
The following checks do not require a live model or a running Agent Mesh server:

```sh
go vet ./...
go test ./...
python3 -B -m unittest discover -s adapters -p 'test_*.py'
python3 -B -m unittest discover -s scripts -p 'test_*.py'
node --check web/app.js
node tests/i18n_runtime.mjs
node --test tests/delivery_alerts_runtime.mjs
node --test tests/artifact_documents_runtime.mjs
node --test tests/message_addressing_runtime.mjs
node tests/branding.mjs
node scripts/check-docs.mjs
```

Format changed Go files with `gofmt` before review. Python unit tests use fake/mock
provider boundaries; live smoke programs are a different category and are not
part of the commands above.

The documentation check is offline: it validates local Markdown links/anchors,
SVG safety/accessibility, and PNG file signatures/dimensions. Run it after changing
guides or public visuals; it does not verify external sites or replace source
review of command examples.

Without `AGENT_LINK_TEST_DATABASE_URL`, Go PostgreSQL integration tests explicitly
skip. A green run containing those skips does not verify transactions, migrations,
authorization races, or database-backed HTTP behavior.

## Real PostgreSQL integration tests

Use a dedicated test database, never a production or shared project DSN. With the
ordinary local role from the [quickstart](docs/getting-started.md), provision a
separate empty test database and private URL file:

```sh
AGENT_LINK_TEST_USER="$(id -un)"
sudo -u postgres createdb --owner="$AGENT_LINK_TEST_USER" --template=template0 agent_link_test
AGENT_LINK_TEST_DIR="$HOME/.local/share/agent-link-test"
install -d -m 0700 "$AGENT_LINK_TEST_DIR"
(umask 077; set -o noclobber; printf '%s\n' 'postgresql:///agent_link_test?host=/var/run/postgresql' > "$AGENT_LINK_TEST_DIR/database-url")
AGENT_LINK_TEST_DATABASE_URL="$(< "$AGENT_LINK_TEST_DIR/database-url")" \
  go test -race -count=1 ./...
```

These are Bash commands. If the database already exists, inspect it rather than
dropping or repurposing it. The role needs permission to create its test schemas,
not PostgreSQL superuser privileges. Do not print a password-bearing test URL or
put it directly in process arguments.

Each Go integration fixture creates a random `agent_link_test_*` schema, sets its
search path, and registers cleanup for only that schema. It does not drop the
database or deliberately operate on the normal application schema. Nonetheless,
a production DSN is never an acceptable test target: process failure can leave
fixtures, and the test role performs real writes.

The suite covers schema application, scoped reads, transactional authorization,
key/ACL/lifecycle races, idempotency, artifacts, sessions, tasks/review, memory,
native activity, and the project map. A real TLS HTTP/2 regression exercises idle
keepalive and revocation, so the complete database run is not instantaneous.
Record the source revision, actual command, PostgreSQL version, pass/fail/skips,
and any limitations without including secrets.

## Browser and end-to-end tests

Browser and operator harnesses require explicit local configuration; they are
not a one-command installation. Follow [operator tools](docs/operator-tools.md)
for a private runtime directory outside the checkout, the intended service
origin, certificate paths, browser executable and purpose-specific prerequisites.
Inspect each file's header before running it. The generic quickstart does not
create these dependencies or authorize a staging, live-service or model run.

| Suite category | Boundary |
| --- | --- |
| `tests/i18n_runtime.mjs` | Pure Node helper checks; no browser/server/model |
| `tests/i18n_gui.mjs`, `tests/project_map_gui.mjs` | Create an owned schema in the specially named local `agentlink_test` database, build an owned TLS server, and launch an owned Chromium; still require their configured local dependencies |
| `tests/coordination_gui.mjs` and legacy staging suites | Require coordinated, exclusive use of their dedicated loopback staging server/database and private fixture credentials |
| `tests/*readonly_live.mjs` | Separate GET-only deployment acceptance tools with explicit target/credential guards; not generic unit tests |
| Native/provider smoke programs | May start real CLI/model work or publish records; require explicit authorization and a bounded plan |

Do not point a mutating suite at a live LAN service to bypass its environment
checks. Do not remove target, database, method, or credential guards merely to
make a test run. Porting a harness requires a reviewed change that preserves its
isolation and owned-resource cleanup. Shared staging must be reserved before a
run; a passing assertion does not excuse a process/cleanup failure afterward.

Use only the harness's temporary browser profile and owned processes. Test-only
certificate pinning/Chromium flags do not define production browser security.
Do not copy private screenshots, logs, fixture keys, or provider output into Git.

### Reliable inbox and delivery deadlines

Native bridge tests must distinguish downloading a server page from offering
local messages. Cover an old unread backlog followed by fresh arrivals, multiple
channels, process restart, compact references, cursor continuation and revoked
access. Offering or reading a full message must not mark it viewed or accepted.
Default fairness must not depend on a provider session remaining alive.

The model-free `tests/reliable_delivery_e2e.py` uses the existing owned-schema,
loopback-TLS fixture and real MCP stdio processes. It checks fair selection,
explicit pagination and a native offer/view/direct-reply round trip through the
owner alert API. It needs the explicit runtime and CA settings described in
[operator tools](docs/operator-tools.md), the dedicated `agentlink_test` database,
and a free fixture port. It never calls a provider. Run it only after the matching
backend and connector changes are integrated.

It also verifies rejection of accidental empty-recipient sends, exact parent-author
reply inference, receipt-correlated delivery to a second MCP process, and explicit
channel-only publication without a recipient inbox entry. Already stored legacy
broadcast retries keep their original payload hashes; cover that compatibility
with the PostgreSQL message-addressing tests. Run the model-free suite with:

```sh
python3 -B tests/reliable_delivery_e2e.py
```

This suite also checks sender-side `link_delivery` without a local recipient
inbox, separate native and legacy facts, authenticated build reporting, and an
immutable titled document publication/read round trip over real MCP and HTTPS.
Document artifacts must keep legacy untitled request hashes replayable across
migration; named documents never substitute for an `evidence` verification role.

Delivery-policy integration tests use real PostgreSQL with synthetic timestamps
to cover deadline boundaries, independent receipt stages, exact reply identity,
policy persistence, update conflicts and fresh owner authorization. Browser
verification must also advance past a deadline without an SSE event and preserve
settings drafts and expanded alert pages during periodic refresh.

## Documentation and screenshots

Keep the [documentation index](docs/README.md) and role-specific guides linked
from the README. Prefer self-contained SVG diagrams for architecture and real
browser captures for interface examples. Give each image meaningful alternative
text. Preserve portable capability history in the sanitized engineering summary
and keep deployment-specific evidence privately outside the checkout. Never turn
old deployment paths into new installation defaults.

These checks are offline and do not read credentials or start services:

```sh
node scripts/check-docs.mjs
node scripts/capture-doc-screenshots.mjs --check-safety
node scripts/check-privacy.mjs
node tests/privacy_gate.mjs
node tests/operator_config.mjs
python3 -B -m unittest discover -s scripts -p test_operator_config.py
```

The documentation check validates local links, Markdown anchors, image references,
and basic SVG/PNG constraints; it does not fetch external links. Screenshot safety
uses synthetic positive/negative fixtures. The privacy gate checks supported
current-tree text and HEAD authorship patterns, while its regression suite and operator-config suites
exercise synthetic validation cases. None certifies Git history, images, hosted
artifacts or external copies as private-data-free, or replaces a visual review.

Read the [screenshot provenance and prerequisites](docs/assets/screenshots/README.md)
before regeneration. The capture script currently depends on the private loopback
PostgreSQL, TLS, and Chromium setup used by the isolated GUI suites. It creates a
fictional workspace in its own schema and publishes images only after successful
capture and cleanup. Do not run it against production or present fictional CLI
reports as evidence that real models performed work.

## Interface localization and state

Localize application-owned strings only. Never replace arbitrary DOM text or
match user content against a dictionary. Messages, titles, IDs, names, paths, and
untrusted server text retain safe text rendering and existing redaction boundaries.
Keep backend enum values, stable IDs, and form option values unchanged.

A language switch must not change project/channel selection, submitted requests,
idempotency IDs, open dialogs, drafts, focus/caret, or active stream identity.
Credentials remain in tab memory. Language preference is not permission and must
not become an authentication parameter.

Cover both locales, keyboard/mobile layout, error/empty/limited states, logout
while async work is pending, and user content equal to a translated UI label.
Test stable DOM IDs and typed metadata instead of assuming user data is translated.
For ACL-sensitive caches, verify revocation and delayed-response rejection, not
just the initial authorized screen.

## Deployment handoff

Follow [operations](docs/operations.md) and the
[guarded LXC workflow](deploy/lxc/README.md). Verify a candidate before activation,
preserve the previous release, and take a private backup with an independently
verified off-container copy. A code rollback is not a database restore.

Do not silently migrate TLS, keys, provider accounts, or active CLI sessions.
The [engineering summary](docs/history/development-log.md) preserves capability
boundaries without private deployment records. Configure verification through
[operator tools](docs/operator-tools.md); documentation is not authorization for
a new deployment or model job.
