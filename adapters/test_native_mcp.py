"""Offline MCP protocol tests, including real stdio pipes + loopback HTTP.

Only the bridge subprocess is launched: no provider, model, production API or
existing credential is used. Every config/database/key is an owned fixture.
"""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from native_bridge import NativeError, canonical
from native_mcp import MAX_LINE, MCPServer, PROTOCOLS, tools, validate
from test_native_hooks import FakeNativeAPI


KEY = 'd' * 64


def rpc(identity, method, params=None):
    return {'jsonrpc': '2.0', 'id': identity, 'method': method, 'params': params or {}}


def initialize(version=PROTOCOLS[0]):
    return rpc(1, 'initialize', {'protocolVersion': version, 'capabilities': {},
                                'clientInfo': {'name': 'fixture', 'version': '1'}})


READY = {'jsonrpc': '2.0', 'method': 'notifications/initialized'}


class StubBridge:
    key = KEY

    def __init__(self):
        self.calls = []
        self.failure = None

    def reject_secret(self, value):
        if KEY in canonical(value):
            raise NativeError('known_credential_in_payload')

    def sanitize(self, value):
        return json.loads(canonical(value).replace(KEY, '[REDACTED]'))

    def status(self):
        self.calls.append('status')
        if self.failure:
            raise self.failure
        return {'auto_execution': False, 'detail': KEY}


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.bridge = StubBridge()
        self.server = MCPServer(self.bridge)

    def ready(self, version=PROTOCOLS[0]):
        response = self.server.handle(initialize(version))
        self.assertEqual(response['result']['serverInfo']['name'], 'agent_link_native')
        self.assertIsNone(self.server.handle(READY))
        return response

    def test_capabilities_negotiation_and_notification_silence(self):
        response = self.ready('2099-01-01')
        self.assertEqual(response['result']['protocolVersion'], PROTOCOLS[0])
        self.assertEqual(response['result']['capabilities'], {'tools': {'listChanged': False}})
        self.assertIsNone(self.server.handle({'jsonrpc': '2.0', 'method': 'anything'}))
        self.assertEqual(self.server.handle(rpc(2, 'ping'))['result'], {})

    def test_initialization_required_and_not_repeatable(self):
        self.assertEqual(self.server.handle(rpc(3, 'tools/list'))['error']['code'], -32002)
        self.ready()
        second = initialize()
        second['id'] = 4
        self.assertEqual(self.server.handle(second)['error']['code'], -32602)

    def test_fixed_tools_no_generic_http_shell_or_files(self):
        self.ready()
        listing = self.server.handle(rpc(2, 'tools/list'))['result']['tools']
        names = {v['name'] for v in listing}
        self.assertEqual(len(names), 15)
        self.assertIn('link_artifact_publish', names)
        self.assertIn('link_accept', names)
        self.assertIn('link_seen', names)
        self.assertIn('link_message', names)
        for item in listing:
            self.assertEqual(item['inputSchema']['type'], 'object')
            self.assertFalse(item['inputSchema']['additionalProperties'])
            self.assertNotIn('url', item['inputSchema']['properties'])
            self.assertNotIn('path', item['inputSchema']['properties'])
        listing[0]['name'] = 'mutated'
        self.assertEqual(tools()[0]['name'], 'link_status')

    def test_unknown_method_tool_and_argument_validation(self):
        self.ready()
        self.assertEqual(self.server.handle(rpc(2, 'resources/list'))['error']['code'], -32601)
        self.assertEqual(self.server.handle(rpc(3, 'tools/call', {'name': 'exec'}))['error']['code'], -32602)
        for identity, args in [(4, {'url': 'https://other'}), (5, {'limit': True}), (6, {'limit': 201}), (7, {'include_seen': 1})]:
            response = self.server.handle(rpc(identity, 'tools/call', {'name': 'link_inbox', 'arguments': args}))
            self.assertTrue(response['result']['isError'])
        self.assertEqual(self.bridge.calls, [])

    def test_secret_input_output_and_exception_are_sanitized(self):
        self.ready()
        answer = self.server.handle(rpc(2, 'tools/call', {'name': 'link_status'}))
        self.assertNotIn(KEY, canonical(answer))
        self.assertIn('[REDACTED]', canonical(answer))
        self.bridge.failure = RuntimeError(KEY + ' private path')
        failed = self.server.handle(rpc(3, 'tools/call', {'name': 'link_status'}))
        self.assertTrue(failed['result']['isError'])
        self.assertNotIn(KEY, canonical(failed))
        self.assertNotIn('private path', canonical(failed))
        rejected = self.server.handle(rpc(4, 'tools/call', {'name': 'link_send', 'arguments': {
            'channel_id': 'c', 'recipient_ids': [], 'body': KEY}}))
        self.assertTrue(rejected['result']['isError'])
        self.assertNotIn(KEY, canonical(rejected))
        self.assertEqual(self.server.handle(rpc(KEY, 'ping'))['id'], None)

    def test_unique_request_ids_and_jsonrpc_validation(self):
        self.ready()
        self.assertIn('result', self.server.handle(rpc('same', 'ping')))
        self.assertEqual(self.server.handle(rpc('same', 'ping'))['error']['code'], -32600)
        for identity in (None, True, [], {}, 1.5):
            self.assertEqual(self.server.handle(rpc(identity, 'ping'))['error']['code'], -32600)
        for value in ([], None, {'jsonrpc': '1.0', 'method': 'ping'}, {'jsonrpc': '2.0', 'method': 'ping', 'extra': 1}):
            self.assertEqual(self.server.handle(value)['error']['code'], -32600)

    def test_old_version_text_result_compatibility(self):
        self.ready('2024-11-05')
        result = self.server.handle(rpc(2, 'tools/call', {'name': 'link_status'}))['result']
        self.assertFalse(result['isError'])
        self.assertNotIn('structuredContent', result)
        self.assertEqual(json.loads(result['content'][0]['text'])['auto_execution'], False)

    def test_duplicate_fields_invalid_utf8_and_batch_are_rejected(self):
        raw = b'{"jsonrpc":"2.0","method":"ping","id":1,"id":2}\n\xff\n[]\n'
        output = io.BytesIO()
        self.server.serve(io.BytesIO(raw), output)
        codes = [v['error']['code'] for v in map(json.loads, output.getvalue().splitlines())]
        self.assertEqual(codes, [-32700, -32700, -32600])

    def test_oversized_frame_stops_without_draining_following_requests(self):
        output = io.BytesIO()
        self.server.serve(io.BytesIO(b'x' * (MAX_LINE + 1) + b'\n' + canonical(initialize()).encode() + b'\n'), output)
        answers = list(map(json.loads, output.getvalue().splitlines()))
        self.assertEqual(len(answers), 1)
        self.assertEqual(answers[0]['error']['code'], -32600)

    def test_nested_schema_rejects_extra_fields_null_and_boolean_integer(self):
        schema = next(t['inputSchema'] for t in tools() if t['name'] == 'link_task_event')
        event = {'client_id': 'e', 'expected_version': 1, 'type': 'run_started', 'run_id': 'run', 'summary': 'Starting'}
        validate({'task_id': 'task', 'event': event}, schema)
        for bad in ({**event, 'expected_version': True}, {**event, 'unknown': 'x'}, {**event, 'run_id': None}):
            with self.assertRaises(NativeError):
                validate({'task_id': 'task', 'event': bad}, schema)


class PipeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='agent-link-native-pipes-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'workspace').mkdir(mode=0o700)
        self.api = FakeNativeAPI()
        self.api.messages = [{'id': 'message-1', 'seq': 1, 'channel_id': 'c', 'author_id': 'peer',
                              'recipient_ids': ['a'], 'reply_to': 'earlier', 'body': 'fixture-only message'}]
        self.requests = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def serve_request(self):
                if self.headers.get('Authorization') != 'Bearer ' + KEY:
                    self.send_response(401)
                    self.end_headers()
                    return
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0')))) if self.command == 'POST' else None
                fixture.requests.append((self.command, self.path))
                if self.command == 'GET' and self.path == '/v1/messages/message-1':
                    result = {'message': fixture.api.messages[0]}
                else:
                    result = fixture.api.request(self.command, self.path, body)
                raw = canonical(result).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = serve_request
            do_POST = serve_request

        self.http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_http)
        key = self.root / 'key'
        key.write_text(KEY)
        key.chmod(0o600)
        self.config = self.root / 'config.json'
        self.config.write_text(canonical({'version': 1, 'url': 'http://127.0.0.1:' + str(self.http.server_port),
            'ca_file': None, 'key_file': str(key), 'agent_id': 'a', 'project_id': 'p', 'channel_ids': ['c'],
            'state_dir': str(self.root / 'state'), 'runtime': 'codex', 'workspace_root': str(self.root / 'workspace')}))
        self.config.chmod(0o600)

    def stop_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())

    def run_pipe(self, requests, extra_env=None):
        entry = Path(__file__).resolve().parents[1] / 'scripts' / 'agent-link-mcp.py'
        env = {**os.environ, 'AGENT_LINK_NATIVE_SESSION_ID': 'pipe-session', **(extra_env or {})}
        result = subprocess.run([sys.executable, '-B', str(entry), '--config', str(self.config)],
            input=''.join(canonical(v) + '\n' for v in requests).encode(), stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env, timeout=15, check=False)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stderr, b'')
        self.assertNotIn(KEY.encode(), result.stdout)
        return list(map(json.loads, result.stdout.splitlines()))

    def test_real_stdio_http_inbox_offer_and_explicit_accept(self):
        answers = self.run_pipe([initialize(), READY, rpc(2, 'tools/list'),
            rpc(3, 'tools/call', {'name': 'link_inbox'}), rpc(4, 'tools/call', {'name': 'link_flush'})])
        self.assertEqual([v['id'] for v in answers], [1, 2, 3, 4])
        inbox = answers[2]['result']['structuredContent']
        self.assertEqual(inbox['messages'][0]['reply_to'], 'earlier')
        self.assertEqual(inbox['delivery'], 'offered_not_accepted')
        self.assertEqual({v['event_type'] for v in self.api.activity.values()}, {'inbox.offered'})
        again = self.run_pipe([initialize(), READY, rpc(2, 'tools/call', {'name': 'link_accept',
            'arguments': {'message_id': 'message-1'}}), rpc(3, 'tools/call', {'name': 'link_inbox'})])
        self.assertFalse(again[1]['result']['isError'])
        self.assertEqual(again[2]['result']['structuredContent']['messages'], [])
        self.assertEqual({v['event_type'] for v in self.api.activity.values()}, {'inbox.offered', 'inbox.accepted'})
        self.assertFalse(any('/receipt' in path or '/heartbeat' in path for _, path in self.requests))

    def test_real_stdio_bad_config_fails_closed_without_secret_output(self):
        self.config.chmod(0o644)
        entry = Path(__file__).resolve().parents[1] / 'scripts' / 'agent-link-mcp.py'
        result = subprocess.run([sys.executable, '-B', str(entry), '--config', str(self.config), '--session-id', 's'],
                                input=b'', capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')
        self.assertEqual(result.stderr, b'{"error":"native_mcp_stopped"}\n')
        self.assertEqual(self.requests, [])

    def test_full_message_seen_and_review_across_stdio_restarts(self):
        self.api.messages[0]['body'] = '\x01' * 16384  # Worst-case JSON expansion remains bounded.
        answers = self.run_pipe([initialize(), READY,
            rpc(2, 'tools/call', {'name': 'link_inbox'}),
            rpc(3, 'tools/call', {'name': 'link_message', 'arguments': {'message_id': 'message-1'}}),
            rpc(4, 'tools/call', {'name': 'link_seen', 'arguments': {'message_id': 'message-1'}})])
        read = answers[2]['result']['structuredContent']
        self.assertEqual(read['message']['body'], self.api.messages[0]['body'])
        self.assertFalse(read['seen'] or read['accepted'])
        self.assertFalse(answers[3]['result']['structuredContent']['accepted'])
        again = self.run_pipe([initialize(), READY,
            rpc(2, 'tools/call', {'name': 'link_inbox'}),
            rpc(3, 'tools/call', {'name': 'link_inbox', 'arguments': {'include_seen': True}}),
            rpc(4, 'tools/call', {'name': 'link_message', 'arguments': {'message_id': 'message-1'}})],
            extra_env={'AGENT_LINK_NATIVE_SESSION_ID': 'another-pipe-session'})
        self.assertEqual(again[1]['result']['structuredContent']['messages'], [])
        self.assertEqual(len(again[2]['result']['structuredContent']['messages']), 1)
        self.assertTrue(again[3]['result']['structuredContent']['seen'])
        self.assertFalse(again[3]['result']['structuredContent']['accepted'])
        self.assertEqual({v['event_type'] for v in self.api.activity.values()}, {'inbox.offered', 'inbox.seen'})
        self.assertFalse(any('/receipt' in path or '/heartbeat' in path for _, path in self.requests))


if __name__ == '__main__':
    unittest.main()
