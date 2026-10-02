#!/usr/bin/env python3
"""Opt-in two-CLI generic-worker smoke; only a new isolated test DB schema.

Run after coordinating the frozen worker/helper sources:
  python3 tests/coordination_live_smoke.py --allow-models
Exactly one Codex writer and one Sonnet read-only review are allowed, <=180s
each. No model retry, production API, existing credentials or external workspace.
Private evidence survives; the owned TLS server and owned DB schema do not.
"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from operator_config import runtime_dir, certificate_file

RUNTIME = runtime_dir()
DSN_FILE = RUNTIME / 'secrets/agentlink_test-dsn'
CERT = certificate_file()
TLS_CERT = RUNTIME / 'secrets/server.crt'
TLS_KEY = RUNTIME / 'secrets/server.key'
PSQL = RUNTIME / 'pgsql/usr/lib/postgresql/14/bin/psql'
PG_LIBS = RUNTIME / 'pgsql/usr/lib/x86_64-linux-gnu'
ORIGIN = 'https://127.0.0.1:18774'
BASE_REVISION = 'toy-add-baseline-v1'
BASELINE = 'def add(a, b):\n    return a - b\n'
FIXED = 'def add(a, b):\n    return a + b\n'
sys.path[:0] = [str(ROOT / 'adapters'), str(ROOT / 'scripts')]
from adapter import Client
from artifact_client import ArtifactClient
from coordination import CoordinationError, CoordinationWorker, Journal, snapshot
from dev_trial_runtimes import run_job


def private_bytes(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def private_json(path, value):
    private_bytes(path, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode())


def require(value, message):
    if not value:
        raise AssertionError(message)


def group_members(group):
    result = []
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            raw = path.read_text()
            tail = raw[raw.rfind(')') + 2:].split()
            if int(tail[2]) == group:
                result.append({'pid': int(path.parent.name), 'state': tail[0]})
        except (OSError, ValueError, IndexError):
            continue
    return result


class LostPublicationAck:
    """Calls the REAL server, then discards exactly its first committed ACK."""
    def __init__(self, client):
        self.client, self.lost, self.committed = client, False, None

    def __getattr__(self, name):
        return getattr(self.client, name)

    def request(self, method, path, body=None):
        response = self.client.request(method, path, body)
        if (not self.lost and method == 'POST' and path.endswith('/events')
                and body and body.get('type') == 'artifacts_ready'):
            self.lost, self.committed = True, response
            raise ConnectionError('deliberately lost post-commit acknowledgement')
        return response


class Smoke:
    def __init__(self):
        os.umask(0o077)
        self.directory = Path(tempfile.mkdtemp(prefix='coordination-live-', dir=RUNTIME / 'development'))
        self.schema = 'coordination_smoke_' + uuid.uuid4().hex[:16]
        self.run_id = 'toy-run-' + uuid.uuid4().hex[:12]
        self.report = {'started_at': time.time(), 'origin': ORIGIN, 'database': 'agentlink_test',
                       'schema': self.schema, 'run_id': self.run_id, 'cases': [], 'models': [],
                       'success': False, 'model_call_limit': 2, 'model_timeout_seconds': 180}
        self.server = None
        self.schema_created = False
        self.journals = []
        self.model_calls = 0
        self.stop = threading.Event()
        self.heartbeat_errors = []
        self.heartbeat_count = 0
        self.heartbeat_thread = None
        self.log_serial = 0

    def progress(self, phase):
        print(json.dumps({'phase': phase, 'evidence_dir': str(self.directory)}), flush=True)

    def check(self, name, condition, **facts):
        require(condition, name)
        self.report['cases'].append({'name': name, 'passed': True, **facts})

    def command(self, argv, label, *, env=None, data=None, timeout=60, want=0):
        self.log_serial += 1
        prefix = f'{self.log_serial:02d}-{label}'
        result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                cwd=ROOT, env=env, timeout=timeout)
        private_bytes(self.directory / (prefix + '.stdout'), result.stdout)
        private_bytes(self.directory / (prefix + '.stderr'), result.stderr)
        require(result.returncode == want, label + ' unexpected exit')
        return result

    def sql(self, query, label):
        env = os.environ.copy()
        parsed = urllib.parse.urlsplit(self.source_dsn)
        options = dict(urllib.parse.parse_qsl(parsed.query))
        env['PGDATABASE'] = urllib.parse.unquote(parsed.path.lstrip('/'))
        env['PGHOST'] = options.get('host', parsed.hostname or '127.0.0.1')
        env['PGPORT'] = options.get('port', str(parsed.port or 5432))
        env['PGUSER'] = urllib.parse.unquote(parsed.username or '')
        env['PGPASSWORD'] = urllib.parse.unquote(parsed.password or '')
        env['PGSSLMODE'] = options.get('sslmode', 'prefer')
        env['PGCONNECT_TIMEOUT'] = '5'
        env['LD_LIBRARY_PATH'] = str(PG_LIBS)
        return self.command([str(PSQL), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], label,
                            env=env, data=query.encode(), timeout=30)

    def setup(self):
        self.progress('isolated_setup')
        info = DSN_FILE.stat()
        require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077, 'private test DSN required')
        self.source_dsn = DSN_FILE.read_text().strip()
        parsed = urllib.parse.urlsplit(self.source_dsn)
        require(urllib.parse.unquote(parsed.path) == '/agentlink_test', 'test database boundary')
        require(self.sql('SELECT current_database();', 'database-boundary').stdout.strip() == b'agentlink_test', 'wrong database')
        require(re.fullmatch(r'coordination_smoke_[0-9a-f]{16}', self.schema), 'owned schema name')
        self.sql(f'CREATE SCHEMA "{self.schema}";', 'create-owned-schema')
        self.schema_created = True
        query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
        query['search_path'] = self.schema
        scoped = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
        dsn = self.directory / 'database-url.private'
        private_bytes(dsn, (scoped + '\n').encode())
        binary = self.directory / 'agent-link'
        self.command(['go', 'build', '-o', str(binary), './cmd/agent-link'], 'build', timeout=60)
        credentials = self.directory / 'credentials.private.json'
        self.command([str(binary), 'bootstrap', '--database-url-file', str(dsn),
                      '--credentials-out', str(credentials)], 'bootstrap')
        keys = json.loads(credentials.read_text())['keys']
        self.clients, self.artifact_clients = {}, {}
        for actor in ('codex-pilot', 'claude-pilot'):
            path = self.directory / (actor + '.private.key')
            private_bytes(path, (keys[actor] + '\n').encode())
            self.clients[actor] = Client(ORIGIN, keys[actor], str(CERT))
            self.artifact_clients[actor] = ArtifactClient(ORIGIN, path, CERT)
        del keys
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 18774))
        log = os.open(self.directory / 'api.private.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            self.server = subprocess.Popen([str(binary), 'serve', '--database-url-file', str(dsn),
                '--listen', '127.0.0.1:18774', '--tls-cert', str(TLS_CERT), '--tls-key', str(TLS_KEY),
                '--web-dir', str(ROOT / 'web')], stdout=log, stderr=log, start_new_session=True)
        finally:
            os.close(log)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            require(self.server.poll() is None, 'owned API exited during startup')
            try:
                if self.clients['codex-pilot'].request('GET', '/v1/me')['agent']['id'] == 'codex-pilot':
                    break
            except Exception:
                time.sleep(.15)
        else:
            raise AssertionError('owned HTTPS API did not become ready')
        self.check('isolated_authenticated_https_ready', True)
        self.writer = self.directory / 'writer-work'
        self.reviewer = self.directory / 'reviewer-work'
        self.writer.mkdir(mode=0o700)
        self.reviewer.mkdir(mode=0o700)
        private_bytes(self.writer / 'calc.py', BASELINE.encode())
        # Codex requires a trusted git worktree; keep its metadata out of the
        # audited directory and audit only the regular .git pointer itself.
        self.command(['git', 'init', '--quiet', '--separate-git-dir', str(self.directory / 'writer-git'),
                      str(self.writer)], 'isolated-git')
        test = '''import importlib.util, pathlib, sys, unittest
source = pathlib.Path(sys.argv.pop(1))
spec = importlib.util.spec_from_file_location("toy_calc", source)
calc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(calc)
class Addition(unittest.TestCase):
    def test_positive_negative_zero(self):
        for a in range(-5, 6):
            for b in range(-5, 6):
                with self.subTest(a=a, b=b):
                    self.assertEqual(calc.add(a, b), a + b)
if __name__ == "__main__": unittest.main(verbosity=2)
'''
        self.test_file = self.directory / 'independent_unittest.py'
        private_bytes(self.test_file, test.encode())
        self.verify_fixture('baseline-red', expected=1)
        self.legacy = {actor: 'legacy-' + actor + '-' + self.run_id for actor in self.clients}
        self.heartbeat_once()
        self.heartbeat_thread = threading.Thread(target=self.heartbeats, daemon=True)
        self.heartbeat_thread.start()
        client = self.clients['codex-pilot']
        self.memory = client.request('POST', '/v1/projects/pilot/memory', {
            'client_id': 'toy-memory', 'title': 'Toy arithmetic acceptance',
            'body': 'Project-shared context: add(a, b) returns the arithmetic sum for positive, negative and zero integers. No other behavior or files should change.'})['memory']
        self.task = client.request('POST', '/v1/projects/pilot/tasks', {
            'client_id': 'toy-task', 'title': 'Correct the isolated addition fixture',
            'owner_id': 'codex-pilot', 'reviewer_id': 'claude-pilot', 'scope': ['calc.py'],
            'acceptance': ['add(a,b) equals a+b for integers including positive, negative and zero',
                           'Only calc.py changes; independent baseline fails and fixed unittest passes']})['task']
        self.task_path = '/v1/projects/pilot/tasks/' + self.task['id']
        self.event('run_started', 'Operator explicitly authorizes a single bounded toy run')
        self.report['task_id'] = self.task['id']
        self.report['source_hashes'] = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (ROOT / 'adapters/coordination.py', ROOT / 'scripts/dev_trial_runtimes.py', ROOT / 'scripts/artifact_client.py')}

    def heartbeat_once(self):
        for actor, client in self.clients.items():
            answer = client.request('POST', '/v1/heartbeat', {'session_id': self.legacy[actor],
                'activity': 'isolated live smoke legacy coexistence', 'runtime': 'smoke-legacy'})
            require(answer['agent']['session_id'] == self.legacy[actor], 'legacy heartbeat identity changed')
            self.heartbeat_count += 1

    def heartbeats(self):
        while not self.stop.wait(4):
            try:
                self.heartbeat_once()
            except Exception as error:
                self.heartbeat_errors.append(type(error).__name__)
                return

    def event(self, kind, summary, **extra):
        result = self.clients['codex-pilot'].request('POST', self.task_path + '/events', {
            'client_id': 'operator-' + uuid.uuid4().hex, 'expected_version': self.task['version'],
            'type': kind, 'run_id': self.run_id, 'summary': summary, **extra})
        require(result['server_verified'] is False, 'external verification must not be server-proven')
        self.task = result['task']
        return result['event']

    def verify_fixture(self, label, expected):
        tree = ast.dump(ast.parse((self.writer / 'calc.py').read_text()), include_attributes=False)
        safe = ast.dump(ast.parse(BASELINE if expected else FIXED), include_attributes=False)
        require(tree == safe, 'toy source must be exactly the safe single arithmetic function')
        result = self.command([sys.executable, '-B', str(self.test_file), str(self.writer / 'calc.py')],
                              label, timeout=30, want=expected)
        facts = {'exit_code': result.returncode, 'cases': 121,
                 'stdout_sha256': hashlib.sha256(result.stdout).hexdigest(),
                 'stderr_sha256': hashlib.sha256(result.stderr).hexdigest()}
        self.check(label, True, **facts)
        return facts

    def runner(self, *args, **kwargs):
        require(self.model_calls < 2, 'global two-model-call budget exhausted')
        self.model_calls += 1
        require(kwargs.get('timeout', 999) <= 180, 'runtime deadline exceeds authorized cap')
        self.progress(args[0] + '_model_started')
        report = run_job(*args, **kwargs)
        self.report['models'].append({name: report.get(name) for name in (
            'runtime', 'requested_model', 'observed_models', 'session_id', 'pid', 'success', 'exit_code',
            'terminal_success', 'terminal_failure_seen', 'read_only', 'tool_counts', 'timed_out',
            'error_category', 'cleanup', 'started_at', 'finished_at', 'evidence_dir')})
        self.progress(args[0] + '_model_finished')
        return report

    def plan(self, actor, role, cwd, **extra):
        return {'version': 1, 'agent_id': actor, 'project_id': 'pilot', 'channel_id': 'general',
                'task_id': self.task['id'], 'run_id': self.run_id, 'job_id': role + '-' + self.run_id,
                'runtime': 'codex' if role == 'writer' else 'claude', 'task_role': role,
                'cwd': str(cwd), 'scope': ['calc.py'], 'base_revision': BASE_REVISION,
                'timeout_seconds': 180, 'max_model_turns': 1, 'max_run_seconds': 600,
                'memory_refs': [{'memory_id': self.memory['id'], 'version': self.memory['version']}], **extra}

    def worker(self, plan, name, client):
        journal = Journal(self.directory / (name + '.sqlite'), plan)
        self.journals.append(journal)
        return CoordinationWorker(journal, client, self.runner, self.directory / (name + '-runtime'),
                                  artifact_client=self.artifact_clients[plan['agent_id']])

    def live(self):
        writer_plan = self.plan('codex-pilot', 'writer', self.writer, prompt=(
            'This is a tiny isolated Python acceptance fixture. Read calc.py, then change only the subtraction operator '
            'in add(a, b) into addition so the function returns a + b. Keep the exact function shape. Edit only calc.py. '
            'Do not create tests, caches, comments, metadata or other files. Do not run tests: an independent operator '
            'will run them. No network, credentials, other directories, delegation or git operations. Read and edit '
            'this one file. Report only the change you actually made; findings are defects only, so use [] if none.'))
        private_json(self.directory / 'writer-plan.json', writer_plan)
        lost = LostPublicationAck(self.clients['codex-pilot'])
        writer = self.worker(writer_plan, 'writer', lost)
        status = writer.execute()
        self.check('writer_real_cli_completed_once', status['state'] == 'completed' and status['model_turns'] == 1)
        self.check('writer_selected_memory', len(status['memory_context']) == 1)
        green = self.verify_fixture('fixed-green', expected=0)
        code = (self.writer / 'calc.py').read_bytes()
        artifact = self.artifact_clients['codex-pilot'].upload('pilot', 'toy-implementation', 'implementation', BASE_REVISION, code)['artifact']
        evidence_bytes = json.dumps({'provenance': 'independent_external_unittest', 'baseline_exit': 1,
            'fixed': green, 'source_sha256': hashlib.sha256(code).hexdigest()}, sort_keys=True).encode()
        evidence = self.artifact_clients['codex-pilot'].upload('pilot', 'toy-evidence', 'evidence', BASE_REVISION, evidence_bytes)['artifact']
        refs = [{key: value for key, value in {'artifact_id': item['id'], 'sha256': item['sha256'], 'role': item['role']}.items()}
                for item in (artifact, evidence)]
        publication = {'type': 'artifacts_ready', 'expected_version': self.task['version'], 'artifacts': refs}
        try:
            writer.publish_report(publication)
        except ConnectionError:
            pass
        else:
            raise AssertionError('intentional post-commit lost ACK was not observed')
        pending = writer.journal.status()
        self.check('lost_ack_preserves_durable_outbox', lost.lost and pending['state'] == 'report_pending' and pending['pending_reports'] == 1)
        self.report['writer_after_lost_ack'] = pending
        committed_id = lost.committed['event']['id']
        writer.journal.close()
        self.journals.remove(writer.journal)
        writer = self.worker(writer_plan, 'writer', lost)
        status = writer.publish_report(publication)
        response = json.loads(writer.journal.db.execute('SELECT response FROM outbox').fetchone()[0])
        self.check('durable_retry_same_server_event_no_model_replay', status['state'] == 'reported'
                   and self.model_calls == 1 and response['replayed'] is True and response['event']['id'] == committed_id)
        detail = self.clients['codex-pilot'].request('GET', self.task_path)
        self.task = detail['task']
        self.check('one_artifacts_event_after_lost_ack', len([e for e in detail['events'] if e['type'] == 'artifacts_ready']) == 1)
        self.report['writer_status'] = status
        self.report['writer_publication_event'] = {'id': committed_id, 'version': response['event']['version'], 'replayed': response['replayed']}
        request = self.event('review_requested', 'Independent reviewer must read the exact immutable artifact set', artifacts=refs)
        self.event('verification_reported', 'Operator ran independent unittest; this is externally supplied evidence',
                   artifacts=refs, evidence={'status': 'passed', 'command': 'python3 -B independent_unittest.py calc.py',
                                            'exit_code': 0, 'artifact': refs[1]})
        downloaded = self.artifact_clients['claude-pilot'].download(artifact['id'], artifact['sha256'], BASE_REVISION, expected_project='pilot')
        private_bytes(self.reviewer / 'calc.py', downloaded)
        reviewer_before = snapshot(self.reviewer)
        reviewer_plan = self.plan('claude-pilot', 'reviewer', self.reviewer, model='sonnet',
            prompt=('Read the local calc.py with the Read tool and independently review whether add(a,b) correctly '
                    'returns the arithmetic sum for positive, negative and zero integers. This is READ ONLY: no edits, '
                    'tests, shell commands, network, credentials, other paths or delegation. Do not claim tests ran. '
                    'An independent external unittest report is pinned in the artifact set, but your verdict must follow '
                    'your own reading. findings must contain actual defects only; if the code is correct use [] and approved.'),
            artifacts=refs, review_request_id=request['id'], artifact_pins={'calc.py': hashlib.sha256(downloaded).hexdigest()})
        private_json(self.directory / 'reviewer-plan.json', reviewer_plan)
        reviewer = self.worker(reviewer_plan, 'reviewer', self.clients['claude-pilot'])
        status = reviewer.execute()
        self.check('reviewer_real_cli_readonly_completed_once', status['state'] == 'completed' and status['model_turns'] == 1
                   and snapshot(self.reviewer) == reviewer_before)
        model = self.report['models'][-1]
        self.check('reviewer_read_observed', model['read_only'] is True and model['tool_counts'].get('Read.ended', 0) >= 1)
        self.check('sonnet_model_identity_observed', bool(model['observed_models'])
                   and all('sonnet' in name.lower() for name in model['observed_models']), observed_models=model['observed_models'])
        status = reviewer.publish_report({'type': 'review_result', 'expected_version': self.task['version'],
            'review_request_id': request['id'], 'artifacts': refs})
        self.report['reviewer_status'] = status
        detail = self.clients['codex-pilot'].request('GET', self.task_path)
        self.task = detail['task']
        reviews = [event for event in detail['events'] if event['type'] == 'review_result']
        self.check('exact_pinned_review_approved', status['state'] == 'reported' and self.task['state'] == 'approved'
                   and len(reviews) == 1 and reviews[0]['review_request_id'] == request['id']
                   and reviews[0]['actor_id'] == 'claude-pilot')
        self.event('completion_reported', 'Externally checked toy task completed; not a server-executed verification',
                   artifacts=refs, review_request_id=request['id'])
        self.heartbeat_once()
        visible = self.clients['codex-pilot'].request('GET', '/v1/projects/pilot/agents')['agents']
        self.check('independent_sessions_preserve_legacy_heartbeats', not self.heartbeat_errors
                   and all(next(v for v in visible if v['id'] == actor)['session_id'] == lease for actor, lease in self.legacy.items()),
                   heartbeat_requests=self.heartbeat_count)
        self.check('exactly_two_successful_model_dispatches', self.model_calls == 2
                   and all(m['success'] and m['exit_code'] == 0 and m['terminal_success'] for m in self.report['models']))
        self.report['task_final'] = self.task
        self.report['event_receipts'] = [{key: event[key] for key in ('id', 'type', 'actor_id', 'version', 'run_id', 'review_request_id')}
            for event in self.clients['codex-pilot'].request('GET', self.task_path)['events']]
        self.report['artifacts'] = refs
        self.report['success'] = True

    def cleanup(self):
        self.stop.set()
        if self.heartbeat_thread:
            self.heartbeat_thread.join(timeout=20)
        for journal in self.journals:
            try:
                journal.close()
            except Exception:
                self.report.setdefault('cleanup_errors', []).append('journal_close')
        remaining = {str(model['pid']): group_members(model['pid']) for model in self.report['models'] if model.get('pid')}
        self.report['remaining_model_group_members'] = remaining
        if any(remaining.values()):
            self.report['success'] = False
        if self.server:
            self.server.terminate()
            try:
                self.server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.server.kill()
                self.server.wait(timeout=5)
            self.report['owned_api_stopped'] = self.server.poll() is not None
        if self.schema_created:
            try:
                self.sql(f'DROP SCHEMA "{self.schema}" CASCADE;', 'drop-owned-schema')
                self.report['owned_schema_removed'] = True
            except Exception as error:
                self.report['owned_schema_removed'] = False
                self.report.setdefault('cleanup_errors', []).append(type(error).__name__)
                self.report['success'] = False
        self.report['model_calls'] = self.model_calls
        self.report['finished_at'] = time.time()
        private_json(self.directory / 'evidence.json', self.report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-models', action='store_true', help='explicitly permit at most two real CLI jobs')
    args = parser.parse_args()
    require(args.allow_models, 'explicit --allow-models required; no implicit model calls')
    smoke = Smoke()
    def stop_owned(_number, _frame):
        raise KeyboardInterrupt('owned live smoke termination requested')
    previous = {sig: signal.signal(sig, stop_owned) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        smoke.setup()
        smoke.live()
    except BaseException as error:
        smoke.report['failure_category'] = type(error).__name__
        if isinstance(error, (AssertionError, CoordinationError)):
            smoke.report['failure_message'] = str(error)
        smoke.report['success'] = False
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
