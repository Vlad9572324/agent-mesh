#!/usr/bin/env python3
"""Prepare new private Compose state; never start Docker or modify old state.

For a local rootful Docker daemon without user-namespace remapping on Linux.
Run as the ordinary operator whose UID/GID should own all persistent files.
Requires Python 3.10+ and OpenSSL. No installation, sudo or chown is performed.
"""

import argparse
import ipaddress
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys


REPO = Path(__file__).resolve().parents[2]
SAFE_PATH = re.compile(r"/[A-Za-z0-9_./-]+\Z")
IMAGE = re.compile(r"[a-z0-9][a-z0-9._:/-]*(?:@sha256:[0-9a-f]{64}|:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})\Z")


class PrepareError(ValueError):
    """A preparation precondition failed without changing existing data."""


def canonical_path(value):
    path = Path(value)
    if (not path.is_absolute() or not SAFE_PATH.fullmatch(str(value))
            or str(path) != str(value) or path.resolve() != path):
        raise PrepareError("paths must be absolute, canonical, symlink-free and use only letters, digits, /._-")
    return path


def read_input(value, private=False):
    path = canonical_path(value)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 1024 * 1024:
        raise PrepareError("TLS inputs must be bounded, nonempty regular files")
    if private and (info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise PrepareError("TLS private key must be owned by the operator and mode 0600 or stricter")
    return path, path.read_bytes()


def openssl(*args):
    result = subprocess.run(["openssl", *args], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    if result.returncode:
        raise PrepareError("OpenSSL rejected TLS input; require a valid certificate and matching unencrypted key")
    return result.stdout


def write_private(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(content)


def prepare(state, image, cert, key, bind_ip="127.0.0.1", port=8766):
    if sys.platform != "linux" or os.getuid() == 0 or os.getgid() == 0:
        raise PrepareError("prepare as an ordinary nonroot Linux operator (nonzero UID and GID)")
    state = canonical_path(state)
    if (state == Path("/") or state.exists() or state.is_symlink()
            or not state.parent.is_dir() or state.is_relative_to(REPO)):
        raise PrepareError("state must be a new directory outside the checkout with an existing parent")
    if not IMAGE.fullmatch(image) or image.rsplit(":", 1)[-1] == "latest":
        raise PrepareError("image must have an explicit non-latest tag or sha256 digest")
    try:
        address = ipaddress.IPv4Address(bind_ip)
    except ipaddress.AddressValueError as error:
        raise PrepareError("bind IP must be a numeric IPv4 address") from error
    if address.is_multicast or int(address) == 0xFFFFFFFF:
        raise PrepareError("bind IP must identify a local interface, loopback or 0.0.0.0")
    if type(port) is not int or not 1024 <= port <= 65535:
        raise PrepareError("port must be an unprivileged TCP port (1024 through 65535)")
    cert_path, cert_data = read_input(cert)
    key_path, key_data = read_input(key, private=True)
    openssl("x509", "-in", str(cert_path), "-noout", "-checkend", "0")
    if openssl("x509", "-in", str(cert_path), "-pubkey", "-noout") != openssl(
            "pkey", "-in", str(key_path), "-pubout"):
        raise PrepareError("TLS certificate and key do not match")
    # No existing resource is modified. An interrupted preparation is retained
    # for inspection; the helper never deletes or reuses a partially made state.
    state.mkdir(mode=0o700)
    (state / "pgdata").mkdir(mode=0o700)
    (state / "owner").mkdir(mode=0o700)
    app_password = secrets.token_hex(32)
    write_private(state / "app-password", (app_password + "\n").encode())
    write_private(state / "postgres-password", (secrets.token_hex(32) + "\n").encode())
    write_private(state / "database-url", (
        "postgresql://agent_mesh:" + app_password + "@db:5432/agent_mesh?sslmode=disable\n").encode())
    write_private(state / "server.crt", cert_data)
    write_private(state / "server.key", key_data)
    config = (f"AGENT_MESH_STATE={state}\nAGENT_MESH_IMAGE={image}\n"
              f"AGENT_MESH_UID={os.getuid()}\nAGENT_MESH_GID={os.getgid()}\n"
              f"AGENT_MESH_BIND_IP={address}\nAGENT_MESH_PORT={port}\n")
    write_private(state / "compose.env", config.encode())
    return state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, help="absolute new private directory outside the checkout")
    parser.add_argument("--image", required=True, help="explicit version/commit tag or digest, never latest")
    parser.add_argument("--tls-cert", required=True, help="absolute leaf-first certificate/chain PEM path")
    parser.add_argument("--tls-key", required=True, help="absolute operator-owned private key PEM, mode 0600")
    parser.add_argument("--bind-ip", default="127.0.0.1", help="numeric host IPv4; loopback by default")
    parser.add_argument("--port", type=int, default=8766, help="unprivileged host HTTPS port")
    args = parser.parse_args(argv)
    try:
        prepare(args.state, args.image, args.tls_cert, args.tls_key, args.bind_ip, args.port)
    except (PrepareError, OSError, subprocess.SubprocessError) as error:
        # Never print input contents, environment, password values or OpenSSL diagnostics.
        print("Compose preparation refused: " + str(error), file=sys.stderr)
        return 1
    print("Prepared private Compose state; no containers were started and no owner was created.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
