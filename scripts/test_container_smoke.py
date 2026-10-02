"""Offline guards for the live Docker smoke; no Docker or network is invoked."""
import argparse
import contextlib
import importlib.util
import io
import json
import os
import ssl
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("container_smoke", Path(__file__).with_name("container-smoke.py"))
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)
COMMIT = "a" * 40


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.args = argparse.Namespace(repository=Path(__file__).resolve().parents[1],
                    release_dir=self.directory / "release", expected_commit=COMMIT,
                    image="agent-mesh-ci:sha-" + COMMIT, source="owner/repo", keep_image=False)
        self.instance = smoke.Smoke(self.directory, self.args)
        self.instance.metadata = {"version": "v0.1.0-rc.2-container." + COMMIT[:12],
             "source_commit": COMMIT, "builder_version": "go1.23.6", "build_date": "2026-10-01T00:00:00Z"}

    def test_image_references_are_commit_qualified_and_bounded(self):
        smoke.image_reference(self.args.image)
        smoke.image_reference("ghcr.io/owner/repo:sha-" + COMMIT)
        for value in ("agent-mesh-ci:latest", "ghcr.io/owner/repo:main", "--flag", "sha-" + COMMIT,
                      "ghcr.io/owner/repo:sha-" + COMMIT + ";id", "docker.io/owner/repo:sha-" + COMMIT):
            with self.subTest(value=value), self.assertRaises(smoke.release.SmokeError):
                smoke.image_reference(value)

    def test_release_version_reuses_builder_validation_and_bounds(self):
        for version in ("v1.2.3", "v0.1.0-rc.2"):
            self.assertEqual(smoke.release_version(version), version)
        for version in ("", "1.2.3", "v01.2.3", "v1.2", "v1.2.3..4", "v1.2.3-",
                        "v1.2.3\n", "v1.2.3 -X private", "../v1.2.3", "v1.2.3-" + "a" * 64):
            with self.subTest(version=version), self.assertRaises(smoke.release.SmokeError):
                smoke.release_version(version)

    def test_formal_images_require_the_explicit_version_or_a_commit_tag(self):
        for image in ("agent-mesh-ci:v0.1.0-rc.2", "ghcr.io/owner/repo:v0.1.0-rc.2",
                      "agent-mesh-ci:sha-" + COMMIT):
            self.assertEqual(smoke.image_reference(image, "v0.1.0-rc.2"), image)
        for image in ("agent-mesh-ci:v0.1.0-rc.1", "ghcr.io/owner/repo:latest",
                      "docker.io/owner/repo:v0.1.0-rc.2", "agent-mesh-ci:v0.1.0-rc.2;id"):
            with self.subTest(image=image), self.assertRaises(smoke.release.SmokeError):
                smoke.image_reference(image, "v0.1.0-rc.2")
        with self.assertRaises(smoke.release.SmokeError):
            smoke.image_reference("agent-mesh-ci:v0.1.0-rc.2")

    def test_invalid_version_and_formal_image_mismatch_fail_before_archive_read(self):
        for version, image in (("v01.2.3", "agent-mesh-ci:v01.2.3"),
                               ("v1.2.3", "agent-mesh-ci:v1.2.4"),
                               ("v1.2.3", "agent-mesh-ci:sha-" + "b" * 40)):
            self.args.version, self.args.image = version, image
            with self.subTest(version=version, image=image), \
                 mock.patch.object(smoke.release, "verify_inputs") as verify, \
                 mock.patch.object(self.instance, "command") as command:
                with self.assertRaises(smoke.release.SmokeError):
                    self.instance.packages()
            verify.assert_not_called()
            command.assert_not_called()

    def test_legacy_and_explicit_versions_select_exact_matching_archive_names(self):
        cases = ((None, "agent-mesh-ci:sha-" + COMMIT, "v0.1.0-rc.2-container." + COMMIT[:12]),
                 ("v1.2.3", "agent-mesh-ci:v1.2.3", "v1.2.3"),
                 ("v1.2.3-rc.1", "ghcr.io/owner/repo:v1.2.3-rc.1", "v1.2.3-rc.1"),
                 ("v1.2.3", "agent-mesh-ci:sha-" + COMMIT, "v1.2.3"))
        for explicit, image, version in cases:
            self.args.version, self.args.image = explicit, image
            with self.subTest(version=explicit, image=image), \
                 mock.patch.object(smoke.release, "verify_inputs", side_effect=smoke.release.SmokeError("stop")) as verify:
                with self.assertRaisesRegex(smoke.release.SmokeError, "stop"):
                    self.instance.packages()
            verify.assert_called_once_with(
                self.args.release_dir / ("agent-mesh_" + version + "_linux_amd64.tar.gz"),
                self.args.release_dir / ("agent-mesh_" + version + "_connectors.tar.gz"),
                self.args.release_dir / "SHA256SUMS")

    def package_fixture(self, *, extra_connector=False, connector_commit=None, source_commit=COMMIT):
        version = "v1.2.3-rc.1"
        self.args.version, self.args.image = version, "agent-mesh-ci:" + version
        self.args.release_dir.mkdir()
        metadata = smoke.builder.metadata(version, source_commit, 1790899200, "go1.23.6")
        metadata_bytes = smoke.builder.json_bytes(metadata)
        server_files = dict.fromkeys(smoke.release.SERVER_FILES, b"fixture")
        server_files["RELEASE.json"] = metadata_bytes
        connector_files = dict.fromkeys(smoke.release.CONNECTOR_FILES, b"fixture")
        connector_files["RELEASE.json"] = (smoke.builder.json_bytes(dict(metadata, source_commit=connector_commit))
                                             if connector_commit else metadata_bytes)
        if extra_connector:
            connector_files["private.key"] = b"PRIVATE"
        names = []
        for suffix, files in (("linux_amd64", server_files), ("connectors", connector_files)):
            root = "agent-mesh_" + version + "_" + suffix
            name = root + ".tar.gz"
            smoke.builder.write_archive(self.args.release_dir / name, root, files, 1790899200)
            names.append(name)
        (self.args.release_dir / "RELEASE.json").write_bytes(metadata_bytes)
        names.append("RELEASE.json")
        (self.args.release_dir / "SHA256SUMS").write_text("".join(
            smoke.builder.file_sha256(self.args.release_dir / name) + "  " + name + "\n" for name in names))
        return json.dumps({"version": version, "commit": source_commit,
             "build_date": metadata["build_date"], "go_version": "go1.23.6",
             "goos": "linux", "goarch": "amd64"}).encode()

    def test_formal_packages_check_both_archives_help_imports_and_binary_identity(self):
        binary = self.package_fixture()
        with mock.patch.object(self.instance, "command", side_effect=[binary, b"usage:", b"usage:", b"usage:", b""]) as command:
            self.instance.packages()
        self.assertEqual(self.instance.report["checksums_verified"], 3)
        self.assertEqual(self.instance.report["connector_help_checks"], 3)
        self.assertEqual(self.instance.report["connector_imports"], 4)
        self.assertEqual(self.instance.metadata["source_commit"], COMMIT)
        calls = command.call_args_list
        self.assertEqual(len(calls), 5)
        for call in calls[1:4]:
            self.assertEqual(call.args[0][:4], [smoke.sys.executable, "-E", "-s", "-B"])
            self.assertEqual(call.args[0][-1], "--help")
            self.assertTrue(Path(call.args[0][-2]).is_relative_to(self.directory))
        self.assertEqual(calls[-1].args[0][:4], [smoke.sys.executable, "-I", "-B", "-c"])
        self.assertIn("is_relative_to(root)", calls[-1].args[0][4])

    def test_explicit_version_does_not_relax_archive_source_commit(self):
        self.package_fixture(source_commit="b" * 40)
        with mock.patch.object(self.instance, "command") as command:
            with self.assertRaisesRegex(smoke.release.SmokeError, "source or toolchain identity mismatch"):
                self.instance.packages()
        command.assert_not_called()

    def test_connector_metadata_mismatch_fails_before_executing_payload(self):
        self.package_fixture(connector_commit="b" * 40)
        with mock.patch.object(self.instance, "command") as command:
            with self.assertRaisesRegex(smoke.release.SmokeError, "connector archive metadata mismatch"):
                self.instance.packages()
        command.assert_not_called()

    def test_connector_payload_allowlist_is_applied_before_execution(self):
        self.package_fixture(extra_connector=True)
        with mock.patch.object(self.instance, "command") as command:
            with self.assertRaisesRegex(smoke.release.SmokeError, "unexpected or duplicate member"):
                self.instance.packages()
        command.assert_not_called()

    def test_connector_help_failure_prevents_docker(self):
        binary = self.package_fixture()
        with mock.patch.object(self.instance, "command", side_effect=[binary, b"missing"]) as command:
            with self.assertRaisesRegex(smoke.release.SmokeError, "connector help missing"):
                self.instance.packages()
        self.assertEqual(command.call_count, 2)
        self.assertFalse(self.instance.docker_touched)

    def test_source_fence_fails_before_any_child(self):
        self.args.expected_commit = "main"
        with mock.patch.object(self.instance, "command") as command:
            with self.assertRaises(smoke.release.SmokeError):
                self.instance.packages()
        command.assert_not_called()

    def test_image_source_mismatch_fails_before_archive_read(self):
        self.args.image = "agent-mesh-ci:sha-" + "b" * 40
        with mock.patch.object(smoke.release, "verify_inputs") as verify:
            with self.assertRaises(smoke.release.SmokeError):
                self.instance.packages()
        verify.assert_not_called()

    def test_binary_metadata_must_match_every_field(self):
        value = {"version": self.instance.metadata["version"], "commit": COMMIT,
                 "build_date": self.instance.metadata["build_date"], "go_version": "go1.23.6",
                 "goos": "linux", "goarch": "amd64"}
        self.instance.check_version(json.dumps(value))
        for field in value:
            with self.subTest(field=field), self.assertRaises(smoke.release.SmokeError):
                self.instance.check_version(json.dumps(dict(value, **{field: "wrong"})))

    def test_environment_drops_inherited_tokens_and_remote_docker(self):
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "PRIVATE", "DOCKER_HOST": "tcp://private",
                                         "AGENT_LINK_DATABASE_URL": "PRIVATE", "HTTPS_PROXY": "PRIVATE"}):
            other = self.directory / "other"
            other.mkdir()
            instance = smoke.Smoke(other, self.args)
        for key in ("GITHUB_TOKEN", "DOCKER_HOST", "AGENT_LINK_DATABASE_URL", "HTTPS_PROXY"):
            self.assertNotIn(key, instance.env)
        self.assertEqual(instance.docker[1:3], ["--host", "unix:///var/run/docker.sock"])
        self.assertEqual(Path(instance.env["HOME"]), other / "home")

    def test_child_failure_has_only_safe_diagnostics(self):
        result = subprocess.CompletedProcess([], 17, b"PRIVATE", b"PRIVATE")
        with mock.patch.object(smoke.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(smoke.release.SmokeError, "child command failed"):
                self.instance.command(self.instance.docker + ["build", "PRIVATE"])
        self.assertEqual(self.instance.report["operation"], "docker_build")
        self.assertEqual(self.instance.report["child_exit_code"], 17)
        self.assertNotIn("PRIVATE", json.dumps(self.instance.report))

    def test_timeout_is_recorded_without_output(self):
        with mock.patch.object(smoke.subprocess, "run", side_effect=subprocess.TimeoutExpired("PRIVATE", 1)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.instance.command(["openssl", "PRIVATE"])
        self.assertTrue(self.instance.report["child_timed_out"])
        self.assertNotIn("PRIVATE", json.dumps(self.instance.report))

    def test_cleanup_before_docker_use_never_invokes_docker(self):
        with mock.patch.object(self.instance, "command") as command:
            self.assertTrue(self.instance.cleanup())
        command.assert_not_called()

    def test_cleanup_requires_exact_owned_project(self):
        self.instance.project = "existing-production"
        with mock.patch.object(self.instance, "command") as command:
            with self.assertRaises(smoke.release.SmokeError):
                self.instance.cleanup()
        command.assert_not_called()

    def test_cleanup_fences_project_and_checks_all_resource_types(self):
        self.instance.docker_touched = self.instance.started = True
        with mock.patch.object(self.instance, "compose", return_value=b"") as compose, \
             mock.patch.object(self.instance, "command", return_value=b"") as command:
            self.assertTrue(self.instance.cleanup())
        compose.assert_called_once_with("down", "--volumes", "--remove-orphans", "--timeout", "10")
        self.assertEqual(command.call_count, 3)
        for call in command.call_args_list:
            self.assertIn("label=com.docker.compose.project=" + self.instance.project, call.args[0])
        self.assertIn("--all", command.call_args_list[0].args[0])

    def test_failed_cleanup_remains_failure(self):
        self.instance.docker_touched = self.instance.started = True
        with mock.patch.object(self.instance, "compose", side_effect=RuntimeError("PRIVATE")), \
             mock.patch.object(self.instance, "command", return_value=b""):
            self.assertFalse(self.instance.cleanup())

    def test_leftover_network_is_not_silently_accepted_or_deleted(self):
        self.instance.docker_touched = True
        with mock.patch.object(self.instance, "command", side_effect=[b"", b"owned-network\n", b""]) as command:
            self.assertFalse(self.instance.cleanup())
        self.assertFalse(self.instance.report["owned_networks_removed"])
        self.assertFalse(any("rm" in call.args[0] for call in command.call_args_list))

    def test_image_removal_and_publication_retention(self):
        self.instance.docker_touched = self.instance.image_built = True
        for keep in (False, True):
            self.args.keep_image = keep
            with mock.patch.object(self.instance, "command", return_value=b"") as command:
                self.assertTrue(self.instance.cleanup())
            removals = [call for call in command.call_args_list if "rm" in call.args[0]]
            self.assertEqual(len(removals), 0 if keep else 1)

    def http_fixture(self):
        instance = self.instance
        instance.bundle = self.directory / "bundle"
        (instance.bundle / "web").mkdir(parents=True)
        for name in ("index.html", "app.js", "app.css"):
            (instance.bundle / "web" / name).write_bytes(name.encode())
        instance.state.mkdir()
        (instance.state / "owner").mkdir()
        def compose(*args):
            if "bootstrap-owner" in args:
                smoke.release.write_private(instance.state / "owner/owner.json",
                    json.dumps({"agent_id": "owner", "key": "c" * 64}).encode())
        def request(path, *, key=None):
            assets = {"/": "index.html", "/app.js": "app.js", "/app.css": "app.css"}
            if path in assets:
                return 200, assets[path].encode()
            if key is None:
                return 401, b'{}'
            if path == "/v1/me":
                return 200, b'{"agent":{"id":"owner","kind":"owner"}}'
            return 200, b'{"projects":[]}'
        return compose, request

    def test_http_requires_database_failure_recovery_and_owner_persistence(self):
        compose, request = self.http_fixture()
        with mock.patch.object(self.instance, "compose", side_effect=compose) as commands, \
             mock.patch.object(self.instance, "request", side_effect=request), \
             mock.patch.object(self.instance, "sql", side_effect=[b"t", b"t", b"0"]), \
             mock.patch.object(self.instance, "wait_health") as health:
            self.instance.check_http()
        self.assertEqual([call.args for call in health.call_args_list], [(200,), (503,), (200,), (200,)])
        self.assertIn(mock.call("stop", "db"), commands.call_args_list)
        self.assertIn(mock.call("start", "db"), commands.call_args_list)
        self.assertIn(mock.call("restart", "app"), commands.call_args_list)
        self.assertEqual(self.instance.report["web_assets_verified"], 3)
        self.assertEqual(self.instance.report["unauthenticated_denials"], 3)
        self.assertTrue(self.instance.report["restart_persistence_verified"])

    def test_http_asset_mutation_fails(self):
        compose, request = self.http_fixture()
        with mock.patch.object(self.instance, "compose", side_effect=compose), \
             mock.patch.object(self.instance, "request", return_value=(200, b"wrong")), \
             mock.patch.object(self.instance, "sql", side_effect=[b"t", b"t", b"0"]), \
             mock.patch.object(self.instance, "wait_health"):
            with self.assertRaisesRegex(smoke.release.SmokeError, "matching web asset"):
                self.instance.check_http()

    def test_seeded_principals_and_privileged_role_fail(self):
        for answers, error in (([b"t", b"f"], "unprivileged"), ([b"t", b"t", b"1"], "seed principals")):
            with self.subTest(error=error), mock.patch.object(self.instance, "wait_health"), \
                 mock.patch.object(self.instance, "sql", side_effect=answers):
                with self.assertRaisesRegex(smoke.release.SmokeError, error):
                    self.instance.check_http()

    def test_main_error_runs_cleanup_and_redacts_generic_exception(self):
        output = io.StringIO()
        with mock.patch.object(smoke.Smoke, "packages", side_effect=ValueError("PRIVATE")), \
             mock.patch.object(smoke.Smoke, "cleanup", return_value=True) as cleanup, \
             contextlib.redirect_stdout(output):
            status = smoke.main(["--release-dir", str(self.directory), "--expected-commit", COMMIT,
                                 "--image", self.args.image, "--source", "owner/repo"])
        self.assertEqual(status, 1)
        cleanup.assert_called_once()
        report = json.loads(output.getvalue())
        self.assertTrue(report["temporary_files_removed"])
        self.assertFalse(report["success"])
        self.assertNotIn("PRIVATE", output.getvalue())

    def test_transport_diagnostics_never_include_raw_exception(self):
        cases = ((ConnectionRefusedError(111, "PRIVATE"), "connection_refused"),
                 (ConnectionResetError(104, "PRIVATE"), "connection_reset"),
                 (TimeoutError("PRIVATE"), "timeout"),
                 (OSError(101, "PRIVATE"), "network_unreachable"),
                 (smoke.urllib.error.URLError("PRIVATE"), "other_transport_error"),
                 (ssl.SSLCertVerificationError(1, "PRIVATE"), "certificate_verification"))
        for error, category in cases:
            with self.subTest(category=category):
                result = smoke.transport_failure(smoke.urllib.error.URLError(error))
                self.assertEqual(result["category"], category)
                self.assertNotIn("PRIVATE", json.dumps(result))

    def test_startup_log_classification_is_fixed_and_bounded(self):
        raw = b"PRIVATE password authentication failed PRIVATE listener starting on PRIVATE"
        self.assertEqual(smoke.startup_categories(raw), ["database_authentication_failed", "listener_started"])
        self.assertEqual(smoke.startup_categories(b"PRIVATE"), [])
        self.assertEqual(smoke.startup_categories(b"x" * 65536 + b"permission denied"), [])

    def test_published_port_checks_actual_mapping_not_requested_intent(self):
        binding = [{"HostIp": "127.0.0.1", "HostPort": "43210"}]
        intent_only = {"HostConfig": {"PortBindings": {"8766/tcp": binding}}}
        self.assertFalse(smoke.published_loopback(intent_only, 43210))
        for actual in (None, [], [{"HostIp": "0.0.0.0", "HostPort": "43210"}],
                       [{"HostIp": "127.0.0.1", "HostPort": "43211"}]):
            self.assertFalse(smoke.published_loopback({"NetworkSettings": {"Ports": {"8766/tcp": actual}}}, 43210))
        self.assertTrue(smoke.published_loopback({"NetworkSettings": {"Ports": {"8766/tcp": binding}}}, 43210))

    def test_diagnostics_skip_unstarted_or_unowned_projects(self):
        with mock.patch.object(self.instance, "command") as command:
            self.instance.diagnostics()
            self.instance.started = True
            self.instance.project = "production"
            self.instance.diagnostics()
        command.assert_not_called()

    def test_diagnostics_are_owned_filtered_and_redacted(self):
        instance = self.instance
        instance.started = True
        instance.port = 43210
        def command(argv, **kwargs):
            if "ls" in argv:
                self.assertIn("label=com.docker.compose.project=" + instance.project, argv)
                return b"aabbccddeeff\n"
            service = "app" if command.calls == 0 else "db"
            command.calls += 1
            return json.dumps([{"Config": {"Labels": {"com.docker.compose.project": instance.project,
                        "com.docker.compose.service": service}, "Env": ["PRIVATE"]},
                "State": {"Running": True, "Restarting": False, "OOMKilled": False,
                          "ExitCode": 0, "Error": "PRIVATE", "Health": {"Status": "healthy"}},
                "RestartCount": 2, "NetworkSettings": {"Ports": {"8766/tcp": [
                    {"HostIp": "127.0.0.1", "HostPort": "43210"}]}}}]).encode()
        command.calls = 0
        with mock.patch.object(instance, "command", side_effect=command), \
             mock.patch.object(smoke.subprocess, "run", return_value=subprocess.CompletedProcess([], 0,
                               b"PRIVATE listener starting on PRIVATE")):
            instance.diagnostics()
        result = instance.report["container_diagnostics"]
        self.assertTrue(result["app"]["expected_loopback_port_present"])
        self.assertEqual(result["app"]["restart_count"], 2)
        self.assertEqual(result["db"]["health"], "healthy")
        self.assertEqual(result["app"]["startup_categories"], ["listener_started"])
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_diagnostic_errors_do_not_prevent_cleanup(self):
        self.instance.started = True
        with mock.patch.object(self.instance, "command", side_effect=RuntimeError("PRIVATE")):
            self.instance.diagnostics()
        result = self.instance.report["container_diagnostics"]
        self.assertTrue(result["app"]["diagnostic_incomplete"])
        self.assertTrue(result["db"]["diagnostic_incomplete"])
        self.assertNotIn("PRIVATE", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
