"""Offline configuration fences; never read credentials or contact a service."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

PYTHON = ("operator_config.py", "native_activity_validation.py", "handoff_protocol.py", "swarm_protocol.py")
JAVASCRIPT = ("check-admin-rollout.mjs", "check-lifecycle-rollout.mjs", "check-lxc-migration.mjs")


def load(filename):
    spec = importlib.util.spec_from_file_location("operator_test_" + filename.replace("-", "_"), SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OperatorScriptConfigTests(unittest.TestCase):
    def test_imports_do_not_require_operator_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            for name in PYTHON:
                with self.subTest(name=name):
                    load(name)

    @unittest.skipUnless(shutil.which("node"), "Node is not installed")
    def test_javascript_missing_configuration_fails_before_state_access(self):
        for name in JAVASCRIPT:
            args = ["--vmid", "900"] if name == "check-lxc-migration.mjs" else []
            with self.subTest(name=name):
                result = subprocess.run([shutil.which("node"), str(SCRIPTS / name), *args],
                                        env={"PATH": os.defpath}, capture_output=True, timeout=10, check=False)
                self.assertNotEqual(result.returncode, 0)
                if name != "check-lxc-migration.mjs":
                    self.assertIn(b"AGENT_LINK_RUNTIME_DIR", result.stderr)
                    self.assertNotIn(b"ENOENT", result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node is not installed")
    def test_migration_target_settings_reject_shell_options_and_ambiguous_hostnames(self):
        code = """import assert from 'node:assert/strict';
import {targetSettings} from MODULE;
const good = {AGENT_LINK_SSH_HOST:'operator@hypervisor.example',
  AGENT_LINK_SOURCE_DB_PORT:'5432', AGENT_LINK_EXPECTED_HOSTNAME:'agent-mesh-fixture'};
assert.equal(targetSettings(good).expectedHostname, 'agent-mesh-fixture');
for (const [key, values] of Object.entries({
  AGENT_LINK_SSH_HOST:['-oProxyCommand=bad','host;command','user@host command','host\\ncommand'],
  AGENT_LINK_SOURCE_DB_PORT:['0','65536','-1','5432;command'],
  AGENT_LINK_EXPECTED_HOSTNAME:['host.example','-host','host-','host;command', 'x'.repeat(64)]})) {
  for (const value of values) assert.throws(() => targetSettings({...good,[key]:value}));
}
assert.throws(() => targetSettings({}));
""".replace("MODULE", json.dumps((SCRIPTS / "check-lxc-migration.mjs").as_uri()))
        result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", code],
                                env={"PATH": os.defpath}, capture_output=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_no_operator_home_topology_or_dated_workspace_literals(self):
        # General patterns, not a list that reproduces the private values removed.
        forbidden = re.compile(r"/(?:home|root)/|192\.168\.[0-9]+\.[0-9]+|"
                               r"\b(?:node|lxc)-[0-9]+\b|"
                               r"trial-[A-Za-z-]*20[0-9]{6}|[\"'][0-9a-f]{40}[\"']")
        for name in (*PYTHON, *JAVASCRIPT):
            with self.subTest(name=name):
                self.assertIsNone(forbidden.search((SCRIPTS / name).read_text()))


if __name__ == "__main__":
    unittest.main()
