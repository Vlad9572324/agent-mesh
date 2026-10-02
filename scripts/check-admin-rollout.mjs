// Read-only before/after evidence: existing identities, ACLs and history survive.
import { readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { certificateFile, runtimeDir, serviceOrigin } from './operator-config.mjs';

process.umask(0o077);
const runtime = runtimeDir();
const base = serviceOrigin();
const ca = await readFile(certificateFile());
const evidence = `${runtime}/evidence/pre-admin-state.json`;
const mode = process.argv[2];
if (!['before', 'after'].includes(mode)) throw new Error('Usage: check-admin-rollout.mjs before|after');
function get(path, key) {
  return new Promise((resolve, reject) => {
    const req = https.get(base + path, { ca, headers: { Authorization: `Bearer ${key}` }, timeout: 10000 }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch { reject(new Error('Non-JSON API response')); } });
    });
    req.on('error', () => reject(new Error('HTTPS API unavailable'))); req.on('timeout', () => req.destroy());
  });
}
const snapshots = {};
for (const id of ['claude-pilot', 'codex-pilot', 'viewer-pilot', 'deny-pilot']) {
  const key = (await readFile(`${runtime}/secrets/${id}.key`, 'utf8')).trim();
  const identity = await get('/v1/me', key); const projects = await get('/v1/projects', key);
  if (identity.status !== 200 || identity.body.agent.id !== id || projects.status !== 200) throw new Error('Existing identity no longer works');
  const content = { identity: identity.body, projects: projects.body, scopes: [] };
  for (const project of projects.body.projects) {
    const channels = await get(`/v1/projects/${encodeURIComponent(project.id)}/channels`, key);
    const notes = await get(`/v1/projects/${encodeURIComponent(project.id)}/notes`, key);
    if (channels.status !== 200 || notes.status !== 200) throw new Error('Existing project access changed');
    const scope = { channels: channels.body, notes: notes.body, histories: [] };
    for (const channel of channels.body.channels) {
      const messages = []; let after = 0;
      for (;;) {
        const page = await get(`/v1/channels/${encodeURIComponent(channel.id)}/messages?after_seq=${after}&limit=100`, key);
        if (page.status !== 200) throw new Error('Existing channel access changed');
        messages.push(...page.body.messages);
        if (page.body.messages.length < 100) break;
        after = page.body.messages.at(-1).seq;
      }
      scope.histories.push({ channel_id: channel.id, messages });
    }
    content.scopes.push(scope);
  }
  snapshots[id] = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  if (mode === 'after' && (await get('/v1/admin/overview', key)).status !== 403) throw new Error('Ordinary principal gained admin access');
}
if (mode === 'before') {
  await writeFile(evidence, JSON.stringify(snapshots, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Existing four identities, access and history fingerprinted privately.');
} else {
  const previous = JSON.parse(await readFile(evidence, 'utf8'));
  if (JSON.stringify(previous) !== JSON.stringify(snapshots)) throw new Error('Existing identity/access/history changed; inspect rollout before continuing');
  const credentials = JSON.parse(await readFile(`${runtime}/secrets/owner-pilot.json`, 'utf8'));
  const me = await get('/v1/me', credentials.key); const overview = await get('/v1/admin/overview', credentials.key);
  if (me.status !== 200 || me.body.agent.kind !== 'owner' || overview.status !== 200) throw new Error('Owner provisioning failed');
  const report = { passed: true, checked_at: new Date().toISOString(), existing_principals: 4,
    old_keys_access_and_history_unchanged: true, ordinary_admin_access_denied: true,
    owner_identity: me.body.agent.id, owner_admin_access: true,
    projects: overview.body.projects.length, principals: overview.body.principals.length };
  await writeFile(`${runtime}/evidence/admin-rollout.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
