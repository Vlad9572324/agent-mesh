#!/usr/bin/env python3
"""Isolated native connector acceptance; models require --allow-models.

Reuses the existing test-only SQL/TLS fixture lifecycle, never the live API.
The optional models perform MCP coordination only, not code changes/deployment.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

from coordination_live_smoke import Smoke, ROOT, CERT, ORIGIN, private_json, require
from dev_trial_runtimes import _OwnedGroup, _stop_owned_group
from native_launch import build_launch


class NativeSmoke(Smoke):
    def setup_native(self):
        self.setup()
        self.report['test_kind'] = 'native MCP and hooks inside existing CLI invocations'
        self.report['model_call_limit'] = 2
        self.configs = {}
        self.native_sessions = {}
        for runtime, actor, work in [('codex', 'codex-pilot', self.writer), ('claude', 'claude-pilot', self.reviewer)]:
            state = self.directory / (runtime + '-native-state')
            state.mkdir(mode=0o700)
            config = {'version': 1, 'url': ORIGIN, 'ca_file': str(CERT),
                      'key_file': str(self.directory / (actor + '.private.key')),
                      'agent_id': actor, 'project_id': 'pilot', 'channel_ids': ['general'],
                      'state_dir': str(state), 'runtime': runtime, 'workspace_root': str(work)}
            config_path = self.directory / (runtime + '-native.json')
            private_json(config_path, config)
            self.configs[runtime] = (config_path, config)
            self.native_sessions[runtime] = 'native-' + uuid.uuid4().hex
        self.message = self.clients['claude-pilot'].request('POST', '/v1/channels/general/messages', {
            'client_id': 'native-inbox-seed-' + self.run_id, 'body': 'NATIVE_INBOX_CANARY: inspect this reference message; no shell or code changes requested.',
            'recipient_ids': ['codex-pilot']})['message']

    def protocol(self):
        self.progress('native_stdio_protocol')
        path, _config = self.configs['codex']
        session = self.native_sessions['codex']
        env = dict(os.environ, AGENT_LINK_NATIVE_SESSION_ID=session)
        packets = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
                'protocolVersion': '2025-11-25', 'capabilities': {},
                'clientInfo': {'name': 'owned-native-smoke', 'version': '1'}}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'link_status', 'arguments': {}}},
            {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'link_inbox', 'arguments': {}}},
        ]
        answer = self.command([sys.executable, '-B', str(ROOT / 'scripts/agent-link-mcp.py'), '--config', str(path)],
                              'native-protocol', env=env, data=('\n'.join(json.dumps(p) for p in packets) + '\n').encode())
        rows = [json.loads(line) for line in answer.stdout.splitlines() if line.strip()]
        by_id = {row.get('id'): row for row in rows}
        require(set(by_id) == {1, 2, 3, 4}, 'stdio correlated responses')
        self.check('real_stdio_handshake_and_tools', all('result' in row and 'error' not in row for row in rows))
        for i in (3, 4):
            require(not by_id[i]['result'].get('isError'), 'native tool returned error')
        self.check('native_inbox_from_authenticated_api', b'NATIVE_INBOX_CANARY' in answer.stdout)
        self.check('native_mcp_has_explicit_accept', any(tool['name'] == 'link_accept' for tool in by_id[2]['result']['tools']))
        # A separate native session proves hook delivery, independently of the
        # preceding explicit MCP inbox read and its duplicate-offer suppression.
        session = 'native-' + uuid.uuid4().hex
        env['AGENT_LINK_NATIVE_SESSION_ID'] = session
        hook = {'hook_event_name': 'PreToolUse', 'session_id': 'provider-fixture',
                'turn_id': 'turn-fixture', 'tool_use_id': 'tool-fixture', 'tool_name': 'Bash',
                'tool_input': {'command': 'RAW_COMMAND_MUST_NOT_BE_PUBLISHED'},
                'transcript_path': '/not-readable/private-transcript'}
        answer = self.command([sys.executable, '-B', str(ROOT / 'scripts/agent-link-hook.py'), '--config', str(path), '--runtime', 'codex'],
                              'native-hook', env=env, data=json.dumps(hook).encode())
        context = json.loads(answer.stdout)['hookSpecificOutput']['additionalContext']
        self.check('hook_offers_context_not_permission', 'UNTRUSTED PEER DATA' in context and 'NATIVE_INBOX_CANARY' in context)
        activity = self.clients['codex-pilot'].request('GET', '/v1/channels/general/activity')['activity']
        own = [event for event in activity if event['session_id'] == session]
        self.check('native_metadata_not_raw_commands', any(event['event_type'] == 'tool.started' for event in own)
                   and 'RAW_COMMAND_MUST_NOT_BE_PUBLISHED' not in json.dumps(activity))
        self.check('inbox_offer_not_acceptance', any(event['event_type'] == 'inbox.offered' for event in own)
                   and not any(event['event_type'] == 'inbox.accepted' for event in own))
        original = self.clients['codex-pilot'].request('GET', '/v1/messages/' + self.message['id'])['message']
        self.check('native_offer_preserves_legacy_receipts', all(not row.get('accepted_at') and not row.get('delivered_at')
                                                             for row in original.get('receipts', [])))

    def model(self, runtime):
        require(self.model_calls < 2, 'model dispatch budget exhausted')
        self.progress('native_real_cli_' + runtime)
        path, config = self.configs[runtime]
        prompt = (
            'This is a bounded native Agent Mesh integration smoke in an isolated fixture. '
            'Use ONLY the agent_link_native MCP tools; do not execute shell commands or change files. '
            'Call link_status, then link_inbox. Explicitly accept any message whose body contains '
            'NATIVE_INBOX_CANARY using link_accept. Use link_send once to send body '
            'NATIVE_REAL_CLI_' + runtime.upper() + ' to channel general, recipient_ids ["' +
            ('claude-pilot' if runtime == 'codex' else 'codex-pilot') +
            '"], client_id "native-real-' + runtime + '-' + self.run_id + '". '
            'Finally reply NATIVE_DONE. No task creation, code edits or other action.'
        )
        if runtime == 'codex':
            tail = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
                    '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
                    '-c', 'features.plugins=false', '-c', 'features.apps=false',
                    '-c', 'mcp_servers.agent_link_native.enabled_tools=["link_status","link_inbox","link_accept","link_send"]']
            # This isolated fixture explicitly authorizes only these three
            # coordination writes. The normal launcher keeps the user's policy.
            for tool in ('link_inbox', 'link_accept', 'link_send'):
                tail += ['-c', 'mcp_servers.agent_link_native.tools.' + tool + '.approval_mode="approve"']
            tail += ['-']
        else:
            tail = ['--restricted', '--setting-sources', '', '--strict-mcp-config', '--tools', '',
                    '--allowedTools', 'mcp__agent_link_native__*', '--permission-mode', 'dontAsk',
                    '--permission-prompts', 'none', '--no-chrome', '--no-session-persistence',
                    '--model', 'sonnet', '--effort', 'low', '--output-format', 'stream-json', '--verbose', '--print']
        launch = build_launch(path, config, cli_args=tail, session_id=self.native_sessions[runtime])
        stdout_path, stderr_path = self.directory / (runtime + '-cli.stdout'), self.directory / (runtime + '-cli.stderr')
        entry = {'runtime': runtime, 'session_id': launch['native_session_id'], 'started_at': time.time()}
        self.report['models'].append(entry)
        self.model_calls += 1
        with stdout_path.open('xb') as out, stderr_path.open('xb') as err:
            child = subprocess.Popen(launch['argv'], cwd=launch['cwd'], env=launch['env'],
                                     stdin=subprocess.PIPE, stdout=out, stderr=err, start_new_session=True)
            entry['pid'] = child.pid
            owner = _OwnedGroup(child)
            try:
                child.stdin.write(prompt.encode())
                child.stdin.close()
                deadline = time.monotonic() + 180
                while not owner.exited() and time.monotonic() < deadline:
                    require(stdout_path.stat().st_size < 16 * 1024 * 1024 and stderr_path.stat().st_size < 8 * 1024 * 1024,
                            'bounded native model logs exceeded')
                    time.sleep(.1)
                entry['timed_out'] = not owner.exited()
            finally:
                entry['cleanup'] = _stop_owned_group(child, owner)
                entry['exit_code'] = child.returncode
                entry['finished_at'] = time.time()
        require(not entry.get('timed_out') and child.returncode == 0 and entry['cleanup']['group_stopped'], 'native CLI failed or unclean')
        messages = self.clients['codex-pilot'].request('GET', '/v1/channels/general/messages')['messages']
        expected = 'NATIVE_REAL_CLI_' + runtime.upper()
        self.check(runtime + '_real_mcp_send', any(m['author_id'] == config['agent_id'] and m['body'] == expected for m in messages))
        activity = self.clients['codex-pilot'].request('GET', '/v1/channels/general/activity')['activity']
        own = [item for item in activity if item['session_id'] == launch['native_session_id']]
        if runtime == 'codex':
            self.check('codex_real_explicit_accept', any(item['event_type'] == 'inbox.accepted'
                       and item.get('message_id') == self.message['id'] for item in own))
        entry['observed_event_types'] = sorted({item['event_type'] for item in own})
        observed_hooks = (any(item['event_type'] == 'session.started' for item in own)
                          and any(item['event_type'] == 'turn.completed' for item in own))
        entry['native_lifecycle_hooks_observed'] = observed_hooks
        if runtime == 'claude' or observed_hooks:
            self.check(runtime + '_native_lifecycle_hooks', observed_hooks)
        else:
            entry['hook_limitation'] = 'Codex exact-definition hook trust requires interactive /hooks review; not bypassed. MCP success does not prove native hooks.'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-models', action='store_true')
    parser.add_argument('--runtime', choices=('both', 'codex', 'claude'), default='both')
    args = parser.parse_args()
    smoke = NativeSmoke()
    previous = {sig: signal.signal(sig, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
                for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        smoke.setup_native()
        smoke.protocol()
        if args.allow_models:
            for runtime in ('codex', 'claude') if args.runtime == 'both' else (args.runtime,):
                smoke.model(runtime)
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
                      'passed_cases': len(smoke.report['cases']), 'failure_category': smoke.report.get('failure_category'),
                      'evidence': str(smoke.directory / 'evidence.json')}), flush=True)
    return 0 if smoke.report['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
