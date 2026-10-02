#!/usr/bin/env python3
"""Offline release-smoke tests: subprocesses/network are fakes, never a real DB."""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
import urllib.parse


SPEC = importlib.util.spec_from_file_location("smoke_release", Path(__file__).with_name("smoke-release.py"))
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)
VERSION = "v0.1.0-rc.1"
SERVER_NAME = "agent-mesh_" + VERSION + "_linux_amd64.tar.gz"
CONNECTOR_NAME = "agent-mesh_" + VERSION + "_connectors.tar.gz"
METADATA = {"schema_version": 1, "packaging_version": 1, "version": VERSION,
            "source_commit": "a" * 40, "source_date_epoch": 1700000000,
            "build_date": "2026-10-01T12:00:00Z", "target": {"goos": "linux", "goarch": "amd64"},
            "builder_version": "go1.25.0"}
DSN = "postgresql://smoke_user:PRIVATE_PASSWORD@127.0.0.1:5432/agentlink_test?sslmode=disable"


def archive_bytes(filename=SERVER_NAME, files=None, *, extra=(), omit=()):
    if files is None:
        files = smoke.SERVER_FILES
    stream = io.BytesIO()
    root = filename[:-7]
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for relative in sorted(set(files) - set(omit)):
            data = json.dumps(METADATA).encode() if relative == "RELEASE.json" else relative.encode()
            member = tarfile.TarInfo(root + "/" + relative)
            member.size = len(data)
            member.mode = 0o755 if relative == "bin/agent-mesh" else 0o644
            archive.addfile(member, io.BytesIO(data))
        for member, data in extra:
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return stream.getvalue()


class TemporaryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="release-smoke-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def private(self, name, data):
        path = self.directory / name
        smoke.write_private(path, data)
        return path

    def instance(self):
        return smoke.Smoke(self.directory)


class ArchiveTests(TemporaryTest):
    def test_valid_extract_is_exact_and_private(self):
        root, version = smoke.extract_archive(archive_bytes(), SERVER_NAME, "server", self.directory)
        self.assertEqual(version, VERSION)
        self.assertEqual({str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()},
                         set(smoke.SERVER_FILES))
        self.assertEqual((root / "bin/agent-mesh").stat().st_mode & 0o777, 0o700)
        self.assertEqual((root / "RELEASE.json").stat().st_mode & 0o777, 0o600)

    def test_rejects_traversal_aliases_and_wrong_root_without_writing(self):
        root = SERVER_NAME[:-7]
        for name in ("/tmp/release-smoke-escape", "../escape", root + "/../escape",
                     root + "/web/../../escape", "./" + root + "/web/app.js",
                     root + "//web/app.js", root + "/web/./app.js", "wrong/web/app.js",
                     root + "/web\\app.js", root + "/unexpected"):
            with self.subTest(name=name):
                item = tarfile.TarInfo(name)
                with self.assertRaises(smoke.SmokeError):
                    smoke.extract_archive(archive_bytes(extra=[(item, b"bad")]), SERVER_NAME,
                                          "server", self.directory)
                self.assertEqual(list(self.directory.iterdir()), [])

    def test_rejects_links_devices_pipes_directories_and_duplicates(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE,
                     tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.DIRTYPE, tarfile.REGTYPE):
            with self.subTest(kind=kind):
                item = tarfile.TarInfo(SERVER_NAME[:-7] + "/web/app.js")
                item.type = kind
                item.linkname = "/tmp/never-follow"
                # Non-regular cases replace the allowlisted file; regular tests a duplicate.
                omit = () if kind == tarfile.REGTYPE else ("web/app.js",)
                with self.assertRaises(smoke.SmokeError):
                    smoke.extract_archive(archive_bytes(extra=[(item, b"")], omit=omit), SERVER_NAME,
                                          "server", self.directory)
                self.assertEqual(list(self.directory.iterdir()), [])

    def test_rejects_missing_and_privileged_members(self):
        with self.assertRaises(smoke.SmokeError):
            smoke.extract_archive(archive_bytes(omit={"web/app.css"}), SERVER_NAME, "server", self.directory)
        item = tarfile.TarInfo(SERVER_NAME[:-7] + "/web/app.js")
        item.mode = 0o4755
        with self.assertRaises(smoke.SmokeError):
            smoke.extract_archive(archive_bytes(omit={"web/app.js"}, extra=[(item, b"a")]),
                                  SERVER_NAME, "server", self.directory)

    def test_oversized_archive_refused(self):
        with mock.patch.object(smoke, "MAX_FILE", 2), self.assertRaises(smoke.SmokeError):
            smoke.extract_archive(archive_bytes(), SERVER_NAME, "server", self.directory)

    def input_files(self):
        paths = [self.private(SERVER_NAME, archive_bytes()),
                 self.private(CONNECTOR_NAME, archive_bytes(CONNECTOR_NAME, smoke.CONNECTOR_FILES)),
                 self.private("RELEASE.json", json.dumps(METADATA).encode())]
        listing = "".join(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.name + "\n"
                          for path in paths)
        return paths, self.private("SHA256SUMS", listing.encode())

    def test_checksum_snapshot_verifies_all_three(self):
        paths, checksums = self.input_files()
        values = smoke.verify_inputs(paths[0], paths[1], checksums)
        self.assertEqual(set(values), {path.name for path in paths})
        paths[0].write_bytes(b"changed after snapshot")
        self.assertNotEqual(values[paths[0].name], paths[0].read_bytes())
        with self.assertRaises(smoke.SmokeError):
            smoke.verify_inputs(paths[0], paths[1], checksums)

    def test_checksum_rejects_duplicate_missing_unknown_and_paths(self):
        paths, checksums = self.input_files()
        good = checksums.read_bytes()
        bad_values = (good + good.splitlines(keepends=True)[0], good.splitlines(keepends=True)[0],
                      good + b"a" * 64 + b"  extra\n", good.replace(b"  RELEASE.json", b"  ../RELEASE.json"))
        for value in bad_values:
            with self.subTest(value=value[-80:]):
                checksums.write_bytes(value)
                with self.assertRaises(smoke.SmokeError):
                    smoke.verify_inputs(paths[0], paths[1], checksums)

    def test_rejects_symlink_and_nonprivate_source(self):
        target = self.private("target", b"secret")
        link = self.directory / "link"
        link.symlink_to(target)
        with self.assertRaises(OSError):
            smoke.read_regular(link, 4096, private=True)
        target.chmod(0o644)
        with self.assertRaises(smoke.SmokeError):
            smoke.read_regular(target, 4096, private=True)

    def test_release_metadata_and_duplicate_json(self):
        self.assertEqual(smoke.validate_metadata(json.dumps(METADATA), VERSION), METADATA)
        for changed in ({"version": "v9.0.0"}, {"source_commit": "main"},
                        {"target": {"goos": "linux", "goarch": "arm64"}}, {"source_date_epoch": True}):
            with self.assertRaises(smoke.SmokeError):
                smoke.validate_metadata(json.dumps({**METADATA, **changed}), VERSION)
        with self.assertRaises(smoke.SmokeError):
            smoke.strict_json('{"key":1,"key":2}')


class DatabaseBoundaryTests(TemporaryTest):
    def test_only_numeric_loopback_or_explicit_socket(self):
        for url in (DSN, "postgresql://user@127.0.0.2/agent_link_test",
                    "postgresql://user@[::1]/agentlink_test",
                    "postgresql:///agentlink_test?host=%2Fvar%2Frun%2Fpostgresql&user=test"):
            with self.subTest(url=url):
                result = smoke.parse_test_dsn(url)
                self.assertIn(result["database"], {"agentlink_test", "agent_link_test"})

    def test_refuses_remote_unknown_database_ambiguous_and_override_dsns(self):
        invalid = (DSN.replace("127.0.0.1", "localhost"), DSN.replace("127.0.0.1", "192.0.2.1"),
                   DSN.replace("agentlink_test", "production"), DSN + "&host=127.0.0.1",
                   DSN + "&port=5433", DSN + "&hostaddr=192.0.2.1", DSN + "&service=production",
                   DSN + "&options=-csearch_path=public", DSN + "&search_path=public",
                   DSN + "&user=other", DSN + "&sslmode=disable", DSN + "#fragment",
                   DSN + "&passfile=/tmp/other", DSN + "&dbname=production",
                   "postgresql:///agentlink_test?user=test", "postgresql://user@127.0.0.1,192.0.2.1/agentlink_test",
                   "postgresql:///agentlink_test?host=/tmp/../socket&user=test",
                   "postgresql://user@[::1%25lo]/agentlink_test", "host=127.0.0.1 dbname=agentlink_test",
                   DSN.replace(":5432", ":0"), DSN.replace("/agentlink_test", "/agentlink_test/other"),
                   DSN.replace("smoke_user", "bad%0auser"))
        for url in invalid:
            with self.subTest(url=url), self.assertRaises((smoke.SmokeError, ValueError)):
                smoke.parse_test_dsn(url)

    def test_scoped_url_has_only_owned_search_path(self):
        config = smoke.parse_test_dsn(DSN)
        schema = "release_smoke_" + "b" * 32
        url = urllib.parse.urlsplit(smoke.scoped_dsn(config, schema))
        query = urllib.parse.parse_qs(url.query)
        self.assertEqual(query["options"], ["-csearch_path=" + schema])
        self.assertEqual(query["host"], ["127.0.0.1"])
        self.assertEqual(query["password"], ["PRIVATE_PASSWORD"])
        self.assertEqual(url.path, "/agentlink_test")
        for invalid in ("public", schema + "; DROP DATABASE agentlink_test", "release_smoke_short"):
            with self.assertRaises(smoke.SmokeError):
                smoke.scoped_dsn(config, invalid)

    def test_command_environment_clears_auth_python_and_pg_inheritance(self):
        with mock.patch.dict(os.environ, {"PYTHONPATH": "/poison", "PGSERVICE": "production",
                                         "PGHOST": "remote", "OPENAI_API_KEY": "PRIVATE",
                                         "AGENT_LINK_DATABASE_URL": "PRIVATE_DSN"}):
            env = smoke.child_environment(self.directory)
        self.assertEqual(env["PYTHONPATH"], "")
        self.assertEqual(env["HOME"], str(self.directory))
        for key in ("PGSERVICE", "PGHOST", "OPENAI_API_KEY", "AGENT_LINK_DATABASE_URL"):
            self.assertNotIn(key, env)

    def test_psql_secrets_only_private_env_never_argv_or_query(self):
        instance = self.instance()
        instance.config = smoke.parse_test_dsn(DSN)
        with mock.patch.object(smoke.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"1\n", b"")) as run:
            self.assertEqual(instance.sql("SELECT 1;"), b"1")
        args, kwargs = run.call_args
        self.assertNotIn("PRIVATE_PASSWORD", repr(args))
        self.assertNotIn("PRIVATE_PASSWORD", kwargs["input"].decode())
        self.assertEqual(kwargs["env"]["PGPASSWORD"], "PRIVATE_PASSWORD")
        self.assertEqual(kwargs["env"]["PGDATABASE"], "agentlink_test")
        self.assertIn("-w", args[0])
        self.assertIn("-X", args[0])
        self.assertEqual(kwargs["cwd"], instance.cwd)

    def test_invalid_dsn_never_invokes_psql(self):
        instance = self.instance()
        source = self.private("invalid-dsn", DSN.replace("agentlink_test", "production").encode())
        with mock.patch.object(instance, "sql") as sql, self.assertRaises(smoke.SmokeError):
            instance.setup_database(source)
        sql.assert_not_called()

    def test_database_identity_must_match_before_create(self):
        instance = self.instance()
        source = self.private("dsn", DSN.encode())
        with mock.patch.object(instance, "sql", return_value=b"production") as sql:
            with self.assertRaises(smoke.SmokeError):
                instance.setup_database(source)
        self.assertEqual(sql.call_count, 1)
        self.assertFalse(instance.schema_attempted)

    def test_create_timeout_still_attempts_marker_guarded_cleanup(self):
        instance = self.instance()
        source = self.private("dsn", DSN.encode())
        with mock.patch.object(instance, "sql", side_effect=[b"agentlink_test", TimeoutError(), b"0"]) as sql:
            with self.assertRaises(TimeoutError):
                instance.setup_database(source)
            self.assertTrue(instance.cleanup())
        create = sql.call_args_list[1].args[0]
        cleanup = sql.call_args_list[2].args[0]
        self.assertIn("BEGIN; CREATE SCHEMA", create)
        self.assertIn("COMMENT ON SCHEMA", create)
        self.assertIn(instance.owner_marker, create)
        self.assertIn(instance.owner_marker, cleanup)
        self.assertIn("IF EXISTS", cleanup)
        self.assertIn('DROP SCHEMA "' + instance.schema + '" CASCADE', cleanup)
        self.assertNotIn("DROP DATABASE", cleanup)

    def test_bootstrap_uses_private_scoped_file_and_new_owner_only(self):
        instance = self.instance()
        instance.binary = self.directory / "bin/agent-mesh"
        source = self.private("dsn", DSN.encode())
        def bootstrap(argv, **_kwargs):
            self.assertEqual(argv[1], "bootstrap-owner")
            self.assertNotIn("PRIVATE_PASSWORD", repr(argv))
            dsn_path = Path(argv[argv.index("--database-url-file") + 1])
            self.assertEqual(dsn_path.stat().st_mode & 0o777, 0o600)
            parsed = urllib.parse.urlsplit(dsn_path.read_text().strip())
            self.assertEqual(urllib.parse.parse_qs(parsed.query)["options"], ["-csearch_path=" + instance.schema])
            owner = argv[argv.index("--owner-id") + 1]
            key_path = Path(argv[argv.index("--key-out") + 1])
            smoke.write_private(key_path, json.dumps({"agent_id": owner, "key": "c" * 64}).encode())
            return b""
        with mock.patch.object(instance, "sql", side_effect=[b"agentlink_test", b"", b"1"]) as sql, \
             mock.patch.object(instance, "command", side_effect=bootstrap) as command:
            instance.setup_database(source)
        command.assert_called_once()
        self.assertTrue(instance.report["database_isolated"])
        self.assertEqual(instance.owner_key, "c" * 64)
        self.assertIn('FROM "' + instance.schema + '".principals', sql.call_args.args[0])


class ExecutionTests(TemporaryTest):
    def test_packaged_commands_only_version_help_imports_from_unrelated_cwd(self):
        server = self.private(SERVER_NAME, archive_bytes())
        connectors = self.private(CONNECTOR_NAME, archive_bytes(CONNECTOR_NAME, smoke.CONNECTOR_FILES))
        metadata = self.private("RELEASE.json", json.dumps(METADATA).encode())
        records = "".join(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.name + "\n"
                          for path in (server, connectors, metadata))
        checksums = self.private("SHA256SUMS", records.encode())
        instance = self.instance()
        info = {"version": VERSION, "commit": METADATA["source_commit"], "build_date": METADATA["build_date"],
                "go_version": METADATA["builder_version"], "goos": "linux", "goarch": "amd64"}
        outputs = [json.dumps(info).encode(), b"usage: cli", b"usage: hook", b"usage: mcp", b""]
        with mock.patch.object(instance, "command", side_effect=outputs) as command:
            instance.packages(argparse.Namespace(server=server, connectors=connectors, checksums=checksums))
        calls = [call.args[0] for call in command.call_args_list]
        self.assertEqual(calls[0][-1], "version")
        for argv in calls[1:4]:
            self.assertEqual(argv[-1], "--help")
            self.assertEqual(argv[0], sys.executable)
        self.assertIn("-I", calls[4])
        self.assertEqual(instance.report["connector_help_checks"], 3)
        self.assertEqual(instance.report["connector_imports"], 4)
        self.assertNotEqual(instance.cwd, Path.cwd())

    def test_http_uses_numeric_loopback_no_proxy_and_closes_connection(self):
        instance = self.instance()
        instance.port, instance.owner_key = 43210, "PRIVATE_KEY"
        connection = mock.Mock()
        response = connection.getresponse.return_value
        response.status = 200
        response.read.return_value = b"{}"
        with mock.patch.object(smoke.http.client, "HTTPConnection", return_value=connection) as factory:
            self.assertEqual(instance.request("/v1/me", authenticated=True), (200, b"{}"))
        factory.assert_called_once_with("127.0.0.1", 43210, timeout=2)
        connection.request.assert_called_once_with("GET", "/v1/me", headers={"Authorization": "Bearer PRIVATE_KEY"})
        connection.close.assert_called_once()

    def test_http_closes_on_network_failure(self):
        instance = self.instance()
        instance.port = 43210
        connection = mock.Mock()
        connection.request.side_effect = OSError("private error")
        with mock.patch.object(smoke.http.client, "HTTPConnection", return_value=connection):
            with self.assertRaises(OSError):
                instance.request("/healthz")
        connection.close.assert_called_once()

    def http_instance(self):
        instance = self.instance()
        instance.binary = self.directory / "agent-mesh"
        instance.dsn_file = self.directory / "scoped-dsn"
        instance.owner_id = "release-smoke-test-owner"
        instance.owner_key = "c" * 64
        instance.web = self.directory / "web"
        instance.web.mkdir()
        for name in ("index.html", "app.js", "app.css"):
            smoke.write_private(instance.web / name, name.encode())
        return instance

    def run_http_fake(self, instance, *, mutation=None):
        server = mock.Mock()
        server.poll.return_value = None
        probe = mock.MagicMock()
        probe.__enter__.return_value.getsockname.return_value = ("127.0.0.1", 43210)
        routes = []
        def response(path, *, authenticated=False):
            routes.append((path, authenticated))
            if path == "/healthz":
                result = (200, b'{"status":"ok"}')
            elif path in ("/", "/app.js", "/app.css"):
                result = (200, ("index.html" if path == "/" else path[1:]).encode())
            elif not authenticated:
                result = (401, b'{"error":"invalid or revoked key"}')
            elif path == "/v1/me":
                result = (200, json.dumps({"agent": {"id": instance.owner_id, "kind": "owner"}}).encode())
            else:
                result = (200, b'{"projects":[]}')
            return mutation(path, authenticated, result) if mutation else result
        with mock.patch.object(smoke.socket, "socket", return_value=probe), \
             mock.patch.object(smoke.subprocess, "Popen", return_value=server) as popen, \
             mock.patch.object(instance, "request", side_effect=response):
            instance.check_http()
        return routes, popen, probe

    def test_http_full_contract_uses_owned_loopback_server(self):
        instance = self.http_instance()
        routes, popen, probe = self.run_http_fake(instance)
        probe.__enter__.return_value.bind.assert_called_once_with(("127.0.0.1", 0))
        argv = popen.call_args.args[0]
        self.assertEqual(argv[1], "serve")
        self.assertEqual(argv[argv.index("--listen") + 1], "127.0.0.1:43210")
        self.assertEqual(popen.call_args.kwargs["cwd"], instance.cwd)
        self.assertNotIn(instance.owner_key, repr(popen.call_args))
        self.assertEqual(routes, [("/healthz", False), ("/", False), ("/app.js", False),
                                 ("/app.css", False), ("/v1/me", False), ("/v1/projects", False),
                                 ("/v1/me", True), ("/v1/projects", True)])
        self.assertTrue(instance.report["health_verified"])
        self.assertEqual(instance.report["web_assets_verified"], 3)
        self.assertEqual(instance.report["unauthenticated_denials"], 2)
        self.assertTrue(instance.report["owner_authenticated"])
        self.assertTrue(instance.report["empty_projects_verified"])

    def test_http_negative_controls_refuse_asset_auth_owner_and_projects_drift(self):
        mutations = [("/app.js", False, (200, b"wrong asset")),
                     ("/v1/me", False, (200, b'{}')),
                     ("/v1/me", True, (200, b'{"agent":{"id":"other","kind":"owner"}}')),
                     ("/v1/projects", True, (200, b'{"projects":[{"id":"unexpected"}]}'))]
        # A fresh independently owned temporary instance for every negative control.
        for route, authenticated, replacement in mutations:
            with self.subTest(route=route, authenticated=authenticated), tempfile.TemporaryDirectory() as directory:
                original_directory = self.directory
                try:
                    self.directory = Path(directory)
                    instance = self.http_instance()
                finally:
                    self.directory = original_directory
                def mutate(path, auth, result):
                    return replacement if path == route and auth == authenticated else result
                with self.assertRaises(smoke.SmokeError):
                    self.run_http_fake(instance, mutation=mutate)
                self.assertIsNotNone(instance.server)
                self.assertFalse(instance.report["success"])

    def test_cleanup_only_owned_process_and_marker_schema(self):
        instance = self.instance()
        instance.schema_attempted = True
        instance.server = mock.Mock()
        instance.server.poll.side_effect = [None, 0]
        instance.server.wait.side_effect = [subprocess.TimeoutExpired("owned", 7), 0]
        with mock.patch.object(instance, "sql", return_value=b"0") as sql:
            self.assertTrue(instance.cleanup())
        instance.server.terminate.assert_called_once()
        instance.server.kill.assert_called_once()
        self.assertEqual(instance.server.wait.call_count, 2)
        self.assertIn(instance.owner_marker, sql.call_args.args[0])
        self.assertEqual(instance.report["owned_schema_removed"], True)

    def test_cleanup_failure_does_not_skip_other_resources(self):
        instance = self.instance()
        instance.schema_attempted = True
        instance.server = mock.Mock()
        instance.server.poll.return_value = None
        instance.server.terminate.side_effect = OSError("cannot terminate")
        with mock.patch.object(instance, "sql", return_value=b"0") as sql:
            self.assertFalse(instance.cleanup())
        sql.assert_called_once()
        self.assertFalse(instance.report["owned_process_stopped"])
        self.assertTrue(instance.report["owned_schema_removed"])

    def test_cleanup_never_drops_unvalidated_schema(self):
        instance = self.instance()
        instance.schema_attempted = True
        instance.schema = "public"
        with mock.patch.object(instance, "sql") as sql:
            self.assertFalse(instance.cleanup())
        sql.assert_not_called()

    def test_cleanup_without_owned_resources_is_noop(self):
        instance = self.instance()
        with mock.patch.object(instance, "sql") as sql:
            self.assertTrue(instance.cleanup())
        sql.assert_not_called()

    def test_schema_cleanup_failure_reports_failure(self):
        instance = self.instance()
        instance.schema_attempted = True
        with mock.patch.object(instance, "sql", side_effect=TimeoutError()):
            self.assertFalse(instance.cleanup())
        self.assertFalse(instance.report["owned_schema_removed"])

    def test_main_always_removes_temporary_files_and_sanitizes_failure(self):
        arguments = ["--server", "fake-server", "--connectors", "fake-connectors", "--checksums", "fake-checksums",
                     "--database-url-file", "fake-dsn"]
        for failed_stage in ("packages", "setup_database", "check_http", "none"):
            with self.subTest(failed_stage=failed_stage):
                directories = []
                def step(name):
                    def execute(instance, *_args):
                        directories.append(instance.directory)
                        smoke.write_private(instance.directory / (name + ".private"), b"PRIVATE_SECRET")
                        if name == failed_stage:
                            raise RuntimeError("PRIVATE_SECRET postgresql://private")
                    return execute
                output = io.StringIO()
                with mock.patch.object(smoke.Smoke, "packages", step("packages")), \
                     mock.patch.object(smoke.Smoke, "setup_database", step("setup_database")), \
                     mock.patch.object(smoke.Smoke, "check_http", step("check_http")), \
                     mock.patch.object(smoke.subprocess, "run") as run, \
                     mock.patch.object(smoke.subprocess, "Popen") as popen, contextlib.redirect_stdout(output):
                    result = smoke.main(arguments)
                self.assertEqual(result, 0 if failed_stage == "none" else 1)
                self.assertTrue(directories)
                self.assertTrue(all(not path.exists() for path in directories))
                report = json.loads(output.getvalue())
                self.assertTrue(report["temporary_files_removed"])
                self.assertNotIn("PRIVATE_SECRET", output.getvalue())
                self.assertNotIn("postgresql://", output.getvalue())
                self.assertTrue(all(type(value) in (bool, int) for value in report.values()))
                run.assert_not_called()
                popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
