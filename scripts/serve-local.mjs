import { readFile, writeFile, open, mkdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import https from 'node:https';
import { runtimeDir, repositoryRoot, serviceOrigin, certificateFile, requiredEnv } from './operator-config.mjs';
import { isIP } from 'node:net';
import { readOwnedProcess, processIdentity, acquireLifecycleLock } from './local-process-owner.mjs';

const root = repositoryRoot;
const runtime = runtimeDir();
const binary = `${root}/bin/agent-link`;
const metadata = `${runtime}/server-process.json`;
const address = requiredEnv('AGENT_LINK_BIND_IP');
if (isIP(address) !== 4) throw new Error('AGENT_LINK_BIND_IP must be an explicit IPv4 address');
const origin = new URL(serviceOrigin());
if (origin.hostname !== address) throw new Error('AGENT_LINK_ORIGIN must name the explicit bind IP for this local helper');
const port = Number(origin.port || '443');
const caFile = certificateFile();
async function readOwner() {
  return readOwnedProcess(metadata, {binary, address, port, releases: `${runtime}/releases`,
    dsn: `${runtime}/secrets/agentlink-dsn`, cert: `${runtime}/secrets/server.crt`, key: `${runtime}/secrets/server.key`});
}
async function healthy() {
  const ca = await readFile(caFile);
  return new Promise(resolve => {
    const request = https.get(new URL('/healthz', origin), { ca, timeout: 1500 }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => request.destroy());
  });
}
const command = process.argv[2];
if (!['start', 'stop', 'status'].includes(command)) throw new Error('Usage: node scripts/serve-local.mjs start|stop|status');
const unlock = command === 'status' ? null : await acquireLifecycleLock(`${runtime}/local-server-operation.lock`);
try {
if (command === 'start') {
  // A migrated pilot must not accidentally reappear as a second writable node.
  let deployed, migrated = false;
  try { deployed = JSON.parse(await readFile(`${runtime}/deployed-lxc.json`, 'utf8')); migrated = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (migrated) throw new Error(`Pilot migrated to ${deployed?.url || 'the dedicated LXC'}; local start is fenced. Restore authoritative data and deliberately retire deployed-lxc.json before a rollback.`);
  const existing = await readOwner();
  if (existing) {
    if (!(await healthy())) throw new Error('Owned server exists but is not healthy; inspect private log');
    console.log(JSON.stringify({ status: 'already running', pid: existing.pid, url: origin.href }));
  } else {
    // Serve a frozen asset set: ongoing source edits must not partially alter the
    // running GUI. A new verified start is the explicit rollout boundary.
    const releases = `${runtime}/releases`;
    await mkdir(releases, { recursive: true, mode: 0o700 });
    const webDir = `${releases}/${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await mkdir(webDir, { mode: 0o700 });
    for (const file of ['index.html', 'app.js', 'app.css']) {
      await copyFile(`${root}/web/${file}`, `${webDir}/${file}`, constants.COPYFILE_EXCL);
    }
    const log = await open(`${runtime}/server.log`, 'a', 0o600);
    const args = ['serve', '--database-url-file', `${runtime}/secrets/agentlink-dsn`, '--listen', `${address}:${port}`, '--tls-cert', `${runtime}/secrets/server.crt`, '--tls-key', `${runtime}/secrets/server.key`, '--web-dir', webDir];
    const child = spawn(binary, args, { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    await log.close();
    try {
      const identity = await processIdentity(child.pid);
      const owner = { pid: child.pid, start_ticks: identity.startTicks, binary, address, port,
        web_dir: webDir, started_at: new Date().toISOString(), autostart: false };
      await writeFile(metadata, JSON.stringify(owner, null, 2) + '\n', { mode: 0o600 });
    } catch {
      child.kill('SIGTERM');
      throw new Error('Could not record owned process identity; the new child was signalled to stop');
    }
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const before = await readOwner();
      if (!before || before.pid !== child.pid || child.exitCode !== null) throw new Error('Pilot process exited; inspect private server.log');
      if (await healthy()) {
        const after = await readOwner();
        if (!after || after.pid !== child.pid || child.exitCode !== null) throw new Error('Owned process exited during readiness; no running state claimed');
        ready = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error('Pilot failed readiness; process metadata retained for inspection');
    console.log(JSON.stringify({ status: 'running', pid: child.pid, url: origin.href, certificate_verified: true }));
  }
} else if (command === 'stop') {
  const owner = await readOwner();
  if (!owner) console.log('No matching owned pilot process; nothing stopped.');
  else {
    process.kill(owner.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 60 && await readOwner(); attempt++) await new Promise(resolve => setTimeout(resolve, 200));
    if (await readOwner()) throw new Error('Owned process did not stop gracefully; no unrelated process killed');
    console.log('Owned pilot server stopped; database and demo left running.');
  }
} else if (command === 'status') {
  const owner = await readOwner();
  console.log(JSON.stringify({ owned_process: owner, healthy: await healthy() }));
}
} finally { if (unlock) await unlock(); }
