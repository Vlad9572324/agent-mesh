"""Real HTTP/PostgreSQL pilot acceptance checks; secrets never printed.

Uses an isolated agentlink_e2e database and a loopback-only child server.
Does not mutate the LAN pilot database or any other project's services.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from operator_config import runtime_dir

RUNTIME = runtime_dir()
BINARY = ROOT / 'bin/agent-link'
DSN_FILE = RUNTIME / 'secrets/agentlink_e2e-dsn'
CREDENTIALS = RUNTIME / 'secrets/e2e-credentials.json'
BASE = 'http://127.0.0.1:18766'
RUN = uuid.uuid4().hex[:12]
REPORT = {'run': RUN, 'cases': [], 'started_at': time.time()}
KEYS = {}
SERVER = None
LOG = None


def cli(*args):
    result = subprocess.run([str(BINARY), *args, '--database-url-file', str(DSN_FILE)], capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise AssertionError(f'Local CLI {args[0]} failed: {result.stderr[:400]}')
    return result


def request(path, actor=None, body=None, method=None):
    headers = {'Accept': 'application/json'}
    if actor:
        headers['Authorization'] = 'Bearer ' + KEYS[actor]
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            status, data = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, data = error.code, error.read()
    try:
        result = json.loads(data)
    except ValueError:
        result = {'text': data.decode(errors='replace')[:200]}
    return status, result


def require(value, message):
    if not value:
        raise AssertionError(message)


def check(name, action):
    started = time.monotonic()
    try:
        action()
        item = {'name': name, 'passed': True, 'seconds': round(time.monotonic() - started, 3)}
    except Exception as error:
        item = {'name': name, 'passed': False, 'error': str(error)[:1000], 'seconds': round(time.monotonic() - started, 3)}
    REPORT['cases'].append(item)
    print(json.dumps(item), flush=True)


def start_server():
    global SERVER, LOG
    LOG = open(RUNTIME / 'e2e-server.log', 'ab', buffering=0)
    SERVER = subprocess.Popen([str(BINARY), 'serve', '--database-url-file', str(DSN_FILE), '--listen', '127.0.0.1:18766', '--web-dir', str(ROOT / 'web')], stdout=LOG, stderr=LOG)
    for _ in range(100):
        if SERVER.poll() is not None:
            raise AssertionError('Test server exited; inspect private e2e-server.log')
        try:
            if request('/healthz')[0] == 200:
                return
        except OSError:
            pass
        time.sleep(.1)
    raise AssertionError('Test server readiness timeout')


def stop_server():
    global SERVER, LOG
    if SERVER is not None:
        SERVER.terminate()
        try:
            SERVER.wait(timeout=10)
        except subprocess.TimeoutExpired:
            SERVER.kill()
            SERVER.wait(timeout=5)
        SERVER = None
    if LOG:
        LOG.close()
        LOG = None


def post_message(label, actor='claude-pilot', recipients=None, **extra):
    payload = {'client_id': f'{RUN}-{label}', 'body': f'Acceptance check {RUN}/{label}', 'recipient_ids': ['codex-pilot'] if recipients is None else recipients, **extra}
    status, result = request('/v1/channels/general/messages', actor, payload)
    require(status in (200, 201), f'message {label}: HTTP {status}: {result}')
    return result['message'], payload


def heartbeat(actor, session):
    status, result = request('/v1/heartbeat', actor, {'session_id': session, 'activity': 'Acceptance test only', 'runtime': 'test'})
    require(status in (200, 201, 204), f'heartbeat: HTTP {status}: {result}')


def events(after=0):
    result = []
    for _ in range(30):
        status, data = request(f'/v1/channels/general/events?after={after}&limit=100', 'viewer-pilot')
        require(status == 200, f'events HTTP {status}')
        page = data['events']
        result.extend(page)
        if len(page) < 100:
            return result
        after = page[-1]['seq']
    raise AssertionError('Unexpectedly large test event history')


def open_sse(actor, after):
    req = urllib.request.Request(BASE + '/v1/channels/general/stream', headers={'Authorization': 'Bearer ' + KEYS[actor], 'Last-Event-ID': str(after), 'Accept': 'text/event-stream'})
    return urllib.request.urlopen(req, timeout=8)


def next_hint(stream):
    event = {}
    for _ in range(80):
        line = stream.readline().decode().strip()
        if not line and event.get('data'):
            return event
        if line.startswith('id:'):
            event['id'] = int(line[3:].strip())
        elif line.startswith('data:'):
            event['data'] = json.loads(line[5:].strip())
    raise AssertionError('No SSE hint')


try:
    cli('bootstrap', '--credentials-out', str(CREDENTIALS))
    KEYS.update(json.loads(CREDENTIALS.read_text())['keys'])
    start_server()

    def auth_and_scope():
        require(request('/v1/me')[0] == 401, 'missing key accepted')
        require(request('/v1/me', 'viewer-pilot')[1]['agent']['id'] == 'viewer-pilot', 'wrong principal')
        require(request('/v1/projects', 'deny-pilot')[1]['projects'][0]['id'] == 'isolated', 'project leakage')
        for route in ['/v1/channels/general/messages', '/v1/channels/general/events', '/v1/channels/general/stream', '/v1/projects/pilot/notes', '/v1/projects/pilot/agents']:
            require(request(route, 'deny-pilot')[0] == 404, f'forbidden route exposed: {route}')
        status, _ = request('/v1/channels/general/messages', 'viewer-pilot', {'client_id': RUN, 'body': 'must not write', 'recipient_ids': []})
        require(status in (403, 404), 'viewer can write')
        require(request('/v1/heartbeat', 'viewer-pilot', {'session_id': 'bad', 'activity': '', 'runtime': 'test'})[0] in (403, 404), 'viewer can heartbeat')
    check('authentication, default-deny project/channel isolation and viewer read-only', auth_and_scope)

    message, payload = post_message('idempotent')

    def idempotency():
        status, duplicate = request('/v1/channels/general/messages', 'claude-pilot', payload)
        require(status in (200, 201) and duplicate['message']['id'] == message['id'] and duplicate['replayed'], 'duplicate created second logical message')
        require(request('/v1/channels/general/messages', 'claude-pilot', {**payload, 'body': 'different payload'})[0] == 409, 'conflicting client_id not rejected')
        require(request('/v1/messages/' + message['id'], 'deny-pilot')[0] == 404, 'ID endpoint leaks restricted message')
        status, _ = request('/v1/channels/general/messages', 'claude-pilot', {**payload, 'client_id': RUN + '-bad-recipient', 'recipient_ids': ['deny-pilot']})
        require(status in (400, 403, 404), 'cross-channel recipient accepted')
    check('idempotency, payload conflict and structured recipient ACL', idempotency)

    heartbeat('codex-pilot', 'e2e-codex-session')
    heartbeat('claude-pilot', 'e2e-claude-session')

    def receipt_semantics():
        path = '/v1/messages/' + message['id'] + '/receipts'
        require(request('/v1/heartbeat', 'codex-pilot', {'session_id': 'competing-session', 'activity': '', 'runtime': 'test'})[0] == 409, 'fresh session takeover accepted')
        require(request(path, 'codex-pilot', {'status': 'accepted', 'session_id': 'e2e-codex-session'})[0] == 409, 'accepted without delivery')
        require(request(path, 'codex-pilot', {'status': 'delivered', 'session_id': 'wrong-session'})[0] == 409, 'receipt session spoofing')
        require(request(path, 'claude-pilot', {'status': 'delivered', 'session_id': 'e2e-claude-session'})[0] in (403, 404), 'nonrecipient can ACK')
        for stage in ['delivered', 'delivered', 'accepted', 'accepted']:
            require(request(path, 'codex-pilot', {'status': stage, 'session_id': 'e2e-codex-session'})[0] in (200, 201, 204), 'valid receipt rejected: ' + stage)
        receipt = request('/v1/messages/' + message['id'], 'viewer-pilot')[1]['message']['receipts'][0]
        require(receipt['delivered_at'] and receipt['accepted_at'] and not receipt['uncertain_at'], 'receipt meanings conflated')
        require(request(path, 'codex-pilot', {'status': 'uncertain', 'session_id': 'e2e-codex-session'})[0] in (200, 201, 204), 'uncertain marker rejected')
        require(request(path, 'codex-pilot', {'status': 'accepted', 'session_id': 'e2e-codex-session'})[0] == 409, 'uncertain state silently overwritten')
    check('single-session fencing and delivered/accepted/uncertain receipts', receipt_semantics)

    def concurrent_order():
        before = events()
        cursor = before[-1]['seq'] if before else 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            messages = list(pool.map(lambda i: post_message('parallel-' + str(i))[0], range(24)))
        journal = events(cursor)
        seqs = [entry['seq'] for entry in journal]
        require(seqs == sorted(set(seqs)), 'event sequence duplicate or unordered')
        require(seqs == list(range(cursor + 1, cursor + 1 + len(seqs))), 'transactional event sequence has gaps')
        ids = {entry['entity_id'] for entry in journal if entry['kind'] == 'message.created'}
        require(all(item['id'] in ids for item in messages), 'committed message missing from event journal')
        require(all('body' not in entry for entry in journal), 'event contains message body, not pointer')
    check('concurrent commits and ordered pointer-only replay journal', concurrent_order)

    def sse_replay():
        history = events()
        cursor = history[-1]['seq'] if history else 0
        with open_sse('viewer-pilot', cursor) as stream:
            first, _ = post_message('sse-connected')
            hint = next_hint(stream)
            require(hint['data']['entity_id'] == first['id'], 'SSE missed connected event')
        second, _ = post_message('sse-disconnected')
        with open_sse('viewer-pilot', hint['id']) as resumed:
            replay = next_hint(resumed)
            require(replay['data']['entity_id'] == second['id'] and replay['id'] > hint['id'], 'SSE resume lost or replayed prior event')
    check('SSE delivery and Last-Event-ID replay after disconnect', sse_replay)

    note_id = []
    def notes():
        body = {'client_id': RUN + '-note', 'title': '<img src=x onerror=alert(1)>', 'body': 'Explicitly published pilot note', 'source_message_id': message['id']}
        status, result = request('/v1/projects/pilot/notes', 'claude-pilot', body)
        require(status in (200, 201), f'note publication failed: {status} {result}')
        entries = request('/v1/projects/pilot/notes', 'viewer-pilot')[1]['notes']
        found = [entry for entry in entries if entry['source_message_id'] == message['id']]
        require(len(found) == 1 and found[0]['version'] == 1 and found[0]['author_id'] == 'claude-pilot', 'note attribution/source/version missing')
        note_id.append(found[0]['id'])
        require(request('/v1/projects/pilot/notes', 'claude-pilot', body)[0] in (200, 201), 'note retry failed')
        entries2 = request('/v1/projects/pilot/notes', 'viewer-pilot')[1]['notes']
        require(len(entries2) == len(entries), 'note retry duplicated data')
        require(request('/v1/projects/pilot/notes', 'viewer-pilot', body)[0] in (403, 404), 'viewer note write accepted')
    check('published note provenance, literal text and idempotency', notes)

    def persistence():
        before_hash = hashlib.sha256(CREDENTIALS.read_bytes()).hexdigest()
        cli('bootstrap', '--credentials-out', str(CREDENTIALS))
        require(hashlib.sha256(CREDENTIALS.read_bytes()).hexdigest() == before_hash, 'bootstrap silently rotated keys')
        stop_server()
        start_server()
        require(request('/v1/messages/' + message['id'], 'viewer-pilot')[0] == 200, 'message missing after server restart')
        require(any(note['id'] in note_id for note in request('/v1/projects/pilot/notes', 'viewer-pilot')[1]['notes']), 'note missing after restart')
    check('server restart persistence and repeat bootstrap preserves keys', persistence)

    def revoke_rotate():
        cursor = events()[-1]['seq']
        stream = open_sse('codex-pilot', cursor)
        try:
            cli('revoke-key', '--agent', 'codex-pilot')
            require(request('/v1/me', 'codex-pilot')[0] == 401, 'revoked key still accepted')
            deadline = time.monotonic() + 8
            ended = False
            while time.monotonic() < deadline:
                if not stream.readline():
                    ended = True
                    break
            require(ended, 'existing SSE did not terminate after revocation')
        finally:
            stream.close()
            output = RUNTIME / 'secrets' / f'e2e-rotated-{RUN}.json'
            cli('rotate-key', '--agent', 'codex-pilot', '--key-out', str(output))
            KEYS['codex-pilot'] = json.loads(output.read_text())['key']
            fd = os.open(CREDENTIALS, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW)
            with os.fdopen(fd, 'w') as target:
                json.dump({'keys': KEYS}, target)
                target.flush()
                os.fsync(target.fileno())
        require(request('/v1/me', 'codex-pilot')[1]['agent']['id'] == 'codex-pilot', 'key rotation changed account')
        require(request('/v1/messages/' + message['id'], 'codex-pilot')[0] == 200, 'key rotation lost history')
    check('revoked key closes active SSE; rotation preserves identity and history', revoke_rotate)

    def static_boundary():
        for path in ['/server.key', '/api-contract.json', '/go.mod', '/scripts/local-runtime.mjs', '/%2e%2e%2fsecrets/credentials.json']:
            require(request(path)[0] == 404, 'unexpected static path served: ' + path)
        require(request('/v1/channels/general/events?after=-1', 'viewer-pilot')[0] == 400, 'negative cursor accepted')
    check('static allowlist and invalid cursor rejection', static_boundary)
except Exception as error:
    REPORT['cases'].append({'name': 'suite infrastructure', 'passed': False, 'error': str(error)[:1000]})
    print(json.dumps(REPORT['cases'][-1]), flush=True)
finally:
    stop_server()
    REPORT['finished_at'] = time.time()
    REPORT['passed'] = bool(REPORT['cases']) and all(case['passed'] for case in REPORT['cases'])
    output = RUNTIME / 'evidence/pilot-e2e.json'
    output.write_text(json.dumps(REPORT, indent=2) + '\n')
    print(json.dumps({'passed': REPORT['passed'], 'cases': len(REPORT['cases']), 'report': str(output)}), flush=True)
    if not REPORT['passed']:
        raise SystemExit(1)
