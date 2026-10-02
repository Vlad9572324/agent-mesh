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
    if workspace.is_symlink():
        raise SetupError("Use the real workspace directory, not a symlink.")
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


def read_prompt(bundle):
    from native_bridge import read_private
    prompt = read_private(bundle / "PROMPT.md", 32768).decode("utf-8")
    if not prompt.strip() or "\x00" in prompt:
        raise SetupError("The supplied initial prompt is empty or invalid.")
    return prompt


def check_access(config_path, prompt=None):
    from native_bridge import NativeBridge
    bridge = NativeBridge(config_path, "check-" + uuid.uuid4().hex, timeout=5)
    try:
        if prompt is not None:
            bridge.reject_secret(prompt)
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
    parser.add_argument("--check", action="store_true", help="prepare/verify local configuration and read server grants; do not start a model or send messages")
    args = parser.parse_args(argv)
    os.umask(0o077)
    directory = Path(bundle).resolve() if bundle is not None else Path(__file__).resolve().parent
    try:
        _profile, config_path, launcher = prepare(directory, args)
        prompt = None if args.check else read_prompt(directory)
        result = check_access(config_path, prompt)
        if args.check:
            print(json.dumps(result, ensure_ascii=False))
            return 0
        print("Agent Mesh access verified. Starting your normal CLI with this bundle's connector and initial coordination prompt.", file=sys.stderr)
        os.execv(sys.executable, [sys.executable, "-B", str(launcher), "run", "--config", str(config_path), "--", prompt])
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
