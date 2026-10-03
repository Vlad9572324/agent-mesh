"""Offline onboarding checks: fake transport/exec boundaries, no real models."""
import base64
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "adapters"), str(ROOT / "scripts")]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


release = module("onboarding_release_test", ROOT / "scripts/build-release.py")
connect = module("onboarding_connect_test", ROOT / "onboarding/connect.py")
paths = ["connect.py", "README.md", "PROMPT.md", "profile.json", "agent.key", "ca.crt"]
paths += ["connectors/" + name for name in (*release.CONNECTOR_FILES, "LICENSE", "NOTICE", "CLI-CONNECTION.md", "docs/third-party-notices.md")]
paths += ["connectors/RELEASE.json"]
installer_source = (ROOT / "onboarding/install.py").read_text().replace("__PACKAGE_PATHS_JSON__", repr(paths))
installer = types.ModuleType("onboarding_installer_test")
exec(compile(installer_source, str(ROOT / "onboarding/install.py"), "exec"), installer.__dict__)

ORIGIN = "https://fixture.example.invalid:443"
PIN = "sha256//" + base64.b64encode(b"p" * 32).decode()
TOKEN = "t" * 48
KEY = "e" * 64


def profile():
    return {"version": 1, "agent_id": "new-agent", "project_id": "existing-project",
            "url": ORIGIN, "channel_ids": ["coordination"], "runtime": "auto",
            "repository": "https://github.com/example/mesh", "connector_dir": "connectors"}


def package_files():
    files = {}
    for name in paths:
        if name == "connectors/RELEASE.json":
            files[name] = json.dumps({"version": "v1.2.3-test.4", "source_commit": "a" * 40}).encode()
        elif name.startswith("connectors/"):
            files[name] = (ROOT / name[len("connectors/"):]).read_bytes()
        elif name in ("connect.py", "README.md", "PROMPT.md"):
            files[name] = (ROOT / "onboarding" / name).read_bytes()
    files.update({"agent.key": (KEY + "\n").encode(), "ca.crt": b"fixture-public-certificate",
                  "profile.json": json.dumps(profile()).encode()})
    files["MANIFEST.json"] = json.dumps({"version": 1, "files": {
        name: {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data in files.items()}}).encode()
    return files


def archive(files, extra=None):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w:gz", format=tarfile.USTAR_FORMAT) as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name); info.mode = 0o600; info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        if extra is not None:
            tar.addfile(extra)
    return result.getvalue()


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mesh-onboarding-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_exact_manifest_private_install_and_check_argv(self):
        path = self.root / "new"
        out = io.StringIO()
        with patch.object(installer, "redeem", return_value=archive(package_files())) as redeem, \
                patch.object(installer.os, "execv") as execute, contextlib.redirect_stderr(out):
            result = installer.main([ORIGIN, PIN, TOKEN, "--install-dir", str(path), "--check", "--runtime", "codex"])
        self.assertEqual(result, 0)
        redeem.assert_called_once_with(ORIGIN, PIN, TOKEN)
        execute.assert_called_once_with(sys.executable, [sys.executable, "-B", str(path / "connect.py"), "--runtime", "codex", "--check"])
        self.assertEqual(set(str(p.relative_to(path)) for p in path.rglob("*") if p.is_file()), set(paths) | {"MANIFEST.json"})
        bridge = path / "connectors/adapters/native_bridge.py"
        metadata = bridge.parent.parent / "RELEASE.json"
        self.assertEqual(json.loads(metadata.read_bytes()),
                         {"version": "v1.2.3-test.4", "source_commit": "a" * 40})
        for item in [path, *path.rglob("*")]:
            self.assertEqual(item.stat().st_mode & 0o777, 0o700 if item.is_dir() else 0o600)
        self.assertNotIn(KEY, out.getvalue()); self.assertNotIn(TOKEN, out.getvalue())

    def test_existing_directory_and_symlink_refuse_before_redemption(self):
        existing = self.root / "existing"; existing.mkdir()
        alias = self.root / "alias"; alias.symlink_to(existing)
        for path in (existing, alias / "new"):
            with patch.object(installer, "redeem") as redeem, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(installer.main([ORIGIN, PIN, TOKEN, "--check", "--install-dir", str(path)]), 2)
            redeem.assert_not_called()

    def test_failure_does_not_retry_and_removes_only_empty_reservation(self):
        path = self.root / "new"
        with patch.object(installer, "redeem", side_effect=OSError("fixture")) as redeem, contextlib.redirect_stderr(io.StringIO()) as output:
            self.assertEqual(installer.main([ORIGIN, PIN, TOKEN, "--check", "--install-dir", str(path)]), 2)
        redeem.assert_called_once(); self.assertFalse(path.exists()); self.assertIn("uncertain", output.getvalue())

    def test_archive_rejects_traversal_links_duplicates_missing_and_changed_bytes(self):
        for name, kind in (("../outside", tarfile.REGTYPE), ("agent.key", tarfile.SYMTYPE), ("agent.key", tarfile.REGTYPE)):
            info = tarfile.TarInfo(name); info.type = kind; info.linkname = "outside" if kind == tarfile.SYMTYPE else ""
            with self.subTest(name=name, kind=kind), self.assertRaises(installer.InstallError):
                installer.unpack(archive(package_files(), info), ORIGIN)
        for transform in (lambda files: files.pop("agent.key"), lambda files: files.update({"connect.py": b"changed"}),
                          lambda files: files.pop("connectors/RELEASE.json"),
                          lambda files: files.update({"connectors/RELEASE.json": b'{"version":"dev","source_commit":"unknown"}'})):
            files = package_files(); transform(files)
            with self.assertRaises(installer.InstallError): installer.unpack(archive(files), ORIGIN)
        with self.assertRaises(installer.InstallError): installer.unpack(archive(package_files()), "https://other.invalid")

    def test_bounded_gzip_and_connection_inputs(self):
        with self.assertRaises(installer.InstallError): installer.unpack(gzip.compress(b"\0" * (installer.MAXIMUM + 100000)), ORIGIN)
        installer.validate_connection(ORIGIN, PIN, TOKEN)
        for origin, pin, token in (("http://fixture.invalid", PIN, TOKEN), (ORIGIN + "/path", PIN, TOKEN), (ORIGIN, "invalid", TOKEN), (ORIGIN, PIN, "bad\n")):
            with self.assertRaises(installer.InstallError): installer.validate_connection(origin, pin, token)

    def test_no_tty_default_refuses_before_redemption(self):
        with patch.object(installer.os, "open", side_effect=OSError), patch.object(installer, "redeem") as redeem, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(installer.main([ORIGIN, PIN, TOKEN]), 2)
        redeem.assert_not_called()

    def test_redeem_uses_pin_and_body_without_retry_or_token_argument(self):
        class Sink(io.BytesIO):
            def close(self): self.snapshot = self.getvalue(); super().close()
        process = types.SimpleNamespace(stdin=Sink(), stdout=io.BytesIO(b"archive"), wait=lambda **_: 0, poll=lambda: 0)
        with patch.object(installer.subprocess, "Popen", return_value=process) as popen:
            self.assertEqual(installer.redeem(ORIGIN, PIN, TOKEN), b"archive")
        argv = popen.call_args.args[0]
        self.assertNotIn(TOKEN, " ".join(argv)); self.assertNotIn("--retry", argv); self.assertNotIn("--location", argv)
        self.assertEqual(argv[argv.index("--pinnedpubkey") + 1], PIN)
        self.assertEqual(json.loads(process.stdin.snapshot), {"token": TOKEN})
        self.assertEqual(argv[-1], ORIGIN + "/connect/redeem")


class FakeHTTP:
    calls = []; writable = True; identity = "new-agent"
    def __init__(self, config, key, timeout): self.url = config["url"]
    def request(self, method, path, body=None, **kwargs):
        if method != "GET" or body is not None: raise AssertionError("Unexpected write")
        self.calls.append(path)
        if path == "/v1/me": return {"agent": {"id": self.identity, "kind": "agent"}}
        if path.endswith("/channels"): return {"channels": [{"id": "coordination", "project_id": "existing-project", "can_write": self.writable}]}
        if path.endswith("/agents"): return {"agents": [{"id": "arbitrary-developer"}]}
        raise AssertionError("Unexpected request")


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mesh-connection-test-"); self.addCleanup(self.temp.cleanup)
        self.bundle = Path(self.temp.name) / "bundle"; self.bundle.mkdir(mode=0o700)
        installer.write_files(self.bundle, package_files())
        import native_bridge
        self.bridge = native_bridge
        FakeHTTP.calls = []; FakeHTTP.writable = True; FakeHTTP.identity = "new-agent"

    def invoke(self, args, available=()):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(self.bridge, "NativeHTTP", FakeHTTP), patch.object(connect.shutil, "which", side_effect=lambda name: "/fake/" + name if name in available else None), patch.object(connect.os, "execv") as execute, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = connect.main(args, bundle=self.bundle)
        self.assertNotIn(KEY, out.getvalue() + err.getvalue())
        return result, out.getvalue(), err.getvalue(), execute

    def test_check_reads_only_three_endpoints_and_reuses_binding(self):
        result, out, err, execute = self.invoke(["--check", "--runtime", "codex"])
        self.assertEqual(result, 0); self.assertEqual(err, ""); execute.assert_not_called()
        self.assertEqual(FakeHTTP.calls, ["/v1/me", "/v1/projects/existing-project/channels", "/v1/projects/existing-project/agents"])
        self.assertEqual(json.loads(out)["visible_other_agents"], 1)
        config = (self.bundle / "config.json").read_bytes()
        self.assertEqual(self.invoke(["--check"])[0], 0)
        self.assertEqual((self.bundle / "config.json").read_bytes(), config)
        self.assertEqual((self.bundle / "config.json").stat().st_mode & 0o777, 0o600)

    def test_binding_rejects_runtime_workspace_and_containing_bundle(self):
        self.invoke(["--check", "--runtime", "codex"])
        for args in (["--check", "--runtime", "claude"], ["--check", "--workspace", self.temp.name]):
            self.assertEqual(self.invoke(args)[0], 2)

    def test_identity_acl_and_missing_cli_fail_without_model(self):
        self.assertEqual(self.invoke([])[0], 2)
        FakeHTTP.identity = "other"; self.assertEqual(self.invoke(["--check", "--runtime", "codex"])[0], 2)
        FakeHTTP.identity = "new-agent"; FakeHTTP.writable = False
        self.assertEqual(self.invoke(["--check"])[0], 2)

    def test_auto_codex_prompt_and_explicit_claude_invitation(self):
        result, out, err, execute = self.invoke([], ("codex", "claude"))
        execute.assert_called_once(); argv = execute.call_args.args[1]
        self.assertEqual(argv[-2:], ["--", (self.bundle / "PROMPT.md").read_text()])
        self.assertEqual(json.loads((self.bundle / "config.json").read_text())["runtime"], "codex")
        self.assertNotIn(KEY, " ".join(argv))

    def test_invitation_selected_runtime_is_respected(self):
        value = profile(); value["runtime"] = "claude"; (self.bundle / "profile.json").write_text(json.dumps(value))
        result, out, err, execute = self.invoke([], ("codex", "claude"))
        execute.assert_called_once(); self.assertEqual(json.loads((self.bundle / "config.json").read_text())["runtime"], "claude")

    def test_prompt_secret_oversize_and_symlink_refused(self):
        prompt = self.bundle / "PROMPT.md"
        for content in (KEY, "x" * 32769):
            prompt.write_text(content)
            result, out, err, execute = self.invoke([], ("codex",)); self.assertEqual(result, 2); execute.assert_not_called()
        prompt.unlink(); prompt.symlink_to(self.bundle / "agent.key")
        result, out, err, execute = self.invoke([], ("codex",)); self.assertEqual(result, 2); execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
