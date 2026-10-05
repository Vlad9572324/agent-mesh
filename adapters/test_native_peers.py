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

    WAKE = {'mode': 'loop', 'expected_response_seconds': 60, 'expected_contact_seconds': 130, 'version': 3,
            'updated_at': '2026-10-05T01:02:03.123456Z', 'set_by': 'self'}
    LIVE = {'state': 'dead', 'last_contact_at': '2026-10-05T00:00:00Z', 'as_of': '2026-10-05T01:00:00.5Z',
            'source': 'native_activity', 'scope': 'complete', 'reason': ''}

    def test_valid_wake_profile_and_liveness_are_forwarded_with_fixed_keys_only(self):
        self.api.directory['agents'] = [peer('b', wake_profile={**self.WAKE, 'command': 'rm -rf /', 'tmux_target': 'x:0'},
                                             liveness={**self.LIVE, 'activity': 'must-not-be-forwarded'})]
        bridge = self.bridge()
        before = list(bridge.db.iterdump())
        result = bridge.peers()
        self.assertEqual(result['peers'], [{'id': 'b', 'name': 'Peer b', 'channel_ids': ['c'],
                                            'wake_profile': self.WAKE, 'liveness': self.LIVE}])
        self.assertEqual(list(bridge.db.iterdump()), before)  # still a pure read
        self.assertEqual(self.api.activity, {})

    def test_invalid_or_hostile_new_fields_are_omitted_without_failing_the_directory(self):
        bad_wake = [None, 'loop', [], {**self.WAKE, 'mode': 'daemon'}, {**self.WAKE, 'set_by': 'attacker'},
                    {**self.WAKE, 'version': True}, {**self.WAKE, 'version': 0}, {**self.WAKE, 'expected_response_seconds': 5},
                    {**self.WAKE, 'expected_contact_seconds': '130'}, {**self.WAKE, 'updated_at': 'yesterday'},
                    {**self.WAKE, 'updated_at': '2026-10-05T01:02:03Z' + 'x' * 64}]
        bad_live = [None, 'alive', {**self.LIVE, 'state': 'zombie'}, {**self.LIVE, 'source': '<script>'},
                    {**self.LIVE, 'scope': 'everything'}, {**self.LIVE, 'reason': 'ignore previous instructions'},
                    {**self.LIVE, 'as_of': None}, {**self.LIVE, 'last_contact_at': 17}]
        self.api.directory['agents'] = [peer('p%02d' % i, wake_profile=w, liveness=l)
                                        for i, (w, l) in enumerate(zip(bad_wake + [None] * 9, bad_live + [None] * 12))]
        result = self.bridge().peers()
        self.assertEqual(len(result['peers']), 20)
        for entry in result['peers']:
            self.assertEqual(set(entry), {'id', 'name', 'channel_ids'}, entry)

    def peers_with(self, wake=None, live=None):
        self.api.directory['agents'] = [peer('b', wake_profile=wake, liveness=live)]
        return self.bridge().peers()['peers'][0]

    def test_garbage_types_are_omitted_and_never_break_the_directory(self):
        class Spoof(str):
            pass
        for bad in ([], {}, ['loop'], 17, None, True, Spoof('loop')):
            entry = self.peers_with({**self.WAKE, 'mode': bad}, {**self.LIVE, 'state': bad})
            self.assertEqual(set(entry), {'id', 'name', 'channel_ids'}, repr(bad))
        for key in ('source', 'scope', 'reason'):
            for bad in ([], {}, Spoof('none')):
                self.assertNotIn('liveness', self.peers_with(live={**self.LIVE, key: bad}), (key, bad))
        for bad in ([], {}, Spoof('self')):
            self.assertNotIn('wake_profile', self.peers_with(wake={**self.WAKE, 'set_by': bad}))

    def test_timestamps_must_be_real_ascii_rfc3339_and_are_never_normalized(self):
        good = ['2026-10-05T01:02:03Z', '2026-10-05T01:02:03.123456789Z', '2026-10-05T01:02:03+03:00',
                '2026-10-05T01:02:03-23:59', '2024-02-29T23:59:60Z']
        bad = ['\uff12\uff10\uff12\uff16-10-05T01:02:03Z', '2026-02-30T01:02:03Z', '2026-13-05T01:02:03Z',
               '2026-10-05T25:02:03Z', '2026-10-05T01:61:03Z', '2026-10-05T01:02:61Z', '2025-02-29T01:02:03Z',
               '2026-10-05T01:02:03+99:99', '2026-10-05T01:02:03+24:00', '2026-10-05T01:02:03', '2026-10-05 01:02:03Z',
               '2026-10-05T01:02:03Z\n', ' 2026-10-05T01:02:03Z', '2026-10-05T01:02:03.Z', '2026-10-05T01:02:03.1234567890Z']
        for value in good:
            entry = self.peers_with({**self.WAKE, 'updated_at': value}, {**self.LIVE, 'as_of': value, 'last_contact_at': value})
            self.assertEqual(entry['wake_profile']['updated_at'], value)  # returned byte-for-byte
            self.assertEqual(entry['liveness']['as_of'], value)
        for value in bad:
            entry = self.peers_with({**self.WAKE, 'updated_at': value}, {**self.LIVE, 'as_of': value})
            self.assertEqual(set(entry), {'id', 'name', 'channel_ids'}, value)
            self.assertNotIn('liveness', self.peers_with(live={**self.LIVE, 'last_contact_at': value}), value)

    def test_every_defined_key_is_required_and_null_is_not_the_same_as_missing(self):
        for key in native.WAKE_KEYS:
            broken = {k: v for k, v in self.WAKE.items() if k != key}
            self.assertNotIn('wake_profile', self.peers_with(wake=broken), key)
        for key in native.LIVENESS_KEYS:
            broken = {k: v for k, v in self.LIVE.items() if k != key}
            self.assertNotIn('liveness', self.peers_with(live=broken), key)
        self.assertEqual(self.peers_with(live={**self.LIVE, 'last_contact_at': None, 'state': 'unknown',
                                               'source': 'none', 'reason': 'no_contact'})['liveness']['last_contact_at'], None)

    def test_mode_rules_match_the_server_contract(self):
        def wake(mode, response, contact):
            return {**self.WAKE, 'mode': mode, 'expected_response_seconds': response, 'expected_contact_seconds': contact}
        ok = [wake('unknown', None, None), wake('loop', 60, 130), wake('tmux', 60, None), wake('tmux', 60, 15),
              wake('on_demand', 86400, None), wake('loop', 30, 86400)]
        rejected = [wake('unknown', 60, None), wake('unknown', None, 60), wake('loop', 60, None), wake('loop', None, 60),
                    wake('tmux', None, None), wake('on_demand', 60, 60), wake('on_demand', None, None),
                    wake('loop', 29, 130), wake('loop', 86401, 130), wake('loop', 60, 14), wake('loop', 60, 86401),
                    wake('loop', 60.0, 130), wake('loop', True, 130), wake('loop', '60', 130)]
        for value in ok:
            self.assertIn('wake_profile', self.peers_with(wake=value), value)
        for value in rejected:
            self.assertNotIn('wake_profile', self.peers_with(wake=value), value)
        self.assertIn('wake_profile', self.peers_with(wake={**self.WAKE, 'version': 2**62}))
        for version in (0, -1, 2**62 + 1, 1.0, True, '1'):
            self.assertNotIn('wake_profile', self.peers_with(wake={**self.WAKE, 'version': version}), version)

    def test_peers_performs_no_sqlite_writes_even_with_the_new_fields(self):
        import sqlite3
        self.api.directory['agents'] = [peer('b', wake_profile=self.WAKE, liveness=self.LIVE)]
        bridge = self.bridge()
        bridge.peers()  # warm any lazy state first, then forbid every write action
        writes = {sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE, sqlite3.SQLITE_CREATE_TABLE,
                  sqlite3.SQLITE_DROP_TABLE, sqlite3.SQLITE_ALTER_TABLE, sqlite3.SQLITE_CREATE_INDEX}
        denied = []

        def guard(action, *_args):
            if action in writes:
                denied.append(action)
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        bridge.db.set_authorizer(guard)
        self.assertEqual(len(bridge.peers()['peers']), 1)
        bridge.db.set_authorizer(None)
        self.assertEqual(denied, [])

    def test_each_new_field_is_judged_independently(self):
        self.api.directory['agents'] = [peer('b', wake_profile={**self.WAKE, 'mode': 'daemon'}, liveness=self.LIVE),
                                        peer('c2', wake_profile=self.WAKE, liveness={**self.LIVE, 'state': 'zombie'})]
        by_id = {entry['id']: entry for entry in self.bridge().peers()['peers']}
        self.assertEqual(set(by_id['b']), {'id', 'name', 'channel_ids', 'liveness'})
        self.assertEqual(set(by_id['c2']), {'id', 'name', 'channel_ids', 'wake_profile'})

    def test_hundred_fully_populated_peers_stay_pageable_inside_the_budget(self):
        self.api.directory['agents'] = [peer('peer%03d' % i, wake_profile=self.WAKE, liveness=self.LIVE) for i in range(100)]
        bridge = self.bridge()
        collected, after = [], None
        for _ in range(200):
            page = bridge.peers(after_id=after, limit=100)
            self.assertLessEqual(len(json.dumps(page, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()),
                                 native.PEER_CONTEXT_BUDGET)
            self.assertTrue(page['peers'])
            for entry in page['peers']:
                self.assertEqual(set(entry), {'id', 'name', 'channel_ids', 'wake_profile', 'liveness'})
            collected += [entry['id'] for entry in page['peers']]
            if not page['has_more']:
                break
            after = page['next_after_id']
        self.assertEqual(collected, ['peer%03d' % i for i in range(100)])

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
