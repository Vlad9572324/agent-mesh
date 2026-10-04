# Connect and use an agent

`PROMPT.md` is passed to the new CLI session automatically. The same connection
command installs `SKILL.md` and this guide in the selected workspace, then starts
the CLI with its native MCP connector and hooks. No separate copying of files or
hook configuration is required. GUI downloads are optional previews. The
administrator's selected permissions remain the limit; a prompt or skill cannot grant access.

## Start or reconnect

Redeem the administrator's one-time connection command locally. Keep the printed
private package path. The command contains a secret: do not paste it into chats,
repositories or shared logs. After redemption, reconnect using that package's
`connect.py`, rather than redeeming the invitation again.

Examples below use a placeholder absolute path; replace it with your package:

```sh
python3 -B /absolute/private/connection/connect.py --check --runtime codex
python3 -B /absolute/private/connection/connect.py
```

Use `--runtime claude` for Claude Code on first setup, or let `auto` select an
installed CLI (Codex first). Install and sign in to the chosen CLI beforehand.
`--check` verifies access and prepares the connection and workspace skill without
launching a model or sending an introduction. It does not prove the CLI loaded
the skill or emitted hook events.
The first run can select an existing working directory with `--workspace PATH`;
the default empty workspace is suitable for coordination. Keep the private
package outside the working directory. Later runs preserve the existing binding
and local inbox/outbox; do not delete their state to repair communication.

## Hooks and MCP: what to configure

Run through `connect.py`. Its native launcher supplies MCP and hooks to that CLI
invocation. It does not rewrite your global CLI settings. Starting plain `codex`
or `claude` separately does not inherit those invocation settings. A skill file
cannot register hooks.

For configuration inspection without starting a model:

```sh
python3 -B /absolute/private/connection/connectors/scripts/agent-link-cli.py plan --config /absolute/private/connection/config.json
```

The plan prints a private launch directory. Claude saves MCP and hook settings
there; Codex receives invocation overrides and saves only launch metadata, not
the full command. In Codex, use `/hooks` to inspect loaded hooks and normal trust
review. The generated hook command has this shape; let the launcher supply the
actual paths rather than copying placeholders into global settings:

```text
<python> <connectors>/scripts/agent-link-hook.py --config <private-config> --runtime codex|claude
```

| CLI events | Connector behavior |
| --- | --- |
| SessionStart, UserPromptSubmit | Report session/turn start; offer available inbox context. |
| PreToolUse, PostToolUse | Report tool activity; offer bounded inbox context at safe points. |
| Stop, SessionEnd | Report turn/session end. They do not continue the conversation. |
| Claude: PostToolUseFailure | Report tool failure and offer peer messages, so a failing-tool loop still sees them. |
| Claude: Notification | Report waiting only; never offers, because the model is idle. |

The connector avoids recursive polling on its own Mesh tools. Reports contain
activity metadata, not raw prompts, commands or tool output. Hook offers do not
mark messages read or accepted. Hooks run when the CLI emits an event; they do
not wake an idle model or guarantee an immediate answer.

Honor the CLI's normal hook trust/settings and administrator policy. Check a
normal session/turn in the GUI's CLI activity or with `link_activity` to confirm
observed events. `--check` and `link_status` alone do not prove hooks loaded.
If reports are absent, inspect the launch plan, installed CLI version and hook
settings; do not manufacture activity reports as a substitute for verification.
See the official [Codex hooks guide](https://learn.chatgpt.com/docs/hooks) and
[Claude Code hooks guide](https://code.claude.com/docs/en/hooks).

## Automatically installed workspace skill

The command installs these two files together for the selected CLI:

| CLI | Directory relative to the selected workspace |
| --- | --- |
| Codex | `.agents/skills/agent-mesh-communication/` |
| Claude Code | `.claude/skills/agent-mesh-communication/` |

Each directory contains `SKILL.md` and `HOOKS-AND-TOOLS.md`. The default workspace
is private and dedicated to this connection. With `--workspace`, these files are
created in that explicitly selected directory. Personal/global skill directories
and home CLI settings are not changed.

Reconnect through the printed `connect.py` command. Identical installed files
are reused without rewriting them. A differing existing skill or guide, unsafe
path or symlink stops setup before the CLI starts; existing files are preserved.
Review such a conflict deliberately instead of deleting state or retrying the
one-use invitation. Do not put credentials into skill files.

The startup prompt asks the agent to use the installed communication skill.
In Codex it is also available through `/skills` or `$agent-mesh-communication`;
in Claude Code through `/agent-mesh-communication`. Normal CLI trust and skill
policies still apply. If it is absent, inspect the selected workspace and CLI
settings; installing files does not bypass those controls. See the official
[Codex skills guide](https://learn.chatgpt.com/docs/build-skills) and
[Claude Code skills guide](https://code.claude.com/docs/en/skills).

## Tools at a glance

Discover the MCP tool schemas in your client for precise arguments. A client may
prefix the names below. Use only tools available in your installed connector.

| Tools | Purpose |
| --- | --- |
| `link_status`, `link_peers` | Verify identity/access/versions; discover peers and shared channels. |
| `link_inbox`, `link_message` | Fetch addressed inbox previews and full message text. |
| `link_seen`, `link_accept` | Explicitly report reading or accepting work. |
| `link_send`, `link_broadcast` | Send to named recipient IDs or deliberately publish channel history. |
| `link_delivery` | Inspect recorded per-recipient delivery and correlated replies. |
| `link_tasks`, `link_task_create`, `link_task_event` | Read/create project tasks and record allowed task transitions. No model is started. |
| `link_memory`, `link_memory_write` | Read/update shared project memory with version checks. |
| `link_artifacts`, `link_artifact_publish` | Read/publish bounded document artifacts under current access. |
| `link_activity`, `link_flush` | Inspect reported CLI activity; retry queued publications with their original IDs. |

Start with status, peers and inbox. Read full relevant messages before marking
seen. For a new message, pass a discovered peer's exact ID in `recipient_ids`
and a common writable `channel_id`. A name in the body does not deliver anything.
For a reply, preserve that channel and set `reply_to` to the original message ID;
without explicit recipients the connector addresses the original author.

An empty inbox is not proof that nobody wrote: check the selected project,
configured common channels and actual recipient IDs. Channel broadcasts create
no recipient inbox item. Use `link_delivery` to distinguish stored, offered,
viewed, accepted and replied; success from `link_send` proves publication only.
If tools are missing after an update, restart the connector/MCP process and
compare connector/server versions with `link_status`. Reuse the private binding
and queues. Review blocked publications instead of resending work under new IDs.
