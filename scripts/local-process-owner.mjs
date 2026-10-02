// Process ownership checks and an explicit local lifecycle lock. Never signal
// a process except signal 0; acquiring/releasing a lock writes only its own file.
import {readFile as fsReadFile, open, lstat, unlink} from 'node:fs/promises';
import {isAbsolute, relative, sep} from 'node:path';

export async function acquireLifecycleLock(path) {
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch { throw new Error('Local service operation is locked or cannot be fenced; inspect the private lock before retrying'); }
  const identity = await handle.stat();
  let closed = false;
  const release = async () => {
    if (closed) return;
    closed = true; await handle.close();
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error('Lifecycle lock was replaced; no replacement file was removed');
    }
    await unlink(path);
  };
  try { await handle.writeFile(JSON.stringify({pid: process.pid}) + '\n'); }
  catch (error) { await release(); throw error; }
  return release;
}

export async function processIdentity(pid, readFile = fsReadFile) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Invalid owned process identifier');
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(') ');
  const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/);
  if (!/^[0-9]+$/.test(fields[19] || '') || !/^[A-Za-z]$/.test(fields[0] || '')) throw new Error('Cannot establish process identity');
  return {state: fields[0], startTicks: fields[19]};
}

export async function readOwnedProcess(metadataPath, expected, {readFile = fsReadFile, probe = pid => process.kill(pid, 0)} = {}) {
  let owner;
  try { owner = JSON.parse(await readFile(metadataPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Process ownership record cannot be read; inspect it privately before proceeding');
  }
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 2) throw new Error('Invalid process ownership record');
  // A mismatching live PID is NOT absence. Never replace its record or signal it.
  try { probe(owner.pid); }
  catch (error) {
    if (error.code === 'ESRCH') return null;
    throw new Error('Recorded process liveness is uncertain; refusing operation');
  }
  let before, argv, after;
  try {
    before = await processIdentity(owner.pid, readFile);
    if (['Z', 'X'].includes(before.state)) return null;
    argv = (await readFile(`/proc/${owner.pid}/cmdline`, 'utf8')).split('\0');
    if (argv.at(-1) === '') argv.pop();
    after = await processIdentity(owner.pid, readFile);
  } catch {
    try { probe(owner.pid); } catch (error) { if (error.code === 'ESRCH') return null; }
    throw new Error('Recorded process identity is uncertain; refusing operation');
  }
  if (before.startTicks !== after.startTicks || owner.start_ticks !== before.startTicks) {
    throw new Error('Process identity changed or legacy ownership is incomplete; inspect without automatic adoption');
  }
  const web = owner.web_dir;
  const webRel = typeof web === 'string' ? relative(expected.releases, web) : '';
  if (owner.binary !== expected.binary || owner.address !== expected.address || owner.port !== expected.port ||
      typeof web !== 'string' || !isAbsolute(web) || !webRel || webRel === '..' || webRel.startsWith(`..${sep}`) || isAbsolute(webRel)) {
    throw new Error('Live process record belongs to another configuration; refusing operation');
  }
  const wanted = [expected.binary, 'serve', '--database-url-file', expected.dsn,
    '--listen', `${expected.address}:${expected.port}`, '--tls-cert', expected.cert,
    '--tls-key', expected.key, '--web-dir', web];
  if (argv.length !== wanted.length || argv.some((value, index) => value !== wanted[index])) {
    throw new Error('Live process arguments do not match this runtime; refusing operation');
  }
  return owner;
}
