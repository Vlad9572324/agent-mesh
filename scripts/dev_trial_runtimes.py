"""Fresh, bounded CLI jobs. Importing this module never launches a runtime.

Raw events, stderr, prompts, final text and the returned report are PRIVATE.
Only the small allowlisted callback dictionaries are suitable for publication.
Codex JSONL protocol: https://learn.chatgpt.com/docs/non-interactive-mode
"""
import collections
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import tempfile
import time


FILE_TOOLS = ("Read", "Glob", "Grep", "Edit", "Write")
READ_ONLY_TOOLS = ("Read", "Glob", "Grep")
CODEX_TOOLS = ("command_execution", "file_change")
STRUCTURED_TOOL = "StructuredOutput"
MAX_LINE = 4 * 1024 * 1024
MAX_LOG = 64 * 1024 * 1024


def _schema_argument(runtime, json_schema):
    if json_schema is None:
        return None
    if runtime != "claude" or type(json_schema) is not dict:
        raise ValueError("JSON schema must be an object and is supported only for Claude")
    try:
        encoded = json.dumps(json_schema, ensure_ascii=False, sort_keys=True, allow_nan=False)
        if len(encoded.encode("utf-8")) > 65_536:
            raise ValueError("schema too large")
    except (TypeError, ValueError, RecursionError):
        raise ValueError("invalid bounded JSON schema object") from None
    return encoded


def _command(runtime, cwd, read_only=False, model=None, json_schema=None):
    schema = _schema_argument(runtime, json_schema)
    if type(read_only) is not bool:
        raise ValueError("read_only must be a boolean")
    if runtime == "codex":
        if model is not None:
            raise ValueError("Codex jobs retain the CLI default model")
        command = ["codex", "exec", "--json", "--ephemeral", "--ignore-user-config",
                   "--sandbox", "read-only" if read_only else "workspace-write", "-C", str(cwd)]
        settings = ['approval_policy="never"', 'web_search="disabled"',
                    "sandbox_workspace_write.network_access=false", "mcp_servers={}", "notify=[]"]
        settings += ["features." + name + "=false" for name in (
            "apps", "plugins", "remote_plugin", "hooks", "multi_agent", "multi_agent_v2",
            "browser_use", "browser_use_external", "computer_use", "image_generation")]
        for setting in settings:
            command += ["-c", setting]
        return command + ["-"]
    if runtime == "claude":
        if model is not None and (type(model) is not str or model not in ("sonnet", "opus")):
            raise ValueError("Claude model must be sonnet or opus")
        tools = ",".join(READ_ONLY_TOOLS if read_only else FILE_TOOLS)
        command = ["claude", "--restricted", "--safe-mode", "--setting-sources", "",
                "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                "--tools", tools, "--allowedTools", tools, "--permission-mode", "dontAsk",
                "--permission-prompts", "none", "--no-chrome", "--no-session-persistence",
                "--model", model or "sonnet", "--effort", "low", "--output-format", "stream-json",
                "--verbose", "--print"]
        if schema is not None:
            command += ["--json-schema", schema]
        return command
    raise ValueError("runtime must be codex or claude")


def _private_file(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    return os.fdopen(fd, "wb", buffering=0)


class _OwnedGroup:
    """Linux private session ownership, pinned by an *unreaped* direct child.

    run_job is the sole waiter for its Popen. WNOWAIT keeps even an exited
    leader as our zombie until all group signals are finished. Its PID/PGID
    cannot be reused during that interval. Never call poll()/wait() before
    cleanup: a bare numeric PGID is not safe authority after reaping.

    This is group cleanup, not a cgroup/process-tree fence: a descendant that
    deliberately escapes this group/session is not identified or signalled.
    Non-child zombies are left for their actual parent/subreaper to reap.
    """
    def __init__(self, child):
        self.child = child
        self.pid = child.pid
        self._prove()

    def _prove(self):
        if self.child.returncode is not None:
            raise ChildProcessError("owned group leader was already reaped")
        # ECHILD also rejects externally reaped leaders, SIGCHLD auto-reaping,
        # stale/reused PIDs, and arbitrary Popen-like objects for other PIDs.
        observed = os.waitid(os.P_PID, self.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if observed is not None and observed.si_pid != self.pid:
            raise ChildProcessError("owned leader identity not proven")
        if os.getpgid(self.pid) != self.pid or os.getsid(self.pid) != self.pid:
            raise ChildProcessError("private process group and session not proven")
        return observed is not None

    def exited(self):
        return self._prove()

    def live_members(self):
        self._prove()
        members = []
        examined = 0
        started = time.monotonic()
        with os.scandir("/proc") as entries:
            for entry in entries:
                if not entry.name.isdecimal():
                    continue
                examined += 1
                if examined > 65536 or time.monotonic() - started > 1:
                    raise TimeoutError("owned group inspection budget exhausted")
                try:
                    fields = (Path(entry.path) / "stat").read_text().rsplit(")", 1)[1].split()
                except (FileNotFoundError, ProcessLookupError):
                    continue
                # /proc/PID/stat: state, ppid, pgrp, session. Never select by
                # command name or send a signal to an enumerated numeric PID.
                if int(fields[2]) == self.pid and int(fields[3]) == self.pid and fields[0] not in ("Z", "X"):
                    members.append(int(entry.name))
        self._prove()
        return members


def _stop_owned_group(child, ownership=None):
    """Bounded TERM/KILL of only our pinned group, then reap our direct child.

    An already-reaped leader is deliberately not recovered by looking up its
    old PGID: the number might now denote an unrelated process group.
    """
    result = {"leader_stopped": False, "leader_reaped": False, "group_stopped": False,
              "group_signals": [], "live_descendants_found": False}
    try:
        ownership = ownership or _OwnedGroup(child)
        members = ownership.live_members()
        result["live_descendants_found"] = any(pid != child.pid for pid in members)
        for sig, grace in ((signal.SIGTERM, 5), (signal.SIGKILL, 3)):
            if not members:
                break
            ownership._prove()
            os.killpg(child.pid, sig)
            result["group_signals"].append(signal.Signals(sig).name)
            deadline = time.monotonic() + grace
            while True:
                members = ownership.live_members()
                if not members or time.monotonic() >= deadline:
                    break
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        result["group_stopped"] = not members
        result["leader_stopped"] = ownership.exited()
        if result["leader_stopped"]:
            # Reap only after the final group audit. No signals use this PGID
            # after wait(), even if the process table reuses it immediately.
            child.wait(timeout=1)
            result["leader_reaped"] = True
    except (OSError, ValueError, IndexError, TimeoutError, subprocess.TimeoutExpired) as error:
        result["ownership_refused"] = True
        result["cleanup_error_category"] = type(error).__name__
        # Polling is safe here only as a final reap attempt; no group signal can
        # follow this point. A live unproven target is left alone, not guessed.
        result["leader_stopped"] = child.poll() is not None
        result["leader_reaped"] = result["leader_stopped"]
    return result


class _Events:
    def __init__(self, runtime, callback, read_only=False, json_schema=None):
        if type(read_only) is not bool:
            raise ValueError("read_only must be a boolean")
        self.runtime, self.callback = runtime, callback
        self.structured_output_required = _schema_argument(runtime, json_schema) is not None
        self.structured_output_used = False
        self.read_only = read_only
        self.allowed_tools = (("command_execution",) if read_only else CODEX_TOOLS) if runtime == "codex" else (
            READ_ONLY_TOOLS if read_only else FILE_TOOLS)
        if self.structured_output_required:
            self.allowed_tools += (STRUCTURED_TOOL,)
        self.session_id = None
        self.observed_models = []
        self.terminal_success = False
        self.failed = False
        self.final_text = ""
        self.callback_errors = 0
        self.started, self.ended = {}, set()
        self.counts = collections.Counter()

    def emit(self, category, tool_type=None):
        if self.callback is None:
            return
        event = {"event": category, "runtime": self.runtime,
                 "started_count": len(self.started), "ended_count": len(self.ended)}
        if tool_type is not None:
            event["tool_type"] = tool_type if tool_type in FILE_TOOLS + CODEX_TOOLS + (STRUCTURED_TOOL,) else "other"
        try:
            self.callback(event)
        except Exception:
            # A failed publication is not a reason to retry model execution.
            self.callback_errors += 1

    def session(self, value):
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", value):
            raise ValueError("invalid runtime session identity")
        if self.session_id is not None and self.session_id != value:
            raise ValueError("runtime session identity changed")
        self.session_id = value

    def observe_model(self, value):
        # Missing metadata means unknown, never infer identity from the CLI or
        # requested alias. Resolved IDs need not equal aliases such as "opus".
        if value is None:
            return
        if type(value) is not str or not value.strip() or len(value) > 256 or any(ord(char) < 32 for char in value):
            raise ValueError("invalid runtime model identity")
        if value not in self.observed_models:
            self.observed_models.append(value)

    def tool(self, identifier, name, ended=False):
        if not isinstance(identifier, str) or len(identifier) > 256:
            raise ValueError("invalid tool event identity")
        if name not in self.allowed_tools:
            raise ValueError("unexpected tool outside configured job policy")
        if ended:
            if identifier not in self.ended:
                self.ended.add(identifier)
                self.counts[name + ".ended"] += 1
                self.emit("tool_ended", name)
        elif identifier not in self.started:
            self.started[identifier] = name
            self.counts[name + ".started"] += 1
            self.emit("tool_started", name)

    def accept(self, event):
        if not isinstance(event, dict):
            raise ValueError("runtime event must be an object")
        kind = event.get("type")
        if self.runtime == "codex":
            self.observe_model(event.get("model"))
            for name in ("thread", "item", "message"):
                metadata = event.get(name)
                if isinstance(metadata, dict):
                    self.observe_model(metadata.get("model"))
            if self.read_only and isinstance(event.get("item"), dict) and event["item"].get("type") == "file_change":
                raise ValueError("file change event in read-only job")
            if kind == "thread.started":
                self.session(event.get("thread_id"))
            elif kind in ("turn.failed", "error"):
                self.failed = True
            elif kind == "turn.completed":
                self.terminal_success = True
            elif kind in ("item.started", "item.completed"):
                item = event.get("item", {})
                item_type = item.get("type")
                if item_type in CODEX_TOOLS:
                    self.tool(item.get("id"), item_type, kind == "item.completed")
                elif item_type in ("mcp_tool_call", "web_search", "tool_call"):
                    raise ValueError("unexpected external tool event")
                elif item_type == "agent_message" and kind == "item.completed":
                    self.final_text = str(item.get("text", ""))
        else:
            if event.get("session_id"):
                self.session(event["session_id"])
            if kind == "system" and event.get("subtype") == "init":
                self.observe_model(event.get("model"))
                inventory = event.get("tools", [])
                if not isinstance(inventory, list) or any(tool not in self.allowed_tools for tool in inventory):
                    raise ValueError("Claude advertised tools outside the file-only allowlist")
            elif kind in ("assistant", "user"):
                if kind == "assistant":
                    self.observe_model(event.get("message", {}).get("model"))
                for item in event.get("message", {}).get("content", []):
                    if not isinstance(item, dict):
                        continue
                    if item.get("type") == "tool_use":
                        self.tool(item.get("id"), item.get("name"))
                    elif item.get("type") == "tool_result":
                        identity = item.get("tool_use_id")
                        if identity not in self.started:
                            raise ValueError("tool completion without an observed start")
                        self.tool(identity, self.started[identity], ended=True)
            elif kind == "result":
                self.terminal_success = event.get("subtype") == "success" and not event.get("is_error", False)
                self.failed = self.failed or not self.terminal_success
                if self.structured_output_required:
                    structured = event.get("structured_output")
                    if type(structured) is not dict:
                        raise ValueError("required native structured output object missing")
                    self.final_text = json.dumps(structured, ensure_ascii=False, sort_keys=True, allow_nan=False)
                    self.structured_output_used = True
                else:
                    self.final_text = str(event.get("result", ""))


def run_job(runtime, cwd, prompt, evidence_dir, event_callback, timeout=600, *, read_only=False, model=None, json_schema=None):
    """Run ONCE; callers must independently review the patch and run tests.

    Callback must return promptly (set deadlines on any publication it performs).
    The report/final_text is private, not callback or public message content.
    No auth files or user configuration are changed; existing CLI auth is reused.
    Read-only jobs use a read-only Codex sandbox or Claude's read-only file tools.
    Tool events incompatible with the selected profile fail the job closed.
    Claude accepts only sonnet/opus aliases; Codex retains its default model.
    observed_models contains only runtime metadata; an empty list means unknown.
    With a Claude JSON schema, only native structured_output is returned as JSON;
    the caller must still validate its application schema. No prose fallback.
    """
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode()) > MAX_LINE:
        raise ValueError("prompt must be nonempty and at most 4 MiB")
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 3600:
        raise ValueError("timeout must be between zero and 3600 seconds")
    cwd = Path(cwd).resolve(strict=True)
    if not cwd.is_dir() or cwd == Path(cwd.anchor):
        raise ValueError("cwd must be a specific existing work directory")
    command = _command(runtime, cwd, read_only=read_only, model=model, json_schema=json_schema)
    base = Path(evidence_dir).absolute()
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = base.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("evidence directory must be private, owned and not a symlink")
    directory = Path(tempfile.mkdtemp(prefix=runtime + "-", dir=base))
    paths = {name: directory / name for name in ("prompt.txt", "stdout.jsonl", "stderr.log", "report.json")}
    with _private_file(paths["prompt.txt"]) as output:
        output.write((prompt + "\n").encode())
    report = {"runtime": runtime, "cwd": str(cwd), "command": command, "read_only": read_only,
              "requested_model": model or ("sonnet" if runtime == "claude" else None),
              "started_at": time.time(), "pid": None, "success": False, "timed_out": False,
              "error_category": None, "evidence_dir": str(directory), "automatic_retry": False}
    events = _Events(runtime, event_callback, read_only=read_only, json_schema=json_schema)
    child = None
    ownership = None
    selector = selectors.DefaultSelector()
    deadline = time.monotonic() + timeout
    buffers = bytearray()
    sizes = collections.Counter()
    try:
        with paths["prompt.txt"].open("rb") as input_file, _private_file(paths["stdout.jsonl"]) as raw, _private_file(paths["stderr.log"]) as errors:
            environment = os.environ.copy()
            environment.pop("CLAUDECODE", None)
            child = subprocess.Popen(command, cwd=cwd, env=environment, stdin=input_file,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                                     close_fds=True)
            report["pid"] = child.pid
            ownership = _OwnedGroup(child)
            events.emit("runtime_started")
            outputs = {"stdout": raw, "stderr": errors}
            for name, pipe in (("stdout", child.stdout), ("stderr", child.stderr)):
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ, name)
            while selector.get_map() or not ownership.exited():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    report["timed_out"] = True
                    raise TimeoutError("job deadline")
                for key, _ in selector.select(min(remaining, 0.25)):
                    data = os.read(key.fd, 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    name = key.data
                    sizes[name] += len(data)
                    if sizes[name] > MAX_LOG:
                        raise ValueError("private runtime log size limit")
                    outputs[name].write(data)
                    if name != "stdout":
                        continue
                    buffers.extend(data)
                    while b"\n" in buffers:
                        line, _, rest = buffers.partition(b"\n")
                        buffers = bytearray(rest)
                        if len(line) > MAX_LINE:
                            raise ValueError("runtime event size limit")
                        if line.strip():
                            events.accept(json.loads(line))
                    if len(buffers) > MAX_LINE:
                        raise ValueError("runtime event size limit")
            if buffers.strip():
                events.accept(json.loads(buffers))
            # EOF + exited leader need not mean the group is done: a helper can
            # close both pipes and keep running. Audit before any leader reap.
            if ownership.live_members():
                raise ChildProcessError("runtime left live group descendants")
    except BaseException as error:
        report["error_category"] = type(error).__name__
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            report["interrupted"] = True
    finally:
        selector.close()
        if child is not None:
            report["cleanup"] = _stop_owned_group(child, ownership)
            report["exit_code"] = child.returncode
            if not report["cleanup"]["group_stopped"] or not report["cleanup"]["leader_reaped"]:
                report["error_category"] = report["error_category"] or "UnconfirmedProcessCleanup"
            for pipe in (child.stdout, child.stderr):
                if pipe is not None:
                    pipe.close()
        report.update(session_id=events.session_id, terminal_success=events.terminal_success,
                      observed_models=list(events.observed_models),
                      structured_output_used=events.structured_output_used,
                      terminal_failure_seen=events.failed, final_text=events.final_text,
                      tool_started=len(events.started), tool_ended=len(events.ended),
                      tool_counts=dict(events.counts), callback_errors=events.callback_errors,
                      finished_at=time.time(), logs={name: str(path) for name, path in paths.items()})
        report["success"] = bool(report.get("exit_code") == 0 and events.session_id and
                                 events.terminal_success and not events.failed and not report["error_category"])
        with _private_file(paths["report.json"]) as output:
            output.write((json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode())
    return report
