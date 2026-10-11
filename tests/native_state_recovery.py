#!/usr/bin/env python3
"""A malformed native.sqlite is quarantined and rebuilt instead of wedging the connector.

python3 tests/native_state_recovery.py   (offline, temporary directory, no network)
"""
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'adapters'))
from native_bridge import NativeBridge


def check(condition, message):
    if not condition:
        raise SystemExit('FAIL: ' + message)


def main():
    with tempfile.TemporaryDirectory() as root:
        root = Path(root)
        (root / 'ws').mkdir()
        state = root / 'state'
        key = root / 'agent.key'
        key.write_text('a' * 64 + '\n')
        key.chmod(0o600)
        ca = root / 'ca.crt'
        ca.write_text('')
        config = root / 'config.json'
        config.write_text(json.dumps({
            'version': 1, 'url': 'https://127.0.0.1:1', 'ca_file': None, 'key_file': str(key),
            'agent_id': 'a1', 'project_id': 'p1', 'channel_ids': ['c1', 'c2'],
            'state_dir': str(state), 'runtime': 'claude', 'workspace_root': str(root / 'ws')}))
        config.chmod(0o600)
        config_value = json.loads(config.read_text())
        config_value['url'] = 'http://127.0.0.1:1'
        config.write_text(json.dumps(config_value))

        bridge = NativeBridge(str(config), 's1')
        with bridge.atomic():
            for i in range(3000):
                bridge.db.execute('INSERT INTO offers VALUES(?,?,?)', ('s', 'm%05d' % i, float(i)))
            bridge.db.execute('UPDATE cursors SET seq=77 WHERE channel_id=?', ('c1',))
        bridge.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        bridge.db.close()

        database = state / 'native.sqlite'
        blob = bytearray(database.read_bytes())
        for page in range(3, len(blob) // 4096 - 1, 23):  # damage interior pages, keep the header
            blob[page * 4096:page * 4096 + 64] = os.urandom(64)
        database.write_bytes(bytes(blob))
        probe = sqlite3.connect(database)
        try:
            broken = probe.execute('PRAGMA integrity_check').fetchone()[0] != 'ok'
        except sqlite3.DatabaseError:
            broken = True
        probe.close()
        check(broken, 'test did not corrupt the database')

        recovered = NativeBridge(str(config), 's2')  # must not raise
        check(recovered.db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'rebuilt database unhealthy')
        check(list(state.glob('native.sqlite.corrupt-*')), 'damaged file not preserved')
        check(recovered.db.execute('SELECT value FROM meta WHERE key=?', ('binding',)).fetchone() is not None,
              'binding missing after recovery')
        check(oct(database.stat().st_mode & 0o777) == '0o600', 'rebuilt database not private')
        rows = recovered.db.execute('SELECT COUNT(*) FROM offers').fetchone()[0]
        check(0 < rows <= 3000, 'no readable rows carried over')
        recovered.db.close()

        again = NativeBridge(str(config), 's3')  # a healthy database is left alone
        before = len(list(state.glob('native.sqlite.corrupt-*')))
        again.db.close()
        check(before == 1, 'unexpected quarantine count')
    print('native_state_recovery: ok')


if __name__ == '__main__':
    main()
