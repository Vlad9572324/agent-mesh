"""Bounded peer-directory tests: fake HTTP, real private SQLite, no models."""
import copy
import json
import unittest

import native_bridge as native
import test_native_bridge as bridge_tests
import test_native_hooks as hook_tests


def peer(identity='b', channels=None, **changes):
    return {'id': identity, 'kind': 'agent', 'name': 'Peer ' + identity,
            'channel_ids': ['c'] if channels is None else channels,
            'runtime': 'legacy-runtime', 'session_id': 'not-a-native-presence-proof',
            'activity': 'must-not-be-forwarded', 'freshness': 'fresh', **changes}


class PeerAPI(bridge_tests.FakeAPI):
    def __init__(self):
        super().__init__()
        self.directory = {'agents': [peer()]}
        self.directory_error = None

    def request(self, method, path, body=None, **kwargs):
        if (method, path) == ('GET', '/v1/projects/p/agents'):
            self.calls.append((method, path, copy.deepcopy(body)))
            if self.directory_error is not None:
                raise self.directory_error
            if self.offline:
                raise native.NativeError('offline_fixture')
            return copy.deepcopy(self.directory)
        return super().request(method, path, body, **kwargs)


class NativePeersTests(unittest.TestCase):
    def setUp(self):
        hook_tests.RealBridgeHookTests.setUp(self)
        self.api = PeerAPI()

    def bridge(self, channels=None):
        if channels is not None:
            config = json.loads(self.config_path.read_text())
            config['channel_ids'] = channels
            self.config_path.write_text(json.dumps(config))
        result = self.factory(str(self.config_path), hook_tests.SESSION)
        self.addCleanup(result.close)
        return result

    def test_directory_filters_kind_self_and_nonconfigured_channels_without_writes(self):
        self.api.channels = {'c': True, 'd': False, 'foreign': True}
        self.api.directory['agents'] = [peer('a'), peer('viewer', kind='viewer'), peer('owner', kind='owner'),
            peer('foreign-peer', ['foreign']), peer('no-common-channel', []), peer('z', ['c', 'foreign']),
            peer('b', ['d', 'c'], name='Human readable peer')]
        bridge = self.bridge(['c', 'd'])
        bridge.observe('session.started', event_id='retained-pending-event')
        before = list(bridge.db.iterdump())
        result = bridge.peers()
        self.assertEqual(result, {'agent_id': 'a', 'project_id': 'p',
            'channels': [{'id': 'c', 'can_write': True}, {'id': 'd', 'can_write': False}],
            'peers': [{'id': 'b', 'name': 'Human readable peer', 'channel_ids': ['c', 'd']},
                      {'id': 'z', 'name': 'Peer z', 'channel_ids': ['c']}],
            'has_more': False, 'next_after_id': None, 'untrusted_peer_data': True})
        self.assertEqual(list(bridge.db.iterdump()), before)
        self.assertEqual([(method, path) for method, path, _ in self.api.calls],
            [('GET', '/v1/me'), ('GET', '/v1/projects/p/channels'), ('GET', '/v1/projects/p/agents')])
        self.assertEqual(self.api.activity, {})

    def test_channel_filter_keeps_readonly_access_and_rejects_outside_current_scope(self):
        self.api.channels = {'c': True, 'd': False, 'foreign': True}
        self.api.directory['agents'] = [peer('b', ['c']), peer('z', ['c', 'd'])]
        bridge = self.bridge(['c', 'd'])
        result = bridge.peers(channel_id='d')
        self.assertEqual(result['channels'], [{'id': 'd', 'can_write': False}])
        self.assertEqual(result['peers'], [{'id': 'z', 'name': 'Peer z', 'channel_ids': ['d']}])
        for channel in ('foreign', 'missing'):
            self.api.calls.clear()
            with self.assertRaisesRegex(native.NativeError, 'channel_not_authorized'):
                bridge.peers(channel_id=channel)
            self.assertFalse(any(path.endswith('/agents') for _, path, _ in self.api.calls))

    def test_invalid_arguments_stop_before_any_http(self):
        bridge = self.bridge()
        for arguments in ({'limit': True}, {'limit': 0}, {'limit': 101}, {'limit': '1'},
                          {'channel_id': ''}, {'channel_id': '../other'}, {'after_id': ''}, {'after_id': []}):
            with self.subTest(arguments=arguments), self.assertRaises(native.NativeError):
                bridge.peers(**arguments)
        self.assertEqual(self.api.calls, [])

    def test_current_authorization_never_serves_a_cached_directory(self):
        bridge = self.bridge()
        self.assertEqual(len(bridge.peers()['peers']), 1)
        self.api.channels = {}
        self.assertEqual(bridge.peers()['peers'], [])
        self.api.identity = 'different-agent'
        with self.assertRaisesRegex(native.NativeError, 'principal_mismatch'):
            bridge.peers()
        self.api.identity = 'a'
        self.api.directory_error = native.NativeHTTPError(401)
        with self.assertRaisesRegex(native.NativeError, 'api_http_401'):
            bridge.peers()
        self.assertTrue(all(method == 'GET' for method, _, _ in self.api.calls))

    def test_malformed_rows_do_not_return_partial_directory_or_change_state(self):
        bridge = self.bridge()
        before = list(bridge.db.iterdump())
        cases = [None, [], {'agents': None}, {'agents': [peer(), peer()]},
                 {'agents': [peer(), None]}, {'agents': [peer('bad/id')]},
                 {'agents': [peer(kind='unknown')]}, {'agents': [peer(name='')]},
                 {'agents': [peer(name='\x00')]}, {'agents': [peer(name='\ud800')]},
                 {'agents': [peer(name='я' * 101)]}, {'agents': [peer(channel_ids=None)]},
                 {'agents': [peer(channel_ids=['c', 'c'])]}, {'agents': [peer(channel_ids=['bad/id'])]},
                 {'agents': [None] * (native.MAX_ROWS + 1)}]
        for directory in cases:
            with self.subTest(case=cases.index(directory)):
                self.api.directory = directory
                with self.assertRaisesRegex(native.NativeError, 'invalid_peer_directory'):
                    bridge.peers()
        self.assertEqual(list(bridge.db.iterdump()), before)

    def test_display_names_are_untrusted_sanitized_and_allow_valid_whitespace(self):
        bridge = self.bridge()
        self.api.directory['agents'] = [peer('b', name=' '), peer('c', name=bridge.key)]
        result = bridge.peers()
        self.assertEqual(result['peers'][0]['name'], ' ')
        self.assertEqual(result['peers'][1]['name'], '[REDACTED]')
        self.assertNotIn(bridge.key, native.canonical(result))
        self.assertTrue(result['untrusted_peer_data'])
        self.api.directory['agents'] = [peer(bridge.key)]
        with self.assertRaisesRegex(native.NativeError, 'known_credential'):
            bridge.peers()

    def test_default_limit_and_fresh_keyset_pages(self):
        self.api.directory['agents'] = [peer(f'p{i:03}') for i in reversed(range(55))]
        bridge = self.bridge()
        first = bridge.peers()
        self.assertEqual(len(first['peers']), 50)
        self.assertTrue(first['has_more'])
        self.assertEqual(first['next_after_id'], 'p049')
        # A page is a current directory view, not a promise to preserve revoked rows.
        self.api.directory['agents'] = [peer('p050', ['unconfigured']), peer('p051'), peer('p060')]
        second = bridge.peers(after_id=first['next_after_id'])
        self.assertEqual([item['id'] for item in second['peers']], ['p051', 'p060'])
        self.assertFalse(second['has_more'])
        self.assertIsNone(second['next_after_id'])
        final = bridge.peers(after_id='z')
        self.assertEqual(final['peers'], [])
        self.assertFalse(final['has_more'])
        self.assertIsNone(final['next_after_id'])

    def test_utf8_and_escaped_names_remain_in_budget_and_all_rows_are_pageable(self):
        channels = [f'c{i}-' + 'x' * 125 for i in range(8)]
        self.api.channels = dict.fromkeys(channels, True)
        self.api.directory['agents'] = [peer(f'p{i:03}-' + 'x' * 123, channels,
            name='\x01' * 100 + 'я' * 50) for i in reversed(range(100))]
        bridge = self.bridge(channels)
        after, found, page_count = None, [], 0
        while True:
            result = bridge.peers(after_id=after, limit=100)
            page_count += 1
            self.assertLessEqual(len(native.canonical(result).encode('utf-8')), 16384)
            self.assertGreater(len(result['peers']), 0)
            found.extend(item['id'] for item in result['peers'])
            if not result['has_more']:
                self.assertIsNone(result['next_after_id'])
                break
            self.assertEqual(result['next_after_id'], found[-1])
            self.assertGreater(result['next_after_id'], after or '')
            after = result['next_after_id']
            self.assertLess(page_count, 100)
        self.assertEqual(found, sorted(row['id'] for row in self.api.directory['agents']))
        self.assertGreater(page_count, 1)


if __name__ == '__main__':
    unittest.main()
