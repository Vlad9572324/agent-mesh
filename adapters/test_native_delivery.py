"""Sender delivery inspection through actual bridge and MCP; no provider/network."""
import copy
import unittest
from native_bridge import NativeError, canonical
from native_mcp import MCPServer
import test_native_bridge as bridge_tests

TIME = '2026-10-03T10:00:00.123456789Z'
def status(stage='stored'):
    row = {'agent_id': 'b', 'status': stage,
           'native': {'offered_at': None, 'seen_at': None, 'accepted_at': None, 'provenance': 'client_reported', 'server_verified': False},
           'legacy': {'delivered_at': None, 'accepted_at': None, 'uncertain_at': None}, 'reply': None}
    if stage in ('offered', 'viewed', 'accepted'):
        row['native'][{'offered': 'offered_at', 'viewed': 'seen_at', 'accepted': 'accepted_at'}[stage]] = TIME
    if stage == 'replied':
        row['reply'] = {'message_id': 'reply-1', 'created_at': TIME}
    return row

class DeliveryTests(unittest.TestCase):
    setUp = bridge_tests.NativeBridgeTests.setUp
    bridge = bridge_tests.NativeBridgeTests.bridge
    config = bridge_tests.NativeBridgeTests.config
    message = bridge_tests.NativeBridgeTests.message

    def sent(self, stage='stored', **changes):
        value = self.message(author_id='a', recipient_ids=['b'], body='BODY MUST NOT BE RETURNED', delivery_status=[status(stage)], **changes)
        self.api.messages = [value]
        return value

    def test_sender_can_inspect_native_only_status_without_local_inbox_or_mutation(self):
        bridge = self.bridge()
        for stage in ('stored', 'offered', 'viewed', 'accepted', 'replied'):
            original = self.sent(stage)
            before = copy.deepcopy(original)
            result = MCPServer(bridge).call('link_delivery', {'message_id': 'm1'})
            self.assertEqual(result['delivery_status'][0], status(stage))
            self.assertNotIn(original['body'], canonical(result))
            self.assertNotIn('body', result)
            self.assertIn('do not prove task completion', result['boundary'])
            self.assertEqual(original, before)
        self.assertEqual(bridge.db.execute('SELECT count(*) FROM inbox').fetchone()[0], 0)
        self.assertEqual(bridge.db.execute('SELECT count(*) FROM outbox').fetchone()[0], 0)
        self.assertTrue(all(method == 'GET' for method, _, _ in self.api.calls))
        with self.assertRaisesRegex(NativeError, 'message_not_in_native_inbox'):
            bridge.message('m1')  # Existing full-body tool semantics remain intact.

    def test_legacy_uncertainty_remains_independent_of_native_ack_and_reply(self):
        message = self.sent('accepted')
        message['delivery_status'][0]['legacy']['uncertain_at'] = TIME
        result = self.bridge().delivery('m1')['delivery_status'][0]
        self.assertEqual(result['legacy']['uncertain_at'], TIME)
        self.assertIsNone(result['legacy']['delivered_at'])
        self.assertIsNone(result['native']['seen_at'])
        self.assertEqual(result['status'], 'accepted')

    def test_current_acl_configured_project_and_message_identity_fence_every_read(self):
        bridge = self.bridge()
        for change in ('revoked', 'other-channel', 'other-project', 'wrong-id', 'other-participants'):
            self.api.allowed = True; self.api.identity = 'a'
            item = self.sent()
            if change == 'revoked': self.api.allowed = False
            if change == 'other-channel': item['channel_id'] = 'd'
            if change == 'other-project': item['channel_id'] = 'foreign'
            if change == 'wrong-id': self.api.identity = 'other'
            if change == 'other-participants': item['author_id'] = 'c'
            with self.subTest(change=change), self.assertRaises(NativeError): bridge.delivery('m1')
        self.assertTrue(all(method == 'GET' for method, _, _ in self.api.calls))

    def test_missing_or_malformed_status_is_unknown_not_false_stored(self):
        bridge = self.bridge()
        mutations = [lambda m: m.pop('delivery_status'), lambda m: m.update(delivery_status=[]),
            lambda m: m['delivery_status'][0].update(agent_id='foreign'),
            lambda m: m['delivery_status'].append(copy.deepcopy(m['delivery_status'][0])),
            lambda m: m['delivery_status'][0].update(status='completed'),
            lambda m: m['delivery_status'][0]['native'].update(server_verified=True),
            lambda m: m['delivery_status'][0]['native'].update(seen_at='2026-02-31T01:00:00Z'),
            lambda m: m['delivery_status'][0]['native'].pop('offered_at'),
            lambda m: m['delivery_status'][0].update(reply={'message_id':'wrong', 'created_at':None}),
            lambda m: m['delivery_status'][0].update(private_detail='DO NOT LEAK')]
        for mutate in mutations:
            item = self.sent('viewed'); mutate(item)
            with self.subTest(mutate=mutations.index(mutate)), self.assertRaises(NativeError): bridge.delivery('m1')

if __name__ == '__main__': unittest.main()
