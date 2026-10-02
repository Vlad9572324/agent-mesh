"""Offline release-contract tests; fake Go builds never start a service/model."""

import gzip
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("build_release", Path(__file__).with_name("build-release.py"))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agent-mesh-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.commit = "a" * 40
        self.epoch = 1790899200

    def test_fixed_connector_dependency_closure_includes_opt_in_listener(self):
        self.assertEqual(set(release.CONNECTOR_FILES), {
            "scripts/agent-link-cli.py", "scripts/native_launch.py",
            "scripts/agent-link-hook.py", "scripts/agent-link-mcp.py",
            "adapters/native_bridge.py", "adapters/native_hooks.py", "adapters/native_mcp.py",
            "scripts/agent-link-listener.py", "adapters/task_listener.py",
            "adapters/coordination.py", "scripts/dev_trial_runtimes.py",
            "scripts/artifact_client.py", "scripts/agent-link-artifacts.py",
            "docs/task-listener.md", "listener-contract.json",
        })
        for name in (*release.CONNECTOR_FILES, *release.WEB_FILES, *release.BUILD_FILES):
            self.assertNotIn("test_", name)
            self.assertNotIn("_test.", name)
            self.assertNotIn("smoke", name)
            if name != "scripts/dev_trial_runtimes.py":
                self.assertNotIn("trial", name)
            self.assertNotIn("__pycache__", name)
            self.assertNotIn("deploy/", name)
        self.assertEqual(set(release.WEB_FILES), {"web/index.html", "web/app.js", "web/app.css"})

    def test_manifest_paths_are_strictly_relative_unique_and_canonical(self):
        for name in ("", "/absolute", "../up", "a/../b", "a/./b", "a//b", "a/",
                     "a\\b", "a\0b", "a\nb", "a b", "./file", "C:/file"):
            with self.subTest(name=name), self.assertRaises(release.ReleaseError):
                release.validate_manifest([name])
        with self.assertRaises(release.ReleaseError):
            release.validate_manifest(["web/app.js", "web/app.js"])
        self.assertEqual(release.validate_manifest(["web/app.js"]), ("web/app.js",))

    def test_version_cannot_inject_paths_or_linker_arguments(self):
        self.assertEqual(release.validate_version("v0.1.0-rc.1"), "v0.1.0-rc.1")
        for value in ("0.1.0", "v01.0.0", "v1.0", "../v1.0.0", "v1.0.0\n", "v1.0.0 -X secret=x"):
            with self.subTest(value=value), self.assertRaises(release.ReleaseError):
                release.validate_version(value)

    def test_install_guide_renders_stable_and_prerelease_versions_only_in_memory(self):
        source = (b"<!-- release-install-version: v0.1.0-rc.1 -->\n"
                  b"# Install v0.1.0-rc.1\n"
                  b"agent-mesh_v0.1.0-rc.1_linux_amd64.tar.gz\n"
                  b"https://github.com/example/repo/blob/v0.1.0-rc.1/docs/operations.md\n"
                  b"Unrelated v9.8.7, scripts/agent-link-cli.py, AGENT_LINK_DATABASE_URL\n")
        for version in ("v0.2.0", "v2.3.4-rc.2", "v0.1.0-rc.1"):
            with self.subTest(version=version):
                rendered = release.render_install_guide(source, version)
                self.assertEqual(rendered, source.replace(b"v0.1.0-rc.1", version.encode()))
                self.assertIn(b"Unrelated v9.8.7, scripts/agent-link-cli.py, AGENT_LINK_DATABASE_URL", rendered)
        self.assertIn(b"# Install v0.1.0-rc.1\n", source)

    def test_install_guide_rejects_missing_duplicate_or_malformed_version_markers(self):
        marker = b"<!-- release-install-version: v0.1.0-rc.1 -->\n"
        invalid = (b"# Unmarked guide\n", marker + marker,
                   marker + b"<!-- release-install-version: v1.2.3 -->\n",
                   marker + b"release-install-version: malformed\n",
                   b" <!-- release-install-version: v0.1.0-rc.1 -->\n",
                   b"<!-- release-install-version: v01.0.0 -->\n",
                   b"<!-- release-install-version: v1.0.0 -- >\n",
                   marker + b"\xff")
        for source in invalid:
            with self.subTest(source=source), self.assertRaises(release.ReleaseError):
                release.render_install_guide(source, "v0.2.0")
        with self.assertRaises(release.ReleaseError):
            release.render_install_guide(marker, "v0.2.0\n")

    def test_real_install_guide_renders_future_links_archive_names_and_identity(self):
        source = (Path(__file__).resolve().parents[1] / release.INSTALL_SOURCE).read_bytes()
        for version in ("v1.0.0", "v1.0.0-rc.2"):
            with self.subTest(version=version):
                rendered = release.render_install_guide(source, version)
                self.assertNotIn(b"v0.1.0-rc.1", rendered)
                for suffix in ("linux_amd64", "connectors"):
                    self.assertIn(("agent-mesh_" + version + "_" + suffix + ".tar.gz").encode(), rendered)
                self.assertIn(("/releases/tag/" + version).encode(), rendered)
                self.assertIn(("/blob/" + version + "/docs/operations.md").encode(), rendered)
                self.assertIn(("`version` to be `" + version + "`").encode(), rendered)
                self.assertIn(b"scripts/agent-link-cli.py", rendered)
        self.assertEqual((Path(__file__).resolve().parents[1] / release.INSTALL_SOURCE).read_bytes(), source)

    def test_read_manifest_uses_only_requested_committed_blob_ids(self):
        tree = {"web/app.js": ("100644", "blob", "b" * 40),
                "runtime/private.key": ("100600", "blob", "c" * 40)}
        with patch.object(release, "git", return_value=b"committed content") as git:
            result = release.read_manifest(self.root, tree, ("web/app.js",))
        self.assertEqual(result, {"web/app.js": b"committed content"})
        git.assert_called_once_with(self.root, "cat-file", "blob", "b" * 40)

    def test_manifest_rejects_missing_symlink_gitlink_and_nonregular_entries(self):
        for entry in (None, ("120000", "blob", "a" * 40),
                      ("160000", "commit", "a" * 40), ("040000", "tree", "a" * 40)):
            tree = {} if entry is None else {"web/app.js": entry}
            with self.subTest(entry=entry), patch.object(release, "git") as git:
                with self.assertRaises(release.ReleaseError):
                    release.read_manifest(self.root, tree, ("web/app.js",))
                git.assert_not_called()

    def test_license_sources_require_regular_committed_files(self):
        self.assertEqual(release.LICENSE_FILES, ("LICENSE", "NOTICE"))
        for name in release.LICENSE_FILES:
            for entry in (None, ("120000", "blob", "a" * 40),
                          ("160000", "commit", "a" * 40), ("040000", "tree", "a" * 40)):
                tree = {} if entry is None else {name: entry}
                with self.subTest(name=name, entry=entry), patch.object(release, "git") as git:
                    with self.assertRaises(release.ReleaseError):
                        release.read_manifest(self.root, tree, (name,))
                    git.assert_not_called()

    def test_new_build_inputs_require_allowlist_review_but_tests_are_not_inputs(self):
        tree = dict.fromkeys((*release.BUILD_FILES, "internal/link/new_test.go", "docs/example.md"))
        release.validate_build_inputs(tree)
        for name in ("internal/link/new.go", "cmd/agent-link/secret.key", "internal/link/new_schema.sql"):
            with self.subTest(name=name), self.assertRaises(release.ReleaseError):
                release.validate_build_inputs({**tree, name: None})

    def test_output_rejects_existing_file_directory_and_symlink(self):
        existing_file = self.root / "file"
        existing_file.write_bytes(b"keep")
        existing_dir = self.root / "dir"
        existing_dir.mkdir()
        link = self.root / "link"
        link.symlink_to(self.root / "missing")
        parent_link = self.root / "parent-link"
        parent_link.symlink_to(existing_dir, target_is_directory=True)
        for output in (existing_file, existing_dir, link, parent_link / "new",
                       Path("relative"), Path("/"), self.root / ".." / "new",
                       self.root / "missing-parent" / "new"):
            with self.subTest(output=output), self.assertRaises(release.ReleaseError):
                release.validate_output(output)
        self.assertEqual(existing_file.read_bytes(), b"keep")
        self.assertEqual(release.validate_output(self.root / "new"), self.root / "new")

    def test_archives_are_deterministic_sorted_regular_and_normalized(self):
        first = self.root / "first.tar.gz"
        second = self.root / "second.tar.gz"
        files = {"web/app.js": b"app", "bin/agent-mesh": b"binary", "INSTALL.md": b"guide"}
        release.write_archive(first, "agent-mesh_v0.1.0-rc.1_linux_amd64", files, self.epoch)
        release.write_archive(second, "agent-mesh_v0.1.0-rc.1_linux_amd64",
                              dict(reversed(list(files.items()))), self.epoch)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(int.from_bytes(first.read_bytes()[4:8], "little"), self.epoch)
        self.assertEqual(first.read_bytes()[3], 0)  # No gzip filename/comment flags.
        with tarfile.open(first, "r:gz") as archive:
            members = archive.getmembers()
            self.assertEqual([m.name.rsplit("/", 1)[-1] for m in members], ["INSTALL.md", "agent-mesh", "app.js"])
            for member in members:
                self.assertTrue(member.isfile())
                self.assertEqual((member.uid, member.gid, member.uname, member.gname), (0, 0, "", ""))
                self.assertEqual(member.mtime, self.epoch)
                self.assertEqual(member.mode, 0o755 if member.name.endswith("/bin/agent-mesh") else 0o644)
                self.assertFalse(member.pax_headers)
            self.assertEqual(archive.extractfile(members[1]).read(), b"binary")
        self.assertTrue(gzip.decompress(first.read_bytes()))

    def test_archive_refuses_overwrite_and_unsafe_names_before_creation(self):
        path = self.root / "asset.tar.gz"
        path.write_bytes(b"keep")
        with self.assertRaises(FileExistsError):
            release.write_archive(path, "root", {"file": b"data"}, self.epoch)
        self.assertEqual(path.read_bytes(), b"keep")
        for root, files in (("../root", {"file": b"data"}), ("root", {"../outside": b"data"})):
            with self.assertRaises(release.ReleaseError):
                release.write_archive(self.root / "new.tar.gz", root, files, self.epoch)
            self.assertFalse((self.root / "new.tar.gz").exists())

    def test_metadata_and_build_environment_ignore_caller_overrides(self):
        info = release.metadata("v0.1.0-rc.1", self.commit, self.epoch, "go1.23.2")
        self.assertEqual(info["version"], "v0.1.0-rc.1")
        self.assertEqual(info["source_commit"], self.commit)
        self.assertEqual(info["build_date"], "2026-10-02T00:00:00Z")
        self.assertEqual(info["target"], {"goos": "linux", "goarch": "amd64"})
        self.assertEqual(info["packaging_version"], 3)
        with patch.dict(os.environ, {"GOFLAGS": "-tags=unsafe", "CGO_ENABLED": "1", "GOOS": "windows",
                                    "GOWORK": "/outside/go.work", "SOURCE_DATE_EPOCH": "0", "GOPROXY": "https://example.invalid"}):
            env = release.build_environment(self.epoch)
        self.assertEqual(env["GOFLAGS"], "")
        self.assertEqual(env["CGO_ENABLED"], "0")
        self.assertEqual(env["GOOS"], "linux")
        self.assertEqual(env["GOARCH"], "amd64")
        self.assertEqual(env["GOAMD64"], "v1")
        self.assertEqual(env["GOENV"], "off")
        self.assertEqual(env["GOWORK"], "off")
        self.assertEqual(env["GOTOOLCHAIN"], "local")
        self.assertEqual(env["GOPROXY"], "off")
        self.assertEqual(env["SOURCE_DATE_EPOCH"], str(self.epoch))
        for epoch in (-1, 2**32, True):
            with self.assertRaises(release.ReleaseError):
                release.metadata("v0.1.0", self.commit, epoch, "go1.23.2")
        with self.assertRaises(release.ReleaseError):
            release.metadata("v0.1.0", self.commit, self.epoch, "devel go1.99")

    def test_build_flags_pin_version_commit_and_reproducible_date(self):
        info = release.metadata("v0.1.0-rc.1", self.commit, self.epoch, "go1.23.2")
        env = release.build_environment(self.epoch)
        with patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            release.build_binary(self.root, self.root / "bin", info, env)
        argv = run.call_args.args[0]
        self.assertIn("-trimpath", argv)
        self.assertIn("-buildvcs=false", argv)
        self.assertIn("-mod=readonly", argv)
        ldflags = argv[argv.index("-ldflags") + 1]
        for value in ("main.version=v0.1.0-rc.1", "main.commit=" + self.commit,
                      "main.buildDate=" + info["build_date"], "-buildid="):
            self.assertIn(value, ldflags)
        self.assertEqual(run.call_args.kwargs["env"], env)

    def test_clean_checkout_rejects_dirty_untracked_or_changed_head(self):
        for status in (b" M file\0", b"A  file\0", b"?? untracked.key\0"):
            with patch.object(release, "git", return_value=status), self.assertRaises(release.ReleaseError):
                release.clean_commit(self.root)
        with patch.object(release, "git", side_effect=[b"", (self.commit + "\n").encode()]):
            self.assertEqual(release.clean_commit(self.root), self.commit)
        with patch.object(release, "git", side_effect=[b"", (self.commit + "\n").encode()]):
            with self.assertRaises(release.ReleaseError):
                release.clean_commit(self.root, expected="b" * 40)

    def test_publish_refuses_any_existing_output_and_preserves_it(self):
        staging = self.root / "staging"
        staging.mkdir()
        (staging / "asset").write_bytes(b"new")
        output = self.root / "output"
        output.mkdir()
        (output / "asset").write_bytes(b"keep")
        with self.assertRaises(release.ReleaseError):
            release.publish(staging, output, ["asset"])
        self.assertEqual((output / "asset").read_bytes(), b"keep")
        with self.assertRaises(release.ReleaseError):
            release.publish(staging, self.root / "new", ["subdir/asset"])
        self.assertFalse((self.root / "new").exists())

    def test_complete_release_contract_and_repeatability_with_fake_offline_build(self):
        names = tuple(dict.fromkeys((*release.BUILD_FILES, *release.EMBED_FILES, *release.WEB_FILES,
                                    *release.CONNECTOR_FILES, *release.LICENSE_FILES,
                                    release.INSTALL_SOURCE, release.NOTICES_SOURCE, "scripts/build-release.py")))
        blobs = {name: ("committed:" + name).encode() for name in names}
        blobs["scripts/build-release.py"] = Path(release.__file__).read_bytes()
        blobs[release.INSTALL_SOURCE] = (b"<!-- release-install-version: v0.1.0-rc.1 -->\n"
                                         b"# Install v0.1.0-rc.1\n")
        for name in release.LICENSE_FILES:
            blobs[name] = (Path(__file__).resolve().parents[1] / name).read_bytes()
        tree = {name: ("100644", "blob", "b" * 40) for name in names}

        def fake_git(repo, *args):
            if args == ("rev-parse", "--show-toplevel"):
                return (str(self.root) + "\n").encode()
            if args[:3] == ("show", "-s", "--format=%ct"):
                return str(self.epoch).encode()
            raise AssertionError(args)

        def fake_build(source, binary, info, env):
            self.assertEqual({str(p.relative_to(source)) for p in source.rglob("*") if p.is_file()}, set((*release.BUILD_FILES, *release.EMBED_FILES)))
            for name in (*release.BUILD_FILES, *release.EMBED_FILES):
                self.assertEqual((source / name).read_bytes(), blobs[name])
            binary.write_bytes(b"fake-offline-go-binary")

        with patch.object(release, "git", side_effect=fake_git), \
                patch.object(release, "clean_commit", return_value=self.commit) as clean, \
                patch.object(release, "source_tree", return_value=tree), \
                patch.object(release, "read_manifest", return_value=blobs) as manifest, \
                patch.object(release, "build_binary", side_effect=fake_build), \
                patch.object(release.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"go1.23.2\n", b"")):
            info = release.release(self.root, "v0.1.0-rc.1", self.root / "first")
            release.release(self.root, "v0.1.0-rc.1", self.root / "second")
            release.release(self.root, "v0.2.0", self.root / "future")
        self.assertEqual(clean.call_count, 6)
        manifest.assert_called_with(self.root, tree, names)
        clean.assert_called_with(self.root, expected=self.commit)
        first, second = self.root / "first", self.root / "second"
        expected = {"agent-mesh_v0.1.0-rc.1_linux_amd64.tar.gz", "agent-mesh_v0.1.0-rc.1_connectors.tar.gz",
                    "RELEASE.json", "SHA256SUMS"}
        self.assertEqual({p.name for p in first.iterdir()}, expected)
        self.assertEqual(json.loads((first / "RELEASE.json").read_bytes()), info)
        for name in expected:
            self.assertEqual((first / name).read_bytes(), (second / name).read_bytes())
        checksums = (first / "SHA256SUMS").read_text().splitlines()
        self.assertEqual(len(checksums), 3)
        for line in checksums:
            digest, name = line.split("  ")
            self.assertEqual(digest, release.file_sha256(first / name))
        for kind, payload in (("linux_amd64", {"bin/agent-mesh", *release.WEB_FILES}),
                              ("connectors", set(release.CONNECTOR_FILES))):
            root = "agent-mesh_v0.1.0-rc.1_" + kind
            with tarfile.open(first / (root + ".tar.gz"), "r:gz") as archive:
                files = {member.name: archive.extractfile(member).read() for member in archive.getmembers()}
            self.assertEqual(set(files), {root + "/" + name for name in payload |
                             {"INSTALL.md", "RELEASE.json", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"}})
            self.assertEqual(len(files), 9 if kind == "linux_amd64" else 20)
            self.assertEqual(files[root + "/RELEASE.json"], (first / "RELEASE.json").read_bytes())
            self.assertEqual(files[root + "/INSTALL.md"], blobs[release.INSTALL_SOURCE])
            self.assertEqual(files[root + "/THIRD_PARTY_NOTICES.md"], blobs[release.NOTICES_SOURCE])
            for name in release.LICENSE_FILES:
                self.assertEqual(files[root + "/" + name], blobs[name])
            future_root = "agent-mesh_v0.2.0_" + kind
            with tarfile.open(self.root / "future" / (future_root + ".tar.gz"), "r:gz") as archive:
                guide = archive.extractfile(future_root + "/INSTALL.md").read()
            self.assertEqual(guide, blobs[release.INSTALL_SOURCE].replace(b"v0.1.0-rc.1", b"v0.2.0"))


if __name__ == "__main__":
    unittest.main()
