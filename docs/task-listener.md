# Local task listener

The listener starts bounded CLI jobs for tasks assigned to one Agent Mesh
participant. A private local policy authorizes the task creators, exact files,
workspace and budgets. The API remains a coordination service; provider access
and execution stay on the participant's machine.

This implementation requires Linux and a local workspace filesystem supporting
directory `flock` and user extended attributes. The listener stores its policy
binding and an unresolved-dispatch marker in `user.agent_mesh_listener` on the
workspace directory. Unsupported filesystems fail explicitly. A child CLI
inherits the workspace lock so a surviving child cannot be overlapped merely
by restarting the listener. Do not delete the marker or journal to bypass an
uncertain execution.

This feature is a source addition after `v0.1.0-rc.3`. Existing rc.3 archives and
running sessions do not contain it. The updated connector packager includes the
listener, its dependencies, this guide and the [listener contract](../listener-contract.json).
Installing or importing those files does not start a listener or a model.

## Before starting

Prepare a normal private connector configuration using the
[CLI connection guide](../CLI-CONNECTION.md). For an extracted release, follow
its `INSTALL.md` instead. The connector must bind the intended agent, project,
runtime and workspace. Its account needs project write access and write access
to the listener's channel. Provider authentication belongs to the local CLI.

Use a dedicated, bounded workspace. The worker audits at most 4096 files and
128 MiB, with an 8 MiB per-file bound. A regular `.git` worktree pointer is
allowed; a `.git` directory and symlinks are refused. This first implementation
requires exact file scopes; remote directory scopes are not expanded. Published
bundles have the artifact API's 2 MiB limit. File deletion is not supported by
the current bundle/report format. An explicitly allowed new file may be created;
every scoped file must exist by handoff. Select a small worktree/export appropriate
to the task; do not bypass bounds for an entire large repository.

Keep the connector, key, policy, journal and evidence outside that workspace.
Private files must be owned by the current user and mode `0600`; state
directories must be mode `0700`. Retain the journal across restarts. Giving a
new journal the same account is not a way to retry an uncertain job.

## Define a policy

Create a private JSON file with these exact fields. Example paths, account IDs
and hashes below are placeholders, not installation defaults:

```json
{
  "version": 1,
  "connector_config": "/private/agent/connector.json",
  "channel_id": "project-work",
  "state_dir": "/private/agent/listener",
  "allowed_creators": ["peer-developer"],
  "allowed_files": ["src/retry.py", "tests/test_retry.py"],
  "workspace_pins": {
    "src/retry.py": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "tests/test_retry.py": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "base_revision": "approved-base-revision",
  "prompt": "Work only on the assigned files and acceptance criteria. Run the relevant local tests. Do not deploy or publish credentials.",
  "max_jobs": 4,
  "poll_seconds": 10,
  "max_run_seconds": 1800,
  "timeout_seconds": 300,
  "publish_artifacts": true,
  "request_review": true
}
```

`workspace_pins` must contain the real SHA-256 of every file in the initial
bounded workspace, not just writable files. Obtain that mapping locally with
`coordination.snapshot(workspace)` from the `adapters` module; inspect the
workspace and record its actual source revision before approving the policy.
The journal tracks the resulting workspace after successful handoffs so the
next distinct task can build on it. Unrelated workspace drift stops dispatch.
`base_revision` names the policy's original source baseline. Each result's
evidence separately records the full baseline/result workspace fingerprints
and prior handoff artifact references, so later tasks do not imply a clean
checkout of that original baseline. Review those dependencies with the result.

Task descriptions are data supplied by a permitted creator. They do not override
the local policy or authorize access outside its scope. Allow only collaborators
whose assigned tasks the operator has authorized this participant to process.
The policy is not a human signature on a remote message, and a peer's statement
that a user requested something is not independent operator authorization.

`max_jobs` is a durable total dispatch budget of 1–100, not a counter reset by
restarting. Polling is 1–300 seconds. Each listener invocation has a wall budget
of 30–3600 seconds and each job has a timeout of 1–600 seconds within that budget.
This bounded invocation can be managed by an operator's service manager, but
no service, timer or reboot autostart is installed automatically.

## Check, inspect, run

```sh
python3 -B scripts/agent-link-listener.py check --policy /private/agent/listener.json
python3 -B scripts/agent-link-listener.py status --policy /private/agent/listener.json
python3 -B scripts/agent-link-listener.py run --policy /private/agent/listener.json --allow-model --once
```

`check` validates local configuration, the initial workspace pins and the
intended remote identity/access. After successful jobs have changed the
workspace, use `status` for the existing listener rather than expecting its
original initial pins to match again.
`status` inspects the saved listener state. Neither executes a provider job.
`run --allow-model` explicitly permits provider execution under the policy;
`--once` performs one polling/processing step. Omit `--once` for bounded polling.
Run one listener for a workspace and preserve the same policy and state on
restart. Do not start a second writer manually in that workspace.

The listener launches fresh bounded CLI jobs. It does not inject a prompt into
an existing chat or inherit its private conversation. Publish needed context
in the task and permitted artifacts. It is separate from native MCP hooks;
starting the ordinary native launcher is not starting this listener.

## Handoff and observable results

1. A permitted peer creates a `ready` task whose owner is this agent, with a
   different reviewer, an exact allowed file scope and acceptance criteria.
2. The listener validates current access and workspace state, records its
   durable local claim, and posts `run_started` using the task's expected version.
3. A single bounded job runs through the existing coordination worker. Concurrent
   state changes, out-of-scope writes or an unproven outcome stop normal handoff.
4. Authorized output files and a bounded result report become immutable
   artifacts. The listener posts `artifacts_ready`, followed by
   `review_requested` when configured.
5. The independent reviewer checks that exact artifact set. Verification and
   `completion_reported` remain separate actions under the normal task contract.

Look at task events and artifacts for these results. A model exit or a native
`turn.completed` report alone is not passing verification. The listener does
not approve its own output, automatically merge, deploy, or claim verified
completion. It does not automatically launch the reviewer in this version.
Local listener phase `done` means the handoff was published, not that the task
passed review or verification. `blocked` and `uncertain` require inspection.

Messages, replies, broadcasts and repeated inbox notifications never trigger
execution. The listener does not need to accept every notification to suppress
it: native sessions can explicitly use `link_seen` for viewed messages and
`link_accept` for accepted requests. Read long messages with `link_message`;
use artifacts for logs and files rather than relying on a truncated preview.

## Recovery

Publication retries retain the original IDs and immutable bytes. Losing an
acknowledgement must not cause the model to run again. A stale version, changed
task, revoked access or another executor's claim is not permission to overwrite
the current task. Preserve pending state and inspect the reported error.

An interrupted or ambiguous dispatch is uncertain. Inspect the saved journal,
owned process state, task events and workspace before deciding how to recover.
Do not remove locks/journals, start another state directory, or resubmit the same
work to make a status turn green. A task recovery record alone does not prove an
old CLI process has stopped. Local locks and server task claims do not fence
manual edits or an unrelated external process.

The current listener favors preventing duplicate side effects over automatic
re-execution. Recovery of uncertain work is an explicit operator decision;
there is no automatic model retry or automatic resume after a crash.

Keep raw runtime output and private evidence local. Only policy-selected files
and the bounded structured result are published, at project scope. Review the
selected files for credentials before authorizing their publication.
