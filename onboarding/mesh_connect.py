#!/usr/bin/env python3
"""Launch an installed attended Agent Mesh CLI connection."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys


MARKER = "agent-mesh-client-v1"


class ClientError(ValueError):
    pass


def private_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 32768:
            raise ClientError("The connection registration is not a private owned file.")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return json.loads(stream.read(32769))
    finally:
        os.close(fd)


def registrations(home):
    root = home / ".local/share/agent-mesh/client/connections"
    if not root.is_dir() or root.is_symlink():
        return []
    result = []
    for path in sorted(root.glob("*.json")):
        try:
            item = private_json(path)
            if (type(item) is dict and set(item) == {"version", "agent_id", "runtime", "bundle"}
                    and item["version"] == 1 and item["runtime"] in ("codex", "claude")
                    and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", item["agent_id"])
                    and Path(item["bundle"]).is_absolute()):
                result.append(item)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return result


def session_name(agent_id):
    """Return a readable, collision-resistant tmux session name."""
    prefix = re.sub(r"[^A-Za-z0-9_-]", "-", agent_id)[:48].strip("-") or "agent"
    digest = hashlib.sha256(agent_id.encode("utf-8")).hexdigest()[:10]
    return "mesh-%s-%s" % (prefix, digest)


def tmux_run(tmux, *args, capture=False):
    return subprocess.run(
        [tmux, *args], check=False, text=True,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL)


def tmux_option(tmux, session, name):
    result = tmux_run(tmux, "show-options", "-v", "-t", session, name, capture=True)
    return result.stdout.strip() if result.returncode == 0 else None


def prepare_session(tmux, session, item, command):
    """Create or validate the dedicated attended session without touching global tmux state."""
    bundle_id = hashlib.sha256(str(Path(item["bundle"]).resolve()).encode("utf-8")).hexdigest()
    exists = tmux_run(tmux, "has-session", "-t", session).returncode == 0
    if exists:
        if (tmux_option(tmux, session, "@agent_mesh_agent") != item["agent_id"]
                or tmux_option(tmux, session, "@agent_mesh_bundle") != bundle_id):
            raise ClientError("The existing tmux session has a different Agent Mesh identity; run mesh-connect restart after reviewing it.")
        return
    try:
        size = os.get_terminal_size()
        columns, lines = max(size.columns, 100), max(size.lines, 30)
    except OSError:
        columns, lines = 120, 40
    created = tmux_run(tmux, "new-session", "-d", "-s", session, "-x", str(columns), "-y", str(lines), *command)
    if created.returncode != 0:
        raise ClientError("Could not create the dedicated tmux session.")
    settings = (
        ("set-option", "-t", session, "@agent_mesh_agent", item["agent_id"]),
        ("set-option", "-t", session, "@agent_mesh_bundle", bundle_id),
        ("set-window-option", "-t", session + ":0", "window-size", "manual"),
        ("resize-window", "-t", session + ":0", "-x", str(columns), "-y", str(lines)),
    )
    if any(tmux_run(tmux, *setting).returncode != 0 for setting in settings):
        tmux_run(tmux, "kill-session", "-t", session)
        raise ClientError("Could not secure the dedicated tmux session.")


def main(argv=None, *, home=None):
    parser = argparse.ArgumentParser(prog="mesh-connect", description=__doc__)
    parser.add_argument("runtime", choices=("codex", "claude"))
    parser.add_argument("--agent", help="agent ID when more than one installed connection uses this runtime")
    parser.add_argument("provider_args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    home = Path.home() if home is None else Path(home)
    matches = [item for item in registrations(home)
               if item["runtime"] == args.runtime and (args.agent is None or item["agent_id"] == args.agent)]
    if not matches:
        raise ClientError("No installed Agent Mesh connection matches this runtime/agent.")
    if len(matches) != 1:
        names = ", ".join(item["agent_id"] for item in matches)
        raise ClientError("Several connections match; choose one with --agent ID: " + names)
    item = matches[0]
    bundle = Path(item["bundle"])
    connect = bundle / "connect.py"
    config = bundle / "config.json"
    if bundle.is_symlink() or not connect.is_file() or connect.is_symlink() or not config.is_file() or config.is_symlink():
        raise ClientError("The registered private connection is incomplete or aliased.")
    tmux = shutil.which("tmux")
    if not tmux:
        raise ClientError("tmux is required for waking the attended CLI. Install it with: sudo apt-get install -y tmux")
    # Non-login SSH commands commonly omit the user's executable directory,
    # even though both supported CLIs install there. Keep provider discovery
    # consistent with an interactive shell without depending on shell startup
    # files or a specific operating system package manager.
    user_bin = str(home / ".local/bin")
    path = os.environ.get("PATH", "")
    if user_bin not in path.split(os.pathsep):
        os.environ["PATH"] = user_bin + (os.pathsep + path if path else "")
    command = [sys.executable, "-B", str(connect), "--doorbell", "--", *args.provider_args]
    session = session_name(item["agent_id"])
    prepare_session(tmux, session, item, command)
    if os.environ.get("TMUX"):
        os.execvp(tmux, [tmux, "switch-client", "-t", session])
    os.execvp(tmux, [tmux, "attach-session", "-d", "-t", session])


if __name__ == "__main__":
    try:
        main()
    except ClientError as error:
        print("mesh-connect: " + str(error), file=sys.stderr)
        raise SystemExit(2)
