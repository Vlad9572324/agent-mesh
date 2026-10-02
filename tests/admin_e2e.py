"""Real HTTP/PostgreSQL owner-administration acceptance checks.

Only agentlink_e2e and the loopback child on port 18768 are used. Existing pilot
credentials, memberships, leases and history are never changed. All new ordinary
resources have a unique run prefix; the dedicated local test owner is reused.
Secrets remain in memory/private files and are redacted from test evidence.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from operator_config import runtime_dir

RUNTIME = runtime_dir()
DSN_FILE = RUNTIME / 'secrets/agentlink_e2e-dsn'
CREDENTIALS = RUNTIME / 'secrets/e2e-credentials.json'
OWNER_FILE = RUNTIME / 'secrets/admin-e2e-owner.json'
OWNER = 'admin-e2e-owner'
HOST, PORT = '127.0.0.1', 18768
BASE = f'http://{HOST}:{PORT}'
RUN = 'admin-e2e-' + uuid.uuid4().hex[:12]
REPORT = {'run': RUN, 'database': 'agentlink_e2e', 'listen': f'{HOST}:{PORT}',
          'cases': [], 'started_at': time.time()}
KEYS = {}
SECRETS = set()
MUTATIONS = []
SERVER = None
LOG = None
BINARY = None
SEED_HASH = None
STATE = {}
SERVER_STARTS = 0


def require(value, message):
    if not value:
        raise AssertionError(message)


def remember(key):
    require(isinstance(key, str) and len(key) == 64, 'invalid issued key shape')
    SECRETS.add(key)
    SECRETS.add(hashlib.sha256(key.encode()).hexdigest())
    return key


def safe_error(error):
    message = str(error)
    for secret in SECRETS:
        message = message.replace(secret, '[REDACTED]')
    return message[:800]


def check(name, action):
    started = time.monotonic()
    try:
        action()
        case = {'name': name, 'passed': True}
    except Exception as error:
        case = {'name': name, 'passed': False, 'error': safe_error(error)}
    case['seconds'] = round(time.monotonic() - started, 3)
    REPORT['cases'].append(case)
    print(json.dumps(case), flush=True)
    return case['passed']


def private_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) & 0o077 == 0,
            'credential input is not a private regular file')


def cli(*args):
    result = subprocess.run([str(BINARY), *args, '--database-url-file', str(DSN_FILE)],
                            capture_output=True, text=True, timeout=25)
    require(result.returncode == 0, f'local CLI {args[0]} failed (exit {result.returncode})')
    require(not result.stdout.strip(), 'local CLI unexpectedly wrote stdout')
    return result


def request(path, actor=None, body=None, method=None, raw=None):
    headers = {'Accept': 'application/json'}
    if actor:
        headers['Authorization'] = 'Bearer ' + KEYS[actor]
    data = raw if raw is not None else None if body is None else json.dumps(body).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            status, payload, response_headers = response.status, response.read(), response.headers
    except urllib.error.HTTPError as error:
        status, payload, response_headers = error.code, error.read(), error.headers
    try:
        result = json.loads(payload)
    except ValueError:
        result = {'non_json_response': True}
    require(response_headers.get('Cache-Control') == 'no-store', 'response lacks no-store')
    require(bool(response_headers.get('Content-Security-Policy')), 'response lacks CSP')
    return status, result


def success(path, body=None, method=None, actor=OWNER, expected=200):
    status, result = request(path, actor, body, method)
    require(status == expected, f'{method or ("POST" if body is not None else "GET")} '
            f'{path.split("?")[0]}: expected {expected}, received {status}')
    return result


def mutate(path, body, method=None, expected=200):
    result = success(path, body, method, expected=expected)
    MUTATIONS.append(path)
    return result


def access(agent, scope, resource, level):
    return mutate('/v1/admin/access', {'agent_id': agent, 'scope': scope,
                  'resource_id': resource, 'access': level}, 'PUT')


def rotate(agent):
    result = mutate(f'/v1/admin/principals/{agent}/rotate-key', {})
    require(result.get('agent_id') == agent, 'rotation changed principal identity')
    KEYS[agent] = remember(result.get('key'))
    return KEYS[agent]


def overview():
    return success('/v1/admin/overview')


def no_secrets(value):
    serialized = json.dumps(value)
    require(not any(secret in serialized for secret in SECRETS), 'raw key or key hash leaked')
    def visit(item):
        if isinstance(item, dict):
            for name, child in item.items():
                require(name not in ('key', 'key_hash', 'token', 'authorization'),
                        'secret-bearing field leaked in inventory or audit')
                visit(child)
        elif isinstance(item, list):
            for child in item:
                visit(child)
    visit(value)


def start_server():
    global SERVER, LOG, SERVER_STARTS
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind((HOST, PORT))
    SERVER_STARTS += 1
    path = RUNTIME / 'evidence' / f'{RUN}-server-{SERVER_STARTS}.log'
    LOG = path.open('xb', buffering=0)
    SERVER = subprocess.Popen([str(BINARY), 'serve', '--database-url-file', str(DSN_FILE),
                               '--listen', f'{HOST}:{PORT}', '--web-dir', str(ROOT / 'web')],
                              stdout=LOG, stderr=LOG)
    for _ in range(100):
        require(SERVER.poll() is None, 'owned loopback child exited during startup')
        try:
            if request('/healthz')[0] == 200:
                return
        except OSError:
            pass
        time.sleep(.1)
    raise AssertionError('owned loopback child readiness timeout')


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


def bootstrap_owner():
    global SEED_HASH
    for path in (DSN_FILE, CREDENTIALS):
        private_file(path)
    require(urllib.parse.urlsplit(DSN_FILE.read_text().strip()).path == '/agentlink_e2e',
            'refusing any database other than agentlink_e2e')
    SEED_HASH = hashlib.sha256(CREDENTIALS.read_bytes()).hexdigest()
    # Existing seed credentials are read for denial assertions only, never altered.
    KEYS.update(json.loads(CREDENTIALS.read_text())['keys'])
    for key in KEYS.values():
        remember(key)
    cli('bootstrap-owner', '--owner-id', OWNER, '--owner-name', 'Isolated admin acceptance owner',
        '--key-out', str(OWNER_FILE))
    private_file(OWNER_FILE)
    require(stat.S_IMODE(OWNER_FILE.stat().st_mode) == 0o600, 'owner output must be exactly 0600')
    value = json.loads(OWNER_FILE.read_text())
    require(value.get('agent_id', value.get('owner_id')) == OWNER, 'wrong local owner output identity')
    KEYS[OWNER] = remember(value['key'])
    before = hashlib.sha256(OWNER_FILE.read_bytes()).hexdigest()
    cli('bootstrap-owner', '--owner-id', OWNER, '--owner-name', 'Do not replace existing owner',
        '--key-out', str(OWNER_FILE))
    require(hashlib.sha256(OWNER_FILE.read_bytes()).hexdigest() == before,
            'repeat owner bootstrap changed existing credential file')


def owner_authentication():
    require(success('/v1/me')['agent']['kind'] == 'owner', 'owner was not provisioned locally')
    routes = [('/v1/admin/overview', None, 'GET'), ('/v1/admin/audit', None, 'GET'),
              ('/v1/admin/deliveries', None, 'GET'), ('/v1/admin/projects', {}, 'POST'),
              ('/v1/admin/channels', {}, 'POST'), ('/v1/admin/principals', {}, 'POST'),
              ('/v1/admin/access', {}, 'PUT'),
              (f'/v1/admin/principals/{OWNER}/rotate-key', {}, 'POST'),
              (f'/v1/admin/principals/{OWNER}/revoke-key', {}, 'POST'),
              ('/v1/admin/unknown-route', None, 'GET')]
    for path, body, method in routes:
        require(request(path, None, body, method)[0] == 401, 'admin route accepts missing bearer')
        for actor in ('claude-pilot', 'viewer-pilot', 'deny-pilot'):
            require(request(path, actor, body, method)[0] == 403,
                    f'non-owner {actor} not denied at admin boundary')
    # The server has no access logger; this isolated valid-key probe must not be
    # accepted as authentication. Never put its URL in evidence or error text.
    for parameter in ('key', 'token', 'access_token'):
        status, _ = request('/v1/admin/overview?' + parameter + '=' + KEYS[OWNER])
        require(status == 401, 'query-string key accepted as authentication')


def create_resources():
    STATE.update(project=RUN + '-project', channel=RUN + '-channel',
                 other_project=RUN + '-other-project', other_channel=RUN + '-other-channel',
                 writer=RUN + '-writer', recipient=RUN + '-recipient',
                 viewer=RUN + '-viewer', outsider=RUN + '-outsider')
    for key in ('project', 'other_project'):
        item = mutate('/v1/admin/projects', {'id': STATE[key], 'name': 'Owner test <literal>'}, expected=201)
        require(item['project']['id'] == STATE[key], 'project create response mismatch')
    for key, project in (('channel', 'project'), ('other_channel', 'other_project')):
        item = mutate('/v1/admin/channels', {'id': STATE[key], 'project_id': STATE[project],
                      'name': 'Private test channel'}, expected=201)
        require(item['channel']['id'] == STATE[key], 'channel create response mismatch')
    for key in ('writer', 'recipient', 'viewer', 'outsider'):
        item = mutate('/v1/admin/principals', {'id': STATE[key], 'name': 'Literal <script> test',
                      'kind': 'viewer' if key == 'viewer' else 'agent', 'runtime': 'acceptance'}, expected=201)
        require(item['principal']['id'] == STATE[key], 'principal create response mismatch')
        no_secrets(item)
    inventory = overview()
    fresh = [p for p in inventory['principals'] if p['id'].startswith(RUN)]
    require(len(fresh) == 4 and all(p['key_active'] is False for p in fresh),
            'new principal received a key before explicit rotation')
    require(not any(m['agent_id'].startswith(RUN) for m in inventory['project_members'] +
                    inventory['channel_members']), 'new principal received implicit membership')
    for key in ('writer', 'recipient', 'viewer', 'outsider'):
        rotate(STATE[key])
        require(success('/v1/me', actor=STATE[key])['agent']['id'] == STATE[key],
                'issued key cannot authenticate its own identity')


def strict_validation_and_owner_protection():
    for route, body in [('/v1/admin/projects', {'id': STATE['project'], 'name': 'Duplicate'}),
                        ('/v1/admin/channels', {'id': STATE['channel'], 'project_id': STATE['project'], 'name': 'Duplicate'}),
                        ('/v1/admin/principals', {'id': STATE['writer'], 'name': 'Duplicate', 'kind': 'agent', 'runtime': 'test'})]:
        require(request(route, OWNER, body)[0] == 409, 'duplicate resource did not return 409')
    bad_project = RUN + '-must-not-exist'
    for raw in [b'null', b'[]', b'{} {}', b'{"id":"bad","id":"other","name":"Bad"}',
                b'{"ID":"bad","name":"Bad"}', b'{"id":"bad","name":"Bad","unknown":true}']:
        require(request('/v1/admin/projects', OWNER, raw=raw, method='POST')[0] == 400,
                'admin JSON decoding is not strict')
    require(request('/v1/admin/projects', OWNER, {'id': '../escape', 'name': 'Bad'})[0] == 400,
            'invalid identifier accepted')
    require(request('/v1/admin/projects', OWNER, {'id': bad_project, 'name': 'x' * 4096})[0] == 400,
            'oversized text accepted')
    require(request('/v1/admin/channels', OWNER, {'id': RUN + '-orphan',
            'project_id': bad_project, 'name': 'Bad'})[0] in (400, 404), 'orphan channel accepted')
    require(request('/v1/admin/principals', OWNER, {'id': RUN + '-elevated', 'name': 'Bad',
            'kind': 'owner', 'runtime': ''})[0] in (400, 403), 'web creates owner principal')
    for operation in ('rotate-key', 'revoke-key'):
        require(request(f'/v1/admin/principals/{OWNER}/{operation}', OWNER, {})[0] in (400, 403),
                'web can change owner key')
    require(request('/v1/admin/access', OWNER, {'agent_id': OWNER, 'scope': 'project',
            'resource_id': STATE['project'], 'access': 'write'}, 'PUT')[0] in (400, 403),
            'web can grant owner agent membership')
    require(success('/v1/me')['agent']['kind'] == 'owner', 'owner protection attempt changed key')
    inventory = overview()
    require(not any(p['id'] in (bad_project, RUN + '-elevated') for p in inventory['principals'] +
                    inventory['projects']), 'failed validation left partial resource state')


def grant_access_and_isolation():
    for level in ('read', 'write'):
        require(request('/v1/admin/access', OWNER, {'agent_id': STATE['writer'], 'scope': 'channel',
                'resource_id': STATE['channel'], 'access': level}, 'PUT')[0] in (400, 403, 404, 409),
                'channel grant accepted without project membership')
    for key in ('writer', 'recipient', 'viewer'):
        level = 'read' if key == 'viewer' else 'write'
        access(STATE[key], 'project', STATE['project'], level)
        access(STATE[key], 'channel', STATE['channel'], level)
    access(STATE['outsider'], 'project', STATE['other_project'], 'write')
    access(STATE['outsider'], 'channel', STATE['other_channel'], 'write')
    for scope, resource in (('project', STATE['project']), ('channel', STATE['channel'])):
        require(request('/v1/admin/access', OWNER, {'agent_id': STATE['viewer'], 'scope': scope,
                'resource_id': resource, 'access': 'write'}, 'PUT')[0] in (400, 403),
                'viewer was granted write access')
    for key in ('writer', 'viewer'):
        projects = success('/v1/projects', actor=STATE[key])['projects']
        require([p['id'] for p in projects] == [STATE['project']], 'ordinary principal sees other projects')
        require(request(f'/v1/channels/{STATE["other_channel"]}/messages', STATE[key])[0] == 404,
                'ordinary principal reads unrelated channel')
    require(request(f'/v1/channels/{STATE["channel"]}/messages', STATE['outsider'])[0] == 404,
            'isolated outsider reads private channel')
    no_secrets(overview())


def post_message(actor, channel, label, recipients=None):
    return success(f'/v1/channels/{channel}/messages', {'client_id': RUN + '-' + label,
                   'body': 'Private acceptance payload ' + label,
                   'recipient_ids': recipients or []}, actor=actor, expected=201)['message']


def owner_reads_all_without_impersonation():
    writer, recipient, channel = STATE['writer'], STATE['recipient'], STATE['channel']
    message = post_message(writer, channel, 'pending', [recipient])
    STATE['message'] = message['id']
    isolated = post_message(STATE['outsider'], STATE['other_channel'], 'isolated')
    STATE['isolated_message'] = isolated['id']
    note = success(f'/v1/projects/{STATE["project"]}/notes', {'client_id': RUN + '-note',
                   'title': 'Explicit note', 'body': 'Private note', 'source_message_id': message['id']},
                   actor=writer, expected=201)['note']
    require({STATE['project'], STATE['other_project']}.issubset(
            {p['id'] for p in success('/v1/projects')['projects']}), 'owner cannot read all projects')
    for project, channel in ((STATE['project'], channel), (STATE['other_project'], STATE['other_channel'])):
        require(channel in {c['id'] for c in success(f'/v1/projects/{project}/channels')['channels']},
                'owner cannot list channel without ordinary membership')
        require(success(f'/v1/projects/{project}/agents')['agents'], 'owner cannot list project agents')
        require(success(f'/v1/channels/{channel}/messages')['messages'], 'owner cannot read channel messages')
        require(success(f'/v1/channels/{channel}/events')['events'], 'owner cannot read channel events')
    for message_id in (message['id'], isolated['id']):
        require(success('/v1/messages/' + message_id)['message']['id'] == message_id,
                'owner cannot read direct message endpoint')
    require(all(c['can_write'] is False for c in
                success(f'/v1/projects/{STATE["project"]}/channels')['channels']),
            'owner read inventory advertises ordinary agent write capability')
    with active_stream(OWNER, STATE['other_channel']) as stream:
        live = post_message(STATE['outsider'], STATE['other_channel'], 'owner-live-read')
        hint = None
        for _ in range(20):
            line = stream.readline().decode().strip()
            if line.startswith('data:'):
                hint = json.loads(line[5:].strip())
                break
        require(hint and hint['entity_id'] == live['id'] and 'body' not in hint,
                'owner cannot receive pointer-only live events for isolated channel')
    require(note['id'] in {n['id'] for n in success(f'/v1/projects/{STATE["project"]}/notes')['notes']},
            'owner cannot read published note')
    for actor in (OWNER, STATE['viewer']):
        attempts = [(f'/v1/channels/{STATE["channel"]}/messages',
                     {'client_id': RUN + '-forbidden', 'body': 'Bad', 'recipient_ids': []}),
                    (f'/v1/projects/{STATE["project"]}/notes',
                     {'client_id': RUN + '-forbidden', 'title': 'Bad', 'body': 'Bad'}),
                    ('/v1/heartbeat', {'session_id': RUN + '-spoof', 'activity': '', 'runtime': 'test'}),
                    (f'/v1/messages/{message["id"]}/receipts', {'session_id': RUN + '-spoof', 'status': 'delivered'})]
        for path, body in attempts:
            require(request(path, actor, body)[0] in (403, 404), 'owner/viewer impersonated an agent writer')
    require(request(f'/v1/channels/{STATE["channel"]}/messages', writer,
            {'client_id': RUN + '-owner-recipient', 'body': 'Bad', 'recipient_ids': [OWNER]})[0]
            in (400, 403, 404), 'owner accepted as an agent recipient')


def diagnostics_and_receipts():
    recipient, channel = STATE['recipient'], STATE['channel']
    session = RUN + '-recipient-session'
    success('/v1/heartbeat', {'session_id': session, 'activity': 'Acceptance only', 'runtime': 'test'}, actor=recipient)
    inventory = overview()
    agent = next(p for p in inventory['principals'] if p['id'] == recipient)
    require(agent['freshness'] == 'fresh' and agent['session_id'] == session and agent['last_seen_at'],
            'overview omits fresh runtime/lease diagnostics')
    pending = success('/v1/admin/deliveries?limit=500')['deliveries']
    require(any(d['message_id'] == STATE['message'] and d['recipient_id'] == recipient and
                not d['accepted_at'] for d in pending), 'pending acceptance absent from diagnostics')
    for stage in ('delivered', 'accepted'):
        success(f'/v1/messages/{STATE["message"]}/receipts', {'session_id': session, 'status': stage}, actor=recipient)
    require(not any(d['message_id'] == STATE['message'] for d in
                    success('/v1/admin/deliveries?limit=500')['deliveries']),
            'accepted delivery remains pending in diagnostics')
    uncertain = post_message(STATE['writer'], channel, 'uncertain', [recipient])
    success(f'/v1/messages/{uncertain["id"]}/receipts', {'session_id': session, 'status': 'uncertain'}, actor=recipient)
    deliveries = success('/v1/admin/deliveries?limit=500')['deliveries']
    require(any(d['message_id'] == uncertain['id'] and d['uncertain_at'] for d in deliveries),
            'uncertain delivery absent from diagnostics')
    for route, field in (('/v1/admin/audit', 'entries'), ('/v1/admin/deliveries', 'deliveries')):
        first = success(route + '?limit=1')
        require(len(first[field]) == 1 and isinstance(first['truncated'], bool), 'bounded diagnostics shape invalid')
        require(first == success(route + '?limit=1'), 'bounded diagnostics ordering is not deterministic')
        require(len(success(route + '?limit=10000')[field]) <= 500, 'diagnostics limit exceeds hard cap')
        for invalid in ('0', '-1', 'bad'):
            require(request(route + '?limit=' + invalid, OWNER)[0] == 400, 'invalid diagnostics limit accepted')
        no_secrets(first)
    require(request('/v1/admin/deliveries', OWNER, {})[0] in (404, 405),
            'read-only diagnostic endpoint accepts a mutation')


def active_stream(actor, channel):
    cursor = success(f'/v1/channels/{channel}/events', actor=actor)['cursor']
    req = urllib.request.Request(BASE + f'/v1/channels/{channel}/stream', headers={
        'Authorization': 'Bearer ' + KEYS[actor], 'Last-Event-ID': str(cursor),
        'Accept': 'text/event-stream'})
    return urllib.request.urlopen(req, timeout=8)


def key_revocation_rotation_and_sse():
    actor, channel = STATE['recipient'], STATE['channel']
    before = KEYS[actor]
    with active_stream(actor, channel) as stream:
        mutate(f'/v1/admin/principals/{actor}/revoke-key', {})
        require(request('/v1/me', actor)[0] == 401, 'revoked key still authenticates')
        deadline = time.monotonic() + 7
        ended = False
        while time.monotonic() < deadline:
            if not stream.readline():
                ended = True
                break
        require(ended, 'revocation did not close existing SSE connection')
    require(next(p for p in overview()['principals'] if p['id'] == actor)['key_active'] is False,
            'inventory reports revoked key active')
    after = rotate(actor)
    require(after != before, 'rotation reused old secret')
    require(success('/v1/messages/' + STATE['message'], actor=actor)['message']['id'] == STATE['message'],
            'rotation lost principal history or memberships')
    old_alias = RUN + '-old-secret'
    KEYS[old_alias] = before
    require(request('/v1/me', old_alias)[0] == 401, 'rotation reactivated revoked old key')
    second = rotate(actor)
    KEYS[old_alias] = after
    require(second != after and request('/v1/me', old_alias)[0] == 401,
            'active-key rotation failed to invalidate predecessor')
    no_secrets(overview())
    no_secrets(success('/v1/admin/audit?limit=500'))


def local_cli_audit_and_private_rotation():
    actor = STATE['outsider']
    cli('revoke-key', '--agent', actor)
    require(request('/v1/me', actor)[0] == 401, 'local revocation did not invalidate owned test principal')
    output = RUNTIME / 'secrets' / f'{RUN}-local-rotation.json'
    cli('rotate-key', '--agent', actor, '--key-out', str(output))
    private_file(output)
    require(stat.S_IMODE(output.stat().st_mode) == 0o600, 'local rotation output mode not 0600')
    value = json.loads(output.read_text())
    require(value['agent_id'] == actor, 'local rotation output identity mismatch')
    KEYS[actor] = remember(value['key'])
    require(success('/v1/me', actor=actor)['agent']['id'] == actor, 'local key rotation lost identity')
    entries = [e for e in success('/v1/admin/audit?limit=500')['entries']
               if e['target_id'] == actor and e['actor_id'] == 'local-cli']
    require({e['action'] for e in entries} == {'key.revoke', 'key.rotate'} and len(entries) == 2,
            'local CLI actions lack distinct atomic audit attribution')
    no_secrets(entries)


def acl_removal_and_concurrency():
    writer, project, channel = STATE['writer'], STATE['project'], STATE['channel']
    access(writer, 'project', project, 'read')
    require(next(m for m in overview()['channel_members'] if m['agent_id'] == writer and
                 m['channel_id'] == channel)['can_write'] is False,
            'project read downgrade left channel write metadata enabled')
    require(request(f'/v1/channels/{channel}/messages', writer, {'client_id': RUN + '-downgraded',
                    'body': 'Forbidden', 'recipient_ids': []})[0] in (403, 404),
            'project downgrade did not stop agent writes')
    access(writer, 'project', project, 'write')
    require(request(f'/v1/channels/{channel}/messages', writer, {'client_id': RUN + '-dormant-write',
                    'body': 'Forbidden', 'recipient_ids': []})[0] in (403, 404),
            'project upgrade silently resurrected downgraded channel write access')
    access(writer, 'channel', channel, 'write')
    actor, project, channel = STATE['viewer'], STATE['project'], STATE['channel']
    with active_stream(actor, channel) as stream:
        access(actor, 'project', project, 'none')
        require(not stream.readline(), 'membership removal did not close existing SSE')
    inventory = overview()
    require(not any(m['agent_id'] == actor and m['channel_id'] == channel
                    for m in inventory['channel_members']), 'project removal left orphaned channel membership')
    require(request(f'/v1/channels/{channel}/messages', actor)[0] == 404, 'removed member still reads messages')
    access(actor, 'project', project, 'read')
    require(request(f'/v1/channels/{channel}/messages', actor)[0] == 404,
            'project regrant resurrected removed channel grant')
    require(request('/v1/admin/access', OWNER, {'agent_id': actor, 'scope': 'channel',
            'resource_id': channel, 'access': 'write'}, 'PUT')[0] in (400, 403, 409),
            'channel write accepted without project write')
    actor = STATE['recipient']
    for _ in range(8):
        access(actor, 'project', project, 'write')
        def race(level, scope, resource):
            body = {'agent_id': actor, 'scope': scope, 'resource_id': resource, 'access': level}
            status, _ = request('/v1/admin/access', OWNER, body, 'PUT')
            if status == 200:
                MUTATIONS.append('/v1/admin/access')
            return status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            remove = pool.submit(race, 'none', 'project', project)
            grant = pool.submit(race, 'write', 'channel', channel)
            require(remove.result() == 200 and grant.result() in (200, 400, 403, 404, 409),
                    'concurrent ACL operations failed or deadlocked')
        inventory = overview()
        require(not any(m['agent_id'] == actor and m['project_id'] == project
                        for m in inventory['project_members']), 'project removal was lost during concurrent grant')
        require(not any(m['agent_id'] == actor and m['channel_id'] == channel
                        for m in inventory['channel_members']), 'concurrent ACL change left orphan channel grant')
    access(actor, 'project', project, 'write')
    require(request(f'/v1/channels/{channel}/messages', actor)[0] == 404,
            'concurrent cleanup left dormant channel privileges')


def audit_matches_successful_mutations():
    data = success('/v1/admin/audit?limit=500')
    no_secrets(data)
    entries = [e for e in data['entries'] if e['actor_id'] == OWNER and
               (str(e['target_id']).startswith(RUN) or RUN in json.dumps(e['details']))]
    require(len(entries) == len(MUTATIONS),
            f'audit/state commit mismatch: {len(entries)} audit rows, {len(MUTATIONS)} successful mutations')
    require(len({e['id'] for e in entries}) == len(entries), 'duplicate audit identifiers')
    for entry in entries:
        require(entry['action'] and entry['target_type'] and entry['created_at'] and
                isinstance(entry['details'], dict), 'incomplete audit attribution')
        require(set(entry['details']).issubset({'agent_id', 'scope', 'resource_id', 'access', 'kind', 'project_id'}),
                'audit includes non-allowlisted sensitive payload')
    require({'project', 'channel', 'principal'}.issubset({e['target_type'] for e in entries}),
            'audit omitted a resource class')
    REPORT['successful_admin_mutations'] = len(MUTATIONS)
    REPORT['matching_owner_audit_entries'] = len(entries)


def restart_and_preservation():
    stop_server()
    start_server()
    require(success('/v1/me')['agent']['id'] == OWNER, 'owner key lost after restart')
    require(success('/v1/messages/' + STATE['isolated_message'])['message']['id'] == STATE['isolated_message'],
            'admin-created resource history lost after restart')
    require(hashlib.sha256(CREDENTIALS.read_bytes()).hexdigest() == SEED_HASH,
            'existing pilot credential file was changed')
    no_secrets(overview())
    for index in range(1, SERVER_STARTS + 1):
        log = (RUNTIME / 'evidence' / f'{RUN}-server-{index}.log').read_text()
        require(not any(secret in log for secret in SECRETS), 'server log contains a raw key or key hash')


def main():
    global BINARY
    os.umask(0o077)
    (RUNTIME / 'evidence').mkdir(exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='agent-link-admin-e2e-') as build_dir:
            BINARY = Path(build_dir) / 'agent-link'
            build = subprocess.run(['go', 'build', '-o', str(BINARY), './cmd/agent-link'], cwd=ROOT,
                                   capture_output=True, text=True, timeout=90)
            require(build.returncode == 0, 'test binary build failed; run go test for compiler diagnostics')
            require(check('local owner bootstrap is private and idempotent', bootstrap_owner), 'owner bootstrap prerequisite failed')
            start_server()
            check('owner-only admin boundary, missing/query key rejection', owner_authentication)
            require(check('explicit resource creation and one-time initial key issuance', create_resources), 'resource prerequisite failed')
            check('strict JSON validation, duplicates and owner lifecycle protection', strict_validation_and_owner_protection)
            require(check('default deny, viewer write rejection and scoped membership grants', grant_access_and_isolation), 'ACL prerequisite failed')
            require(check('owner reads all isolated history but cannot impersonate agents', owner_reads_all_without_impersonation), 'history prerequisite failed')
            check('fresh lease, pending/uncertain delivery and bounded diagnostics', diagnostics_and_receipts)
            check('key revocation closes SSE; rotations preserve identity and invalidate old keys', key_revocation_rotation_and_sse)
            check('local CLI revocation and private rotation have distinct audit attribution', local_cli_audit_and_private_rotation)
            check('membership cleanup closes SSE and serializes concurrent ACL changes', acl_removal_and_concurrency)
            check('successful admin state changes match secret-free attributed audit records', audit_matches_successful_mutations)
            check('server restart persistence and original credential preservation', restart_and_preservation)
    except Exception as error:
        check('suite infrastructure', lambda: require(False, safe_error(error)))
    finally:
        stop_server()
        if SEED_HASH is not None:
            check('existing e2e credential file remains byte-identical', lambda: require(
                hashlib.sha256(CREDENTIALS.read_bytes()).hexdigest() == SEED_HASH,
                'existing e2e credentials changed during suite'))
        REPORT['finished_at'] = time.time()
        REPORT['passed'] = bool(REPORT['cases']) and all(case['passed'] for case in REPORT['cases'])
        output = RUNTIME / 'evidence/admin-e2e.json'
        output.write_text(json.dumps(REPORT, indent=2) + '\n')
        print(json.dumps({'passed': REPORT['passed'], 'cases': len(REPORT['cases']),
                          'report': str(output)}), flush=True)
    return 0 if REPORT['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
