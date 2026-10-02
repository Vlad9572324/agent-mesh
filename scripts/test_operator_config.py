import os
from pathlib import Path
import tempfile
import unittest

from operator_config import (REPOSITORY_ROOT, browser_executable, certificate_file,
                             required_env, required_path, runtime_dir, service_origin)


class OperatorConfigTests(unittest.TestCase):
    def test_missing_and_malformed_values(self):
        for value in (None, "", " padded", "padded ", "bad\nvalue", "bad\x00value"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                required_env("SETTING", {"SETTING": value})

    def test_absolute_paths_only(self):
        for value in ("relative", "~/private", "https://example.test"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                required_path("SETTING", {"SETTING": value})
        self.assertEqual(required_path("SETTING", {"SETTING": "/tmp/fixture/path"}), Path("/tmp/fixture/path"))

    def test_runtime_outside_checkout_and_not_broad(self):
        for path in (Path("/"), Path.home(), REPOSITORY_ROOT, REPOSITORY_ROOT / "state", REPOSITORY_ROOT.parent):
            with self.subTest(path=path), self.assertRaises(ValueError):
                runtime_dir({"AGENT_LINK_RUNTIME_DIR": str(path)})

    def test_runtime_resolution_and_no_creation(self):
        with tempfile.TemporaryDirectory(prefix="agent-mesh-config-") as directory:
            root = Path(directory)
            selected = root / "not-created"
            self.assertEqual(runtime_dir({"AGENT_LINK_RUNTIME_DIR": str(selected)}), selected)
            self.assertFalse(selected.exists())
            (root / "link").symlink_to(REPOSITORY_ROOT, target_is_directory=True)
            with self.assertRaises(ValueError):
                runtime_dir({"AGENT_LINK_RUNTIME_DIR": str(root / "link" / "state")})
            (root / "file").write_text("fixture")
            with self.assertRaises(ValueError):
                runtime_dir({"AGENT_LINK_RUNTIME_DIR": str(root / "file")})

    def test_only_bare_https_origins(self):
        for value in ("http://127.0.0.1:8766", "https://user:pass@example.test",
                      "https://example.test/path", "https://example.test/?q=x",
                      "https://example.test/#x", "https://example.test/..",
                      "https://example.test\\path", "https://example.test:99999", "https://exa mple.test"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                service_origin({"AGENT_LINK_ORIGIN": value})
        self.assertEqual(service_origin({"AGENT_LINK_ORIGIN": "https://example.test:8766/"}), "https://example.test:8766")

    def test_ca_and_browser_are_required(self):
        for function in (certificate_file, browser_executable):
            with self.assertRaises(ValueError):
                function({})
        with tempfile.TemporaryDirectory(prefix="agent-mesh-config-files-") as directory:
            root = Path(directory)
            browser = root / "browser-target"
            browser.write_text("fixture; never executed")
            alias = root / "browser-alias"
            alias.symlink_to(browser)
            certificate = root / "ca.crt"
            self.assertEqual(certificate_file({"AGENT_LINK_CA_FILE": str(certificate)}), certificate.resolve())
            self.assertEqual(browser_executable({"AGENT_LINK_CHROME": str(alias)}), browser.resolve())


if __name__ == "__main__":
    unittest.main()
