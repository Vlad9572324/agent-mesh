// Fingerprint existing database content without exposing keys or message bodies.
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { requiredEnv, runtimeDir } from './operator-config.mjs';

process.umask(0o077);
const runtime = runtimeDir();
const expectedPort = requiredEnv('AGENT_LINK_SOURCE_DB_PORT');
if (!/^[1-9][0-9]{0,4}$/.test(expectedPort) || Number(expectedPort) > 65535) throw new Error('Explicit valid source database port required');
const command = process.argv[2];
if (!['before', 'after'].includes(command)) throw new Error('Usage: check-lifecycle-rollout.mjs before|after');
const dsn = new URL((await readFile(`${runtime}/secrets/agentlink-dsn`, 'utf8')).trim());
if (dsn.protocol !== 'postgresql:' || dsn.hostname !== '127.0.0.1' || dsn.port !== expectedPort || dsn.pathname !== '/agentlink') throw new Error('Unexpected database target');
const pgBin = `${runtime}/pgsql/usr/lib/postgresql/14/bin`;
const env = { ...process.env, LD_LIBRARY_PATH: `${runtime}/pgsql/usr/lib/x86_64-linux-gnu`, PGPASSWORD: decodeURIComponent(dsn.password) };
const tables = ['principals', 'projects', 'project_members', 'channels', 'channel_members', 'messages', 'receipts', 'events', 'notes', 'admin_audit'];
const parts = tables.map(table => {
  // The migration adds project lifecycle metadata; compare all pre-existing fields.
  const columns = table === 'projects' ? 'id,name' : '*';
  return `SELECT '${table}' AS table_name,count(*) AS rows,md5(COALESCE(string_agg(row_to_json(x)::text,'' ORDER BY row_to_json(x)::text),'')) AS fingerprint FROM (SELECT ${columns} FROM ${table}) AS x`;
});
const sql = `SELECT json_agg(v ORDER BY table_name) FROM (${parts.join(' UNION ALL ')}) AS v`;
const result = spawnSync(`${pgBin}/psql`, ['-X', '-h', dsn.hostname, '-p', dsn.port, '-U', decodeURIComponent(dsn.username), '-d', 'agentlink', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env, encoding: 'utf8', timeout: 15000 });
if (result.status !== 0) throw new Error('Private database fingerprint query failed');
const snapshot = JSON.parse(result.stdout);
const target = `${runtime}/evidence/pre-project-lifecycle-state.json`;
if (command === 'before') {
  await writeFile(target, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('All existing accounts/keys, projects, ACLs, history and audit fingerprinted privately.');
} else {
  const previous = JSON.parse(await readFile(target, 'utf8'));
  const changed = tables.filter(table => JSON.stringify(previous.find(x => x.table_name === table)) !== JSON.stringify(snapshot.find(x => x.table_name === table)));
  const report = { checked_at: new Date().toISOString(), passed: changed.length === 0, changed_tables: changed, tables_checked: tables.length,
    existing_content_keys_and_memberships_unchanged: changed.length === 0 };
  await writeFile(`${runtime}/evidence/project-lifecycle-rollout.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
  if (changed.length) process.exitCode = 1;
}
