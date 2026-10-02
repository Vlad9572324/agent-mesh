#!/usr/bin/env python3
"""Validate trusted release archives in a disposable, local-only test schema.

Never launches a provider/model, reads CLI authentication, or touches a deployment.
All child output is captured, and the sole public report contains booleans/counts.
Checksums establish consistency, not authenticity: obtain releases from a trusted
source. Requires Python 3.10+, Linux amd64, psql, and an existing dedicated test DB.
"""
import argparse
import hashlib
import http.client
import io
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import uuid


SERVER_FILES = frozenset({"bin/agent-mesh", "web/index.html", "web/app.js", "web/app.css",
                          "INSTALL.md", "THIRD_PARTY_NOTICES.md", "RELEASE.json"})
CONNECTOR_FILES = frozenset({"scripts/agent-link-cli.py", "scripts/native_launch.py",
                             "scripts/agent-link-hook.py", "scripts/agent-link-mcp.py",
                             "adapters/native_bridge.py", "adapters/native_hooks.py",
                             "adapters/native_mcp.py", "INSTALL.md", "THIRD_PARTY_NOTICES.md", "RELEASE.json"})
VERSION_RE = r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?"
SCHEMA_RE = r"release_smoke_[0-9a-f]{32}"
MAX_ARCHIVE = 128 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
MAX_RESPONSE = 8 * 1024 * 1024


class SmokeError(Exception):
    """Only static, non-sensitive messages belong in this exception."""


def require(condition, reason):
    if not condition:
        raise SmokeError(reason)


def read_regular(path, limit, *, private=False):
    """No symlink following, bounded reads, and no filenames in diagnostics."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, "regular bounded file required")
        if private:
            require(info.st_uid == os.getuid() and not info.st_mode & 0o077, "private owned file required")
        data = stream.read(limit + 1)
    require(len(data) <= limit, "file size boundary")
    return data


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate JSON field")
            result[key] = value
        return result
    def invalid(_value):
        raise SmokeError("non-finite JSON value")
    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid)


def verify_inputs(server, connectors, checksums):
    """Hash in-memory snapshots; extraction never reopens mutable input paths."""
    require(server.name != connectors.name, "distinct archive names required")
    expected = {server.name, connectors.name, "RELEASE.json"}
    hashes = {}
    for line in read_regular(checksums, 16384).decode("ascii").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9_.-]+)", line)
        require(match is not None, "invalid checksum record")
        digest, name = match.groups()
        require(name not in hashes and name in expected, "unexpected or duplicate checksum")
        hashes[name] = digest
    require(set(hashes) == expected, "missing checksum")
    values = {}
    for path in (server, connectors, checksums.parent / "RELEASE.json"):
        raw = read_regular(path, 65536 if path.name == "RELEASE.json" else MAX_ARCHIVE)
        require(hashlib.sha256(raw).hexdigest() == hashes[path.name], "checksum mismatch")
        values[path.name] = raw
    return values


def extract_archive(raw, filename, kind, destination):
    suffix = "linux_amd64" if kind == "server" else "connectors"
    match = re.fullmatch(r"agent-mesh_(" + VERSION_RE + r")_" + suffix + r"\.tar\.gz", filename)
    require(match is not None, "unexpected archive filename")
    root_name = filename[:-7]
    allowed = SERVER_FILES if kind == "server" else CONNECTOR_FILES
    members = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            # Reject aliases rather than silently normalizing ./, // or dot-dot.
            require(not path.is_absolute() and str(path) == member.name and
                    ".." not in path.parts and "\\" not in member.name, "unsafe archive path")
            require(len(path.parts) >= 2 and path.parts[0] == root_name, "archive root mismatch")
            relative = str(PurePosixPath(*path.parts[1:]))
            require(relative in allowed and relative not in members, "unexpected or duplicate member")
            require(member.isreg() and not member.issparse() and member.size <= MAX_FILE and
                    member.size >= 0 and not member.mode & 0o7000, "unsafe archive member")
            total += member.size
            require(total <= MAX_ARCHIVE, "archive size boundary")
            stream = archive.extractfile(member)
            require(stream is not None, "missing archive content")
            with stream:
                data = stream.read(MAX_FILE + 1)
            require(len(data) == member.size, "archive content size mismatch")
            members[relative] = data
        require(set(members) == allowed, "incomplete archive")
    root = destination / root_name
    root.mkdir(mode=0o700)
    for relative, data in members.items():
        path = root / relative
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write_private(path, data)
        if relative == "bin/agent-mesh":
            path.chmod(0o700)
    return root, match.group(1)


def validate_metadata(raw, version):
    value = strict_json(raw)
    require(isinstance(value, dict) and value.get("schema_version") == 1 and
            value.get("packaging_version") == 1 and value.get("version") == version,
            "release metadata mismatch")
    require(re.fullmatch(r"[0-9a-f]{40}", value.get("source_commit", "")) is not None,
            "release commit required")
    require(type(value.get("source_date_epoch")) is int and value["source_date_epoch"] > 0,
            "release timestamp required")
    require(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value.get("build_date", ""))
            is not None, "release build date required")
    require(value.get("target") == {"goos": "linux", "goarch": "amd64"} and
            re.fullmatch(r"go[0-9]+\.[0-9]+(?:\.[0-9]+)?", value.get("builder_version", ""))
            is not None, "release target required")
    return value


def parse_test_dsn(raw):
    """Normalize a small URL subset; never let libpq/pgx resolve other hosts."""
    require(isinstance(raw, str) and 0 < len(raw) <= 16384 and
            not any(ord(char) < 32 for char in raw), "invalid database URL")
    parsed = urllib.parse.urlsplit(raw)
    require(parsed.scheme in {"postgresql", "postgres"} and not parsed.fragment, "database URL required")
    params = {}
    for key, value in (urllib.parse.parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
                       if parsed.query else []):
        require(key in {"host", "port", "user", "password", "sslmode", "connect_timeout"} and
                key not in params, "unsafe database URL parameter")
        params[key] = value
    database = urllib.parse.unquote(parsed.path)
    require(database in {"/agentlink_test", "/agent_link_test"}, "dedicated test database required")
    host = urllib.parse.unquote(parsed.hostname or "")
    require(not (host and "host" in params), "ambiguous database host")
    host = params.get("host", host)
    if host.startswith("/"):
        require(str(PurePosixPath(host)) == host and ".." not in PurePosixPath(host).parts and
                not any(char in host for char in "\\,\x00\n\r"), "invalid Unix socket host")
    else:
        require("%" not in host and ipaddress.ip_address(host).is_loopback, "numeric loopback required")
    require(not (parsed.port is not None and "port" in params), "ambiguous database port")
    port = params.get("port", str(parsed.port if parsed.port is not None else 5432))
    require(re.fullmatch(r"[0-9]{1,5}", port) is not None and 1 <= int(port) <= 65535,
            "invalid database port")
    require(not (parsed.username is not None and "user" in params) and
            not (parsed.password is not None and "password" in params), "ambiguous database identity")
    user = params.get("user", urllib.parse.unquote(parsed.username or ""))
    password = params.get("password", urllib.parse.unquote(parsed.password or ""))
    require(user and not any(ord(char) < 32 for char in host + user + password), "explicit database user required")
    sslmode = params.get("sslmode", "prefer")
    require(sslmode in {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"},
            "invalid database TLS mode")
    return {"host": host, "port": str(int(port)), "database": database[1:],
            "user": user, "password": password, "sslmode": sslmode}


def scoped_dsn(config, schema):
    require(re.fullmatch(SCHEMA_RE, schema) is not None, "owned schema required")
    query = {key: config[key] for key in ("host", "port", "user", "password", "sslmode")}
    query.update(connect_timeout="5", options="-csearch_path=" + schema)
    return "postgresql:///" + config["database"] + "?" + urllib.parse.urlencode(query)


def child_environment(directory):
    # A new HOME and empty passfile prevent implicit user credentials/config reads.
    result = {"PATH": os.environ.get("PATH", os.defpath), "HOME": str(directory),
              "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PYTHONNOUSERSITE": "1",
              "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": "",
              "PGPASSFILE": str(directory / "empty.pgpass")}
    if "LD_LIBRARY_PATH" in os.environ:
        result["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
    return result


class Smoke:
    def __init__(self, directory, psql="psql"):
        self.directory = directory
        self.cwd = directory / "unrelated-cwd"
        self.cwd.mkdir(mode=0o700)
        self.home = directory / "private-home"
        self.home.mkdir(mode=0o700)
        write_private(self.home / "empty.pgpass", b"")
        self.env = child_environment(self.home)
        self.psql = psql
        self.config = None
        self.schema = "release_smoke_" + uuid.uuid4().hex
        self.owner_marker = "release-smoke-owner:" + uuid.uuid4().hex
        self.schema_attempted = False
        self.server = None
        self.port = None
        self.report = {"success": False, "checksums_verified": 0, "extracted_files": 0,
                       "version_verified": False, "connector_help_checks": 0,
                       "connector_imports": 0, "database_isolated": False,
                       "health_verified": False, "web_assets_verified": 0,
                       "unauthenticated_denials": 0, "owner_authenticated": False,
                       "empty_projects_verified": False, "owned_process_stopped": True,
                       "owned_schema_removed": True, "temporary_files_removed": False}

    def command(self, argv, *, env=None, data=None, timeout=30):
        result = subprocess.run(argv, cwd=self.cwd, env=self.env if env is None else env,
                                input=data, stdin=subprocess.DEVNULL if data is None else None,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
        require(result.returncode == 0, "child command failed")
        return result.stdout

    def sql(self, query):
        require(self.config is not None, "validated database required")
        env = dict(self.env)
        for field in ("host", "port", "database", "user", "password", "sslmode"):
            env["PG" + field.upper()] = self.config[field]
        env.update(PGCONNECT_TIMEOUT="5", PGOPTIONS="-csearch_path=pg_catalog -cstatement_timeout=10000")
        return self.command([self.psql, "-X", "-qAt", "-w", "-v", "ON_ERROR_STOP=1"],
                            env=env, data=query.encode(), timeout=20).strip()

    def packages(self, args):
        require(platform.system() == "Linux" and platform.machine() in {"x86_64", "amd64"},
                "Linux amd64 smoke host required")
        values = verify_inputs(args.server, args.connectors, args.checksums)
        self.report["checksums_verified"] = 3
        server, version = extract_archive(values[args.server.name], args.server.name, "server", self.directory)
        connectors, other_version = extract_archive(values[args.connectors.name], args.connectors.name,
                                                    "connectors", self.directory)
        require(version == other_version, "archive version mismatch")
        for root in (server, connectors):
            require(read_regular(root / "RELEASE.json", 65536) == values["RELEASE.json"],
                    "archive metadata differs")
        self.metadata = validate_metadata(values["RELEASE.json"], version)
        self.report["extracted_files"] = len(SERVER_FILES) + len(CONNECTOR_FILES)
        self.binary = server / "bin/agent-mesh"
        self.web = server / "web"
        info = strict_json(self.command([str(self.binary), "version"]))
        require(isinstance(info, dict) and info.get("version") == version and
                info.get("commit") == self.metadata["source_commit"] and
                info.get("build_date") == self.metadata["build_date"] and
                info.get("go_version") == self.metadata["builder_version"] and
                info.get("goos") == "linux" and info.get("goarch") == "amd64", "binary identity mismatch")
        self.report["version_verified"] = True
        for name in ("agent-link-cli.py", "agent-link-hook.py", "agent-link-mcp.py"):
            output = self.command([sys.executable, "-E", "-s", "-B", str(connectors / "scripts" / name), "--help"])
            require(b"usage:" in output.lower(), "connector help missing")
            self.report["connector_help_checks"] += 1
        # Explicitly load only packaged modules, never installed or checkout copies.
        code = ("import importlib,pathlib,sys; root=pathlib.Path(sys.argv[1]); "
                "sys.path[:0]=[str(root/'scripts'),str(root/'adapters')]; "
                "names=('native_launch','native_bridge','native_hooks','native_mcp'); "
                "mods=[importlib.import_module(name) for name in names]; "
                "assert all(pathlib.Path(m.__file__).resolve().is_relative_to(root) for m in mods)")
        self.command([sys.executable, "-I", "-B", "-c", code, str(connectors)])
        self.report["connector_imports"] = 4

    def setup_database(self, source):
        self.config = parse_test_dsn(read_regular(source, 16384, private=True).decode("utf-8").strip())
        require(self.sql("SELECT current_database();") == self.config["database"].encode(),
                "database identity mismatch")
        require(re.fullmatch(SCHEMA_RE, self.schema) is not None and
                re.fullmatch(r"release-smoke-owner:[0-9a-f]{32}", self.owner_marker) is not None,
                "owned schema identity required")
        # A transaction-scoped ownership marker makes cleanup safe even when a
        # connection disappears after COMMIT but before the success response.
        self.schema_attempted = True
        self.report["owned_schema_removed"] = False
        self.sql(f'BEGIN; CREATE SCHEMA "{self.schema}"; COMMENT ON SCHEMA "{self.schema}" '
                 f"IS '{self.owner_marker}'; COMMIT;")
        self.dsn_file = self.directory / "database-url.private"
        write_private(self.dsn_file, (scoped_dsn(self.config, self.schema) + "\n").encode())
        self.owner_id = "release-smoke-" + uuid.uuid4().hex
        key_file = self.directory / "owner.private.json"
        self.command([str(self.binary), "bootstrap-owner", "--database-url-file", str(self.dsn_file),
                      "--owner-id", self.owner_id, "--owner-name", "Release smoke owner",
                      "--key-out", str(key_file)])
        credential = strict_json(read_regular(key_file, 4096, private=True))
        require(isinstance(credential, dict) and credential.get("agent_id") == self.owner_id and
                re.fullmatch(r"[0-9a-f]{64}", credential.get("key", "")) is not None,
                "private owner credential required")
        self.owner_key = credential["key"]
        # The newly created principal must actually reside in our schema.
        query = f'SELECT count(*) FROM "{self.schema}".principals WHERE id=\'{self.owner_id}\' AND kind=\'owner\';'
        require(self.sql(query) == b"1", "bootstrap schema isolation failed")
        self.report["database_isolated"] = True

    def request(self, path, *, authenticated=False):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            headers = {"Authorization": "Bearer " + self.owner_key} if authenticated else {}
            connection.request("GET", path, headers=headers)
            response = connection.getresponse()
            data = response.read(MAX_RESPONSE + 1)
            require(len(data) <= MAX_RESPONSE, "HTTP response size boundary")
            return response.status, data
        finally:
            connection.close()

    def check_http(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.server = subprocess.Popen([str(self.binary), "serve", "--database-url-file", str(self.dsn_file),
                        "--listen", "127.0.0.1:" + str(self.port), "--web-dir", str(self.web)],
                        cwd=self.cwd, env=self.env, stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.report["owned_process_stopped"] = False
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            require(self.server.poll() is None, "owned server exited")
            try:
                status, data = self.request("/healthz")
                if status == 200 and strict_json(data) == {"status": "ok"}:
                    self.report["health_verified"] = True
                    break
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(0.1)
        require(self.report["health_verified"], "owned server readiness timeout")
        for filename, route in (("index.html", "/"), ("app.js", "/app.js"), ("app.css", "/app.css")):
            status, actual = self.request(route)
            expected = read_regular(self.web / filename, MAX_RESPONSE)
            require(status == 200 and actual == expected and
                    hashlib.sha256(actual).digest() == hashlib.sha256(expected).digest(), "web asset mismatch")
            self.report["web_assets_verified"] += 1
        for route in ("/v1/me", "/v1/projects"):
            status, _data = self.request(route)
            require(status == 401, "anonymous API access accepted")
            self.report["unauthenticated_denials"] += 1
        status, data = self.request("/v1/me", authenticated=True)
        value = strict_json(data)
        require(status == 200 and isinstance(value, dict) and
                value.get("agent", {}).get("id") == self.owner_id and
                value["agent"].get("kind") == "owner", "owner authentication failed")
        self.report["owner_authenticated"] = True
        status, data = self.request("/v1/projects", authenticated=True)
        require(status == 200 and strict_json(data) == {"projects": []}, "fresh schema projects not empty")
        require(self.server.poll() is None, "owned server exited")
        self.report["empty_projects_verified"] = True

    def cleanup(self):
        if self.server is not None:
            try:
                if self.server.poll() is None:
                    self.server.terminate()
                    try:
                        self.server.wait(timeout=7)
                    except subprocess.TimeoutExpired:
                        self.server.kill()
                        self.server.wait(timeout=5)
                self.report["owned_process_stopped"] = self.server.poll() is not None
            except (OSError, subprocess.SubprocessError):
                self.report["owned_process_stopped"] = False
        if self.schema_attempted:
            try:
                require(re.fullmatch(SCHEMA_RE, self.schema) is not None and
                        re.fullmatch(r"release-smoke-owner:[0-9a-f]{32}", self.owner_marker) is not None,
                        "owned cleanup identity required")
                predicate = (f"nspname='{self.schema}' AND "
                             f"obj_description(oid,'pg_namespace')='{self.owner_marker}'")
                # Never drop a same-named schema without our unguessable marker.
                query = (f"DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_namespace WHERE {predicate}) THEN "
                         f'EXECUTE \'DROP SCHEMA "{self.schema}" CASCADE\'; END IF; END $$; '
                         f"SELECT count(*) FROM pg_namespace WHERE {predicate};")
                self.report["owned_schema_removed"] = self.sql(query) == b"0"
            except Exception:
                self.report["owned_schema_removed"] = False
        return self.report["owned_process_stopped"] and self.report["owned_schema_removed"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True, type=Path)
    parser.add_argument("--connectors", required=True, type=Path)
    parser.add_argument("--checksums", required=True, type=Path)
    parser.add_argument("--database-url-file", required=True, type=Path)
    parser.add_argument("--psql", default="psql", help="psql executable (default: PATH)")
    args = parser.parse_args(argv)
    for name in ("server", "connectors", "checksums", "database_url_file"):
        setattr(args, name, getattr(args, name).absolute())
    if "/" in args.psql:
        args.psql = str(Path(args.psql).absolute())
    def interrupted(_number, _frame):
        raise InterruptedError("smoke interrupted")
    previous = {number: signal.signal(number, interrupted) for number in (signal.SIGINT, signal.SIGTERM)}
    smoke = None
    passed = False
    cleaned = False
    temporary = None
    try:
        temporary = tempfile.TemporaryDirectory(prefix="agent-mesh-release-smoke-")
        smoke = Smoke(Path(temporary.name), args.psql)
        smoke.packages(args)
        smoke.setup_database(args.database_url_file)
        smoke.check_http()
        passed = True
    except (Exception, KeyboardInterrupt):
        # Do not print exceptions, subprocess output, credentials, URLs or paths.
        passed = False
    finally:
        try:
            cleaned = smoke.cleanup() if smoke is not None else True
        finally:
            try:
                if temporary is not None:
                    temporary.cleanup()
                if smoke is not None:
                    smoke.report["temporary_files_removed"] = True
            except Exception:
                cleaned = False
            finally:
                for number, handler in previous.items():
                    signal.signal(number, handler)
    report = smoke.report if smoke is not None else {"success": False}
    report["success"] = passed and cleaned
    print(json.dumps(report, sort_keys=True))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
