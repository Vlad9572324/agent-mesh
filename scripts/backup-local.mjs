// Private, non-destructive backup of this pilot before a schema/binary rollout.
import { readFile, mkdir, chmod, copyFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runtimeDir, repositoryRoot } from './operator-config.mjs';

process.umask(0o077);
const runtime = runtimeDir();
const root = repositoryRoot;
const pgBin = `${runtime}/pgsql/usr/lib/postgresql/14/bin`;
const dsn = new URL((await readFile(`${runtime}/secrets/agentlink-dsn`, 'utf8')).trim());
if (dsn.hostname !== '127.0.0.1' || dsn.port !== '55439' || dsn.pathname !== '/agentlink') {
  throw new Error('Unexpected database target; no backup attempted');
}
const base = `${runtime}/backups`;
await mkdir(base, { recursive: true, mode: 0o700 });
await chmod(base, 0o700);
const destination = `${base}/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(destination, { mode: 0o700 });
const env = { ...process.env, LD_LIBRARY_PATH: `${runtime}/pgsql/usr/lib/x86_64-linux-gnu`,
  PGPASSWORD: decodeURIComponent(dsn.password) };
const dump = `${destination}/agentlink.dump`;
const result = spawnSync(`${pgBin}/pg_dump`, ['--host', dsn.hostname, '--port', dsn.port,
  '--username', decodeURIComponent(dsn.username), '--dbname', 'agentlink', '--format', 'custom',
  '--no-owner', '--no-acl', '--file', dump], { env, encoding: 'utf8', timeout: 60000 });
if (result.status !== 0) throw new Error('Private pg_dump failed; partial backup retained, no rollout authorized');
await chmod(dump, 0o600);
const verify = spawnSync(`${pgBin}/pg_restore`, ['--list', dump], { env, encoding: 'utf8', timeout: 15000 });
if (verify.status !== 0) throw new Error('Backup archive is unreadable; no rollout authorized');
await copyFile(`${root}/bin/agent-link`, `${destination}/agent-link.previous`);
await chmod(`${destination}/agent-link.previous`, 0o700);
const checksum = createHash('sha256').update(await readFile(dump)).digest('hex');
const manifest = { created_at: new Date().toISOString(), database: 'agentlink', archive: dump,
  bytes: (await stat(dump)).size, sha256: checksum, archive_table_of_contents_verified: true,
  restoration_tested: false, previous_binary: `${destination}/agent-link.previous` };
await writeFile(`${destination}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify(manifest));
