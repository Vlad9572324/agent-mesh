"""Isolated project archive/restore/delete acceptance over real HTTP/PostgreSQL.

Run only after coordinating exclusive use of agentlink_e2e with the other suites.
Never archives/deletes seed projects or changes seed credentials. The imported
admin suite has no import-time execution; its transport/private-key helpers are
reused with a distinct child port, binary, resource prefix and evidence report.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
import urllib.parse
import uuid

import admin_e2e as common


RUN = 'lifecycle-e2e-' + uuid.uuid4().hex[:12]
common.RUN = RUN
common.PORT = 18770
common.BASE = f'http://{common.HOST}:{common.PORT}'
common.REPORT = {'run': RUN, 'database': 'agentlink_e2e', 'listen': '127.0.0.1:18770',
                 'cases': [], 'started_at': time.time()}
STATE = {}
require = common.require
request = common.request
success = common.success
check = common.check
OWNER = common.OWNER


def admin(path, body=None, method=None, expected=200):
    return success('/v1/admin/projects/' + STATE['project'] + path, body, method,
                   expected=expected)


def preview(project=None):
    return success(f'/v1/admin/projects/{project or STATE["project"]}/deletion-preview')


def audit(project=None):
    target = project or STATE['project']
    return [e for e in success('/v1/admin/audit?limit=500')['entries'] if e['target_id'] == target]


def lifecycle_audit(project=None):
    return [e for e in audit(project) if e['action'] in ('project.archive', 'project.restore', 'project.delete')]


def post(actor, channel, label, recipients=None, reply=None):
    body = {'client_id': RUN + '-' + label, 'body': 'Lifecycle fixture ' + label,
            'recipient_ids': recipients or []}
    if not recipients:
        body['channel_only'] = True
    if reply is not None:
        body['reply_to'] = reply
    return success(f'/v1/channels/{channel}/messages', body, actor=actor, expected=201)['message']


def create_fixtures():
    STATE.update(project=RUN + '-project', channel=RUN + '-channel', second_channel=RUN + '-second',
                 control_project=RUN + '-control', control_channel=RUN + '-control-channel',
                 race_project=RUN + '-race', race_channel=RUN + '-race-channel',
                 writer=RUN + '-writer', recipient=RUN + '-recipient', viewer=RUN + '-viewer')
    for key in ('project', 'control_project', 'race_project'):
        item = success('/v1/admin/projects', {'id': STATE[key], 'name': 'Lifecycle fixture'}, expected=201)['project']
        require(item['archived_at'] is None and item['lifecycle_version'] == 0,
                'new project lifecycle defaults are not active/version zero')
    for channel, project in (('channel', 'project'), ('second_channel', 'project'),
                             ('control_channel', 'control_project'), ('race_channel', 'race_project')):
        success('/v1/admin/channels', {'id': STATE[channel], 'project_id': STATE[project],
                'name': 'Lifecycle fixture channel'}, expected=201)
    for key in ('writer', 'recipient', 'viewer'):
        actor = STATE[key]
        success('/v1/admin/principals', {'id': actor, 'name': 'Lifecycle fixture principal',
                'kind': 'viewer' if key == 'viewer' else 'agent', 'runtime': 'lifecycle-test'}, expected=201)
        common.rotate(actor)
        level = 'read' if key == 'viewer' else 'write'
        common.access(actor, 'project', STATE['project'], level)
        for channel in ('channel', 'second_channel'):
            common.access(actor, 'channel', STATE[channel], level)
        if key != 'viewer':
            common.access(actor, 'project', STATE['control_project'], 'write')
            common.access(actor, 'channel', STATE['control_channel'], 'write')
    common.access(STATE['writer'], 'project', STATE['race_project'], 'write')
    common.access(STATE['writer'], 'channel', STATE['race_channel'], 'write')
    messages = []
    for number in range(3):
        messages.append(post(STATE['writer'], STATE['channel'], f'reply-{number}', [STATE['recipient']],
                             messages[-1]['id'] if messages else None))
    messages.append(post(STATE['writer'], STATE['second_channel'], 'second-channel', [STATE['recipient']]))
    STATE['messages'] = messages
    STATE['session'] = RUN + '-recipient-session'
    success('/v1/heartbeat', {'session_id': STATE['session'], 'activity': 'Lifecycle acceptance only',
            'runtime': 'lifecycle-test'}, actor=STATE['recipient'])
    for stage in ('delivered', 'accepted'):
        success('/v1/messages/' + messages[0]['id'] + '/receipts',
                {'session_id': STATE['session'], 'status': stage}, actor=STATE['recipient'])
    STATE['notes'] = []
    for number in range(2):
        note = success(f'/v1/projects/{STATE["project"]}/notes',
                       {'client_id': RUN + '-note-' + str(number), 'title': 'Lifecycle fixture note',
                        'body': 'Published lifecycle fixture', 'source_message_id': messages[0]['id']},
                       actor=STATE['writer'], expected=201)['note']
        STATE['notes'].append(note)
    control = post(STATE['writer'], STATE['control_channel'], 'control-history', [STATE['recipient']])
    STATE['control_message'] = control
    STATE['control_note'] = success(f'/v1/projects/{STATE["control_project"]}/notes',
                                    {'client_id': RUN + '-control-note', 'title': 'Preserve this note',
                                     'body': 'Unrelated content must survive', 'source_message_id': control['id']},
                                    actor=STATE['writer'], expected=201)['note']
    post(STATE['writer'], STATE['race_channel'], 'race-initial')
    initial = preview()
    require(initial['can_delete'] is False, 'active project advertised deletable')
    require(initial['counts'] == {'channels': 2, 'messages': 4, 'notes': 2, 'receipts': 4,
                                 'events': 6, 'project_members': 3, 'channel_members': 6,
                                 'tasks': 0, 'task_runs': 0, 'task_events': 0, 'memory': 0,
                                 'memory_versions': 0, 'artifacts': 0, 'artifact_bytes': 0, 'sessions': 0,
                                 'native_activity': 0},
            'deletion preview does not count complete fixture scope')
    STATE['initial_preview'] = initial
    inventory = common.overview()
    STATE['memberships'] = {
        'project': [m for m in inventory['project_members'] if m['project_id'] == STATE['project']],
        'channel': [m for m in inventory['channel_members'] if m['channel_id'] in
                    (STATE['channel'], STATE['second_channel'])]}


def authorization_and_active_delete():
    base = '/v1/admin/projects/' + STATE['project']
    for path, method, body in [(base + '/archive', 'POST', {}), (base + '/restore', 'POST', {}),
                               (base + '/deletion-preview', 'GET', None),
                               (base, 'DELETE', {'confirm_id': STATE['project'], 'expected_version': 0})]:
        require(request(path, body=body, method=method)[0] == 401, 'lifecycle route accepts missing bearer')
        for actor in (STATE['writer'], STATE['viewer'], 'deny-pilot'):
            require(request(path, actor, body, method)[0] == 403, 'non-owner can invoke lifecycle administration')
    require(admin('', {'confirm_id': STATE['project'], 'expected_version': 0}, 'DELETE', 409),
            'active project deletion accepted')
    require(not lifecycle_audit(), 'rejected deletion produced lifecycle audit state')
    for path in ('/archive', '/restore'):
        for raw in (b'null', b'{"confirm":true}', b'{} {}'):
            require(request(base + path, OWNER, method='POST', raw=raw)[0] == 400,
                    'lifecycle mutation does not enforce strict empty JSON object')


def archive_hides_and_preserves():
    before = len(lifecycle_audit())
    with common.active_stream(STATE['viewer'], STATE['channel']) as stream:
        project = admin('/archive', {})['project']
        require(project['archived_at'] and project['lifecycle_version'] == 1, 'archive transition metadata invalid')
        deadline = time.monotonic() + 7
        ended = False
        while time.monotonic() < deadline:
            if not stream.readline():
                ended = True
                break
        require(ended, 'archive failed to close an existing ordinary SSE stream')
    require(admin('/archive', {})['project'] == project, 'repeat archive changed existing archived state')
    require(len(lifecycle_audit()) == before + 1, 'repeat archive duplicated audit record')
    archived = preview()
    require(archived['can_delete'] is True and archived['counts'] == STATE['initial_preview']['counts'],
            'archive changed content or membership counts')
    STATE['stale_preview'] = archived
    for actor in (OWNER, STATE['writer'], STATE['viewer'], STATE['recipient']):
        require(STATE['project'] not in {p['id'] for p in success('/v1/projects', actor=actor)['projects']},
                'archived project leaked into active projects list')
    routes = [f'/v1/projects/{STATE["project"]}/channels', f'/v1/projects/{STATE["project"]}/agents',
              f'/v1/projects/{STATE["project"]}/notes', f'/v1/channels/{STATE["channel"]}/messages',
              f'/v1/channels/{STATE["channel"]}/events', f'/v1/channels/{STATE["channel"]}/stream',
              '/v1/messages/' + STATE['messages'][0]['id']]
    for actor in (STATE['writer'], STATE['viewer'], STATE['recipient'], 'deny-pilot'):
        for route in routes:
            require(request(route, actor)[0] == 404, 'ordinary identity inferred archived content through a direct API')
    for route in routes:
        if route.endswith('/stream'):
            with common.active_stream(OWNER, STATE['channel']) as stream:
                require(stream.status == 200, 'owner cannot read archived SSE history')
        else:
            require(request(route, OWNER)[0] == 200, 'owner cannot inspect archived history')
    inventory = common.overview()
    require(next(p for p in inventory['projects'] if p['id'] == STATE['project']) == project,
            'admin overview omitted archived project metadata')
    for message in STATE['messages']:
        require(success('/v1/messages/' + message['id'])['message']['body'] == message['body'],
                'archive modified message history')


def archived_mutations_are_frozen():
    for path, body in [(f'/v1/channels/{STATE["channel"]}/messages',
                        {'client_id': RUN + '-frozen-message', 'body': 'Forbidden', 'recipient_ids': []}),
                       (f'/v1/projects/{STATE["project"]}/notes',
                        {'client_id': RUN + '-frozen-note', 'title': 'Forbidden', 'body': 'Forbidden'}),
                       ('/v1/messages/' + STATE['messages'][1]['id'] + '/receipts',
                        {'session_id': STATE['session'], 'status': 'delivered'})]:
        actor = STATE['recipient'] if path.endswith('/receipts') else STATE['writer']
        require(request(path, actor, body)[0] == 404, 'archived project allowed ordinary mutation')
    require(request('/v1/admin/channels', OWNER, {'id': RUN + '-frozen-channel',
            'project_id': STATE['project'], 'name': 'Forbidden'})[0] == 409,
            'owner created a channel inside an archived project')
    for scope, resource in (('project', STATE['project']), ('channel', STATE['channel'])):
        for level in ('none', 'read', 'write'):
            require(request('/v1/admin/access', OWNER, {'agent_id': STATE['writer'], 'scope': scope,
                    'resource_id': resource, 'access': level}, 'PUT')[0] == 409,
                    'owner edited archived memberships')
    success('/v1/heartbeat', {'session_id': STATE['session'], 'activity': 'Global heartbeat remains allowed',
            'runtime': 'lifecycle-test'}, actor=STATE['recipient'])
    common.rotate(STATE['viewer'])
    require(success('/v1/me', actor=STATE['viewer'])['agent']['id'] == STATE['viewer'],
            'archive incorrectly disabled independent principal/key management')
    require(preview()['counts'] == STATE['initial_preview']['counts'], 'rejected archived mutation changed data')


def restore_recovers_permissions():
    restored = admin('/restore', {})['project']
    require(restored['archived_at'] is None and restored['lifecycle_version'] == 2, 'restore transition metadata invalid')
    count = len(lifecycle_audit())
    require(admin('/restore', {})['project'] == restored and len(lifecycle_audit()) == count,
            'repeat restore changed version or duplicated audit')
    require(preview()['can_delete'] is False, 'restored project remains deletable')
    for actor in (OWNER, STATE['writer'], STATE['viewer'], STATE['recipient']):
        require(STATE['project'] in {p['id'] for p in success('/v1/projects', actor=actor)['projects']},
                'restore did not return project to active list')
    inventory = common.overview()
    require([m for m in inventory['project_members'] if m['project_id'] == STATE['project']] ==
            STATE['memberships']['project'], 'archive/restore changed project permissions')
    require([m for m in inventory['channel_members'] if m['channel_id'] in
             (STATE['channel'], STATE['second_channel'])] == STATE['memberships']['channel'],
            'archive/restore changed channel permissions')
    require(len(success(f'/v1/channels/{STATE["channel"]}/messages', actor=STATE['viewer'])['messages']) == 3,
            'viewer history did not become readable after restore')
    require(request(f'/v1/channels/{STATE["channel"]}/messages', STATE['viewer'],
            {'client_id': RUN + '-viewer-write', 'body': 'Forbidden', 'recipient_ids': []})[0] in (403, 404),
            'restore elevated viewer to writer')
    STATE['messages'].append(post(STATE['writer'], STATE['channel'], 'after-restore', [STATE['recipient']],
                                  STATE['messages'][2]['id']))
    require(request(f'/v1/channels/{STATE["channel"]}/messages', 'deny-pilot')[0] == 404,
            'restore granted access to an unrelated seed principal')


def deletion_confirmation_and_stale_version():
    archived = admin('/archive', {})['project']
    require(archived['lifecycle_version'] == 3 and archived['archived_at'], 'second archive did not increment version')
    target = '/v1/admin/projects/' + STATE['project']
    valid = {'confirm_id': STATE['project'], 'expected_version': archived['lifecycle_version']}
    invalid = [({**valid, 'confirm_id': STATE['control_project']}, 400),
               ({**valid, 'confirm_id': STATE['project'] + ' '}, 400),
               ({**valid, 'expected_version': STATE['stale_preview']['project']['lifecycle_version']}, 409),
               ({**valid, 'expected_version': -1}, 400),
               ({'confirm_id': STATE['project']}, 400),
               ({'expected_version': archived['lifecycle_version']}, 400),
               ({**valid, 'expected_version': True}, 400), ({**valid, 'unknown': True}, 400)]
    before = preview()
    audit_count = len(lifecycle_audit())
    for body, expected in invalid:
        require(request(target, OWNER, body, 'DELETE')[0] == expected,
                'delete confirmation/type/version validation failed')
    raw = ('{"confirm_id":"' + STATE['project'] + '","expected_version":3,"expected_version":3}').encode()
    require(request(target, OWNER, method='DELETE', raw=raw)[0] == 400, 'delete accepts duplicate JSON fields')
    require(preview() == before and len(lifecycle_audit()) == audit_count,
            'rejected delete changed data, version, or audit')
    STATE['delete_preview'] = before


def literal(value):
    require(bool(re.fullmatch(r'[a-zA-Z0-9_.:-]+', value)), 'unsafe generated SQL identifier literal')
    return "'" + value + "'"


def query_json(sql):
    """Read-only SQL, with private DSN parsed into child environment, never argv."""
    dsn = urllib.parse.urlsplit(common.DSN_FILE.read_text().strip())
    require(dsn.path == '/agentlink_e2e' and dsn.hostname == '127.0.0.1', 'SQL probe refuses non-test database')
    pg_root = common.RUNTIME / 'pgsql/usr'
    env = {**os.environ, 'PGHOST': dsn.hostname, 'PGPORT': str(dsn.port),
           'PGDATABASE': 'agentlink_e2e', 'PGUSER': urllib.parse.unquote(dsn.username),
           'PGPASSWORD': urllib.parse.unquote(dsn.password), 'PGSSLMODE': 'disable',
           'PGCONNECT_TIMEOUT': '5', 'LD_LIBRARY_PATH': str(pg_root / 'lib/x86_64-linux-gnu')}
    result = subprocess.run([str(pg_root / 'lib/postgresql/14/bin/psql'), '-XqAt', '--no-password',
                             '--set', 'ON_ERROR_STOP=1', '-c', 'BEGIN READ ONLY', '-c', sql, '-c', 'COMMIT'],
                            env=env, capture_output=True, text=True, timeout=15)
    require(result.returncode == 0, 'read-only isolated PostgreSQL verification failed')
    lines = [line for line in result.stdout.splitlines() if line.startswith('{')]
    require(len(lines) == 1, 'read-only database probe returned unexpected shape')
    return json.loads(lines[0])


def unaffected_fingerprints():
    project = literal(STATE['project'])
    channels = ','.join(literal(STATE[key]) for key in ('channel', 'second_channel'))
    messages = ','.join(literal(m['id']) for m in STATE['messages'])
    filters = {'projects': f'id <> {project}', 'channels': f'id NOT IN ({channels})',
               'project_members': f'project_id <> {project}', 'channel_members': f'channel_id NOT IN ({channels})',
               'messages': f'channel_id NOT IN ({channels})', 'receipts': f'message_id NOT IN ({messages})',
               'events': f'channel_id NOT IN ({channels})', 'notes': f'project_id <> {project}', 'principals': 'true'}
    fields = []
    for table, condition in filters.items():
        # Only a checksum leaves the database, not principal hashes or content.
        fields.append(literal(table) + f", (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) FROM {table} t WHERE {condition})")
    return query_json('SELECT json_build_object(' + ','.join(fields) + ')')


def deletion_counts():
    project = literal(STATE['project'])
    channels = ','.join(literal(STATE[key]) for key in ('channel', 'second_channel'))
    messages = ','.join(literal(m['id']) for m in STATE['messages'])
    conditions = {'projects': f'id={project}', 'channels': f'id IN ({channels})',
                  'project_members': f'project_id={project}', 'channel_members': f'channel_id IN ({channels})',
                  'messages': f'id IN ({messages})', 'receipts': f'message_id IN ({messages})',
                  'events': f'channel_id IN ({channels})', 'notes': f'project_id={project}'}
    return query_json('SELECT json_build_object(' + ','.join(
        literal(table) + f', (SELECT count(*) FROM {table} WHERE {where})' for table, where in conditions.items()) + ')')


def hard_delete_is_scoped_and_complete():
    before = unaffected_fingerprints()
    state = STATE['delete_preview']
    result = admin('', {'confirm_id': STATE['project'], 'expected_version': state['project']['lifecycle_version']}, 'DELETE')
    require(result == {'deleted': True, 'project_id': STATE['project']}, 'hard delete response shape invalid')
    require(unaffected_fingerprints() == before, 'hard delete changed principals, keys, or unrelated database rows')
    counts = deletion_counts()
    require(all(value == 0 for value in counts.values()), 'hard delete left project content or memberships in database')
    common.REPORT['deleted_scope_remaining_rows'] = counts
    common.REPORT['unrelated_rows_and_principals_unchanged'] = True
    for actor in (OWNER, STATE['writer'], STATE['viewer']):
        for route in (f'/v1/projects/{STATE["project"]}/channels', f'/v1/projects/{STATE["project"]}/notes',
                      f'/v1/channels/{STATE["channel"]}/messages', f'/v1/channels/{STATE["second_channel"]}/events',
                      '/v1/messages/' + STATE['messages'][0]['id']):
            require(request(route, actor)[0] == 404, 'deleted history remains readable')
    for message in STATE['messages']:
        require(request('/v1/messages/' + message['id'], OWNER)[0] == 404, 'deleted reply-chain message remains readable')
    require(success('/v1/messages/' + STATE['control_message']['id'])['message']['body'] ==
            STATE['control_message']['body'], 'unrelated message history changed')
    require(STATE['control_note'] in success(f'/v1/projects/{STATE["control_project"]}/notes')['notes'],
            'unrelated published note changed')
    for actor in (STATE['writer'], STATE['viewer'], STATE['recipient'], 'claude-pilot', 'codex-pilot', 'viewer-pilot', 'deny-pilot'):
        require(success('/v1/me', actor=actor)['agent']['id'] == actor, 'hard deletion revoked or deleted a principal')
    history = lifecycle_audit()
    require(len([e for e in history if e['action'] == 'project.archive']) == 2 and
            len([e for e in history if e['action'] == 'project.restore']) == 1 and
            len([e for e in history if e['action'] == 'project.delete']) == 1,
            'project lifecycle audit was removed, duplicated, or incomplete')
    require(all(e['actor_id'] == OWNER for e in history), 'lifecycle audit owner attribution incorrect')
    common.no_secrets(history)
    common.REPORT['main_project_retained_lifecycle_audit_entries'] = len(history)


def deleted_identifiers_remain_retired():
    project = STATE['project']
    for path, method, body in [(f'/v1/admin/projects/{project}', 'DELETE',
                               {'confirm_id': project, 'expected_version': 3}),
                              (f'/v1/admin/projects/{project}/archive', 'POST', {}),
                              (f'/v1/admin/projects/{project}/restore', 'POST', {}),
                              (f'/v1/admin/projects/{project}/deletion-preview', 'GET', None)]:
        require(request(path, OWNER, body, method)[0] == 404, 'deleted lifecycle target does not fail gracefully with 404')
    require(request('/v1/admin/projects', OWNER, {'id': project, 'name': 'Forbidden reuse'})[0] == 409,
            'hard-deleted project ID was reused')
    for key in ('channel', 'second_channel'):
        require(request('/v1/admin/channels', OWNER, {'id': STATE[key], 'project_id': STATE['control_project'],
                'name': 'Forbidden reuse'})[0] == 409, 'hard-deleted channel ID was reused under another project')
    require(not any(p['id'] == project for p in common.overview()['projects']), 'retired project reappeared in inventory')
    require(len(lifecycle_audit()) == 4, 'failed retired-ID calls altered lifecycle audit')


def concurrency_archive_writes_and_delete():
    project, channel = STATE['race_project'], STATE['race_channel']
    start = threading.Barrier(7)
    def send(number):
        start.wait(timeout=10)
        return request(f'/v1/channels/{channel}/messages', STATE['writer'],
                       {'client_id': RUN + '-racing-' + str(number), 'body': 'Concurrent lifecycle fixture',
                        'recipient_ids': [], 'channel_only': True})[0]
    def archive_project():
        start.wait(timeout=10)
        return request(f'/v1/admin/projects/{project}/archive', OWNER, {})
    with concurrent.futures.ThreadPoolExecutor(max_workers=7) as pool:
        writes = [pool.submit(send, number) for number in range(6)]
        archived = pool.submit(archive_project)
        statuses = [future.result(timeout=15) for future in writes]
        status, archived_result = archived.result(timeout=15)
    require(status == 200 and all(code in (201, 404) for code in statuses), 'archive/write race failed or deadlocked')
    require(len(success(f'/v1/channels/{channel}/messages')['messages']) == 1 + statuses.count(201),
            'archive/write serialization lost committed writes or accepted a rejected write')
    require(request(f'/v1/channels/{channel}/messages', STATE['writer'],
            {'client_id': RUN + '-after-archive-race', 'body': 'Forbidden', 'recipient_ids': []})[0] == 404,
            'completed archive did not fence subsequent writes')
    version = archived_result['project']['lifecycle_version']
    start = threading.Barrier(4)
    def delete():
        start.wait(timeout=10)
        return request(f'/v1/admin/projects/{project}', OWNER,
                       {'confirm_id': project, 'expected_version': version}, 'DELETE')[0]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        statuses = [future.result(timeout=15) for future in [pool.submit(delete) for _ in range(4)]]
    require(sorted(statuses) == [200, 404, 404, 404], 'concurrent delete was duplicated or failed with internal errors')
    require([e['action'] for e in lifecycle_audit(project)].count('project.delete') == 1,
            'concurrent delete produced duplicate or missing audit')
    for actor in (OWNER, STATE['writer']):
        require(request(f'/v1/channels/{channel}/events?after=0', actor)[0] == 404 and
                request(f'/v1/channels/{channel}/stream', actor)[0] == 404,
                'deleted channel did not fail gracefully for a polling/reconnecting adapter')
    common.REPORT['concurrent_delete_statuses'] = sorted(statuses)


def restart_persists_retirement():
    common.stop_server()
    common.start_server()
    deleted_identifiers_remain_retired()
    require(success('/v1/messages/' + STATE['control_message']['id'])['message']['body'] ==
            STATE['control_message']['body'], 'unrelated history failed to survive restart')
    require(hashlib.sha256(common.CREDENTIALS.read_bytes()).hexdigest() == common.SEED_HASH,
            'seed credentials were modified')
    for index in range(1, common.SERVER_STARTS + 1):
        log = (common.RUNTIME / 'evidence' / f'{RUN}-server-{index}.log').read_text()
        require(not any(secret in log for secret in common.SECRETS), 'server log contains key material')


def main():
    os.umask(0o077)
    (common.RUNTIME / 'evidence').mkdir(exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='agent-link-lifecycle-e2e-') as build_dir:
            common.BINARY = Path(build_dir) / 'agent-link'
            result = subprocess.run(['go', 'build', '-o', str(common.BINARY), './cmd/agent-link'],
                                    cwd=common.ROOT, capture_output=True, text=True, timeout=90)
            require(result.returncode == 0, 'lifecycle test binary failed to compile')
            require(check('private idempotent owner and existing credential preservation', common.bootstrap_owner),
                    'owner fixture prerequisite failed')
            common.start_server()
            require(check('isolated project, reply-chain, receipt, note and ACL fixtures', create_fixtures),
                    'project fixture prerequisite failed')
            check('owner-only lifecycle routes, active delete rejection and strict JSON', authorization_and_active_delete)
            require(check('archive hides ordinary history, closes SSE and preserves owner read access', archive_hides_and_preserves),
                    'archive prerequisite failed')
            check('archived project freezes messages, receipts, notes, channels and memberships', archived_mutations_are_frozen)
            require(check('restore returns preserved data and exact prior permissions without elevation', restore_recovers_permissions),
                    'restore prerequisite failed')
            require(check('exact typed ID, strict version and stale-preview delete protection', deletion_confirmation_and_stale_version),
                    'delete confirmation prerequisite failed')
            require(check('hard delete physically removes entire scope and preserves unrelated rows and keys', hard_delete_is_scoped_and_complete),
                    'hard delete prerequisite failed')
            check('deleted project/channel identifiers stay retired and repeat calls return 404', deleted_identifiers_remain_retired)
            check('archive serializes against writers and concurrent deletes commit once', concurrency_archive_writes_and_delete)
            check('restart preserves retirement, audit, unrelated history and private logs', restart_persists_retirement)
    except Exception as error:
        check('suite infrastructure', lambda: require(False, common.safe_error(error)))
    finally:
        common.stop_server()
        if common.SEED_HASH is not None:
            check('existing e2e credential file remains byte-identical', lambda: require(
                hashlib.sha256(common.CREDENTIALS.read_bytes()).hexdigest() == common.SEED_HASH,
                'existing e2e credentials changed during lifecycle suite'))
        common.REPORT['finished_at'] = time.time()
        common.REPORT['passed'] = bool(common.REPORT['cases']) and all(case['passed'] for case in common.REPORT['cases'])
        output = common.RUNTIME / 'evidence/project-lifecycle-e2e.json'
        output.write_text(json.dumps(common.REPORT, indent=2) + '\n')
        print(json.dumps({'passed': common.REPORT['passed'], 'cases': len(common.REPORT['cases']),
                          'report': str(output)}), flush=True)
    return 0 if common.REPORT['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
