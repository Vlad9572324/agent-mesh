import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

from artifact_client import ArtifactClient, digest, pack, relative_path, unpack, validate_bundle, write_new


class ArtifactBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "code.go").write_bytes(b"package main\n")
        (self.source / "sub").mkdir()
        (self.source / "sub/test.go").write_bytes(b"test\x00bytes\n")

    def test_roundtrip_new_directory_only(self):
        data = pack(self.source, ["sub/test.go", "code.go"], "base-v1")
        result = unpack(data, "base-v1", self.root / "receiver")
        self.assertEqual(result["files"], 2)
        self.assertEqual((self.root / "receiver/sub/test.go").read_bytes(), b"test\x00bytes\n")
        self.assertEqual((self.root / "receiver/code.go").stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            unpack(data, "base-v1", self.root / "receiver")

    def test_base_and_file_hash_are_mandatory(self):
        data = pack(self.source, ["code.go"], "base-v1")
        with self.assertRaises(ValueError):
            validate_bundle(data, "base-v2")
        obj = json.loads(data)
        obj["files"][0]["sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            validate_bundle(json.dumps(obj).encode(), "base-v1")

    def test_unsafe_and_duplicate_paths(self):
        for name in ["../file", "/absolute", "a/../b", "a//b", "a/./b", "a\\b", "C:/b", "line\nbreak", ""]:
            with self.subTest(name=name):
                self.assertFalse(relative_path(name))
                with self.assertRaises(ValueError):
                    pack(self.source, [name], "base")
        with self.assertRaises(ValueError):
            pack(self.source, ["code.go", "code.go"], "base")

    def test_symlinks_refused(self):
        (self.source / "link.go").symlink_to(self.source / "code.go")
        with self.assertRaises(ValueError):
            pack(self.source, ["link.go"], "base")
        (self.root / "outlink").symlink_to(self.source)
        with self.assertRaises(ValueError):
            unpack(pack(self.source, ["code.go"], "base"), "base", self.root / "outlink/new")

    def test_nested_conflict_and_duplicate_keys_refused(self):
        data = pack(self.source, ["code.go"], "base")
        obj = json.loads(data)
        obj["files"].append({**obj["files"][0], "path": "code.go/child"})
        with self.assertRaises(ValueError):
            validate_bundle(json.dumps(obj).encode(), "base")
        with self.assertRaises(ValueError):
            validate_bundle(data.replace(b'"format_version":1', b'"format_version":1,"format_version":1'), "base")

    def test_write_never_overwrites(self):
        path = self.root / "output"
        write_new(path, b"original")
        with self.assertRaises(FileExistsError):
            write_new(path, b"changed")
        self.assertEqual(path.read_bytes(), b"original")

    def test_transport_origin_and_private_keys(self):
        key = self.root / "key"
        key.write_text("a" * 64)
        key.chmod(0o600)
        for origin in ["http://192.0.2.10:8766", "https://name/path", "https://user:pass@name", "https://name?token=x"]:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                ArtifactClient(origin, key, allow_loopback_http=True)
        ArtifactClient("http://127.0.0.1:18766", key, allow_loopback_http=True)
        key.chmod(0o644)
        with self.assertRaises(ValueError):
            ArtifactClient("https://localhost:8766", key)

    def test_download_checks_metadata_before_fetch(self):
        client = object.__new__(ArtifactClient)
        calls = []
        data = b"payload"
        def request(path, **kwargs):
            calls.append(path)
            return {"artifact": {"id": "artifact", "project_id": "other", "sha256": digest(data), "base_revision": "base", "size_bytes": len(data)}}
        client.request = request
        with self.assertRaises(ValueError):
            client.download("artifact", digest(data), "base", expected_project="mine")
        self.assertEqual(len(calls), 1)

    def test_download_rehashes_bytes(self):
        client = object.__new__(ArtifactClient)
        good, bad = b"good", b"evil"
        def request(path, **kwargs):
            if kwargs.get("binary"):
                return bad
            return {"artifact": {"id": "artifact", "project_id": "mine", "sha256": digest(good), "base_revision": "base", "size_bytes": len(good)}}
        client.request = request
        with self.assertRaises(ValueError):
            client.download("artifact", digest(good), "base", expected_project="mine")


if __name__ == "__main__":
    unittest.main()
