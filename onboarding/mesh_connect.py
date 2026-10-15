#!/usr/bin/env python3
"""Launch an installed attended Agent Mesh CLI connection."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
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
    command = [sys.executable, "-B", str(connect), "--doorbell", "--", *args.provider_args]
    if os.environ.get("TMUX_PANE"):
        os.execv(sys.executable, command)
    session = "mesh-" + re.sub(r"[^A-Za-z0-9_-]", "-", item["agent_id"])[:80]
    os.execvp(tmux, [tmux, "new-session", "-A", "-s", session, *command])


if __name__ == "__main__":
    try:
        main()
    except ClientError as error:
        print("mesh-connect: " + str(error), file=sys.stderr)
        raise SystemExit(2)
