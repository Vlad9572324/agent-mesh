"""Native inbox scheduling/pagination regressions; owned local fixtures only."""
import base64
import json
import queue
import threading
import unittest
from unittest.mock import patch

import native_bridge as native
from native_mcp import MCPServer
import test_native_bridge as fixtures


class InboxTests(unittest.TestCase):
    setUp = fixtures.NativeBridgeTests.setUp
    bridge = fixtures.NativeBridgeTests.bridge
    config = fixtures.NativeBridgeTests.config
    message = fixtures.NativeBridgeTests.message

    def test_old_unseen_does_not_starve_new_messages_across_sessions(self):
        self.api.messages = [self.message('old-' + str(i), seq=i, body='Ж' * 1000) for i in range(1, 30)]
        bridge = self.bridge()
        bridge.poll_inbox()
        first = bridge.offer_inbox()
        self.api.messages.append(self.message('new', seq=3531, body='new work'))
        self.assertEqual(bridge.poll_inbox()['fetched'], 1)
        observed = {m['id'] for m in first['messages']}
        for i in range(20):
            bridge.close()
            bridge = self.bridge(session='fresh-' + str(i))
            observed.update(m['id'] for m in bridge.offer_inbox()['messages'])
            if 'new' in observed:
                break
        self.assertIn('new', observed)
        self.assertEqual(bridge.status()['unseen_messages'], 30)
        self.assertEqual(bridge.status()['pending_messages'], 30)

    def test_default_ties_use_arrival_not_unrelated_channel_sequences(self):
        self.config(channel_ids=['c', 'd'])
        self.api.messages = [self.message('first', seq=9000, body='x' * 2000),
                             self.message('second', channel='d', seq=1, body='y' * 2000)]
        bridge = self.bridge()
        bridge.poll_inbox()
        self.assertEqual(bridge.offer_inbox(context_budget=512)['messages'][0]['id'], 'first')
        self.assertEqual(bridge.offer_inbox(context_budget=512)['messages'][0]['id'], 'second')

    def test_hook_cooldown_and_new_session_preserve_global_fairness(self):
        self.api.messages = [self.message('m' + str(i), seq=i, body='x' * 2000) for i in range(1, 4)]
        bridge = self.bridge()
        with patch('native_bridge.time.time', return_value=1000):
            bridge.poll_inbox()
            self.assertEqual(bridge.offer_inbox(512, 60)['messages'][0]['id'], 'm1')
            self.assertEqual(bridge.offer_inbox(512, 60)['messages'][0]['id'], 'm2')
        bridge.close()
        reopened = self.bridge(session='new-session')
        with patch('native_bridge.time.time', return_value=1120):
            self.assertEqual(reopened.offer_inbox(512, 60)['messages'][0]['id'], 'm3')

    def test_backlog_beyond_two_hundred_rotates_without_acknowledgement(self):
        self.api.messages = [self.message('m' + str(i), seq=i) for i in range(1, 207)]
        bridge = self.bridge()
        for _ in range(3):
            bridge.poll_inbox()
        returned = set()
        for _ in range(5):
            page = bridge.offer_inbox(context_budget=16000)
            returned.update(m['id'] for m in page['messages'])
        self.assertEqual(returned, {m['id'] for m in self.api.messages})
        self.assertEqual(bridge.status()['unseen_messages'], 206)

    def test_concurrent_connections_advance_global_offer_order_atomically(self):
        self.api.messages = [self.message('m' + str(i), seq=i, body='x' * 2000) for i in range(1, 3)]
        initial = self.bridge()
        initial.poll_inbox()
        initial.close()
        start, answers, errors = threading.Barrier(2), queue.Queue(), queue.Queue()
        def offer(session):
            bridge = None
            try:
                bridge = self.factory(str(self.config_path), session)
                start.wait(timeout=2)
                answers.put([m['id'] for m in bridge.offer_inbox(context_budget=512)['messages']])
            except BaseException as error:
                errors.put(type(error).__name__)
            finally:
                if bridge is not None:
                    bridge.close()
        workers = [threading.Thread(target=offer, args=('concurrent-' + str(i),)) for i in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=4)
        self.assertFalse(any(worker.is_alive() for worker in workers))
        self.assertTrue(errors.empty(), list(errors.queue))
        self.assertEqual(sorted(answers.get_nowait() for _ in range(2)), [['m1'], ['m2']])

    def test_snapshot_keyset_across_channels_restart_and_new_arrivals(self):
        self.config(channel_ids=['c', 'd'])
        self.api.messages = [self.message(channel + str(i), channel=channel, seq=i, body='Ж' * 2000)
                             for channel in ['c', 'd'] for i in range(1, 8)]
        bridge = self.bridge()
        bridge.poll_inbox()
        expected = [m['id'] for m in self.api.messages]
        page = bridge.offer_inbox(context_budget=1100, cursor='')
        seen = [m['id'] for m in page['messages']]
        self.assertTrue(page['next_cursor'])
        self.api.messages.append(self.message('new', seq=8))
        bridge.poll_inbox()
        bridge.close()
        bridge = self.bridge(session='restart')
        for _ in range(30):
            if page['next_cursor'] is None:
                break
            page = bridge.offer_inbox(context_budget=1100, cursor=page['next_cursor'])
            self.assertLessEqual(len(native.canonical(page).encode()), 1100)
            self.assertTrue(page['messages'])
            self.assertEqual(page['has_more'], page['offer_has_more'])
            seen.extend(m['id'] for m in page['messages'])
        self.assertIsNone(page['next_cursor'])
        self.assertEqual(seen, expected)
        self.assertNotIn('new', seen)
        self.assertIn('new', [m['id'] for m in bridge.offer_inbox()['messages']])

    def test_snapshot_rechecks_current_seen_acceptance_and_acl(self):
        self.config(channel_ids=['c', 'd'])
        self.api.messages = [self.message('m' + str(i), seq=i, body='x' * 2000) for i in range(1, 5)]
        bridge = self.bridge()
        bridge.poll_inbox()
        page = bridge.offer_inbox(context_budget=1100, cursor='')
        bridge.seen_message('m2')
        bridge.accept_message('m3')
        next_page = bridge.offer_inbox(cursor=page['next_cursor'])
        self.assertEqual([m['id'] for m in next_page['messages']], ['m4'])
        self.api.channels = {'c': True}
        with self.assertRaisesRegex(native.NativeError, 'invalid_inbox_cursor'):
            bridge.offer_inbox(cursor=page['next_cursor'])
        self.api.channels = {}
        with self.assertRaisesRegex(native.NativeError, 'invalid_inbox_cursor'):
            bridge.offer_inbox(cursor=page['next_cursor'])
        self.assertEqual(bridge.offer_inbox()['messages'], [])

    def test_cursor_rejects_malformed_foreign_scope_and_changed_filter(self):
        self.api.messages = [self.message('m' + str(i), seq=i, body='x' * 2000) for i in range(1, 4)]
        bridge = self.bridge()
        bridge.poll_inbox()
        token = bridge.offer_inbox(context_budget=1100, cursor='')['next_cursor']
        before = bridge.db.execute('SELECT count(*) FROM offers').fetchone()[0]
        for invalid in (None, True, 1, [], '!', 'x' * 2049, token + '=',
                        base64.urlsafe_b64encode(b'{"sql":"DROP TABLE inbox"}').decode().rstrip('=')):
            # None is the internal default; MCP rejects explicit null separately.
            if invalid is None:
                continue
            with self.subTest(cursor=type(invalid).__name__), self.assertRaisesRegex(native.NativeError, 'invalid_inbox_cursor'):
                bridge.offer_inbox(cursor=invalid)
        with self.assertRaisesRegex(native.NativeError, 'invalid_inbox_cursor'):
            bridge.offer_inbox(cursor=token, include_seen=True)
        value = json.loads(base64.urlsafe_b64decode(token + '=' * (-len(token) % 4)))
        corrupt = [[True, *value[1:]], [1, 'wrong', *value[2:]], value + ['extra']]
        for ceiling in (True, -1, 0, 999999999999999999999999999):
            corrupt.append([*value[:2], ceiling, value[3]])
        for position in (['c', True, 'm1'], ['c', 2**64, 'm1'], ['c', 1, 'missing'],
                         ['c; DROP TABLE inbox', 1, 'm1'], ['c', 1], {'seq': 1}):
            corrupt.append([*value[:3], position])
        for raw in [native.canonical(v).encode() for v in corrupt] + [b'\xff', b'{}', b'[' * 1100, json.dumps(value, indent=2).encode()]:
            encoded = base64.urlsafe_b64encode(raw).decode().rstrip('=')
            with self.assertRaisesRegex(native.NativeError, 'invalid_inbox_cursor'):
                bridge.offer_inbox(cursor=encoded)
        for field in ('agent_id', 'project_id'):
            original = bridge.config[field]
            bridge.config[field] = 'foreign'
            with patch.object(bridge, '_authorize', return_value={'c': True}), self.assertRaisesRegex(native.NativeError, 'invalid_inbox_cursor'):
                bridge.offer_inbox(cursor=token)
            bridge.config[field] = original
        original_state = bridge.db.execute("SELECT value FROM meta WHERE key='inbox_view_id'").fetchone()[0]
        bridge.db.execute("UPDATE meta SET value='different-database' WHERE key='inbox_view_id'")
        bridge.db.commit()
        with self.assertRaisesRegex(native.NativeError, 'invalid_inbox_cursor'):
            bridge.offer_inbox(cursor=token)
        bridge.db.execute("UPDATE meta SET value=? WHERE key='inbox_view_id'", (original_state,))
        bridge.db.commit()
        self.api.offline = True
        with self.assertRaisesRegex(native.NativeError, 'offline'):
            bridge.offer_inbox(cursor=token)
        self.assertEqual(bridge.db.execute('SELECT count(*) FROM offers').fetchone()[0], before)

    def test_pre_fairness_sqlite_migration_preserves_data_and_backfills_offer_history(self):
        self.api.messages = [self.message('m' + str(i), seq=i) for i in range(1, 4)]
        bridge = self.bridge()
        bridge.poll_inbox()
        bridge.offer_inbox()
        bridge.seen_message('m1')
        bridge.accept_message('m2')
        bridge.db.execute('DROP INDEX inbox_offer_order')
        bridge.db.execute('ALTER TABLE inbox DROP COLUMN offer_order')
        bridge.db.execute("DELETE FROM meta WHERE key='inbox_view_id'")
        bridge.db.commit()
        tables = ('cursors', 'offers', 'outbox')
        snapshots = {table: [tuple(r) for r in bridge.db.execute('SELECT * FROM ' + table)] for table in tables}
        inbox = [tuple(r) for r in bridge.db.execute('SELECT rowid,* FROM inbox')]
        bridge.close()
        reopened = self.bridge(session='migrated')
        for table in tables:
            self.assertEqual([tuple(r) for r in reopened.db.execute('SELECT * FROM ' + table)], snapshots[table])
        self.assertEqual([tuple(r)[:-1] for r in reopened.db.execute('SELECT rowid,* FROM inbox')], inbox)
        self.assertTrue(all(r[0] > 0 for r in reopened.db.execute('SELECT offer_order FROM inbox')))
        state_id = reopened.db.execute("SELECT value FROM meta WHERE key='inbox_view_id'").fetchone()[0]
        reopened.close()
        again = self.bridge(session='migrated-again')
        self.assertEqual(again.db.execute("SELECT value FROM meta WHERE key='inbox_view_id'").fetchone()[0], state_id)
        self.assertEqual([m['id'] for m in again.offer_inbox()['messages']], ['m3'])

    def test_budget_utf8_and_report_ids_only_for_returned_records(self):
        self.api.messages = [self.message('m' + str(i), seq=i, body='🙂' * 4000) for i in range(1, 8)]
        bridge = self.bridge()
        bridge.poll_inbox()
        page = bridge.offer_inbox(context_budget=1100, cursor='')
        self.assertTrue(page['messages'])
        self.assertTrue(page['truncated'])
        self.assertLessEqual(len(native.canonical(page).encode()), 1100)
        returned = {m['id'] for m in page['messages']}
        reports = {json.loads(row[0])['message_id'] for row in bridge.db.execute('SELECT payload FROM outbox')}
        self.assertEqual(reports, returned)
        for m in page['messages']:
            self.assertTrue(self.api.messages[0]['body'].startswith(m['body_preview']))
            self.assertEqual(bridge.message(m['id'])['message']['body'], '🙂' * 4000)
        self.assertEqual(bridge.status()['unseen_messages'], 7)

    def test_too_small_budget_fails_explicitly_without_empty_cursor_loop_or_offer(self):
        self.api.messages = [self.message('m' + str(i) + 'x' * 126, seq=i,
                             recipient_ids=['a'] + ['recipient-' + str(j) + 'x' * 100 for j in range(30)])
                             for i in range(1, 3)]
        bridge = self.bridge()
        bridge.poll_inbox()
        with self.assertRaisesRegex(native.NativeError, 'context_budget_too_small_for_message'):
            bridge.offer_inbox(context_budget=512, cursor='')
        self.assertEqual(bridge.db.execute('SELECT count(*) FROM offers').fetchone()[0], 0)
        self.assertEqual(bridge.db.execute('SELECT count(*) FROM outbox').fetchone()[0], 0)
        self.assertEqual(len(bridge.offer_inbox(context_budget=16000, cursor='')['messages']), 2)

    def test_minimum_budget_snapshot_advances_with_empty_previews(self):
        self.api.messages = [self.message('m' + str(i), seq=i, body='x' * 2000) for i in range(1, 5)]
        bridge = self.bridge()
        bridge.poll_inbox()
        cursor, received = '', []
        for _ in range(10):
            page = bridge.offer_inbox(context_budget=512, cursor=cursor)
            self.assertLessEqual(len(native.canonical(page).encode()), 512)
            self.assertTrue(page['messages'])
            received.extend(page['messages'])
            cursor = page['next_cursor']
            if cursor is None:
                break
        self.assertIsNone(cursor)
        self.assertEqual([m['id'] for m in received], ['m1', 'm2', 'm3', 'm4'])
        self.assertTrue(any(m['body_preview'] == '' for m in received))

    def test_large_metadata_falls_back_to_reference_and_does_not_block_later_message(self):
        recipients = ['a'] + ['r' + str(i).zfill(2) + 'x' * 125 for i in range(31)]
        self.api.messages = [self.message('large', recipient_ids=recipients), self.message('later', seq=2)]
        bridge = self.bridge()
        bridge.poll_inbox()
        result = bridge.offer_inbox(context_budget=4000, minimum_interval=60)
        self.assertEqual([m['id'] for m in result['messages']], ['large', 'later'])
        self.assertEqual(result['messages'][0], {'id': 'large', 'body_preview': '', 'truncated': True, 'reference_only': True})
        self.assertEqual(bridge.message('large')['message']['recipient_ids'], recipients)
        self.assertEqual(bridge.status()['unseen_messages'], 2)
        self.assertLessEqual(len(native.canonical(result).encode()), 4000)

    def test_mcp_keeps_fetch_and_offer_flags_separate_and_flushes(self):
        self.api.messages = [self.message('m' + str(i), seq=i, recipient='other') for i in range(1, 21)]
        self.api.messages.append(self.message('new', seq=21))
        bridge = self.bridge()
        server = MCPServer(bridge)
        first = server.call('link_inbox', {})
        self.assertTrue(first['fetch_has_more'])
        self.assertFalse(first['offer_has_more'] or first['has_more'])
        self.assertEqual(first['fetch']['fetched'], 20)
        second = server.call('link_inbox', {})
        self.assertEqual([m['id'] for m in second['messages']], ['new'])
        self.assertFalse(second['fetch_has_more'])
        self.assertEqual(second['publication']['sent'], 1)
        self.assertEqual(second['publication']['pending'], 0)
        self.assertEqual({v['message_id'] for v in self.api.activity.values()}, {'new'})

    def test_mcp_flush_failure_preserves_messages_and_safe_retry_evidence(self):
        self.api.messages = [self.message()]
        bridge = self.bridge()
        self.api.lose_next_ack = True
        result = MCPServer(bridge).call('link_inbox', {})
        self.assertEqual([m['id'] for m in result['messages']], ['m1'])
        self.assertEqual(result['publication']['error'], 'publication_failed')
        self.assertNotIn('sent', result['publication'])
        self.assertEqual(result['publication']['pending'], 1)
        self.assertEqual(bridge.flush()['sent'], 1)
        self.assertEqual(len(self.api.activity), 1)
        self.assertEqual(bridge.status()['unseen_messages'], 1)


if __name__ == '__main__':
    unittest.main()
