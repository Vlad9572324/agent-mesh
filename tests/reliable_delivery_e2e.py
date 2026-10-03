#!/usr/bin/env python3
"""Model-free native inbox -> owner deadline -> direct-reply acceptance.

Reuses the existing owned PostgreSQL-schema/loopback-TLS fixture. Requires
AGENT_LINK_RUNTIME_DIR and its test DSN, plus AGENT_LINK_CA_FILE. No provider CLI,
live workspace or model is used. The fixed fixture port must be available.
"""
import argparse
import hashlib
import json
import os
import re
import signal
import sys
import urllib.parse
import uuid

from native_cli_smoke import NativeSmoke
from coordination_live_smoke import (
    CERT, DSN_FILE, ORIGIN, ROOT, require,
)
from adapter import Client


class ReliableDeliverySmoke(NativeSmoke):
    def model(self, *args, **kwargs):
        raise AssertionError('This suite cannot invoke a provider')

    def runner(self, *args, **kwargs):
        raise AssertionError('This suite cannot dispatch a model job')

    def mcp(self, name, arguments, runtime='codex', *, expected_error=None):
        # Each call is a real fresh stdio process/session. Inbox state remains
        # shared, proving that fair selection survives process boundaries.
        config, _ = self.configs[runtime]
        packets = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
                'protocolVersion': '2025-11-25', 'capabilities': {},
                'clientInfo': {'name': 'reliable-delivery-fixture', 'version': '1'}}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {
                'name': name, 'arguments': arguments}},
        ]
        env = dict(os.environ, AGENT_LINK_NATIVE_SESSION_ID='delivery-' + uuid.uuid4().hex)
        result = self.command(
            [sys.executable, '-B', str(ROOT / 'scripts/agent-link-mcp.py'), '--config', str(config)],
            'stdio-' + name, env=env,
            data=('\n'.join(json.dumps(p) for p in packets) + '\n').encode(), timeout=20)
        rows = {p['id']: p for p in map(json.loads, result.stdout.splitlines()) if 'id' in p}
        require(set(rows) == {1, 2} and 'error' not in rows[2], 'correlated MCP response')
        answer = rows[2]['result']
        if expected_error is not None:
            require(answer.get('isError') is True, 'MCP must reject accidental publication')
            require(expected_error in json.dumps(answer), 'MCP returned the expected addressing error')
            return answer
        require(not answer.get('isError'), 'MCP tool failed: ' + name)
        return answer['structuredContent']

    def publish(self, label, body):
        return self.clients['claude-pilot'].request('POST', '/v1/channels/general/messages', {
            'client_id': self.run_id + '-' + label, 'body': body,
            'recipient_ids': ['codex-pilot']})['message']

    def finish_publication(self, page, runtime='codex'):
        publication = page['publication']
        require(not publication.get('error') and publication['blocked'] == 0,
                'MCP reports publication result without hidden failure')
        # link_inbox deliberately caps its automatic flush. Honour the returned
        # backlog instead of assuming every offered report has already arrived.
        if publication['pending']:
            publication = self.mcp('link_flush', {'limit': 100}, runtime=runtime)
        require(publication['pending'] == 0 and publication['blocked'] == 0,
                'explicit pending report flush completed')

    def prepare_reliability(self):
        parsed = urllib.parse.urlsplit(DSN_FILE.read_text().strip())
        query = dict(urllib.parse.parse_qsl(parsed.query))
        require(parsed.scheme == 'postgresql' and parsed.hostname == '127.0.0.1'
                and urllib.parse.unquote(parsed.path) == '/agentlink_test'
                and not {'host', 'port'} & query.keys(), 'dedicated loopback test database required')
        self.setup_native()
        self.stop.set()
        self.heartbeat_thread.join(timeout=10)
        require(not self.heartbeat_thread.is_alive(), 'owned fixture heartbeat stopped')
        self.report.update(test_kind='model-free reliable inbox and owner deadlines', model_call_limit=0)
        path = self.directory / 'owner.private.json'
        self.command([str(self.directory / 'agent-link'), 'bootstrap-owner',
                      '--database-url-file', str(self.directory / 'database-url.private'),
                      '--owner-id', 'delivery-owner', '--owner-name', 'Synthetic delivery owner',
                      '--key-out', str(path)], 'bootstrap-fixture-owner')
        credentials = json.loads(path.read_text())
        require(credentials['agent_id'] == 'delivery-owner', 'owned owner identity')
        self.owner = Client(ORIGIN, credentials['key'], str(CERT))

    def inbox_progress(self):
        old = [self.publish('old-' + str(i), 'Old synthetic context ' + ('x' * 2000))
               for i in range(29)]
        # Fetch only a small server page first. Local offer backlog and server
        # fetch backlog are independently represented in this response.
        first = self.mcp('link_inbox', {'limit': 5, 'context_budget': 3000})
        self.check('server_and_local_backlogs_are_distinct', first['fetch_has_more'] is True
                   and 'offer_has_more' in first and 'publication' in first)
        self.finish_publication(first)
        fresh = [self.publish('new-' + str(i), 'NEW_SYNTHETIC_CONTEXT_' + str(i) + ' ' + ('я' * 1000))
                 for i in range(4)]
        expected = {self.message['id'], *(m['id'] for m in old + fresh)}
        offered = {m['id'] for m in first['messages']}
        for _ in range(40):
            page = self.mcp('link_inbox', {'limit': 100, 'context_budget': 3000})
            self.finish_publication(page)
            offered.update(m['id'] for m in page['messages'])
            if expected <= offered:
                break
        self.check('fresh_messages_reachable_behind_29_old_unseen_across_restarts', expected <= offered,
                   messages=len(expected))
        status = self.mcp('link_status', {})
        self.check('offers_neither_view_nor_accept', status['unseen_messages'] == len(expected)
                   and status['pending_messages'] == len(expected))

        # Explicit local pagination is stable even though default offers already
        # visited every row, and a later server arrival waits for a new view.
        page = self.mcp('link_inbox', {'limit': 100, 'context_budget': 3000, 'cursor': ''})
        self.finish_publication(page)
        ordered = [m['id'] for m in page['messages']]
        later = self.publish('after-view', 'A later synthetic arrival')
        for _ in range(45):
            cursor = page['next_cursor']
            if cursor is None:
                break
            page = self.mcp('link_inbox', {'limit': 100, 'context_budget': 3000, 'cursor': cursor})
            self.finish_publication(page)
            ordered.extend(m['id'] for m in page['messages'])
        else:
            raise AssertionError('inbox page cursor failed to terminate')
        self.check('stable_cursor_no_duplicates_gaps_or_new_arrival_injection',
                   set(ordered) == expected and len(ordered) == len(expected)
                   and later['id'] not in ordered)
        self.target = fresh[0]

    def deadline_roundtrip(self):
        policy = self.owner.request('GET', '/v1/admin/delivery-policy')['policy']
        self.check('owner_monitoring_starts_disabled', policy['enabled'] is False)
        policy = self.owner.request('PUT', '/v1/admin/delivery-policy', {
            'enabled': True, 'ack_timeout_seconds': 60, 'reply_timeout_seconds': 60,
            'expected_version': policy['version']})['policy']
        self.check('enabling_does_not_alert_on_existing_archive',
                   self.owner.request('GET', '/v1/admin/delivery-alerts')['total'] == 0)
        mid = self.target['id']
        require(re.fullmatch(r'[a-f0-9]{1,128}', mid), 'server message ID is safe fixture literal')
        # Adjust only an owned synthetic message and policy clock; do not wait
        # for a real deadline or modify any published/live record.
        self.sql(f'''UPDATE "{self.schema}".delivery_alert_policy
 SET enabled_at=clock_timestamp()-interval '10 minutes';
 UPDATE "{self.schema}".messages SET created_at=clock_timestamp()-interval '2 minutes'
 WHERE id='{mid}';''', 'backdate-owned-deadline')

        def target_alerts():
            return [a for a in self.owner.request('GET', '/v1/admin/delivery-alerts')['alerts']
                    if a['message_id'] == mid and a['recipient_id'] == 'codex-pilot']

        alerts = target_alerts()
        self.check('real_offered_report_does_not_clear_deadline', len(alerts) == 1
                   and alerts[0]['reason'] == 'unacknowledged' and alerts[0]['offered_at']
                   and alerts[0]['seen_at'] is None and alerts[0]['accepted_at'] is None)
        complete = self.mcp('link_message', {'message_id': mid})
        self.check('full_text_read_without_implicit_view', complete['message']['body'] == self.target['body']
                   and target_alerts()[0]['seen_at'] is None)
        self.mcp('link_seen', {'message_id': mid})
        alerts = target_alerts()
        self.check('real_seen_clears_ack_only_leaves_reply_deadline', len(alerts) == 1
                   and alerts[0]['reason'] == 'unanswered' and alerts[0]['seen_at']
                   and alerts[0]['accepted_at'] is None and alerts[0]['legacy_accepted_at'] is None)
        delivery = self.mcp('link_delivery', {'message_id': mid}, runtime='claude')
        row = delivery['delivery_status'][0]
        self.check('sender_reads_native_seen_without_local_inbox_or_fabricated_legacy_ack',
                   delivery['message_id'] == mid and row['agent_id'] == 'codex-pilot'
                   and row['status'] == 'viewed' and row['native']['seen_at']
                   and row['native']['accepted_at'] is None and row['reply'] is None
                   and row['legacy']['delivered_at'] is None and row['legacy']['accepted_at'] is None
                   and 'body' not in delivery)
        self.clients['codex-pilot'].request('POST', '/v1/channels/general/messages', {
            'client_id': self.run_id + '-broadcast-reply', 'body': 'Synthetic reply without addressee',
            'recipient_ids': [], 'channel_only': True, 'reply_to': mid})
        self.check('broadcast_reply_does_not_clear_direct_reply_deadline', len(target_alerts()) == 1)
        sent = self.mcp('link_send', {'channel_id': 'general', 'recipient_ids': ['claude-pilot'],
                                    'reply_to': mid, 'body': 'Synthetic direct answer',
                                    'client_id': self.run_id + '-direct-reply'})
        self.check('real_direct_reply_clears_owner_alert', sent['publication_state'] == 'sent'
                   and not target_alerts())
        delivery = self.mcp('link_delivery', {'message_id': mid}, runtime='claude')
        row = delivery['delivery_status'][0]
        self.check('sender_reads_qualifying_direct_reply_separately_from_acceptance',
                   row['status'] == 'replied'
                   and row['reply']['message_id'] == sent['result']['message']['id']
                   and row['native']['accepted_at'] is None and row['legacy']['accepted_at'] is None)
        original = self.clients['codex-pilot'].request('GET', '/v1/messages/' + mid)['message']
        self.check('native_path_preserves_legacy_receipts', all(not r.get('delivered_at')
                   and not r.get('accepted_at') for r in original.get('receipts', [])))
        self.check('no_model_invocation', self.model_calls == 0 and not self.report['models'])

    def build_and_document_roundtrip(self):
        status = self.mcp('link_status', {})
        server = self.clients['codex-pilot'].request('GET', '/v1/me')['server_build']
        self.check('status_build_identity_matches_actual_authenticated_server',
                   status['server_version'] == server['version'] == 'dev'
                   and status['server_source_commit'] is None
                   and server['source_commit'] == 'unknown'
                   and status['server_identity_source'] == 'authenticated_api')
        self.check('unstamped_source_connector_does_not_borrow_server_identity',
                   status['connector_version'] is None and status['connector_source_commit'] is None
                   and status['connector_identity_source'] == 'unavailable')
        text = 'Synthetic document / Документ: sender delivery verification.\n'
        title = 'Delivery requirements / Требования'
        args = {'client_id': self.run_id + '-document', 'role': 'document',
                'title': title, 'base_revision': 'requirements-v1', 'content': text}
        sent = self.mcp('link_artifact_publish', args)
        artifact = sent['result']['artifact']
        digest = hashlib.sha256(text.encode()).hexdigest()
        self.check('named_document_published_with_explicit_document_revision',
                   sent['publication_state'] == 'sent' and artifact['title'] == title
                   and artifact['role'] == 'document' and artifact['base_revision'] == 'requirements-v1'
                   and artifact['sha256'] == digest and artifact['size_bytes'] == len(text.encode()))
        replay = self.mcp('link_artifact_publish', args)
        self.check('document_retry_preserves_identity', replay['result']['artifact']['id'] == artifact['id'])
        content = self.mcp('link_artifacts', {'action': 'content', 'artifact_id': artifact['id'],
                           'sha256': digest, 'base_revision': 'requirements-v1'}, runtime='claude')
        self.check('other_participant_reads_same_named_document_with_pins',
                   content['text'] == text and content['artifact']['title'] == title
                   and content['artifact']['role'] == 'document' and not content['truncated'])

    def addressed_message_roundtrip(self):
        client = self.clients['codex-pilot']
        path = '/v1/channels/general/messages'
        before = client.request('GET', path + '?limit=100')['messages']
        # The exact previous incident: publication with no recipients must fail
        # before creating a message, rather than report a silently undelivered send.
        self.mcp('link_send', {'channel_id': 'general', 'recipient_ids': [],
                              'body': 'Accidental broadcast',
                              'client_id': self.run_id + '-missing-recipient'},
                 expected_error='recipient')
        after = client.request('GET', path + '?limit=100')['messages']
        self.check('empty_native_send_creates_no_server_message',
                   [m['id'] for m in before] == [m['id'] for m in after])
        question = self.publish('addressed-question', 'Synthetic question for one peer')
        args = {'channel_id': 'general', 'reply_to': question['id'],
                'body': 'Synthetic automatic-author reply',
                'client_id': self.run_id + '-automatic-author-reply'}
        sent = self.mcp('link_send', args)
        reply = sent['result']['message']
        self.check('reply_resolves_exact_author_without_explicit_recipients',
                   sent['publication_state'] == 'sent'
                   and reply['recipient_ids'] == ['claude-pilot']
                   and reply['reply_to'] == question['id'])
        repeated = self.mcp('link_send', args)
        self.check('inferred_reply_replay_keeps_same_identity',
                   repeated['result']['message']['id'] == reply['id'])
        page = self.mcp('link_inbox', {'limit': 100, 'context_budget': 16000}, runtime='claude')
        self.finish_publication(page, runtime='claude')
        self.check('other_native_process_receives_inferred_reply',
                   reply['id'] in {m['id'] for m in page['messages']})
        status = self.mcp('link_delivery', {'message_id': question['id']}, runtime='claude')
        self.check('reply_is_correlated_by_server_delivery_status',
                   status['delivery_status'][0]['reply']['message_id'] == reply['id'])
        broadcast_args = {'channel_id': 'general', 'body': 'Explicit channel note',
                          'client_id': self.run_id + '-intentional-channel-only'}
        broadcast = self.mcp('link_broadcast', broadcast_args)['result']['message']
        again = self.mcp('link_broadcast', broadcast_args)['result']['message']
        self.check('explicit_channel_only_publication_is_replayable',
                   broadcast['recipient_ids'] == [] and broadcast['id'] == again['id'])
        page = self.mcp('link_inbox', {'limit': 100, 'context_budget': 16000}, runtime='claude')
        self.finish_publication(page, runtime='claude')
        self.check('intentional_channel_note_stays_out_of_native_inbox',
                   broadcast['id'] not in {m['id'] for m in page['messages']})
        self.check('addressing_regression_started_no_models', self.model_calls == 0)


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    require(not sys.flags.optimize, 'Run verification without Python -O')
    smoke = ReliableDeliverySmoke()
    previous = {s: signal.signal(s, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
                for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        smoke.prepare_reliability()
        smoke.inbox_progress()
        smoke.deadline_roundtrip()
        smoke.build_and_document_roundtrip()
        smoke.addressed_message_roundtrip()
        smoke.report['success'] = True
    except BaseException as error:
        smoke.report['success'] = False
        smoke.report['failure_category'] = type(error).__name__
        if isinstance(error, AssertionError):
            smoke.report['failure_message'] = str(error)
    finally:
        smoke.cleanup()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    print(json.dumps({'success': smoke.report['success'], 'model_calls': smoke.model_calls,
                      'cases': len(smoke.report['cases']), 'evidence': str(smoke.directory / 'evidence.json'),
                      'failure': smoke.report.get('failure_message', smoke.report.get('failure_category'))}))
    return 0 if smoke.report['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
