"""Pinned one-use invitation installer; embedded in the static Bash bootstrap."""
import argparse
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import uuid
from urllib.parse import urlsplit


PACKAGE_PATHS = __PACKAGE_PATHS_JSON__
MAXIMUM = 8 << 20


class InstallError(ValueError):
    pass


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise InstallError("Package JSON has duplicate fields.")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(InstallError("Invalid package JSON.")))


def validate_connection(origin, pin, token):
    parsed = urlsplit(origin)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment or len(origin) > 2048
            or any(c.isspace() for c in origin)):
        raise InstallError("The invitation must use a complete HTTPS origin without credentials or paths.")
    try:
        if not pin.startswith("sha256//") or len(base64.b64decode(pin[8:], validate=True)) != 32:
            raise ValueError()
    except ValueError:
        raise InstallError("The invitation has an invalid TLS public-key pin.") from None
    if re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token) is None:
        raise InstallError("The invitation token is malformed.")


def destination(value):
    path = Path(value).expanduser() if value else Path.home() / ".local/share/agent-mesh/connections" / ("connection-" + uuid.uuid4().hex)
    if not path.is_absolute() or ".." in path.parts or path == Path(path.anchor):
        raise InstallError("The installation directory must be an absolute new directory.")
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise InstallError("The installation path must not contain symlinks.")
    if path.exists():
        raise InstallError("The installation directory already exists; refusing to overwrite it.")
    if value and not path.parent.is_dir():
        raise InstallError("The explicit installation parent must already exist.")
    if not value:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.mkdir(mode=0o700)  # Exclusive reservation before consuming the invitation.
    return path


def redeem(origin, pin, token):
    # The invitation is in the POST body, never in a URL or curl argument. Do not
    # retry: after a lost response the server may already have consumed it.
    command = ["curl", "--disable", "--silent", "--fail", "--insecure", "--noproxy", "*",
               "--proto", "=https", "--pinnedpubkey", pin, "--connect-timeout", "10", "--max-time", "45",
               "--max-filesize", str(MAXIMUM), "--request", "POST", "--header", "Content-Type: application/json",
               "--data-binary", "@-", origin + "/connect/redeem"]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        process.stdin.write(json.dumps({"token": token}).encode("ascii"))
        process.stdin.close()
        data = process.stdout.read(MAXIMUM + 1)
        if len(data) > MAXIMUM:
            raise InstallError("The invitation response exceeded the package limit.")
        if process.wait(timeout=50) != 0 or not data:
            raise InstallError("Invitation download failed or its result is uncertain. Do not retry automatically; ask the owner to revoke the agent key and issue a new invitation.")
        return data
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
        if not process.stdin.closed:
            process.stdin.close()


def unpack(data, origin):
    if len(data) > MAXIMUM:
        raise InstallError("The package exceeded the size limit.")
    allowed = set(PACKAGE_PATHS) | {"MANIFEST.json"}
    files, total = {}, 0
    # Bound the complete decoded tar before interpreting special/long headers.
    # No extract/extractall or untrusted tar paths are used.
    maximum_tar = MAXIMUM + len(allowed) * 1024 + 10240
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
        decoded = compressed.read(maximum_tar + 1)
    if len(decoded) > maximum_tar:
        raise InstallError("The decoded archive exceeded the size limit.")
    with tarfile.open(fileobj=io.BytesIO(decoded), mode="r:") as archive:
        for member in archive:
            if (member.name not in allowed or member.name in files or not member.isfile()
                    or member.pax_headers or member.linkname or member.offset_data - member.offset != 512
                    or member.size < 0 or member.size > MAXIMUM):
                raise InstallError("The package contains an unexpected file or archive entry.")
            total += member.size
            if total > MAXIMUM:
                raise InstallError("The unpacked package exceeded the size limit.")
            stream = archive.extractfile(member)
            content = stream.read(member.size + 1)
            if len(content) != member.size:
                raise InstallError("The package has a truncated file.")
            files[member.name] = content
    if set(files) != allowed:
        raise InstallError("The package is missing required files.")
    manifest_bytes = files.pop("MANIFEST.json")
    manifest = strict_json(manifest_bytes)
    if (type(manifest) is not dict or set(manifest) != {"version", "files"}
            or type(manifest["version"]) is not int or manifest["version"] != 1
            or type(manifest["files"]) is not dict or set(manifest["files"]) != set(files)):
        raise InstallError("The package manifest has an invalid file set.")
    for name, content in files.items():
        metadata = manifest["files"][name]
        if (type(metadata) is not dict or set(metadata) != {"sha256", "size"}
                or type(metadata["size"]) is not int or metadata["size"] != len(content)
                or metadata["sha256"] != hashlib.sha256(content).hexdigest()):
            raise InstallError("The package failed its integrity check.")
    profile = strict_json(files["profile.json"])
    if type(profile) is not dict or profile.get("url") != origin or profile.get("connector_dir") != "connectors":
        raise InstallError("The package does not match the trusted invitation origin.")
    if re.fullmatch(rb"[0-9a-f]{64}\n?", files["agent.key"]) is None:
        raise InstallError("The package has an invalid agent key.")
    files["MANIFEST.json"] = manifest_bytes
    return files


def write_files(path, files):
    for name, content in sorted(files.items()):
        target = path / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin")
    parser.add_argument("pin")
    parser.add_argument("token")
    parser.add_argument("--install-dir", help="new private directory; default: ~/.local/share/agent-mesh/connections/connection-<random>")
    parser.add_argument("--runtime", choices=("codex", "claude"))
    parser.add_argument("--workspace", help="existing workspace outside the private installation; default is empty")
    parser.add_argument("--check", action="store_true", help="install and verify access without starting a model or sending messages")
    args = parser.parse_args(argv)
    path, tty = None, None
    try:
        if sys.version_info < (3, 10) or not shutil.which("curl"):
            raise InstallError("Python 3.10 or newer and curl are required.")
        os.umask(0o077)
        validate_connection(args.origin, args.pin, args.token)
        if not args.check:
            try:
                tty = os.open("/dev/tty", os.O_RDWR)
            except OSError:
                raise InstallError("Normal startup requires an interactive terminal. Use --check --runtime codex (or claude) for a connection-only installation.") from None
        path = destination(args.install_dir)
        files = unpack(redeem(args.origin, args.pin, args.token), args.origin)
        args.token = None
        write_files(path, files)
        command = [sys.executable, "-B", str(path / "connect.py")]
        for flag, value in (("--runtime", args.runtime), ("--workspace", args.workspace)):
            if value:
                command += [flag, value]
        print("Agent Mesh installed. Reconnect with: " + shlex.join(command), file=sys.stderr, flush=True)
        if args.check:
            command.append("--check")
        else:
            for descriptor in (0, 1, 2):
                os.dup2(tty, descriptor)
            os.close(tty)
            tty = None
        os.execv(sys.executable, command)
        return 0
    except InstallError as error:
        print(str(error), file=sys.stderr)
        return 2
    except Exception:
        print("Installation failed. If redemption began, its outcome may be uncertain; ask the owner to revoke the agent key and issue a new invitation. No automatic retry was attempted.", file=sys.stderr)
        return 2
    finally:
        if tty is not None:
            os.close(tty)
        if path is not None:
            try:
                path.rmdir()  # Remove only our empty reservation, never user files.
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
