#!/usr/bin/env python3
"""Model-free native inbox -> owner deadline -> direct-reply acceptance.

Reuses the existing owned PostgreSQL-schema/loopback-TLS fixture. Requires
AGENT_LINK_RUNTIME_DIR and its test DSN, plus AGENT_LINK_CA_FILE. No provider CLI,
live workspace or model is used. The fixed fixture port must be available.
"""
import argparse
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

    def mcp(self, name, arguments):
        # Each call is a real fresh stdio process/session. Inbox state remains
        # shared, proving that fair selection survives process boundaries.
        config, _ = self.configs['codex']
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
        require(not answer.get('isError'), 'MCP tool failed: ' + name)
        return answer['structuredContent']

    def publish(self, label, body):
        return self.clients['claude-pilot'].request('POST', '/v1/channels/general/messages', {
            'client_id': self.run_id + '-' + label, 'body': body,
            'recipient_ids': ['codex-pilot']})['message']

    def finish_publication(self, page):
        publication = page['publication']
        require(not publication.get('error') and publication['blocked'] == 0,
                'MCP reports publication result without hidden failure')
        # link_inbox deliberately caps its automatic flush. Honour the returned
        # backlog instead of assuming every offered report has already arrived.
        if publication['pending']:
            publication = self.mcp('link_flush', {'limit': 100})
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
        self.clients['codex-pilot'].request('POST', '/v1/channels/general/messages', {
            'client_id': self.run_id + '-broadcast-reply', 'body': 'Synthetic reply without addressee',
            'recipient_ids': [], 'reply_to': mid})
        self.check('broadcast_reply_does_not_clear_direct_reply_deadline', len(target_alerts()) == 1)
        sent = self.mcp('link_send', {'channel_id': 'general', 'recipient_ids': ['claude-pilot'],
                                    'reply_to': mid, 'body': 'Synthetic direct answer',
                                    'client_id': self.run_id + '-direct-reply'})
        self.check('real_direct_reply_clears_owner_alert', sent['publication_state'] == 'sent'
                   and not target_alerts())
        original = self.clients['codex-pilot'].request('GET', '/v1/messages/' + mid)['message']
        self.check('native_path_preserves_legacy_receipts', all(not r.get('delivered_at')
                   and not r.get('accepted_at') for r in original.get('receipts', [])))
        self.check('no_model_invocation', self.model_calls == 0 and not self.report['models'])


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
