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
import sqlite3
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
GUIDANCE_NAMES = ("PROMPT.md", "SKILL.md", "HOOKS-AND-TOOLS.md")
paths = ["connect.py", "README.md", *GUIDANCE_NAMES, "profile.json", "agent.key", "ca.crt"]
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
        elif name in ("connect.py", "README.md", *GUIDANCE_NAMES):
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
        for name in GUIDANCE_NAMES:
            self.assertEqual((path / name).read_bytes(), (ROOT / "onboarding" / name).read_bytes())

    def test_missing_or_tampered_guidance_refuses_before_exec(self):
        for name in GUIDANCE_NAMES:
            for missing in (True, False):
                with self.subTest(name=name, missing=missing):
                    files = package_files()
                    if missing:
                        files.pop(name)
                    else:
                        files[name] += b"\nUntrusted changed guidance\n"
                    path = self.root / (name + ("-missing" if missing else "-tampered"))
                    with patch.object(installer, "redeem", return_value=archive(files)) as redeem, \
                            patch.object(installer.os, "execv") as execute, contextlib.redirect_stderr(io.StringIO()):
                        result = installer.main([ORIGIN, PIN, TOKEN, "--install-dir", str(path), "--check", "--runtime", "codex"])
                    self.assertEqual(result, 2)
                    redeem.assert_called_once()
                    execute.assert_not_called()
                    self.assertFalse(path.exists())

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

    def invoke(self, args, available=(), before_exec=None):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(self.bridge, "NativeHTTP", FakeHTTP), patch.object(connect.shutil, "which", side_effect=lambda name: "/fake/" + name if name in available else None), patch.object(connect.os, "execv", side_effect=before_exec) as execute, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
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
        self.assertTrue(json.loads(out)["skill_ready"])
        self.assertEqual(Path(json.loads(out)["skill_path"]), self.skill_directory() / "SKILL.md")

    def skill_directory(self, workspace=None, runtime="codex"):
        return (workspace or self.bundle / "workspace") / (".agents" if runtime == "codex" else ".claude") / "skills/agent-mesh-communication"

    def assert_skill_ready(self, workspace=None, runtime="codex"):
        directory = self.skill_directory(workspace, runtime)
        for name in ("SKILL.md", "HOOKS-AND-TOOLS.md"):
            self.assertEqual((directory / name).read_bytes(), (self.bundle / name).read_bytes())
        self.assertFalse(list(directory.glob(".agent-mesh-*")))
        return directory

    def test_both_runtimes_install_complete_skill_before_normal_cli_launch(self):
        for runtime in ("codex", "claude"):
            with self.subTest(runtime=runtime):
                self.bundle = Path(self.temp.name) / ("bundle-" + runtime)
                self.bundle.mkdir(mode=0o700)
                installer.write_files(self.bundle, package_files())
                result, out, err, execute = self.invoke(["--runtime", runtime], (runtime,),
                    before_exec=lambda *_: self.assert_skill_ready(runtime=runtime))
                execute.assert_called_once()
                directory = self.assert_skill_ready(runtime=runtime)
                for target in (directory, *directory.iterdir()):
                    self.assertEqual(target.stat().st_mode & 0o777, 0o700 if target.is_dir() else 0o600)
                other = ".claude" if runtime == "codex" else ".agents"
                self.assertFalse((self.bundle / "workspace" / other).exists())

    def test_check_installs_in_explicit_workspace_and_leaves_home_untouched(self):
        home = Path(self.temp.name) / "home"; home.mkdir()
        (home / "existing-settings").write_text("preserve")
        for runtime in ("codex", "claude"):
            with self.subTest(runtime=runtime):
                self.bundle = Path(self.temp.name) / ("explicit-bundle-" + runtime)
                self.bundle.mkdir(mode=0o700); installer.write_files(self.bundle, package_files())
                workspace = Path(self.temp.name) / ("work space-" + runtime); workspace.mkdir()
                (workspace / "existing.txt").write_text("user work")
                with patch.object(Path, "home", return_value=home) as global_home:
                    result, out, err, execute = self.invoke(["--check", "--runtime", runtime, "--workspace", str(workspace)])
                global_home.assert_not_called()
                self.assertEqual(result, 0); execute.assert_not_called()
                directory = self.assert_skill_ready(workspace, runtime)
                self.assertEqual(json.loads(out)["skill_path"], str(directory / "SKILL.md"))
                self.assertEqual((workspace / "existing.txt").read_text(), "user work")
                self.assertEqual(set(p.name for p in home.iterdir()), {"existing-settings"})
                self.assertEqual((home / "existing-settings").read_text(), "preserve")

    def test_reconnect_reuses_identical_files_configuration_and_queued_work(self):
        self.assertEqual(self.invoke(["--check", "--runtime", "codex"])[0], 0)
        directory = self.assert_skill_ready()
        files = [self.bundle / "config.json", directory / "SKILL.md", directory / "HOOKS-AND-TOOLS.md"]
        before = {path: (path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns) for path in files}
        database = self.bundle / "native-state/native.sqlite"
        with sqlite3.connect(database) as db:
            db.execute("INSERT INTO outbox (id,kind,path,method,payload,state,created_at) VALUES (?,?,?,?,?,?,?)",
                       ("preserved", "message", "/fixture", "POST", "{}", "pending", 1))
        result, out, err, execute = self.invoke(["--check"])
        self.assertEqual(result, 0); execute.assert_not_called()
        self.assertEqual({path: (path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns) for path in files}, before)
        with sqlite3.connect(database) as db:
            self.assertEqual(db.execute("SELECT id,payload,state FROM outbox").fetchall(), [("preserved", "{}", "pending")])

    def test_existing_skill_conflict_preserves_both_files_and_refuses_launch(self):
        for conflicting_name in ("SKILL.md", "HOOKS-AND-TOOLS.md"):
            with self.subTest(name=conflicting_name):
                workspace = Path(self.temp.name) / ("conflict-" + conflicting_name); workspace.mkdir()
                directory = self.skill_directory(workspace); directory.mkdir(parents=True)
                target = directory / conflicting_name; target.write_text("Existing user instructions")
                self.bundle = Path(self.temp.name) / ("conflict-bundle-" + conflicting_name)
                self.bundle.mkdir(mode=0o700); installer.write_files(self.bundle, package_files())
                result, out, err, execute = self.invoke(["--workspace", str(workspace)], ("codex",))
                self.assertEqual(result, 2); execute.assert_not_called()
                self.assertIn("existing workspace skill file", err)
                self.assertEqual(list(directory.iterdir()), [target])
                self.assertEqual(target.read_text(), "Existing user instructions")

    def test_skill_parent_and_file_symlinks_cannot_redirect_writes(self):
        for relative in (".agents", ".agents/skills", ".agents/skills/agent-mesh-communication",
                         ".agents/skills/agent-mesh-communication/SKILL.md",
                         ".agents/skills/agent-mesh-communication/HOOKS-AND-TOOLS.md"):
            with self.subTest(path=relative):
                base = Path(tempfile.mkdtemp(dir=self.temp.name))
                workspace = base / "workspace"; workspace.mkdir()
                outside = base / "outside"; outside.mkdir()
                (outside / "sentinel").write_text("untouched")
                target = workspace / relative; target.parent.mkdir(parents=True, exist_ok=True)
                if target.name.endswith(".md"):
                    source = outside / target.name; source.write_bytes((self.bundle / target.name).read_bytes())
                else:
                    source = outside
                before = {p.name: p.read_bytes() for p in outside.iterdir()}
                target.symlink_to(source, target_is_directory=source.is_dir())
                self.bundle = base / "bundle"; self.bundle.mkdir(mode=0o700)
                installer.write_files(self.bundle, package_files())
                result, out, err, execute = self.invoke(["--workspace", str(workspace)], ("codex",))
                self.assertEqual(result, 2); execute.assert_not_called()
                self.assertIn("linked, conflicting or inaccessible", err)
                self.assertTrue(target.is_symlink())
                self.assertEqual({p.name: p.read_bytes() for p in outside.iterdir()}, before)

    def test_explicit_workspace_symlink_ancestor_is_refused(self):
        real = Path(self.temp.name) / "real"; (real / "workspace").mkdir(parents=True)
        alias = Path(self.temp.name) / "alias"; alias.symlink_to(real, target_is_directory=True)
        result, out, err, execute = self.invoke(["--check", "--runtime", "codex", "--workspace", str(alias / "workspace")])
        self.assertEqual(result, 2); execute.assert_not_called()
        self.assertIn("symlinks", err)
        self.assertEqual(list((real / "workspace").iterdir()), [])

    def test_access_failure_prevents_skill_installation(self):
        FakeHTTP.writable = False
        result, out, err, execute = self.invoke(["--check", "--runtime", "codex"])
        self.assertEqual(result, 2); execute.assert_not_called()
        self.assertFalse((self.bundle / "workspace/.agents").exists())

    def test_invalid_or_secret_guidance_never_reaches_workspace_or_cli(self):
        for name in GUIDANCE_NAMES:
            target = self.bundle / name; original = target.read_bytes()
            for content in (KEY.encode(), b"x" * 32769, b"\x00invalid", b"\xff", b"  \n"):
                with self.subTest(name=name, content_kind=len(content)):
                    target.write_bytes(content)
                    result, out, err, execute = self.invoke(["--check", "--runtime", "codex"])
                    self.assertEqual(result, 2); execute.assert_not_called()
                    self.assertFalse((self.bundle / "workspace/.agents").exists())
            target.unlink(); target.symlink_to(self.bundle / "agent.key")
            self.assertEqual(self.invoke(["--check", "--runtime", "codex"])[0], 2)
            self.assertFalse((self.bundle / "workspace/.agents").exists())
            target.unlink(); target.write_bytes(original); target.chmod(0o600)

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
