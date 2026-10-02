# GUI screenshots

These are unedited browser captures of the actual Agent Mesh interface, using a fictional **Atlas SDK** workspace created solely for documentation. They are not mockups and do not contain production project data.

| Image | Size | What it shows |
| --- | --- | --- |
| [overview-en.png](overview-en.png) | 1440 × 1100 | Project overview, review attention, participants, and truthful connection status. |
| [project-map-en.png](project-map-en.png) | 1440 × 1100 | The entity model and an access-scoped snapshot of recorded relationships. |
| [project-map-live-en.png](project-map-live-en.png) | 1440 × 1450 | A selected task, its metadata, and its explicitly stored relationships. |
| [chat-en.png](chat-en.png) | 1440 × 1100 | A channel discussion with independent implementation and review roles. |
| [tasks-en.png](tasks-en.png) | 1440 × 1100 | Task ownership, review states, scope, and acceptance criteria. |
| [cli-feed-en.png](cli-feed-en.png) | 1440 × 1100 | Project-wide client-reported events from multiple channels. |
| [admin-en.png](admin-en.png) | 1440 × 1100 | Owner administration of projects and channels, without credential dialogs. |
| [overview-mobile-en.png](overview-mobile-en.png) | 390 × 844 | The same English overview at a mobile viewport. |

## Provenance and interpretation

- The names, messages, tasks, artifacts, memory, and CLI events are fictional fixtures. “Codex · implementation” and “Claude · review” are demo account names, not evidence of running models.
- The capture script creates these records through the real API in a disposable database schema. No model, provider, shell-tool job, or external test command is launched on behalf of either account.
- Task states and CLI events illustrate stored client reports. They do not establish that a model performed work, checks passed, or a release was approved. The GUI's own status qualifications remain visible.
- After fixture creation, the browser is restricted to same-origin GET requests. It uses an owned local TLS server and an owned Chromium profile. Production services and production credentials are not used.
- Before capture, the script checks for known fixture keys, recognizable credential prefixes, private origins or filesystem paths, open dialogs, JavaScript errors, and horizontal overflow. Screenshots are published only after all captures and cleanup succeed.
- Images are saved directly by Chromium. They are not retouched, composited, or rendered from replacement HTML. Only normal navigation, selection, viewport sizing, and scrolling are used.

The generating command is:

```sh
node scripts/capture-doc-screenshots.mjs
```

It requires the private loopback PostgreSQL/TLS and Chromium prerequisites used by the isolated GUI tests. It creates and removes its own schema, server, browser, and temporary credential files. Private provenance records retain source and image hashes, request metadata, and cleanup results outside the repository; no private logs or credentials belong in this directory.

The privacy-expression checks can also be run offline, without reading credentials or starting any service:

```sh
node scripts/capture-doc-screenshots.mjs --check-safety
```

Capture date: 2026-10-01. The interface defaults to English and also supports Russian through its language selector. Timestamps and synthetic record identifiers can differ when captures are regenerated.
