// Local pilot operations. Never prints credentials or changes system services.
import { readFile, writeFile, chmod, access, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { runtimeDir } from './operator-config.mjs';

const runtime = runtimeDir();
const pgBin = `${runtime}/pgsql/usr/lib/postgresql/14/bin`;
const pgEnv = { ...process.env, LD_LIBRARY_PATH: `${runtime}/pgsql/usr/lib/x86_64-linux-gnu` };
async function exportKey(target, key) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Unexpected credential format');
  try {
    await writeFile(target, `${key}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('Cannot write private key file');
    const info = await lstat(target);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (await readFile(target, 'utf8')).trim() !== key) {
      throw new Error('Existing key file differs or is unsafe; refusing to replace a potentially rotated key');
    }
  }
}
function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { env: pgEnv, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${binary.split('/').pop()} failed: ${result.stderr || result.error || result.stdout}`);
  return result.stdout;
}
const command = process.argv[2];
if (command === 'pg-start') {
  await access(`${runtime}/data/PG_VERSION`);
  const status = spawnSync(`${pgBin}/pg_ctl`, ['-D', `${runtime}/data`, 'status'], { env: pgEnv, encoding: 'utf8' });
  if (status.status !== 0) {
    run(`${pgBin}/pg_ctl`, ['-D', `${runtime}/data`, '-l', `${runtime}/postgres.log`, '-o', `-h 127.0.0.1 -p 55439 -k ${runtime}/socket -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=40 -c fsync=on -c synchronous_commit=on -c jit=off`, '-w', '-t', '20', 'start']);
  }
  console.log('Private PostgreSQL is running on 127.0.0.1:55439.');
} else if (command === 'pg-prepare') {
  const password = (await readFile(`${runtime}/secrets/postgres-password`, 'utf8')).trim();
  const env = { ...pgEnv, PGPASSWORD: password };
  for (const database of ['agentlink', 'agentlink_test', 'agentlink_e2e']) {
    const present = run(`${pgBin}/psql`, ['-h', '127.0.0.1', '-p', '55439', '-U', 'agentlink', '-d', 'postgres', '-Atc', `SELECT 1 FROM pg_database WHERE datname='${database}'`], { env }).trim();
    if (!present) run(`${pgBin}/createdb`, ['-h', '127.0.0.1', '-p', '55439', '-U', 'agentlink', database], { env });
    const target = `${runtime}/secrets/${database}-dsn`;
    await writeFile(target, `postgresql://agentlink:${encodeURIComponent(password)}@127.0.0.1:55439/${database}?sslmode=disable\n`, { mode: 0o600 });
    await chmod(target, 0o600);
  }
  console.log('Pilot and isolated test databases prepared; DSNs stored privately.');
} else if (command === 'split-keys') {
  const credentials = JSON.parse(await readFile(`${runtime}/secrets/credentials.json`, 'utf8'));
  for (const [id, key] of Object.entries(credentials.keys)) {
    if (!/^[a-z0-9-]+$/.test(id) || typeof key !== 'string') throw new Error('Unexpected credential format');
    const target = `${runtime}/secrets/${id}.key`;
    await exportKey(target, key);
    console.log(`Personal key verified for ${id} (0600); value not printed.`);
  }
} else if (command === 'owner-key') {
  const credentials = JSON.parse(await readFile(`${runtime}/secrets/owner-pilot.json`, 'utf8'));
  if (credentials.agent_id !== 'owner-pilot' || typeof credentials.key !== 'string') throw new Error('Unexpected owner credential format');
  await exportKey(`${runtime}/secrets/owner-pilot.key`, credentials.key);
  console.log('Owner key exported privately (0600); value not printed.');
} else {
  throw new Error('Usage: node scripts/local-runtime.mjs pg-start|pg-prepare|split-keys|owner-key');
}
