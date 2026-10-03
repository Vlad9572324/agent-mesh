"""Project-bound native CLI bridge. No model launch, transcript or file tools.

SQLite is shared by short-lived hooks and the MCP process. Network IO is never
inside a SQLite transaction. Repeated publication is safe through server client
IDs; an inbox offer is NOT acceptance and never touches legacy heartbeat/receipts.
"""
from contextlib import contextmanager
from datetime import datetime
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import ssl
import stat
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener
import uuid

ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z')
SHA = re.compile(r'[a-f0-9]{64}\Z')
EVENT_TYPES = frozenset(('session.started', 'session.ended', 'turn.started', 'turn.completed',
    'tool.started', 'tool.completed', 'tool.failed', 'agent.waiting', 'inbox.offered', 'inbox.seen', 'inbox.accepted'))
TOOL_NAMES = frozenset(('Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch',
    'read_file', 'write_file', 'edit_file', 'apply_patch', 'exec_command', 'shell', 'command_execution',
    'file_change', 'update_plan', 'mcp', 'other'))
SELF_PREFIXES = ('mcp__agent_link_native__', 'mcp__agent_link_native', 'mcp__agent_link__', 'mcp__agent-link__')
CONFIG_FIELDS = frozenset(('version', 'url', 'ca_file', 'key_file', 'agent_id', 'project_id',
    'channel_ids', 'state_dir', 'runtime', 'workspace_root'))
MAX_ROWS = 50000


class NativeError(ValueError):
    """Category-only error safe to return over MCP; never embeds remote text."""


class NativeHTTPError(NativeError):
    def __init__(self, status):
        self.status = status
        super().__init__('api_http_' + str(status))


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def strict_json(value):
    def pairs(items):
        result = {}
        for key, item in items:
            if key in result:
                raise NativeError('duplicate_json_field')
            result[key] = item
        return result
    try:
        return json.loads(value, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(NativeError('invalid_json_number')))
    except (ValueError, UnicodeError, RecursionError):
        raise NativeError('invalid_json') from None


def build_identity(value):
    """Bounded display-only build metadata; never a capability or trust decision."""
    if type(value) is not dict:
        return None
    version, commit = value.get('version'), value.get('source_commit')
    if (type(version) is not str or not re.fullmatch(r'(?:dev|v[0-9][A-Za-z0-9.+-]{0,62})', version)
            or type(commit) is not str or not re.fullmatch(r'(?:unknown|[a-f0-9]{40})', commit)):
        return None
    return {'version': version, 'source_commit': None if commit == 'unknown' else commit}


def connector_build(root=None):
    """Read the installed bundle's own stamp, not cwd, environment or server identity."""
    path = (Path(__file__).resolve().parent.parent if root is None else Path(root)) / 'RELEASE.json'
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > 32768:
                return None
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                body = stream.read(32769)
            if len(body) > 32768:
                return None
            return build_identity(strict_json(body))
        finally:
            os.close(fd)
    except (OSError, NativeError):
        return None


# Snapshot the stamp when this module is loaded. Updating files on disk does not
# pretend that an already-running MCP process has reloaded the connector.
CONNECTOR_BUILD = connector_build()


def identifier(value):
    return type(value) is str and ID.fullmatch(value) is not None


def text(value, maximum):
    try:
        return type(value) is str and bool(value.strip()) and '\x00' not in value and len(value.encode()) <= maximum
    except UnicodeError:
        return False


def read_private(path, maximum):
    path = Path(path)
    if not path.is_absolute():
        raise NativeError('absolute_private_path_required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > maximum:
            raise NativeError('private_owned_regular_file_required')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(maximum + 1)
        if len(data) > maximum:
            raise NativeError('private_file_too_large')
        return data
    finally:
        os.close(fd)


def origin(value):
    if type(value) is not str:
        raise NativeError('invalid_origin')
    try:
        p = urlsplit(value)
        if (p.username or p.password or p.query or p.fragment or p.path not in ('', '/') or not p.hostname
                or p.scheme not in ('http', 'https') or (p.scheme == 'http' and p.hostname not in ('127.0.0.1', '::1'))):
            raise NativeError('verified_https_or_numeric_loopback_required')
        port = p.port or (443 if p.scheme == 'https' else 80)
        host = '[' + p.hostname.lower() + ']' if ':' in p.hostname else p.hostname.lower()
        return p.scheme + '://' + host + ':' + str(port)
    except ValueError:
        raise NativeError('invalid_origin') from None


def load_config(path):
    """Validate without network, model calls, directory creation or key output."""
    try:
        value = strict_json(read_private(path, 32768))
        if type(value) is not dict or set(value) != CONFIG_FIELDS or type(value['version']) is not int or value['version'] != 1:
            raise NativeError('invalid_config_fields')
        result = dict(value)
        result['url'] = origin(value['url'])
        if not all(identifier(value[name]) for name in ('agent_id', 'project_id')) or value['runtime'] not in ('codex', 'claude'):
            raise NativeError('invalid_config_identity')
        channels = value['channel_ids']
        if type(channels) is not list or not 1 <= len(channels) <= 8 or not all(identifier(v) for v in channels) or len(set(channels)) != len(channels):
            raise NativeError('invalid_channel_binding')
        for name in ('workspace_root', 'state_dir', 'key_file'):
            if type(value[name]) is not str or not Path(value[name]).is_absolute():
                raise NativeError('absolute_bound_paths_required')
            result[name] = str(Path(value[name]).resolve())
        workspace = Path(result['workspace_root'])
        if not workspace.is_dir() or workspace == Path(workspace.anchor):
            raise NativeError('specific_workspace_required')
        for private in (Path(path).resolve(), Path(result['key_file']), Path(result['state_dir'])):
            if private == workspace or workspace in private.parents:
                raise NativeError('private_state_and_credentials_must_be_outside_workspace')
        if Path(value['key_file']).is_symlink() or Path(value['state_dir']).is_symlink():
            raise NativeError('private_symlinks_forbidden')
        raw = read_private(value['key_file'], 128).strip()
        if SHA.fullmatch(raw.decode('ascii')) is None:
            raise NativeError('raw_64hex_agent_key_required')
        if value['ca_file'] is not None:
            ca = Path(value['ca_file'])
            if not ca.is_absolute() or not ca.is_file():
                raise NativeError('absolute_ca_file_required')
            result['ca_file'] = str(ca.resolve())
        elif result['url'].startswith('https:'):
            raise NativeError('https_ca_file_required')
        return result
    except NativeError:
        raise
    except (OSError, TypeError, UnicodeError):
        raise NativeError('invalid_private_config') from None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class NativeHTTP:
    def __init__(self, config, key, timeout):
        self.url, self.key, self.timeout = config['url'], key, timeout
        self.context = ssl.create_default_context(cafile=config['ca_file'])

    def request(self, method, path, body=None, *, binary=False, maximum=2 << 20):
        data = None if body is None else canonical(body).encode()
        if data is not None and len(data) > 65536:
            raise NativeError('request_too_large')
        req = Request(self.url + path, method=method, data=data,
                      headers={'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'})
        opener = build_opener(_NoRedirect(), ProxyHandler({}), HTTPSHandler(context=self.context))
        try:
            with opener.open(req, timeout=self.timeout) as response:
                value = response.read(maximum + 1)
                if len(value) > maximum:
                    raise NativeError('response_too_large')
                return value if binary else strict_json(value)
        except HTTPError as error:
            raise NativeHTTPError(error.code) from None
        except (URLError, TimeoutError, OSError):
            raise NativeError('network_unavailable') from None


class NativeBridge:
    def __init__(self, config_path, session_id, *, timeout=1.0, _client=None):
        self.config = load_config(config_path)
        if not identifier(session_id) or isinstance(timeout, bool) or not 0 < timeout <= 5:
            raise NativeError('invalid_native_session_or_timeout')
        self.session_id = session_id
        self.key = read_private(self.config['key_file'], 128).decode('ascii').strip()
        self._client = _client or NativeHTTP(self.config, self.key, timeout)
        self.project_path = '/v1/projects/' + self.config['project_id']
        self.reject_secret({k: self.config[k] for k in ('url', 'agent_id', 'project_id', 'channel_ids')})
        state = Path(self.config['state_dir'])
        state.mkdir(mode=0o700, exist_ok=True)
        info = state.stat()
        if not state.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise NativeError('private_owned_state_directory_required')
        database = state / 'native.sqlite'
        fd = os.open(database, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise NativeError('private_owned_database_required')
        finally:
            os.close(fd)
        self.db = sqlite3.connect(database, timeout=1.0)
        self.db.row_factory = sqlite3.Row
        try:
            self.db.executescript('''PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS cursors(channel_id TEXT PRIMARY KEY,seq INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,seq INTEGER NOT NULL,
                    message TEXT NOT NULL,accepted_at REAL,accepted_session TEXT,UNIQUE(channel_id,seq));
                CREATE TABLE IF NOT EXISTS offers(session_id TEXT NOT NULL,message_id TEXT NOT NULL,offered_at REAL NOT NULL,
                    PRIMARY KEY(session_id,message_id));
                CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,channel_id TEXT,path TEXT NOT NULL,
                    method TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',response TEXT,
                    created_at REAL NOT NULL);
            ''')
            identity = {name: self.config[name] for name in ('url', 'agent_id', 'project_id', 'runtime', 'workspace_root')}
            identity['channel_ids'] = sorted(self.config['channel_ids'])
            encoded = canonical(identity)
            with self.atomic():
                row = self.db.execute("SELECT value FROM meta WHERE key='binding'").fetchone()
                if row and row[0] != encoded:
                    raise NativeError('state_belongs_to_different_binding')
                # Serialize upgrades with hooks/MCP opening the same old state.
                columns = {row['name'] for row in self.db.execute('PRAGMA table_info(inbox)')}
                for name, kind in (('seen_at', 'REAL'), ('seen_session', 'TEXT')):
                    if name not in columns:
                        self.db.execute(f'ALTER TABLE inbox ADD COLUMN {name} {kind}')
                self.db.execute('CREATE INDEX IF NOT EXISTS offers_message_time ON offers(message_id,offered_at)')
                if 'offer_order' not in columns:
                    self.db.execute('ALTER TABLE inbox ADD COLUMN offer_order INTEGER NOT NULL DEFAULT 0')
                    self.db.execute('''UPDATE inbox SET offer_order=COALESCE(
                        (SELECT CAST(MAX(offered_at) AS INTEGER) FROM offers WHERE message_id=inbox.id),0)''')
                self.db.execute('CREATE INDEX IF NOT EXISTS inbox_offer_order ON inbox(offer_order)')
                self.db.execute("INSERT OR IGNORE INTO meta VALUES('binding',?)", (encoded,))
                self.db.execute("INSERT OR IGNORE INTO meta VALUES('inbox_view_id',?)", (uuid.uuid4().hex,))
                for channel in self.config['channel_ids']:
                    self.db.execute('INSERT OR IGNORE INTO cursors(channel_id) VALUES(?)', (channel,))
        except BaseException:
            self.db.close()
            raise

    @contextmanager
    def atomic(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def reject_secret(self, value):
        if self.key in canonical(value):
            raise NativeError('known_credential_in_payload')

    def sanitize(self, value):
        if isinstance(value, str):
            return value.replace(self.key, '[REDACTED]')
        if isinstance(value, list):
            return [self.sanitize(v) for v in value]
        if isinstance(value, dict):
            return {self.sanitize(k): self.sanitize(v) for k, v in value.items()}
        return value

    def _request(self, method, path, body=None, **kwargs):
        if getattr(self._client, 'url', self.config['url']) != self.config['url']:
            raise NativeError('transport_origin_changed')
        return self._client.request(method, path, body, **kwargs)

    def _authorize(self):
        identity = self._request('GET', '/v1/me')
        who = identity.get('agent', {})
        if who.get('id') != self.config['agent_id'] or who.get('kind') != 'agent':
            raise NativeError('authenticated_principal_mismatch')
        self._server_build = build_identity(identity.get('server_build'))
        channels = self._request('GET', self.project_path + '/channels').get('channels')
        if not isinstance(channels, list):
            raise NativeError('invalid_authorization_response')
        allowed = {v['id']: bool(v.get('can_write')) for v in channels
                   if type(v) is dict and v.get('id') in self.config['channel_ids'] and v.get('project_id') == self.config['project_id']}
        return allowed

    def _channel(self, channel, allowed, write=False):
        if not identifier(channel) or channel not in self.config['channel_ids'] or channel not in allowed or (write and not allowed[channel]):
            raise NativeError('channel_not_authorized')
        return channel

    def _identifier(self, value):
        if not identifier(value):
            raise NativeError('invalid_identifier')
        self.reject_secret(value)
        return value

    def _put(self, kind, channel, path, method, payload, identity):
        self.reject_secret(payload)
        encoded = canonical(payload)
        if len(encoded.encode()) > 65536:
            raise NativeError('publication_too_large')
        row = self.db.execute('SELECT kind,path,method,payload FROM outbox WHERE id=?', (identity,)).fetchone()
        if row:
            if tuple(row) != (kind, path, method, encoded):
                raise NativeError('client_id_payload_conflict')
            return False
        if self.db.execute('SELECT count(*) FROM outbox').fetchone()[0] >= MAX_ROWS:
            raise NativeError('durable_outbox_capacity_reached')
        self.db.execute('INSERT INTO outbox(id,kind,channel_id,path,method,payload,created_at) VALUES(?,?,?,?,?,?,?)',
                        (identity, kind, channel, path, method, encoded, time.time()))
        return True

    def _observe(self, event_type, tool_name=None, message_id=None, event_id=None):
        if event_type not in EVENT_TYPES:
            raise NativeError('unsupported_activity_type')
        if event_type.startswith('inbox.') != (message_id is not None):
            raise NativeError('activity_message_correlation_required')
        if tool_name is not None and (type(tool_name) is not str or tool_name.startswith(SELF_PREFIXES)):
            return {'event_id': None, 'queued': False, 'ignored': True}
        channel = self.config['channel_ids'][0]
        if message_id is not None:
            self._identifier(message_id)
            row = self.db.execute('SELECT channel_id FROM inbox WHERE id=?', (message_id,)).fetchone()
            if not row:
                raise NativeError('message_not_in_native_inbox')
            channel = row[0]
        if event_id is None:
            event_id = uuid.uuid4().hex
        if not text(event_id, 512):
            raise NativeError('invalid_local_event_identity')
        client_id = hashlib.sha256(canonical([self.session_id, event_type, event_id, channel]).encode()).hexdigest()
        payload = {'client_id': client_id, 'session_id': self.session_id, 'runtime': self.config['runtime'], 'event_type': event_type}
        if event_type.startswith('tool.') and tool_name is not None:
            payload['tool_name'] = tool_name if tool_name in TOOL_NAMES else 'other'
        if message_id is not None:
            payload['message_id'] = message_id
        inserted = self._put('activity', channel, '/v1/channels/' + channel + '/activity', 'POST', payload, 'activity:' + client_id)
        return {'event_id': client_id, 'queued': True, 'duplicate': not inserted}

    def observe(self, event_type, tool_name=None, message_id=None, event_id=None):
        with self.atomic():
            return self._observe(event_type, tool_name, message_id, event_id)

    def poll_inbox(self, limit=100):
        if type(limit) is not int or not 1 <= limit <= 200:
            raise NativeError('invalid_poll_limit')
        limit = min(limit, 100)  # The existing message API caps each page at 100.
        allowed = self._authorize()
        fetched, more = 0, False
        # Each channel advances only after its entire validated page is durable.
        for channel in self.config['channel_ids']:
            if channel not in allowed:
                continue
            cursor = self.db.execute('SELECT seq FROM cursors WHERE channel_id=?', (channel,)).fetchone()[0]
            page = self._request('GET', '/v1/channels/' + channel + '/messages?' + urlencode({'after_seq': cursor, 'limit': limit})).get('messages')
            if type(page) is not list or len(page) > limit:
                raise NativeError('invalid_message_page')
            prior, validated = cursor, []
            for item in page:
                if (type(item) is not dict or not identifier(item.get('id')) or item.get('channel_id') != channel
                        or type(item.get('seq')) is not int or item['seq'] <= prior or not identifier(item.get('author_id'))
                        or type(item.get('recipient_ids')) is not list or not all(identifier(v) for v in item['recipient_ids'])
                        or len(item['recipient_ids']) > 32 or type(item.get('body')) is not str
                        or not item['body'] or '\x00' in item['body'] or len(item['body'].encode('utf-8')) > 16384
                        or (item.get('reply_to') is not None and not identifier(item['reply_to']))):
                    raise NativeError('invalid_message_page')
                prior = item['seq']
                # Replies are valid inbox data too. Never dispatch a model here.
                if self.config['agent_id'] in item['recipient_ids'] and item['author_id'] != self.config['agent_id']:
                    value = {k: item.get(k) for k in ('id', 'channel_id', 'seq', 'author_id', 'recipient_ids', 'reply_to', 'body')}
                    validated.append(self.sanitize(value))
            with self.atomic():
                if self.db.execute('SELECT count(*) FROM inbox').fetchone()[0] + len(validated) > MAX_ROWS:
                    raise NativeError('durable_inbox_capacity_reached')
                for item in validated:
                    self.db.execute('INSERT OR IGNORE INTO inbox(id,channel_id,seq,message) VALUES(?,?,?,?)',
                                    (item['id'], channel, item['seq'], canonical(item)))
                self.db.execute('UPDATE cursors SET seq=max(seq,?) WHERE channel_id=?', (prior, channel))
            fetched += len(page)
            more = more or len(page) == limit
        return {'fetched': fetched, 'pending': self._pending_count(allowed), 'has_more': more}

    def _pending_count(self, allowed, include_seen=True):
        return sum(self.db.execute('SELECT count(*) FROM inbox WHERE channel_id=? AND accepted_at IS NULL AND (? OR seen_at IS NULL)',
                                   (channel, include_seen)).fetchone()[0]
                   for channel in allowed)

    def _inbox_scope(self, allowed, include_seen):
        state_id = self.db.execute("SELECT value FROM meta WHERE key='inbox_view_id'").fetchone()[0]
        material = [state_id, self.config['agent_id'], self.config['project_id'],
                    sorted(allowed), include_seen]
        return hashlib.sha256(canonical(material).encode()).hexdigest()

    @staticmethod
    def _inbox_cursor(scope, ceiling, row):
        value = [1, scope, ceiling, [row['channel_id'], row['seq'], row['id']]]
        return base64.urlsafe_b64encode(canonical(value).encode()).decode().rstrip('=')

    def _inbox_position(self, cursor, scope, maximum):
        # A cursor is only a scoped position, never authority or executable SQL.
        try:
            if type(cursor) is not str or not 1 <= len(cursor) <= 2048 or not re.fullmatch(r'[A-Za-z0-9_-]+', cursor):
                raise ValueError()
            raw = base64.b64decode(cursor + '=' * (-len(cursor) % 4), altchars=b'-_', validate=True)
            value = strict_json(raw.decode('utf-8'))
            if (canonical(value).encode() != raw or base64.urlsafe_b64encode(raw).decode().rstrip('=') != cursor
                    or type(value) is not list or len(value) != 4 or type(value[0]) is not int or value[0] != 1
                    or value[1] != scope or type(value[2]) is not int or not 1 <= value[2] <= maximum
                    or type(value[3]) is not list or len(value[3]) != 3):
                raise ValueError()
            channel, seq, identity = value[3]
            if (not identifier(channel) or not identifier(identity) or type(seq) is not int
                    or not 1 <= seq <= 9223372036854775807):
                raise ValueError()
            if not self.db.execute('SELECT 1 FROM inbox WHERE channel_id=? AND seq=? AND id=? AND rowid<=?',
                                   (channel, seq, identity, value[2])).fetchone():
                raise ValueError()
            return value[2], value[3]
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise NativeError('invalid_inbox_cursor') from None

    def offer_inbox(self, context_budget=6000, minimum_interval=0, include_seen=False, cursor=None, full_text=False):
        if type(context_budget) is not int or not 512 <= context_budget <= 16000:
            raise NativeError('invalid_context_budget')
        if type(minimum_interval) is not int or not 0 <= minimum_interval <= 3600:
            raise NativeError('invalid_offer_interval')
        if type(include_seen) is not bool:
            raise NativeError('invalid_include_seen')
        if type(full_text) is not bool:
            raise NativeError('invalid_full_text_guidance')
        if cursor is not None and (type(cursor) is not str or len(cursor) > 2048):
            raise NativeError('invalid_inbox_cursor')
        allowed = self._authorize()
        # Serialize selection and scheduling across hook/MCP connections. No
        # network IO occurs in this transaction. Global order survives sessions;
        # channel-local sequence numbers are never compared for fair scheduling.
        with self.atomic():
            result = {'messages': [], 'has_more': False, 'offer_has_more': False,
                      'next_cursor': None, 'truncated': False, 'delivery': 'offered_not_accepted'}
            explicit = cursor is not None
            scope = self._inbox_scope(allowed, include_seen)
            ceiling = self.db.execute('SELECT COALESCE(MAX(rowid),0) FROM inbox').fetchone()[0]
            position = ['', 0, '']
            if cursor:
                ceiling, position = self._inbox_position(cursor, scope, ceiling)
            if not allowed:
                return result
            now = time.time()
            marks = ','.join('?' for _ in allowed)
            where = f'i.accepted_at IS NULL AND (? OR i.seen_at IS NULL) AND i.channel_id IN ({marks})'
            params = [include_seen, *allowed]
            if explicit:
                where += ' AND i.rowid<=? AND (i.channel_id,i.seq,i.id)>(?,?,?)'
                params.extend([ceiling, *position])
                order = 'i.channel_id,i.seq,i.id'
            else:
                where += ''' AND (?=0 OR NOT EXISTS (SELECT 1 FROM offers o
                    WHERE o.message_id=i.id AND o.session_id=? AND o.offered_at>?))'''
                params.extend([minimum_interval, self.session_id, now-minimum_interval])
                order = 'i.offer_order,i.rowid'
            # One lookahead record distinguishes an exhausted keyset page.
            rows = self.db.execute(f'SELECT i.* FROM inbox i WHERE {where} ORDER BY {order} LIMIT 201', params).fetchall()
            pending = self._pending_count(allowed, include_seen)
            for index, row in enumerate(rows[:200]):
                item = strict_json(row['message'])
                body = item.pop('body')
                item['body_preview'] = body.encode()[:2000].decode('utf-8', errors='ignore')
                item['truncated'] = item['body_preview'] != body
                if full_text:
                    item['full_text'] = {'tool': 'link_message', 'arguments': {'message_id': row['id']}}
                more = index + 1 < len(rows) if explicit else pending > index + 1
                candidate = {**result, 'messages': result['messages'] + [item],
                             'has_more': more, 'offer_has_more': more,
                             'next_cursor': self._inbox_cursor(scope, ceiling, row) if explicit and more else None}
                while True:
                    candidate['truncated'] = more or any(v['truncated'] for v in candidate['messages'])
                    if len(canonical(candidate).encode()) <= context_budget:
                        break
                    if not item['body_preview']:
                        break
                    item['body_preview'] = item['body_preview'][:max(0, len(item['body_preview']) - 256)]
                    item['truncated'] = True
                if len(canonical(candidate).encode()) > context_budget:
                    # Long recipient lists must not block a hook's whole queue.
                    # Show an explicit reference, never invented/partial author
                    # or recipient metadata. The full record remains online via
                    # link_message. This ID really is included in the offer.
                    item = {'id': row['id'], 'body_preview': '', 'truncated': True, 'reference_only': True}
                    if full_text:
                        item['full_text'] = {'tool': 'link_message', 'arguments': {'message_id': row['id']}}
                    candidate['messages'] = result['messages'] + [item]
                    candidate['truncated'] = True
                if len(canonical(candidate).encode()) > context_budget:
                    if not result['messages']:
                        raise NativeError('context_budget_too_small_for_message')
                    break
                result = candidate
            if not rows and not explicit:
                result['has_more'] = result['offer_has_more'] = pending > 0
            ordinal = self.db.execute('SELECT COALESCE(MAX(offer_order),0)+1 FROM inbox').fetchone()[0]
            # Only the exact returned records count as offered, including an
            # empty/truncated preview whose full text requires link_message.
            for item in result['messages']:
                message_id = item['id']
                self._observe('inbox.offered', message_id=message_id, event_id=message_id)
                self.db.execute('INSERT INTO offers VALUES(?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET offered_at=excluded.offered_at',
                                (self.session_id, message_id, now))
                self.db.execute('UPDATE inbox SET offer_order=? WHERE id=?', (ordinal, message_id))
        return self.sanitize(result)

    def _current_inbox_message(self, message_id, *, write=False):
        self._identifier(message_id)
        allowed = self._authorize()
        row = self.db.execute('SELECT * FROM inbox WHERE id=?', (message_id,)).fetchone()
        if not row:
            raise NativeError('message_not_in_native_inbox')
        self._channel(row['channel_id'], allowed, write)
        actual = self._request('GET', '/v1/messages/' + message_id).get('message', {})
        if (type(actual) is not dict or actual.get('id') != message_id or actual.get('channel_id') != row['channel_id']
                or type(actual.get('recipient_ids')) is not list or self.config['agent_id'] not in actual['recipient_ids']
                or actual.get('author_id') == self.config['agent_id']):
            raise NativeError('message_no_longer_addressed')
        if (not identifier(actual.get('author_id')) or type(actual.get('seq')) is not int or actual['seq'] != row['seq']
                or len(actual['recipient_ids']) > 32 or not all(identifier(v) for v in actual['recipient_ids'])
                or type(actual.get('body')) is not str or not actual['body'] or '\x00' in actual['body']
                or len(actual['body'].encode('utf-8')) > 16384
                or (actual.get('reply_to') is not None and not identifier(actual['reply_to']))):
            raise NativeError('invalid_inbox_message')
        value = self.sanitize({k: actual.get(k) for k in ('id', 'channel_id', 'seq', 'author_id', 'recipient_ids', 'reply_to', 'body')})
        return row, value

    def message(self, message_id):
        """Read a complete addressed inbox message online, without acknowledgement."""
        row, value = self._current_inbox_message(message_id)
        return {'message': value, 'seen': row['seen_at'] is not None, 'accepted': row['accepted_at'] is not None,
                'untrusted_peer_data': True}

    def delivery(self, message_id):
        """Read source-separated delivery facts for a sent/addressed message."""
        self._identifier(message_id)
        allowed = self._authorize()
        message = self._request('GET', '/v1/messages/' + message_id).get('message')
        if (type(message) is not dict or message.get('id') != message_id
                or not identifier(message.get('author_id'))):
            raise NativeError('invalid_delivery_message')
        channel = self._channel(message.get('channel_id'), allowed)
        recipients = message.get('recipient_ids')
        if (type(recipients) is not list or len(recipients) > 32
                or not all(identifier(v) for v in recipients) or len(set(recipients)) != len(recipients)
                or self.config['agent_id'] != message['author_id'] and self.config['agent_id'] not in recipients):
            raise NativeError('delivery_message_not_sent_or_addressed')
        rows = message.get('delivery_status')
        if type(rows) is not list or len(rows) != len(recipients):
            raise NativeError('delivery_status_unavailable')
        def timestamp(value):
            if value is None:
                return True
            if (type(value) is not str or not re.fullmatch(
                    r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})', value)):
                return False
            try:
                # Python 3.10 accepts microseconds; Go emits RFC3339Nano.
                normalized = re.sub(r'\.(\d+)', lambda m: '.' + m.group(1).ljust(6, '0')[:6], value)
                datetime.fromisoformat(normalized.replace('Z', '+00:00'))
                return True
            except ValueError:
                return False
        validated, found = [], set()
        for row in rows:
            if (type(row) is not dict or set(row) != {'agent_id', 'status', 'native', 'legacy', 'reply'}
                    or row.get('agent_id') not in recipients or row['agent_id'] in found):
                raise NativeError('invalid_delivery_status')
            native, legacy, reply = row['native'], row['legacy'], row['reply']
            if (type(native) is not dict or set(native) != {'offered_at', 'seen_at', 'accepted_at', 'provenance', 'server_verified'}
                    or native['provenance'] != 'client_reported' or native['server_verified'] is not False
                    or not all(timestamp(native[k]) for k in ('offered_at', 'seen_at', 'accepted_at'))
                    or type(legacy) is not dict or set(legacy) != {'delivered_at', 'accepted_at', 'uncertain_at'}
                    or not all(timestamp(v) for v in legacy.values())
                    or reply is not None and (type(reply) is not dict or set(reply) != {'message_id', 'created_at'}
                        or not identifier(reply['message_id']) or reply['message_id'] == message_id
                        or reply['created_at'] is None or not timestamp(reply['created_at']))):
                raise NativeError('invalid_delivery_status')
            expected = ('replied' if reply else 'accepted' if native['accepted_at'] or legacy['accepted_at'] else
                        'viewed' if native['seen_at'] else 'delivered' if legacy['delivered_at'] else
                        'offered' if native['offered_at'] else 'stored')
            if row['status'] != expected:
                raise NativeError('invalid_delivery_status')
            found.add(row['agent_id'])
            validated.append(row)
        return self.sanitize({'message_id': message_id, 'channel_id': channel, 'author_id': message['author_id'],
            'recipient_ids': recipients, 'delivery_status': validated, 'untrusted_peer_data': True,
            'boundary': 'Native reports, adapter confirmations and direct replies are independent. '
                        'Adapter delivery is not viewing. Acceptance and a reply do not prove task completion.'})

    def seen_message(self, message_id):
        row, _ = self._current_inbox_message(message_id, write=True)
        with self.atomic():
            changed = self.db.execute('UPDATE inbox SET seen_at=?,seen_session=? WHERE id=? AND seen_at IS NULL',
                                      (time.time(), self.session_id, message_id)).rowcount
            if changed:
                self._observe('inbox.seen', message_id=message_id, event_id=message_id)
        return {'message_id': message_id, 'seen': True, 'accepted': row['accepted_at'] is not None,
                'replayed': not bool(changed), 'legacy_receipt_changed': False}

    def accept_message(self, message_id):
        self._current_inbox_message(message_id, write=True)
        with self.atomic():
            changed = self.db.execute('UPDATE inbox SET accepted_at=?,accepted_session=? WHERE id=? AND accepted_at IS NULL',
                                      (time.time(), self.session_id, message_id)).rowcount
            if changed:
                self._observe('inbox.accepted', message_id=message_id, event_id=message_id)
        return {'message_id': message_id, 'accepted': True, 'replayed': not bool(changed), 'legacy_receipt_changed': False}

    def _validate_receipt(self, row, body, response):
        if type(response) is not dict:
            raise NativeError('invalid_publication_receipt')
        if row['kind'] == 'activity':
            item = response.get('activity', {})
            expected = {'channel_id': row['channel_id'], 'actor_id': self.config['agent_id'], **body}
        elif row['kind'] == 'message':
            item = response.get('message', {})
            expected = {'channel_id': row['channel_id'], 'author_id': self.config['agent_id'], **body}
            expected.pop('client_id')  # Existing Message API does not expose it.
        elif row['kind'] == 'task_event':
            item = response.get('event', {})
            expected = {k: body[k] for k in ('client_id', 'run_id', 'type', 'summary')}
            expected.update(actor_id=self.config['agent_id'], version=body['expected_version'] + 1,
                            task_id=row['path'].split('/')[-2])
            for name in ('artifacts', 'review_request_id', 'verdict', 'evidence', 'recovery_action'):
                expected[name] = body.get(name, [] if name == 'artifacts' else None)
        elif row['kind'] == 'artifact':
            item = response.get('artifact', {})
            if type(item) is not dict:
                raise NativeError('invalid_publication_receipt')
            expected = {k: body[k] for k in ('role', 'base_revision', 'sha256')}
            expected.update(project_id=self.config['project_id'], author_id=self.config['agent_id'],
                            size_bytes=len(base64.b64decode(body['content_base64'])))
            # Old servers omit title for legacy untitled publications.
            expected['title'] = body.get('title', '')
            item = {**item, 'title': item.get('title', '')}
        elif row['kind'] == 'task_create':
            item = response.get('task', {})
            expected = {k: body[k] for k in ('title', 'owner_id', 'reviewer_id', 'scope', 'acceptance')}
            expected.update(project_id=self.config['project_id'], created_by=self.config['agent_id'])
        else:
            item = response.get('memory', {})
            expected = {'project_id': self.config['project_id'], 'updated_by': self.config['agent_id'],
                        'title': body['title'], 'body': body['body'], 'version': body.get('expected_version', 0) + 1}
            if row['method'] == 'PUT':
                expected['id'] = row['path'].split('/')[-1]
            else:
                expected['author_id'] = self.config['agent_id']
        # Go normalizes artifact references to a canonical set on receipt.
        if 'artifacts' in expected and isinstance(item.get('artifacts'), list):
            expected['artifacts'] = sorted(expected['artifacts'], key=lambda v: v['artifact_id'])
            item = {**item, 'artifacts': sorted(item['artifacts'], key=lambda v: v['artifact_id'])}
        if not identifier(item.get('id')) or any(item.get(k) != v for k, v in expected.items()):
            raise NativeError('publication_receipt_mismatch')

    def flush(self, limit=20):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise NativeError('invalid_flush_limit')
        allowed = self._authorize()
        rows = self.db.execute("SELECT * FROM outbox WHERE state='pending' ORDER BY created_at,id LIMIT ?", (limit,)).fetchall()
        sent = 0
        for row in rows:
            if row['channel_id'] is not None:
                if row['channel_id'] not in allowed or not allowed[row['channel_id']]:
                    with self.atomic():
                        self.db.execute("UPDATE outbox SET state='blocked' WHERE id=? AND state='pending'", (row['id'],))
                    continue
            body = strict_json(row['payload'])
            self.reject_secret(body)
            try:
                response = self._request(row['method'], row['path'], body)
                self._validate_receipt(row, body, response)
            except NativeHTTPError as error:
                if error.status in (400, 401, 403, 404, 409, 413, 422):
                    with self.atomic():
                        self.db.execute("UPDATE outbox SET state='blocked' WHERE id=? AND state='pending'", (row['id'],))
                raise
            with self.atomic():
                self.db.execute("UPDATE outbox SET state='sent',response=? WHERE id=?", (canonical(self.sanitize(response)), row['id']))
            sent += 1
        return {'sent': sent, 'pending': self.db.execute("SELECT count(*) FROM outbox WHERE state='pending'").fetchone()[0],
                'blocked': self.db.execute("SELECT count(*) FROM outbox WHERE state='blocked'").fetchone()[0]}

    def status(self):
        allowed = self._authorize()
        connector, server = CONNECTOR_BUILD or {}, self._server_build or {}
        return self.sanitize({'agent_id': self.config['agent_id'], 'project_id': self.config['project_id'], 'runtime': self.config['runtime'],
                'connector_version': connector.get('version'), 'connector_source_commit': connector.get('source_commit'),
                'connector_identity_source': 'release_metadata' if CONNECTOR_BUILD else 'unavailable',
                'server_version': server.get('version'), 'server_source_commit': server.get('source_commit'),
                'server_identity_source': 'authenticated_api' if self._server_build else 'unavailable',
                'session_id': self.session_id, 'channel_ids': list(allowed), 'pending_messages': self._pending_count(allowed),
                'unseen_messages': self._pending_count(allowed, include_seen=False),
                'pending_publications': self.db.execute("SELECT count(*) FROM outbox WHERE state='pending'").fetchone()[0],
                'blocked_publications': self.db.execute("SELECT count(*) FROM outbox WHERE state='blocked'").fetchone()[0],
                'auto_execution': False, 'legacy_heartbeat_changed': False})

    def _publish(self, kind, path, body, *, method='POST', channel=None):
        allowed = self._authorize()
        if channel is not None:
            self._channel(channel, allowed, True)
        self._identifier(body.get('client_id'))
        identity = kind + ':' + hashlib.sha256(canonical([path, method, body['client_id']]).encode()).hexdigest()
        with self.atomic():
            self._put(kind, channel, path, method, body, identity)
        # A failed ACK leaves the exact immutable payload queued for link_flush.
        self.flush()
        row = self.db.execute('SELECT state,response FROM outbox WHERE id=?', (identity,)).fetchone()
        return {'client_id': body['client_id'], 'publication_state': row['state'],
                'result': strict_json(row['response']) if row['response'] else None}

    def send(self, channel_id, recipient_ids, body, reply_to=None, client_id=None):
        self._identifier(channel_id)
        if (not text(body, 16384) or type(recipient_ids) is not list or len(recipient_ids) > 32
                or not all(identifier(v) for v in recipient_ids) or len(set(recipient_ids)) != len(recipient_ids)):
            raise NativeError('invalid_message_fields')
        if reply_to is not None:
            self._identifier(reply_to)
        payload = {'body': body, 'recipient_ids': sorted(recipient_ids), 'reply_to': reply_to}
        # Auto-ID deliberately deduplicates identical sends in this native
        # session. Supply a new explicit client_id to intentionally repeat one.
        payload['client_id'] = client_id or hashlib.sha256(canonical([self.session_id, channel_id, payload]).encode()).hexdigest()
        return self._publish('message', '/v1/channels/' + channel_id + '/messages', payload, channel=channel_id)

    def tasks(self, task_id=None, after_version=None, limit=100):
        self._authorize()
        path = self.project_path + '/tasks'
        if task_id is not None:
            path += '/' + self._identifier(task_id)
        if after_version is not None:
            if task_id is None or type(after_version) is not int or after_version < 0 or type(limit) is not int or not 1 <= limit <= 200:
                raise NativeError('invalid_task_event_cursor')
            path += '/events?' + urlencode({'after_version': after_version, 'limit': limit})
        return self.sanitize(self._request('GET', path))

    def create_task(self, **body):
        required = {'client_id', 'title', 'owner_id', 'reviewer_id', 'scope', 'acceptance'}
        if set(body) != required:
            raise NativeError('invalid_task_fields')
        return self._publish('task_create', self.project_path + '/tasks', body)

    def task_event(self, task_id, event):
        self._identifier(task_id)
        required = {'client_id', 'expected_version', 'type', 'run_id', 'summary'}
        optional = {'artifacts', 'review_request_id', 'verdict', 'evidence', 'recovery_action'}
        if type(event) is not dict or not required <= set(event) or set(event) - required - optional:
            raise NativeError('invalid_task_event_fields')
        return self._publish('task_event', self.project_path + '/tasks/' + task_id + '/events', event)

    def memory(self, memory_id=None, version=None):
        self._authorize()
        path = self.project_path + '/memory'
        if memory_id is not None:
            path += '/' + self._identifier(memory_id)
        if version is not None:
            if memory_id is None or type(version) is not int or not 1 <= version < 9223372036854775807:
                raise NativeError('invalid_memory_pin')
            path += '?' + urlencode({'before_version': version + 1})
        result = self._request('GET', path)
        if version is not None:
            current = result.get('memory', {})
            selected = next((v for v in result.get('versions', []) if v.get('version') == version), None)
            if current.get('id') != memory_id or current.get('project_id') != self.config['project_id'] or not selected:
                raise NativeError('pinned_memory_revision_unavailable')
            result = {'memory': {**selected, 'id': memory_id, 'project_id': self.config['project_id']},
                      'current_version': current['version'], 'pinned_version': version}
        return self.sanitize(result)

    def write_memory(self, client_id, title, body, memory_id=None, expected_version=None):
        if not text(title, 200) or not text(body, 16384):
            raise NativeError('invalid_memory_text')
        payload = {'client_id': client_id, 'title': title, 'body': body}
        path, method = self.project_path + '/memory', 'POST'
        if memory_id is not None:
            path += '/' + self._identifier(memory_id)
            if type(expected_version) is not int or expected_version < 1:
                raise NativeError('memory_cas_version_required')
            payload['expected_version'], method = expected_version, 'PUT'
        elif expected_version is not None:
            raise NativeError('memory_id_required_for_update')
        return self._publish('memory', path, payload, method=method)

    def artifacts(self, action='list', artifact_id=None, sha256=None, base_revision=None, after_seq=0, limit=20):
        self._authorize()
        if action == 'list':
            if artifact_id is not None or sha256 is not None or base_revision is not None or type(after_seq) is not int or after_seq < 0 or type(limit) is not int or not 1 <= limit <= 100:
                raise NativeError('invalid_artifact_list_fields')
            return self.sanitize(self._request('GET', self.project_path + '/artifacts?' + urlencode({'after_seq': after_seq, 'limit': limit})))
        self._identifier(artifact_id)
        metadata = self._request('GET', '/v1/artifacts/' + artifact_id).get('artifact', {})
        if metadata.get('id') != artifact_id or metadata.get('project_id') != self.config['project_id']:
            raise NativeError('artifact_outside_bound_project')
        if action == 'metadata':
            return self.sanitize({'artifact': metadata})
        if action != 'content' or type(sha256) is not str or not SHA.fullmatch(sha256) or not identifier(base_revision):
            raise NativeError('text_content_requires_hash_and_base_pins')
        if metadata.get('sha256') != sha256 or metadata.get('base_revision') != base_revision:
            raise NativeError('artifact_pin_mismatch')
        data = self._request('GET', '/v1/artifacts/' + artifact_id + '/content', binary=True)
        if not isinstance(data, bytes) or len(data) != metadata.get('size_bytes') or hashlib.sha256(data).hexdigest() != sha256:
            raise NativeError('artifact_content_integrity_failure')
        try:
            content = data.decode('utf-8')
            if '\x00' in content:
                raise ValueError()
        except (UnicodeError, ValueError):
            raise NativeError('artifact_is_not_utf8_text') from None
        preview = data[:16000].decode('utf-8', errors='ignore')
        return self.sanitize({'artifact': metadata, 'text': preview, 'truncated': len(data) > 16000,
                              'untrusted_content': True, 'redacted': self.key in preview})

    def publish_artifact(self, client_id, role, base_revision, content, title=''):
        """Explicit selected text only: never reads files or captures tool IO."""
        self._identifier(client_id)
        self._identifier(base_revision)
        if role not in ('baseline', 'implementation', 'test', 'evidence', 'bundle', 'document') or not text(content, 24576):
            raise NativeError('invalid_text_artifact')
        if type(title) is not str or (title != '' and (not text(title, 200) or any(unicodedata.category(c) in ('Cc', 'Zl', 'Zp') for c in title))):
            raise NativeError('invalid_artifact_title')
        self.reject_secret(content)
        self.reject_secret(title)
        raw = content.encode('utf-8')
        body = {'client_id': client_id, 'role': role, 'base_revision': base_revision,
                'sha256': hashlib.sha256(raw).hexdigest(), 'content_base64': base64.b64encode(raw).decode('ascii')}
        if title:
            body['title'] = title
        return self._publish('artifact', self.project_path + '/artifacts', body)

    def activity(self, channel_id=None, after_seq=0, limit=20):
        allowed = self._authorize()
        channel = self._channel(channel_id or self.config['channel_ids'][0], allowed)
        if type(after_seq) is not int or after_seq < 0 or type(limit) is not int or not 1 <= limit <= 100:
            raise NativeError('invalid_activity_cursor')
        return self.sanitize(self._request('GET', '/v1/channels/' + channel + '/activity?' + urlencode({'after_seq': after_seq, 'limit': limit})))

    def close(self):
        self.db.close()
