// Full, read-only source-versus-new-LXC migration evidence. No raw rows or keys
// leave PostgreSQL: only counts, column metadata and canonical SHA-256 hashes.
import { constants } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { requiredEnv, requiredPath, runtimeDir } from './operator-config.mjs';

// Serialize each JSON tree as typed nodes with unambiguous paths/scalars. Object
// keys and strings become UTF-8 hex; arrays retain their ordinal positions;
// numbers use exact scale-normalized PostgreSQL numeric, never JS floats.
// Neither json/jsonb display whitespace nor object key ordering nor database
// locale can affect the result. Session settings normalize timestamp/bytea/float
// conversion before to_jsonb. Every actual, non-dropped column participates.
const rowHash = `(WITH RECURSIVE nodes(path,value) AS (
  SELECT ''::text,to_jsonb(t)
  UNION ALL
  SELECT n.path || '/' || child.component,child.value
  FROM nodes n CROSS JOIN LATERAL (
    SELECT 'o' || encode(convert_to(e.key,'UTF8'),'hex') AS component,e.value
    FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END) e
    UNION ALL
    SELECT 'a' || lpad(e.ordinality::text,20,'0'),e.value
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END)
      WITH ORDINALITY e(value,ordinality)
  ) child
)
SELECT encode(sha256(convert_to(string_agg(
  path || ':' || jsonb_typeof(value) || ':' || CASE jsonb_typeof(value)
    WHEN 'string' THEN encode(convert_to(value #>> '{}','UTF8'),'hex')
    WHEN 'number' THEN trim_scale((value #>> '{}')::numeric)::text
    WHEN 'boolean' THEN value::text
    ELSE '' END, '|' ORDER BY path COLLATE "C"),'UTF8')),'hex') FROM nodes)`;

export const fingerprintSQL = `\\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog,public;
SET LOCAL timezone='UTC';
SET LOCAL datestyle='ISO, YMD';
SET LOCAL intervalstyle='iso_8601';
SET LOCAL bytea_output='hex';
SET LOCAL extra_float_digits=3;
SET LOCAL client_encoding='UTF8';
SET LOCAL row_security=off;
SET LOCAL statement_timeout='60000';
SET LOCAL lock_timeout='5000';
SELECT json_build_object('kind','metadata','database',current_database(),
  'server_version_num',current_setting('server_version_num'),
  'read_only',current_setting('transaction_read_only'),
  'isolation',current_setting('transaction_isolation'),
  'unsupported_foreign_tables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='f'));
SELECT format($table$
SELECT json_build_object('kind','table','name',%1$L,'count',count(*)::text,
  'fingerprint',encode(sha256(convert_to(COALESCE(string_agg(row_hash,'' ORDER BY row_hash COLLATE "C"),''),'UTF8')),'hex'),
  'columns',(SELECT json_agg(json_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated,a.attidentity)
    ORDER BY a.attname COLLATE "C") FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=%2$L AND c.relname=%1$L
      AND a.attnum>0 AND NOT a.attisdropped))
FROM (SELECT ${rowHash} AS row_hash FROM ONLY %2$I.%1$I t) rows;
$table$,c.relname,n.nspname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname COLLATE "C"
\\gexec
SELECT format($sequence$
SELECT json_build_object('kind','sequence','name',%1$L,'last_value',last_value::text,'is_called',is_called)
FROM %2$I.%1$I;
$sequence$,c.relname,n.nspname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='S' ORDER BY c.relname COLLATE "C"
\\gexec
COMMIT;
`;

function require(value, message) {
  if (!value) throw new Error(message);
}

export function parseArguments(args) {
  const result = { targetDB: 'agentlink' };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    require(['--vmid', '--target-db'].includes(flag) && value && !seen.has(flag),
      'Usage: node scripts/check-lxc-migration.mjs --vmid NEW_VMID [--target-db agentlink|agentlink_rehearsal]');
    seen.add(flag);
    if (flag === '--vmid') result.vmid = value;
    if (flag === '--target-db') result.targetDB = value;
  }
  require(/^[1-9][0-9]{2,8}$/.test(result.vmid || ''), 'An explicit numeric NEW_VMID of at least 100 is required');
  require(['agentlink', 'agentlink_rehearsal'].includes(result.targetDB), 'Target database must be agentlink or agentlink_rehearsal');
  return result;
}

async function privateRegular(path, label, strict = true) {
  const info = await lstat(path);
  require(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  require((info.mode & (strict ? 0o077 : 0o022)) === 0, `${label} has unsafe permissions`);
}

function run(binary, args, env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', outputBytes = 0, failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill('SIGTERM');
      reject(new Error(`${label} exceeded the read-only check timeout`));
    }, 180000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > 8 * 1024 * 1024) {
        failed = true;
        child.kill('SIGTERM');
        reject(new Error(`${label} returned unexpectedly large metadata`));
      } else stdout += chunk;
    });
    // Never print database/SSH stderr: a connection error could reveal private
    // parameters, and SQL error diagnostics should not enter shared evidence.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      failed = true;
      reject(new Error(`${label} could not be started`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) reject(new Error(`${label} failed with exit status ${code}; no migration was performed`));
      else resolve(stdout);
    });
    child.stdin.end(fingerprintSQL);
  });
}

function parseSnapshot(output, expectedDB, label) {
  let rows;
  try { rows = output.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { throw new Error(`${label} returned invalid fingerprint metadata`); }
  const metadata = rows.filter(row => row.kind === 'metadata');
  require(metadata.length === 1 && metadata[0].database === expectedDB && metadata[0].read_only === 'on' &&
    metadata[0].isolation === 'repeatable read', `${label} did not confirm the intended read-only snapshot`);
  require(metadata[0].unsupported_foreign_tables === 0, `${label} contains foreign tables; refusing to inspect external data`);
  const tables = new Map(), sequences = new Map();
  for (const row of rows) {
    if (row.kind === 'metadata') continue;
    require(typeof row.name === 'string', `${label} returned unnamed metadata`);
    if (row.kind === 'table') {
      require(!tables.has(row.name) && /^[0-9]+$/.test(row.count) && /^[a-f0-9]{64}$/.test(row.fingerprint) &&
        Array.isArray(row.columns), `${label} returned invalid table metadata`);
      tables.set(row.name, row);
    } else if (row.kind === 'sequence') {
      require(!sequences.has(row.name) && /^-?[0-9]+$/.test(row.last_value) && typeof row.is_called === 'boolean',
        `${label} returned invalid sequence metadata`);
      sequences.set(row.name, row);
    } else throw new Error(`${label} returned unexpected metadata`);
  }
  require(tables.has('principals') && tables.has('projects') && tables.has('messages') && tables.has('admin_audit') &&
    tables.has('retired_project_ids') && tables.has('retired_channel_ids'), `${label} does not contain the complete current Agent Mesh schema`);
  return { metadata: metadata[0], tables, sequences };
}

function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function names(left, right) {
  return [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
export function compareSnapshots(source, target) {
  const tables = names(source.tables, target.tables).map(name => {
    const left = source.tables.get(name), right = target.tables.get(name);
    return { name, source_count: left?.count ?? null, target_count: right?.count ?? null,
      source_fingerprint: left?.fingerprint ?? null, target_fingerprint: right?.fingerprint ?? null,
      columns_equal: Boolean(left && right && hash(left.columns) === hash(right.columns)),
      counts_equal: Boolean(left && right && left.count === right.count),
      fingerprints_equal: Boolean(left && right && left.fingerprint === right.fingerprint) };
  });
  const sequences = names(source.sequences, target.sequences).map(name => {
    const left = source.sequences.get(name), right = target.sequences.get(name);
    return { name, source_fingerprint: left ? hash([left.last_value, left.is_called]) : null,
      target_fingerprint: right ? hash([right.last_value, right.is_called]) : null,
      last_value_equal: Boolean(left && right && left.last_value === right.last_value),
      is_called_equal: Boolean(left && right && left.is_called === right.is_called) };
  });
  return { tables, sequences, passed: tables.every(t => t.columns_equal && t.counts_equal && t.fingerprints_equal) &&
    sequences.every(s => s.last_value_equal && s.is_called_equal) };
}

function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

export function targetSettings(env = process.env) {
  const remoteHost = requiredEnv('AGENT_LINK_SSH_HOST', env);
  const expectedPort = requiredEnv('AGENT_LINK_SOURCE_DB_PORT', env);
  const expectedHostname = requiredEnv('AGENT_LINK_EXPECTED_HOSTNAME', env);
  require(/^(?:[A-Za-z_][A-Za-z0-9_-]*@)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(remoteHost),
    'Explicit SSH [user@]hostname required; options and shell syntax are forbidden');
  require(/^[1-9][0-9]{0,4}$/.test(expectedPort) && Number(expectedPort) <= 65535,
    'Explicit valid source database port required');
  require(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(expectedHostname),
    'Explicit approved short DNS hostname required');
  return {remoteHost, expectedPort, expectedHostname};
}

async function main() {
  process.umask(0o077);
  const options = parseArguments(process.argv.slice(2));
  const runtime = runtimeDir();
  const sourceDSN = `${runtime}/secrets/agentlink-dsn`;
  const pgRoot = `${runtime}/pgsql/usr`;
  const knownHosts = requiredPath('AGENT_LINK_KNOWN_HOSTS');
  const {remoteHost, expectedPort, expectedHostname} = targetSettings();
  await privateRegular(sourceDSN, 'Source DSN');
  await privateRegular(knownHosts, 'Known-hosts file', false);
  const dsn = new URL((await readFile(sourceDSN, 'utf8')).trim());
  require(dsn.protocol === 'postgresql:' && dsn.hostname === '127.0.0.1' && dsn.port === expectedPort &&
    dsn.pathname === '/agentlink', 'Refusing unexpected source database endpoint');
  const localEnvironment = { PATH: '/usr/bin:/bin', LC_ALL: 'C',
    LD_LIBRARY_PATH: `${pgRoot}/lib/x86_64-linux-gnu`, PGPASSWORD: decodeURIComponent(dsn.password),
    PGCONNECT_TIMEOUT: '10', PGOPTIONS: '-c default_transaction_read_only=on' };
  const sourceArgs = ['-X', '-qAt', '--no-password', '--host', dsn.hostname, '--port', dsn.port,
    '--username', decodeURIComponent(dsn.username), '--dbname', 'agentlink', '--set', 'ON_ERROR_STOP=1'];
  // The only remote operation is read-only validation + psql, gated inside the
  // explicitly named CT. This never provisions, migrates, seeds or edits a host.
  const guard = `set -eu
test "$(hostname -s)" = ${shellQuote(expectedHostname)}
test "$(systemd-detect-virt --container)" = lxc
test -f /etc/agent-link-lxc-target
test ! -L /etc/agent-link-lxc-target
test "$(stat -c '%u:%g:%a' /etc/agent-link-lxc-target)" = '0:0:600'
test "$(cat /etc/agent-link-lxc-target)" = agent-link-lxc-v1
exec runuser -u postgres -- env -i PATH=/usr/bin:/bin LC_ALL=C PGCONNECT_TIMEOUT=10 PGOPTIONS='-c default_transaction_read_only=on' psql -X -qAt --no-password --host=/var/run/postgresql --port=5432 --username=postgres --dbname=${options.targetDB} --set=ON_ERROR_STOP=1`;
  const command = `pct exec ${options.vmid} -- /bin/sh -c ${shellQuote(guard)}`;
  const remoteArgs = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'UpdateHostKeys=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'ConnectTimeout=10', '-o', 'ClearAllForwardings=yes', remoteHost, command];
  const startedAt = new Date().toISOString();
  const [localOutput, remoteOutput] = await Promise.all([
    run(`${pgRoot}/lib/postgresql/14/bin/psql`, sourceArgs, localEnvironment, 'Source read-only fingerprint'),
    run('/usr/bin/ssh', remoteArgs, process.env, 'Target marker/hostname/read-only fingerprint')]);
  const source = parseSnapshot(localOutput, 'agentlink', 'Source');
  const target = parseSnapshot(remoteOutput, options.targetDB, 'Target');
  const report = { started_at: startedAt, finished_at: new Date().toISOString(), read_only: true,
    source_database: 'agentlink', source_version_num: source.metadata.server_version_num,
    target_host: remoteHost, target_vmid: options.vmid, target_hostname_verified: expectedHostname,
    target_marker_verified: true, target_database: options.targetDB,
    target_version_num: target.metadata.server_version_num,
    algorithm: 'typed-json-tree-utf8-hex-numeric-trim-scale-sha256-multiset-v1',
    caveat: 'Independent read-only snapshots, not replication. Quiesce source writers for final cutover; sequence state is not MVCC.',
    ...compareSnapshots(source, target) };
  const evidenceDir = `${runtime}/evidence`;
  const info = await lstat(evidenceDir);
  require(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o002) === 0,
    'Evidence directory must already exist as a non-world-writable, non-symlink directory');
  const evidence = `${evidenceDir}/lxc-migration-${options.vmid}-${options.targetDB}-${startedAt.replace(/[:.]/g, '-')}.json`;
  await writeFile(evidence, JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW });
  console.log(JSON.stringify({ ...report, evidence }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Raw subprocess errors, connection strings and SQL diagnostics stay private.
    console.error('Migration comparison failed before complete evidence; no database or service changes were made. Check arguments, strict host trust, target marker, hostname and database readiness.');
    process.exitCode = 1;
  });
}
