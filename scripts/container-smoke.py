#!/usr/bin/env python3
"""Build and exercise the real Compose stack on a disposable Linux Docker host.

No provider, deployment, existing database, or host credential is used. Requires
rootful local Docker/Compose, OpenSSL, and a non-root caller. All diagnostics are
static and all fixture secrets stay in a private temporary directory. This is a
live test, not part of ordinary offline unittest discovery.
"""
import argparse
import errno
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid


SPEC = importlib.util.spec_from_file_location("release_smoke", Path(__file__).with_name("smoke-release.py"))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
BUILD_SPEC = importlib.util.spec_from_file_location("release_builder", Path(__file__).with_name("build-release.py"))
builder = importlib.util.module_from_spec(BUILD_SPEC)
BUILD_SPEC.loader.exec_module(builder)
PROJECT_RE = r"amsmoke-[0-9a-f]{32}"


def require(condition, message):
    release.require(condition, message)


def release_version(value):
    # Share the offline builder's bounded canonical version contract rather than
    # accepting the archive reader's intentionally broader filename expression.
    try:
        return builder.validate_version(value)
    except builder.ReleaseError:
        raise release.SmokeError("canonical v-prefixed release version required") from None


def image_reference(value, version=None):
    tags = r"sha-[0-9a-f]{40}"
    if version is not None:
        tags += "|" + re.escape(release_version(version))
    require(re.fullmatch(r"(?:ghcr\.io/[a-z0-9_.-]+/[a-z0-9_.-]+|agent-mesh-ci):(?:" + tags + ")", value)
            is not None, "commit-qualified or matching release-version image reference required"
            if version is not None else "commit-qualified image reference required")
    return value


def transport_failure(error):
    """Finite categories only: never disclose an exception's URL or message."""
    for _ in range(4):
        if isinstance(error, urllib.error.URLError):
            error = error.reason
        else:
            break
    result = {"category": "other_transport_error"}
    if isinstance(error, ssl.SSLCertVerificationError):
        result["category"] = "certificate_verification"
        code = getattr(error, "verify_code", None)
        if type(code) is int and 0 <= code <= 999:
            result["verify_code"] = code
    elif isinstance(error, ssl.SSLError):
        result["category"] = "tls_error"
        reason = getattr(error, "reason", None)
        result["tls_reason"] = reason if reason in {
            "WRONG_VERSION_NUMBER", "CERTIFICATE_VERIFY_FAILED", "SSLV3_ALERT_HANDSHAKE_FAILURE",
            "TLSV1_ALERT_PROTOCOL_VERSION", "UNEXPECTED_EOF_WHILE_READING"} else "other_tls_error"
    elif isinstance(error, TimeoutError):
        result["category"] = "timeout"
    elif isinstance(error, ConnectionRefusedError):
        result["category"] = "connection_refused"
    elif isinstance(error, ConnectionResetError):
        result["category"] = "connection_reset"
    elif isinstance(error, OSError):
        result["category"] = "network_unreachable" if error.errno in {
            errno.EHOSTUNREACH, errno.ENETUNREACH} else "os_error"
    number = getattr(error, "errno", None)
    if type(number) is int and 0 <= number <= 4095:
        result["errno"] = number
    return result


def startup_categories(raw):
    """Classify captured fixture logs without returning any original bytes."""
    rules = {b"listener starting on": "listener_started", b"listener failed": "listener_failed",
             b"database unavailable": "database_unavailable",
             b"schema initialization failed": "schema_initialization_failed",
             b"cannot begin schema initialization": "schema_initialization_unavailable",
             b"cannot read database URL file": "database_file_unreadable",
             b"database URL file must be private": "database_file_permissions",
             b"password authentication failed": "database_authentication_failed",
             b"permission denied": "permission_denied", b"connection refused": "database_connection_refused",
             b"no such host": "database_dns_failed", b"failed to connect": "database_connection_failed",
             b"failed to load X509 key pair": "tls_key_pair_failed",
             b"database system is ready to accept connections": "database_ready",
             b"could not load": "database_load_failed"}
    return sorted({value for marker, value in rules.items() if marker in raw[:65536]})


def published_loopback(info, port):
    # HostConfig.PortBindings is only requested intent. NetworkSettings reflects
    # the real host publication, which internal-only networks can omit entirely.
    bindings = info.get("NetworkSettings", {}).get("Ports", {}).get("8766/tcp")
    return bindings == [{"HostIp": "127.0.0.1", "HostPort": str(port)}]


class Smoke:
    def __init__(self, directory, args):
        self.directory, self.args = directory, args
        self.project = "amsmoke-" + uuid.uuid4().hex
        self.state = directory / "state"
        self.home = directory / "home"
        self.home.mkdir(mode=0o700)
        self.env = release.child_environment(self.home)
        self.config = directory / "docker-config"
        self.config.mkdir(mode=0o700)
        self.docker = ["docker", "--host", "unix:///var/run/docker.sock", "--config", str(self.config)]
        self.compose_file = args.repository / "deploy/compose/compose.yaml"
        self.started = False
        self.docker_touched = False
        self.image_built = False
        self.report = {"success": False, "phase": "inputs", "checksums_verified": 0,
                       "connector_help_checks": 0, "connector_imports": 0,
                       "version_verified": False, "non_root_verified": False,
                       "postgresql14_verified": False, "application_role_unprivileged": False,
                       "https_verified": False, "web_assets_verified": 0,
                       "unauthenticated_denials": 0, "owner_authenticated": False,
                       "explicit_bootstrap_verified": False, "database_failure_verified": False,
                       "database_recovery_verified": False, "restart_persistence_verified": False,
                       "owned_containers_removed": False, "owned_networks_removed": False,
                       "owned_volumes_removed": False, "temporary_files_removed": False}

    def command(self, argv, *, timeout=60, data=None):
        operation = "child_command"
        if argv[:len(self.docker)] == self.docker:
            tail = argv[len(self.docker):]
            operation = "docker_" + tail[0] if tail[0] in {
                "info", "build", "create", "start", "image", "container", "network", "volume"} else "docker_command"
            if tail[0] == "compose":
                operation = "compose_command"
                for name in ("config", "up", "run", "exec", "stop", "start", "restart", "down", "ps"):
                    if name in tail:
                        operation = "compose_" + name
                        break
        elif argv[0] == "openssl":
            operation = "fixture_tls"
        elif argv[0] == sys.executable:
            operation = "connector_check" if argv[1] in {"-E", "-I"} else "prepare_state"
        self.report["operation"] = operation
        try:
            result = subprocess.run(argv, cwd=self.directory, env=self.env,
                                    input=data, stdin=subprocess.DEVNULL if data is None else None,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            self.report["child_timed_out"] = True
            raise
        if result.returncode != 0:
            self.report.setdefault("child_exit_code", result.returncode)
        require(result.returncode == 0, "child command failed")
        return result.stdout

    def compose(self, *args, timeout=90):
        require(re.fullmatch(PROJECT_RE, self.project) is not None, "owned project required")
        return self.command(self.docker + ["compose", "--env-file", str(self.state / "compose.env"),
                            "--file", str(self.compose_file), "--project-name", self.project,
                            *args], timeout=timeout)

    def packages(self):
        require(re.fullmatch(r"[0-9a-f]{40}", self.args.expected_commit) is not None,
                "full expected source commit required")
        explicit_version = getattr(self.args, "version", None)
        version = ("v0.1.0-rc.2-container." + self.args.expected_commit[:12]
                   if explicit_version is None else release_version(explicit_version))
        image_reference(self.args.image, explicit_version)
        allowed_tags = {"sha-" + self.args.expected_commit}
        if explicit_version is not None:
            allowed_tags.add(version)
        require(self.args.image.rsplit(":", 1)[-1] in allowed_tags, "image commit mismatch")
        server = self.args.release_dir / ("agent-mesh_" + version + "_linux_amd64.tar.gz")
        connectors = self.args.release_dir / ("agent-mesh_" + version + "_connectors.tar.gz")
        values = release.verify_inputs(server, connectors, self.args.release_dir / "SHA256SUMS")
        self.bundle, found = release.extract_archive(values[server.name], server.name, "server", self.directory)
        require(found == version, "candidate version mismatch")
        connector_bundle, connector_version = release.extract_archive(
            values[connectors.name], connectors.name, "connectors", self.directory)
        require(connector_version == version, "connector version mismatch")
        self.metadata = release.validate_metadata(values["RELEASE.json"], version)
        require(self.metadata["source_commit"] == self.args.expected_commit and
                self.metadata["builder_version"] == "go1.23.6", "source or toolchain identity mismatch")
        require(release.read_regular(self.bundle / "RELEASE.json", 65536) == values["RELEASE.json"],
                "archive metadata mismatch")
        require(release.read_regular(connector_bundle / "RELEASE.json", 65536) == values["RELEASE.json"],
                "connector archive metadata mismatch")
        self.report["checksums_verified"] = 3
        self.check_version(self.command([str(self.bundle / "bin/agent-mesh"), "--version"]))
        # Exercise only packaged connector help and imports, from the independent
        # smoke cwd and allowlisted child environment. No provider or DB is used.
        for name in ("agent-link-cli.py", "agent-link-hook.py", "agent-link-mcp.py"):
            output = self.command([sys.executable, "-E", "-s", "-B",
                                   str(connector_bundle / "scripts" / name), "--help"])
            require(b"usage:" in output.lower(), "connector help missing")
            self.report["connector_help_checks"] += 1
        code = ("import importlib,pathlib,sys; root=pathlib.Path(sys.argv[1]); "
                "sys.path[:0]=[str(root/'scripts'),str(root/'adapters')]; "
                "names=('native_launch','native_bridge','native_hooks','native_mcp'); "
                "mods=[importlib.import_module(name) for name in names]; "
                "assert all(pathlib.Path(m.__file__).resolve().is_relative_to(root) for m in mods)")
        self.command([sys.executable, "-I", "-B", "-c", code, str(connector_bundle)])
        self.report["connector_imports"] = 4

    def check_version(self, raw):
        require(release.strict_json(raw) == {
            "version": self.metadata["version"], "commit": self.metadata["source_commit"],
            "build_date": self.metadata["build_date"], "go_version": self.metadata["builder_version"],
            "goos": "linux", "goarch": "amd64"}, "binary identity mismatch")

    def build(self):
        self.report["phase"] = "image"
        require(os.getuid() != 0 and os.getgid() != 0, "non-root smoke caller required")
        self.docker_touched = True
        info = release.strict_json(self.command(self.docker + ["info", "--format", "{{json .}} "]))
        require(info.get("OSType") == "linux" and info.get("Architecture") in {"x86_64", "amd64"}
                and not any("rootless" in item for item in info.get("SecurityOptions", [])),
                "rootful Linux amd64 local daemon required")
        self.command(self.docker + ["build", "--platform", "linux/amd64", "--network", "none",
                     "--file", str(self.args.repository / "Dockerfile"),
                     "--build-arg", "VERSION=" + self.metadata["version"],
                     "--build-arg", "REVISION=" + self.metadata["source_commit"],
                     "--build-arg", "CREATED=" + self.metadata["build_date"],
                     "--label", "org.opencontainers.image.source=https://github.com/" + self.args.source,
                     "--tag", self.args.image, str(self.bundle)], timeout=180)
        self.image_built = True
        image = release.strict_json(self.command(self.docker + ["image", "inspect", self.args.image]))[0]
        config = image["Config"]
        require(config["User"] == "10001:10001", "non-root default image identity required")
        for field, expected in (("version", self.metadata["version"]),
                                ("revision", self.metadata["source_commit"]),
                                ("created", self.metadata["build_date"]),
                                ("source", "https://github.com/" + self.args.source)):
            require(config["Labels"].get("org.opencontainers.image." + field) == expected,
                    "OCI identity mismatch")
        self.report["non_root_verified"] = True
        self.version_name = self.project + "-version"
        self.command(self.docker + ["create", "--name", self.version_name,
                     "--label", "com.docker.compose.project=" + self.project,
                     "--network", "none", self.args.image, "--version"])
        self.check_version(self.command(self.docker + ["start", "--attach", self.version_name]))
        self.command(self.docker + ["container", "rm", self.version_name])
        self.report["version_verified"] = True

    def prepare(self):
        self.report["phase"] = "prepare"
        self.cert = self.directory / "fixture.crt"
        key = self.directory / "fixture.key"
        self.command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
                      "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
                      "-keyout", str(key), "-out", str(self.cert)])
        key.chmod(0o600)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.command([sys.executable, "-B", str(self.args.repository / "deploy/compose/prepare.py"),
                      "--state", str(self.state), "--image", self.args.image,
                      "--tls-cert", str(self.cert), "--tls-key", str(key), "--port", str(self.port)])
        self.compose("config", "--quiet")
        # Mark before invoking up, because a failed command can leave partial resources.
        self.started = True
        self.compose("up", "--detach", "--wait", "--wait-timeout", "100", timeout=150)
        self.context = ssl.create_default_context(cafile=str(self.cert))
        app_id = self.compose("ps", "--quiet", "app").decode().strip()
        require(re.fullmatch(r"[0-9a-f]{12,64}", app_id) is not None, "owned app container required")
        app = release.strict_json(self.command(self.docker + ["container", "inspect", app_id]))[0]
        require(app["Config"]["User"] == str(os.getuid()) + ":" + str(os.getgid()) and
                app["Config"]["Labels"]["com.docker.compose.project"] == self.project,
                "non-root Compose identity mismatch")
        require(published_loopback(app, self.port), "actual loopback published port mapping required")
        self.report["published_port_verified"] = True

    def sql(self, query):
        # SQL and shell program are internal constants; credentials remain files
        # inside the owned fixture and are not arguments, diagnostics, or artifacts.
        return self.compose("exec", "--no-TTY", "db", "sh", "-c",
                            'export PGPASSWORD="$(cat /run/agent-mesh/app-password)"; '
                            'exec psql -X -qAt -h 127.0.0.1 -U agent_mesh -d agent_mesh '
                            '-v ON_ERROR_STOP=1 -c "$1"', "container-smoke", query).strip()

    def request(self, path, *, key=None):
        headers = {"Authorization": "Bearer " + key} if key else {}
        request = urllib.request.Request("https://127.0.0.1:" + str(self.port) + path, headers=headers)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                             urllib.request.HTTPSHandler(context=self.context))
        try:
            response = opener.open(request, timeout=4)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(release.MAX_RESPONSE + 1)
            require(len(data) <= release.MAX_RESPONSE, "response size boundary")
            return response.status, data

    def wait_health(self, wanted):
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                status, data = self.request("/healthz")
                self.report["last_health_status"] = status
                if status == wanted:
                    if wanted == 200:
                        require(release.strict_json(data) == {"status": "ok"}, "health body mismatch")
                    return
            except (OSError, urllib.error.URLError) as error:
                self.report["last_health_transport"] = transport_failure(error)
            time.sleep(0.5)
        raise release.SmokeError("health transition timed out")

    def diagnostics(self):
        """Inspect only owned fixtures before cleanup; no raw logs are emitted."""
        if not self.started or not re.fullmatch(PROJECT_RE, self.project):
            return
        result = {}
        for service in ("app", "db"):
            state = result[service] = {"inspection_succeeded": False}
            try:
                ids = self.command(self.docker + ["container", "ls", "--all", "--quiet", "--filter",
                       "label=com.docker.compose.project=" + self.project, "--filter",
                       "label=com.docker.compose.service=" + service], timeout=10).decode().split()
                state["container_count"] = len(ids)
                require(len(ids) == 1 and re.fullmatch(r"[0-9a-f]{12,64}", ids[0]), "owned diagnostic container required")
                info = release.strict_json(self.command(self.docker + ["container", "inspect", ids[0]], timeout=10))[0]
                labels = info["Config"]["Labels"]
                require(labels.get("com.docker.compose.project") == self.project and
                        labels.get("com.docker.compose.service") == service, "diagnostic ownership mismatch")
                for source, target in (("Running", "running"), ("Restarting", "restarting"), ("OOMKilled", "oom_killed")):
                    if type(info["State"].get(source)) is bool:
                        state[target] = info["State"][source]
                for value, target in ((info["State"].get("ExitCode"), "exit_code"),
                                      (info.get("RestartCount"), "restart_count")):
                    if type(value) is int and 0 <= value <= 2**31 - 1:
                        state[target] = value
                health = info["State"].get("Health", {}).get("Status")
                if health in {"starting", "healthy", "unhealthy"}:
                    state["health"] = health
                if service == "app":
                    ports = info.get("NetworkSettings", {}).get("Ports", {}).get("8766/tcp") or []
                    state["published_port_present"] = bool(ports)
                    state["expected_loopback_port_present"] = any(
                        item.get("HostIp") == "127.0.0.1" and item.get("HostPort") == str(self.port) for item in ports)
                state["inspection_succeeded"] = True
                # docker logs can write the container's stderr to its own stderr.
                # Bound the retained tail and emit only allowlisted classifications.
                logs = subprocess.run(self.docker + ["logs", "--tail", "30", ids[0]],
                                      cwd=self.directory, env=self.env, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10, check=False)
                state["startup_categories"] = startup_categories(logs.stdout)
            except Exception:
                state["diagnostic_incomplete"] = True
        self.report["container_diagnostics"] = result

    def owner(self):
        status, body = self.request("/v1/me", key=self.owner_key)
        value = release.strict_json(body)
        require(status == 200 and value.get("agent", {}).get("id") == self.owner_id and
                value["agent"].get("kind") == "owner", "owner authentication failed")

    def check_http(self):
        self.report["phase"] = "https"
        self.wait_health(200)
        self.report["https_verified"] = True
        require(self.sql("SELECT current_setting('server_version_num')::int BETWEEN 140000 AND 149999;") == b"t",
                "PostgreSQL 14 required")
        self.report["postgresql14_verified"] = True
        require(self.sql("SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication "
                         "FROM pg_roles WHERE rolname=current_user;") == b"t", "unprivileged app role required")
        self.report["application_role_unprivileged"] = True
        require(self.sql("SELECT count(*) FROM principals;") == b"0", "startup must not seed principals")
        for route, name in (("/", "index.html"), ("/app.js", "app.js"), ("/app.css", "app.css")):
            status, body = self.request(route)
            require(status == 200 and body == release.read_regular(self.bundle / "web" / name,
                    release.MAX_RESPONSE), "matching web asset required")
            self.report["web_assets_verified"] += 1
        for path in ("/v1/me", "/v1/projects", "/v1/admin/agents"):
            require(self.request(path)[0] == 401, "unauthenticated request was not denied")
            self.report["unauthenticated_denials"] += 1
        owner_path = self.state / "owner/owner.json"
        require(not owner_path.exists(), "startup must not bootstrap owner")
        self.report["phase"] = "bootstrap"
        self.compose("--profile", "init", "run", "--rm", "bootstrap-owner")
        original = release.read_regular(owner_path, 16384, private=True)
        credential = release.strict_json(original)
        require(isinstance(credential, dict) and isinstance(credential.get("agent_id"), str) and
                re.fullmatch(r"[0-9a-f]{64}", credential.get("key", "")) is not None,
                "private bootstrap credential required")
        self.owner_id, self.owner_key = credential["agent_id"], credential["key"]
        self.owner()
        self.report["owner_authenticated"] = True
        self.report["explicit_bootstrap_verified"] = True
        status, body = self.request("/v1/projects", key=self.owner_key)
        require(status == 200 and release.strict_json(body).get("projects") == [], "empty workspace required")
        self.report["phase"] = "recovery"
        self.compose("stop", "db")
        self.wait_health(503)
        self.report["database_failure_verified"] = True
        self.compose("start", "db")
        self.wait_health(200)
        self.owner()
        self.report["database_recovery_verified"] = True
        self.compose("restart", "app")
        self.wait_health(200)
        self.owner()
        require(release.read_regular(owner_path, 16384, private=True) == original, "owner key changed")
        self.report["restart_persistence_verified"] = True

    def cleanup(self):
        require(re.fullmatch(PROJECT_RE, self.project) is not None, "owned cleanup identity required")
        if not self.docker_touched:
            for field in ("owned_containers_removed", "owned_networks_removed", "owned_volumes_removed"):
                self.report[field] = True
            return True
        passed = True
        if self.started:
            try:
                self.compose("down", "--volumes", "--remove-orphans", "--timeout", "10")
            except Exception:
                passed = False
        # Exact unique ownership label; never enumerate/remove unrelated resources.
        for kind, field in (("container", "owned_containers_removed"),
                            ("network", "owned_networks_removed"), ("volume", "owned_volumes_removed")):
            try:
                remaining = self.command(self.docker + [kind, "ls", *(["--all"] if kind == "container" else []), "--quiet", "--filter",
                           "label=com.docker.compose.project=" + self.project]).decode().split()
                if kind == "container" and remaining:
                    for item in remaining:
                        require(re.fullmatch(r"[0-9a-f]{12,64}", item) is not None, "owned container ID required")
                        self.command(self.docker + ["container", "rm", "--force", item])
                    remaining = self.command(self.docker + [kind, "ls", "--all", "--quiet", "--filter",
                                "label=com.docker.compose.project=" + self.project]).decode().split()
                self.report[field] = not remaining
                passed = passed and not remaining
            except Exception:
                passed = False
        if self.image_built and not self.args.keep_image:
            try:
                self.command(self.docker + ["image", "rm", self.args.image])
            except Exception:
                passed = False
        return passed


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-dir", required=True, type=Path)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--version", help="explicit release version; omitted keeps the commit-candidate version")
    parser.add_argument("--image", required=True)
    parser.add_argument("--source", required=True, help="GitHub owner/repository for OCI association")
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--keep-image", action="store_true", help="retain tested local image for publication")
    args = parser.parse_args(argv)
    args.release_dir, args.repository = args.release_dir.resolve(), args.repository.resolve()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.source):
        parser.error("GitHub owner/repository required")
    def interrupted(_number, _frame):
        raise InterruptedError("smoke interrupted")
    previous = {number: signal.signal(number, interrupted) for number in (signal.SIGINT, signal.SIGTERM)}
    smoke = None
    passed = cleaned = False
    temporary = tempfile.TemporaryDirectory(prefix="agent-mesh-container-smoke-")
    try:
        smoke = Smoke(Path(temporary.name), args)
        smoke.packages()
        smoke.build()
        smoke.prepare()
        smoke.check_http()
        passed = True
    except (Exception, KeyboardInterrupt) as error:
        if smoke is not None:
            smoke.report["failure_operation"] = smoke.report.get("operation", "input_validation")
            # SmokeError is used only for the static guard messages in this file
            # and the archive verifier. Never disclose generic exception strings.
            smoke.report["failure"] = str(error) if isinstance(error, release.SmokeError) else "operation failed"
            smoke.diagnostics()
    finally:
        try:
            cleaned = smoke.cleanup() if smoke is not None else True
        except Exception:
            cleaned = False
        try:
            temporary.cleanup()
            if smoke is not None:
                smoke.report["temporary_files_removed"] = True
        except Exception:
            cleaned = False
        for number, handler in previous.items():
            signal.signal(number, handler)
    report = smoke.report if smoke is not None else {"success": False, "phase": "initialization"}
    report["success"] = passed and cleaned
    print(json.dumps(report, sort_keys=True))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
