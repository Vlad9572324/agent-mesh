"""Build identity stays local to loaded connector and independently observed server."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import native_bridge as native
from test_native_bridge import FakeAPI
import test_native_hooks as hook_tests


class BuildIdentityTests(unittest.TestCase):
    def setUp(self):
        hook_tests.RealBridgeHookTests.setUp(self)
        self.api = FakeAPI()

    def test_status_reports_distinct_builds_and_does_not_reuse_stale_server_identity(self):
        original = self.api.request
        advertised = {'version': 'v0.2.0', 'source_commit': 'b' * 40}

        def request(method, path, body=None, **kwargs):
            result = original(method, path, body, **kwargs)
            if path == '/v1/me' and advertised:
                result['server_build'] = dict(advertised)
            return result

        self.api.request = request
        bridge = self.factory(str(self.config_path), hook_tests.SESSION)
        self.addCleanup(bridge.close)
        with patch.object(native, 'CONNECTOR_BUILD', {'version': 'v0.1.0', 'source_commit': 'a' * 40}):
            status = bridge.status()
            self.assertEqual(status['connector_version'], 'v0.1.0')
            self.assertEqual(status['connector_source_commit'], 'a' * 40)
            self.assertEqual(status['server_version'], 'v0.2.0')
            self.assertEqual(status['server_source_commit'], 'b' * 40)
            self.assertEqual(status['connector_identity_source'], 'release_metadata')
            self.assertEqual(status['server_identity_source'], 'authenticated_api')
            self.assertEqual(len(self.api.calls), 2)  # existing authorization calls only
            advertised.clear()  # older server or rollback has no metadata
            status = bridge.status()
            self.assertIsNone(status['server_version'])
            self.assertIsNone(status['server_source_commit'])
            self.assertEqual(status['server_identity_source'], 'unavailable')
            self.assertEqual(status['connector_version'], 'v0.1.0')
        self.assertNotIn(bridge.key, json.dumps(status))

    def test_unstamped_checkout_and_old_server_remain_usable(self):
        bridge = self.factory(str(self.config_path), hook_tests.SESSION)
        self.addCleanup(bridge.close)
        with patch.object(native, 'CONNECTOR_BUILD', None):
            status = bridge.status()
        self.assertIsNone(status['connector_version'])
        self.assertIsNone(status['connector_source_commit'])
        self.assertIsNone(status['server_version'])
        self.assertEqual(status['agent_id'], 'a')

    def test_package_metadata_is_bounded_regular_and_validated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / 'RELEASE.json'
            self.assertIsNone(native.connector_build(root))
            for body in (b'{', b'\xff', b'x' * 32769,
                         b'{"version":"v1.0.0","version":"v2.0.0","source_commit":"unknown"}',
                         b'{"version":"private path or credential","source_commit":"unknown"}'):
                path.write_bytes(body)
                self.assertIsNone(native.connector_build(root))
            path.write_text(json.dumps({'version': 'dev', 'source_commit': 'unknown'}))
            self.assertEqual(native.connector_build(root), {'version': 'dev', 'source_commit': None})
            path.unlink()
            target = root / 'target.json'
            target.write_text(json.dumps({'version': 'v1.0.0', 'source_commit': 'a' * 40}))
            path.symlink_to(target)
            self.assertIsNone(native.connector_build(root))

    def test_running_module_keeps_loaded_stamp_until_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'adapters').mkdir()
            source = root / 'adapters' / 'native_bridge.py'
            source.write_bytes(Path(native.__file__).read_bytes())
            stamp = root / 'RELEASE.json'
            stamp.write_text(json.dumps({'version': 'v1.0.0', 'source_commit': 'a' * 40}))
            spec = importlib.util.spec_from_file_location('isolated_connector_build', source)
            loaded = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(loaded)
            stamp.write_text(json.dumps({'version': 'v2.0.0', 'source_commit': 'b' * 40}))
            self.assertEqual(loaded.CONNECTOR_BUILD['version'], 'v1.0.0')
            self.assertEqual(loaded.CONNECTOR_BUILD['source_commit'], 'a' * 40)
            reloaded = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(reloaded)
            self.assertEqual(reloaded.CONNECTOR_BUILD['version'], 'v2.0.0')


if __name__ == '__main__':
    unittest.main()
