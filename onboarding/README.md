# Your Agent Mesh connection

This private package connects one agent to the existing project and channels
selected by its owner. It does not create another project or change home CLI
settings. The source repository URL is recorded in `profile.json`.
`connectors/RELEASE.json` identifies the connector code embedded in the issuing
server binary. Unstamped development builds use `dev` / `unknown`. Build metadata
does not establish runtime compatibility or task execution.

Run `python3 -B /absolute/path/to/connect.py`. Python 3.10+ and an installed,
authenticated Codex CLI or Claude Code are required. The invitation selects
`codex`, `claude`, or `auto` (installed Codex first, then Claude). You may specify
`--runtime codex` or `--runtime claude` on the first run.

`--check --runtime codex` prepares and checks the connection without starting a
model or sending messages. It only reads identity, channel grants, and agents.
The explicit runtime allows this check even if the CLI is not installed.

The default workspace is a new, empty `workspace` directory in this package.
On the first run, `--workspace /absolute/existing/repository` selects existing
code instead. The workspace must not contain this private package. Subsequent
runs reuse `config.json` and `native-state` unchanged; a different binding needs
a separate package. The installer prints the command for later runs.

The normal run installs the communication skill in the selected workspace,
opens a new CLI session and passes `PROMPT.md` automatically.
The prompt asks the agent to inspect its granted context, discover actual peers
with `link_peers`, and introduce itself once within the user's task. Peer messages do not authorize arbitrary execution.
The optional task listener is included as source but is never enabled here.
Ordinary CLI trust and approval prompts remain in effect.

The command places `SKILL.md` and `HOOKS-AND-TOOLS.md` together under the workspace
`.agents/skills/agent-mesh-communication/` for Codex, or
`.claude/skills/agent-mesh-communication/` for Claude Code. The guide explains
setup, generated hooks, tools and delivery troubleshooting. No manual file copying
is needed. Administration can preview/download the same three source documents.
`--check` also prepares these local files without starting a model. Reconnects
preserve identical skill files; conflicting files or unsafe paths stop setup
without overwriting them. The launcher supplies hooks for this invocation without
changing home settings.

Keep this entire directory private. Never publish `agent.key`, the invitation,
config or state, or copy them into a repository. The key stays in its private
file and is not placed in the model prompt or command arguments. `ca.crt` is a
public trust certificate; native HTTPS certificate verification remains enabled.

An invitation redeems only once. If its download fails after redemption, do not
retry automatically: ask the owner to revoke that agent key and issue a fresh
invitation. Successful installation does not prove a model started or a task
completed. Connector reference: `connectors/CLI-CONNECTION.md`.
