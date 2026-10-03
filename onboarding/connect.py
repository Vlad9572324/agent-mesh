#!/usr/bin/env python3
"""Connect one provisioned Agent Mesh identity using its private local bundle."""
import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import uuid
from urllib.parse import urlsplit


class SetupError(ValueError):
    pass


def private_directory(path):
    if path.is_symlink():
        raise SetupError("Private bundle/state directories must not be symlinks.")
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SetupError("Private bundle/state directories must be owned by you with mode 0700.")


def read_profile(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 32768:
            raise SetupError("The supplied profile must be an owned private regular file.")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(32769)
    finally:
        os.close(fd)
    if len(raw) > 32768:
        raise SetupError("The supplied profile is too large.")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise SetupError("The supplied profile has duplicate fields.")
            result[key] = value
        return result
    profile = json.loads(raw, object_pairs_hook=pairs)
    fields = {"version", "agent_id", "project_id", "url", "channel_ids", "runtime", "repository", "connector_dir"}
    if type(profile) is not dict or set(profile) != fields or type(profile["version"]) is not int or profile["version"] != 1:
        raise SetupError("The supplied profile has unexpected fields.")
    identifier = lambda value: type(value) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", value)
    if not identifier(profile["agent_id"]) or not identifier(profile["project_id"]):
        raise SetupError("The supplied profile has an invalid identity.")
    channels = profile["channel_ids"]
    if type(channels) is not list or not 1 <= len(channels) <= 8 or not all(identifier(v) for v in channels) or len(set(channels)) != len(channels):
        raise SetupError("The supplied profile has invalid channel bindings.")
    repository = urlsplit(profile["repository"])
    if (profile["connector_dir"] != "connectors" or profile["runtime"] not in ("auto", "codex", "claude")
            or repository.scheme != "https" or not repository.hostname or repository.username
            or repository.password or repository.query or repository.fragment):
        raise SetupError("The supplied profile has an invalid runtime or connector source.")
    return profile


def prepare(bundle, args):
    private_directory(bundle)
    profile = read_profile(bundle / "profile.json")
    connectors = bundle / "connectors"
    if connectors.is_symlink() or not connectors.is_dir() or connectors.resolve() != connectors:
        raise SetupError("The verified connector directory is missing or aliased.")
    launcher = connectors / "scripts" / "agent-link-cli.py"
    if not launcher.is_file() or launcher.is_symlink():
        raise SetupError("The verified native launcher is missing.")
    sys.path[:0] = [str(connectors / "adapters"), str(connectors / "scripts")]
    from native_bridge import load_config, origin
    from native_launch import main as native_main

    config_path = bundle / "config.json"
    existing = load_config(config_path) if config_path.exists() or config_path.is_symlink() else None
    runtime = args.runtime or (existing["runtime"] if existing else profile["runtime"])
    if runtime == "auto":
        runtime = None
    if runtime is None:
        runtime = next((name for name in ("codex", "claude") if shutil.which(name)), None)
    if runtime is None:
        raise SetupError("Install and sign in to Codex CLI or Claude Code first. For a connection-only check, specify --check --runtime codex or claude.")
    if not args.check and not shutil.which(runtime):
        raise SetupError("The selected CLI is not installed on PATH. Install and sign in to it, or use --check without starting a model.")
    default_workspace = bundle / "workspace"
    workspace = Path(args.workspace).expanduser().absolute() if args.workspace else Path(existing["workspace_root"]) if existing else default_workspace
    if any(part.is_symlink() for part in (workspace, *workspace.parents)):
        raise SetupError("Use the real workspace directory without symlinks in its path.")
    workspace = workspace.resolve()
    if workspace == bundle or workspace in bundle.parents or workspace == Path(workspace.anchor):
        raise SetupError("The workspace must not contain the private onboarding bundle.")
    if workspace == default_workspace:
        private_directory(workspace)
    elif not workspace.is_dir():
        raise SetupError("An explicit --workspace must name an existing directory.")

    wanted = {"version": 1, "url": origin(profile["url"]), "runtime": runtime,
              "agent_id": profile["agent_id"], "project_id": profile["project_id"],
              "channel_ids": profile["channel_ids"], "workspace_root": str(workspace),
              "state_dir": str(bundle / "native-state"), "key_file": str(bundle / "agent.key"),
              "ca_file": str(bundle / "ca.crt")}
    if existing:
        if existing != wanted:
            raise SetupError("This bundle already has a different runtime, workspace or identity binding. Reuse its existing configuration; request a separate bundle to change the binding.")
    else:
        arguments = ["prepare", "--url", profile["url"], "--ca-file", str(bundle / "ca.crt"),
                     "--key-file", str(bundle / "agent.key"), "--agent-id", profile["agent_id"],
                     "--project-id", profile["project_id"], "--runtime", runtime,
                     "--workspace", str(workspace), "--state-dir", str(bundle / "native-state"),
                     "--output", str(config_path)]
        for channel in profile["channel_ids"]:
            arguments.extend(("--channel", channel))
        with contextlib.redirect_stdout(io.StringIO()):
            if native_main(arguments) != 0:
                raise SetupError("The native connector could not prepare its private configuration.")
        if load_config(config_path) != wanted:
            raise SetupError("The prepared configuration does not match the supplied profile.")
    return profile, config_path, launcher


def read_guidance(bundle):
    from native_bridge import read_private
    documents = {}
    for name in ("PROMPT.md", "SKILL.md", "HOOKS-AND-TOOLS.md"):
        try:
            content = read_private(bundle / name, 32768).decode("utf-8")
        except Exception:
            raise SetupError("The supplied guidance must contain bounded UTF-8 private regular files.") from None
        if not content.strip() or "\x00" in content:
            raise SetupError("The supplied guidance is empty or invalid.")
        documents[name] = content
    return documents


def install_skill(config_path, documents):
    """Prepare this workspace's skill without following links or replacing files."""
    from native_bridge import load_config
    config = load_config(config_path)
    workspace = Path(config["workspace_root"])
    parts = ((".agents" if config["runtime"] == "codex" else ".claude"),
             "skills", "agent-mesh-communication")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    with contextlib.ExitStack() as stack:
        def directory(name, parent=None):
            descriptor = os.open(name, flags, dir_fd=parent)
            stack.callback(os.close, descriptor)
            return descriptor

        try:
            # Hold directory descriptors from the filesystem root: a symlink in
            # any component must not redirect even an explicit workspace write.
            parent = directory(workspace.anchor)
            for part in workspace.parts[1:]:
                parent = directory(part, parent)
            for part in parts:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=parent)
                except FileExistsError:
                    pass
                parent = directory(part, parent)
                info = os.fstat(parent)
                if info.st_uid != os.getuid() or info.st_mode & 0o022:
                    raise SetupError("The workspace skill directories must be owned by you and not writable by other users.")

            missing = []
            # Validate every existing destination before installing either file.
            for name in ("SKILL.md", "HOOKS-AND-TOOLS.md"):
                content = documents[name].encode("utf-8")
                try:
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                except FileNotFoundError:
                    missing.append((name, content))
                    continue
                with os.fdopen(fd, "rb") as stream:
                    info = os.fstat(stream.fileno())
                    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                            or info.st_mode & 0o022 or info.st_size > 32768
                            or stream.read(32769) != content):
                        raise SetupError("An existing workspace skill file differs or is unsafe; preserve it and resolve the conflict before reconnecting.")

            for name, content in missing:
                temporary = ".agent-mesh-" + uuid.uuid4().hex
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                try:
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(content)
                        stream.flush()
                        os.fsync(stream.fileno())
                    # Link an already complete regular file into place. Unlike
                    # replace/rename, this fails if another file appeared there.
                    os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                finally:
                    os.unlink(temporary, dir_fd=parent)
                os.fsync(parent)
        except OSError:
            raise SetupError("Workspace skill setup refused a linked, conflicting or inaccessible path; existing files were not overwritten.") from None
    return workspace.joinpath(*parts, "SKILL.md")


def check_access(config_path, documents):
    from native_bridge import NativeBridge
    bridge = NativeBridge(config_path, "check-" + uuid.uuid4().hex, timeout=5)
    try:
        bridge.reject_secret(documents)
        # These three requests only read current grants and participant identities.
        # Never poll/ack messages, flush an outbox, heartbeat, or publish activity.
        allowed = bridge._authorize()  # GET /v1/me and GET project/channels.
        if not all(allowed.get(channel) is True for channel in bridge.config["channel_ids"]):
            raise SetupError("The supplied identity lacks write access to its configured channel.")
        agents = bridge._request("GET", bridge.project_path + "/agents").get("agents")
        if type(agents) is not list:
            raise SetupError("The server did not return a participant list.")
        participants = sum(1 for item in agents if type(item) is dict and item.get("id") != bridge.config["agent_id"])
        return {"connected": True, "agent_id": bridge.config["agent_id"],
                "project_id": bridge.config["project_id"], "channel_ids": bridge.config["channel_ids"],
                "runtime": bridge.config["runtime"], "visible_other_agents": participants,
                "messages_sent": 0, "models_started": False}
    finally:
        bridge.close()


def main(argv=None, *, bundle=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", choices=("codex", "claude"), help="first launch uses invitation selection, or installed Codex then Claude for auto; later launches reuse the binding")
    parser.add_argument("--workspace", help="existing code directory; default: this private bundle's workspace directory")
    parser.add_argument("--check", action="store_true", help="prepare/verify local configuration and workspace skill, and read server grants; do not start a model or send messages")
    args = parser.parse_args(argv)
    os.umask(0o077)
    directory = Path(bundle).resolve() if bundle is not None else Path(__file__).resolve().parent
    try:
        _profile, config_path, launcher = prepare(directory, args)
        documents = read_guidance(directory)
        result = check_access(config_path, documents)
        skill_path = install_skill(config_path, documents)
        result.update({"skill_path": str(skill_path), "skill_ready": True})
        if args.check:
            print(json.dumps(result, ensure_ascii=False))
            return 0
        print("Agent Mesh access verified; workspace skill and guide prepared. Starting your normal CLI with this bundle's MCP, hooks and initial coordination prompt.", file=sys.stderr)
        os.execv(sys.executable, [sys.executable, "-B", str(launcher), "run", "--config", str(config_path), "--", documents["PROMPT.md"]])
    except SetupError as error:
        print(str(error), file=sys.stderr)
        return 2
    except Exception as error:
        # Never print reflected server/provider output or credential-bearing values.
        print(json.dumps({"connected": False, "error_category": type(error).__name__,
                          "message": "Setup or verified HTTPS access failed; check the supplied private files, CA, network and grants."}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
