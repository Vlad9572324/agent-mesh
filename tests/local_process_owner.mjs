import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm, lstat, rename, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readOwnedProcess, acquireLifecycleLock} from '../scripts/local-process-owner.mjs';

const expected = {binary: '/fixture/bin/agent-link', address: '127.0.0.1', port: 8766,
  dsn: '/fixture-runtime/secrets/database-url', cert: '/fixture-runtime/secrets/server.crt',
  key: '/fixture-runtime/secrets/server.key', releases: '/fixture-runtime/releases'};
const owner = {pid: 12345, binary: expected.binary, address: expected.address, port: expected.port,
  web_dir: expected.releases + '/candidate', start_ticks: '123456'};
const argv = [expected.binary, 'serve', '--database-url-file', expected.dsn, '--listen', '127.0.0.1:8766',
  '--tls-cert', expected.cert, '--tls-key', expected.key, '--web-dir', owner.web_dir];
const error = code => Object.assign(new Error('synthetic'), {code});
function fixture(record = owner, command = argv, ticks = '123456', state = 'S') {
  return {probe: () => {}, readFile: async path => {
    if (path === '/record.json') return JSON.stringify(record);
    if (path.endsWith('/stat')) return `${record.pid} (fixture process) ${[state, ...Array(18).fill('0'), ticks].join(' ')}`;
    if (path.endsWith('/cmdline')) return command.join('\0') + '\0';
    throw error('ENOENT');
  }};
}
test('exact live runtime and start identity are accepted', async () => {
  assert.deepEqual(await readOwnedProcess('/record.json', expected, fixture()), owner);
});
test('changed address or runtime never counts as a missing server', async () => {
  for (const target of [{...expected, address: '192.0.2.20'}, {...expected, port: 9443},
    {...expected, dsn: '/other-runtime/secrets/database-url'}, {...expected, cert: '/other-runtime/server.crt'},
    {...expected, key: '/other-runtime/server.key'}]) {
    await assert.rejects(readOwnedProcess('/record.json', target, fixture()));
  }
});
test('PID reuse and legacy incomplete records fail closed', async () => {
  await assert.rejects(readOwnedProcess('/record.json', expected, fixture(owner, argv, '999999')));
  const legacy = {...owner}; delete legacy.start_ticks;
  await assert.rejects(readOwnedProcess('/record.json', expected, fixture(legacy)));
});
test('only positively absent or dead process permits a new start', async () => {
  const missing = fixture(); missing.readFile = async () => { throw error('ENOENT'); };
  assert.equal(await readOwnedProcess('/record.json', expected, missing), null);
  const dead = fixture(); dead.probe = () => { throw error('ESRCH'); };
  assert.equal(await readOwnedProcess('/record.json', expected, dead), null);
  assert.equal(await readOwnedProcess('/record.json', expected, fixture(owner, argv, owner.start_ticks, 'Z')), null);
  const denied = fixture(); denied.probe = () => { throw error('EPERM'); };
  await assert.rejects(readOwnedProcess('/record.json', expected, denied));
  const unreadable = fixture(); unreadable.readFile = async () => { throw error('EACCES'); };
  await assert.rejects(readOwnedProcess('/record.json', expected, unreadable));
});
test('foreign arguments and paths cannot authorize stopping a process', async () => {
  await assert.rejects(readOwnedProcess('/record.json', expected, fixture(owner, [...argv, '--unexpected'])));
  await assert.rejects(readOwnedProcess('/record.json', expected, fixture({...owner, web_dir: '/another/web'})));
});
test('parallel lifecycle operations cannot take the same runtime lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-mesh-owner-lock-'));
  try {
    const path = join(directory, 'operation.lock');
    const unlock = await acquireLifecycleLock(path);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await assert.rejects(acquireLifecycleLock(path));
    await unlock();
    const next = await acquireLifecycleLock(path); await next();
  } finally { await rm(directory, {recursive: true}); }
});
test('lock release never removes a replaced file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-mesh-owner-lock-'));
  try {
    const path = join(directory, 'operation.lock');
    const unlock = await acquireLifecycleLock(path);
    await rename(path, path + '.owned');
    await writeFile(path, 'replacement', {flag: 'wx'});
    await assert.rejects(unlock());
    assert.equal(await readFile(path, 'utf8'), 'replacement');
  } finally { await rm(directory, {recursive: true}); }
});
