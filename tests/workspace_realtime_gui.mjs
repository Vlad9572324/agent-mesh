// Real, owned Chromium acceptance for authenticated workspace live updates.
// Root must prepare the isolated agentlink_e2e HTTPS staging server first.
// Only run-prefixed fixtures are mutated; no live-LXC or model calls are allowed.
import { readFile, writeFile, mkdtemp, rm, open, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash, X509Certificate } from 'node:crypto';
import https from 'node:https';
import {runtimeDir, certificateFile, browserExecutable} from '../scripts/operator-config.mjs';

process.umask(0o077);
const runtime = runtimeDir(), chrome = browserExecutable();
const base = process.env.AGENT_LINK_GUI_BASE || 'https://127.0.0.1:18769/';
const origin = new URL(base);
if (origin.protocol !== 'https:' || origin.hostname !== '127.0.0.1' || origin.port !== '18769' ||
    origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
  throw new Error('This test only permits the dedicated https://127.0.0.1:18769/ E2E staging origin');
}
const caFile = certificateFile();
const ownerFile = process.env.AGENT_LINK_GUI_OWNER_FILE || `${runtime}/secrets/admin-e2e-owner.json`;
const seedFile = `${runtime}/secrets/e2e-credentials.json`;
const ca = await readFile(caFile);
const ownerInfo = await lstat(ownerFile);
if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || (ownerInfo.mode & 0o077)) throw new Error('Owner fixture file must be private and regular');
const ownerCredentials = JSON.parse(await readFile(ownerFile, 'utf8'));
if (ownerCredentials.agent_id !== 'admin-e2e-owner') throw new Error('Only the isolated E2E owner is permitted');
const ownerKey = ownerCredentials.key;
const initialSeedDigest = createHash('sha256').update(await readFile(seedFile)).digest('hex');
const run = `workspace-gui-${randomUUID().slice(0, 8)}`;
const ids = Object.fromEntries(['project', 'channel', 'extra-channel', 'new-project', 'hidden-project',
  'hidden-channel', 'hidden-extra', 'writer', 'peer', 'viewer', 'new-principal', 'logout-project'].map(k => [k, `${run}-${k}`]));
const names = Object.fromEntries(Object.keys(ids).map(k => [k, `Fixture ${ids[k]}`]));
const report = { run, base_url: base, started_at: new Date().toISOString(), cases: [], latencies: [],
  browser_errors: [], scope: 'Dedicated isolated staging, run-prefixed API fixtures, owned Chromium; no models',
  visible_update_deadline_ms: 4000 };
const keys = { owner: ownerKey }, secrets = new Set([ownerKey]), created = new Set();
const tabs = [];
let browser, profile, browserLog, browserCDP, owner, writer, viewer, initialMessage;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const js = value => JSON.stringify(value);
function redacted(error) {
  let text = String(error?.message || error);
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text.slice(0, 500);
}
async function check(name, action) {
  const start = performance.now();
  try { await action(); report.cases.push({ name, passed: true, milliseconds: Math.round(performance.now() - start) }); }
  catch (error) {
    report.cases.push({ name, passed: false, error: redacted(error), milliseconds: Math.round(performance.now() - start) });
    throw error;
  } finally { console.log(JSON.stringify(report.cases.at(-1))); }
}
function api(path, method = 'GET', body, actor = 'owner') {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(new URL(path, base), { ca, method, timeout: 10000,
      headers: { Authorization: `Bearer ${keys[actor]}`, ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { reject(new Error('Staging API returned invalid JSON')); }
      });
    });
    req.on('error', () => reject(new Error('Certificate-verified isolated HTTPS request failed')));
    req.on('timeout', () => req.destroy()); req.end(payload);
  });
}
async function assetFingerprint(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(new URL(path, base), { ca, timeout: 10000 }, res => {
      const hash = createHash('sha256');
      res.on('data', chunk => hash.update(chunk));
      res.on('end', () => res.statusCode === 200 ? resolve(hash.digest('hex')) : reject(new Error('Staging asset unavailable')));
    });
    req.on('error', () => reject(new Error('Staging asset verification failed')));
    req.on('timeout', () => req.destroy());
  });
}
async function success(path, method = 'GET', body, actor = 'owner', expected = 200) {
  const response = await api(path, method, body, actor);
  assert(response.status === expected, `Fixture ${method} ${path.split('?')[0]} returned ${response.status}, expected ${expected}`);
  return response.data;
}
async function access(actor, scope, resource, level) {
  return success('/v1/admin/access', 'PUT', { agent_id: ids[actor], scope, resource_id: ids[resource], access: level });
}
async function createProject(key) {
  return success('/v1/admin/projects', 'POST', { id: ids[key], name: names[key] }, 'owner', 201);
}
async function createChannel(key, project) {
  return success('/v1/admin/channels', 'POST', { id: ids[key], project_id: ids[project], name: names[key] }, 'owner', 201);
}
async function post(label, channel = 'channel', recipients = ['writer']) {
  return (await success(`/v1/channels/${ids[channel]}/messages`, 'POST', {
    client_id: `${run}-${label}`, body: `Live message ${run}/${label}`, recipient_ids: recipients.map(key => ids[key]),
  }, 'peer', 201)).message;
}
async function note(label, project = 'project') {
  return (await success(`/v1/projects/${ids[project]}/notes`, 'POST', {
    client_id: `${run}-${label}`, title: `Live note ${run}/${label}`, body: `Published fixture ${run}/${label}`,
  }, 'peer', 201)).note;
}

class CDP {
  constructor(url, name) {
    this.name = name; this.socket = new WebSocket(url); this.serial = 0; this.pending = new Map();
    this.requests = []; this.active = new Map(); this.workspaceStarts = 0; this.workspaceEnds = 0;
    this.ready = new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = () => reject(new Error('Owned browser CDP unavailable')); });
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const task = this.pending.get(message.id); clearTimeout(task.timer); this.pending.delete(message.id);
        message.error ? task.reject(new Error(`Owned browser command failed: ${task.method}`)) : task.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') report.browser_errors.push({ tab: name, text: message.params.exceptionDetails.text });
      if (message.method === 'Page.javascriptDialogOpening') void this.call('Page.handleJavaScriptDialog', { accept: false });
      if (message.method === 'Network.requestWillBeSent') {
        const request = message.params.request, url = new URL(request.url);
        if (url.origin !== origin.origin) return;
        const metadata = { method: request.method, path: url.pathname, started_at: Date.now() };
        this.requests.push(metadata); this.active.set(message.params.requestId, metadata);
        if (metadata.path === '/v1/workspace/stream') this.workspaceStarts++;
      }
      if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) {
        if (this.active.get(message.params.requestId)?.path === '/v1/workspace/stream') this.workspaceEnds++;
        this.active.delete(message.params.requestId);
      }
    };
  }
  async call(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Owned browser timeout: ${method}`)); }, 12000);
      this.pending.set(id, { method, resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed in ${this.name}; expression omitted`);
    return result.result.value;
  }
  async wait(expression, label, timeout = 4000) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      if (typeof expression === 'function' ? await expression() : await this.evaluate(expression)) return Math.round(performance.now() - start);
      await pause(60);
    }
    throw new Error(`${this.name}: ${label} not visible within ${timeout}ms without refresh/relogin`);
  }
  async visible(expression, label, timeout = 4000) {
    const milliseconds = await this.wait(expression, label, timeout);
    report.latencies.push({ tab: this.name, change: label, milliseconds, deadline_ms: timeout });
  }
  async fill(id, value) {
    await this.evaluate(`(()=>{const e=document.getElementById(${js(id)});e.value=${js(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  async click(id) { await this.evaluate(`document.getElementById(${js(id)}).click()`); }
  streaming() { return [...this.active.values()].some(request => request.path === '/v1/workspace/stream'); }
  close() { this.socket.close(); }
}

async function startBrowser() {
  profile = await mkdtemp(join(tmpdir(), 'agent-link-workspace-gui-'));
  browserLog = await open(`${runtime}/evidence/${run}-browser.log`, 'wx', 0o600);
  const certificate = new X509Certificate(ca);
  const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${spki}`, 'about:blank'],
    { stdio: ['ignore', browserLog.fd, browserLog.fd] });
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert(browser.exitCode === null, 'Owned Chromium exited during startup');
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
    await pause(100);
  }
  assert(Number.isInteger(port) && port > 0, 'Owned Chromium readiness timeout');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  browserCDP = new CDP(version.webSocketDebuggerUrl, 'browser'); await browserCDP.ready;
  async function tab(name) {
    const createdTarget = await browserCDP.call('Target.createTarget', { url: 'about:blank', background: false });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(item => item.id === createdTarget.targetId);
    assert(target, 'Owned browser target not found');
    const client = new CDP(target.webSocketDebuggerUrl, name); tabs.push(client); await client.ready;
    await client.call('Runtime.enable'); await client.call('Page.enable'); await client.call('Network.enable');
    // Chromium's offline emulation does not reliably kill an established SSE socket.
    // This test-only wrapper can cancel the real fetch transport without calling app internals.
    await client.call('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const originalFetch=window.fetch.bind(window);let workspaceTransport;
      window.fetch=(input,init)=>{
        const url=new URL(typeof input==='string'?input:input.url,location.href);
        if(url.pathname!=='/v1/workspace/stream')return originalFetch(input,init);
        workspaceTransport=new AbortController();
        const signal=init?.signal?AbortSignal.any([init.signal,workspaceTransport.signal]):workspaceTransport.signal;
        return originalFetch(input,{...init,signal});
      };
      Object.defineProperty(window,'__testCutWorkspaceTransport',{value:()=>workspaceTransport?.abort()});
    })();` });
    await client.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await client.call('Page.navigate', { url: new URL('?lang=ru', base).href });
    await client.wait(`document.readyState==='complete' && !!document.getElementById('login-form')`, 'initial page', 12000);
    return client;
  }
  owner = await tab('owner'); writer = await tab('writer'); viewer = await tab('viewer');
}

async function login(tab, actor) {
  await tab.fill('api-key', keys[actor]); await tab.evaluate(`document.getElementById('login-form').requestSubmit()`);
  await tab.wait(`document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled`, 'login ready', 12000);
}
const textIncludes = (id, value) => `document.getElementById(${js(id)}).textContent.includes(${js(value)})`;
const projectVisible = key => `Array.from(document.querySelectorAll('#project-switcher button')).some(b=>b.textContent===${js(names[key])})`;
const projectSelected = () => `document.getElementById('project-name').textContent===${js(names.project)}`;
const selectedChannel = () => `document.getElementById('current-channel').textContent===${js(names.channel)}`;
async function selectFixture(tab) {
  await tab.evaluate(`Array.from(document.querySelectorAll('#project-switcher button')).find(b=>b.textContent===${js(names.project)}).click()`);
  await tab.wait(projectSelected(), 'selected fixture project');
  await tab.wait(`!!document.querySelector('#channel-list [data-focus-key="channel:${ids.channel}"]') && !document.getElementById('refresh-button').disabled`, 'overview ready');
  await tab.evaluate(`document.querySelector('#channel-list [data-focus-key="channel:${ids.channel}"]').click()`);
  await tab.wait(selectedChannel(), 'selected fixture channel');
  await tab.wait(`!document.getElementById('refresh-button').disabled`, 'selection data ready');
}

async function setup() {
  report.asset_sha256 = Object.fromEntries(await Promise.all(['/', '/app.js', '/app.css'].map(async path => [path, await assetFingerprint(path)])));
  assert((await success('/v1/me')).agent.id === 'admin-e2e-owner', 'Staging owner identity mismatch');
  for (const actor of ['writer', 'peer', 'viewer']) {
    await success('/v1/admin/principals', 'POST', { id: ids[actor], name: names[actor], kind: actor === 'viewer' ? 'viewer' : 'agent', runtime: 'browser-test-no-model' }, 'owner', 201);
    created.add(actor);
    keys[actor] = (await success(`/v1/admin/principals/${ids[actor]}/rotate-key`, 'POST', {})).key;
    secrets.add(keys[actor]);
  }
  await createProject('project'); await createChannel('channel', 'project');
  await createProject('hidden-project'); await createChannel('hidden-channel', 'hidden-project');
  for (const actor of ['writer', 'peer']) { await access(actor, 'project', 'project', 'write'); await access(actor, 'channel', 'channel', 'write'); }
  await access('peer', 'project', 'hidden-project', 'write'); await access('peer', 'channel', 'hidden-channel', 'write');
  initialMessage = await post('initial');
  await startBrowser();
}

let adminDraft, messageDraft;
async function captureAdminDraft() {
  return owner.evaluate(`Object.fromEntries(['admin-principal-id','admin-principal-name','admin-principal-kind','admin-principal-runtime','admin-channel-project','admin-access-agent','admin-access-project','admin-access-scope','admin-access-channel','admin-access-level'].map(id=>[id,document.getElementById(id).value]))`);
}
async function preserveAdminDraft() {
  assert(JSON.stringify(await captureAdminDraft()) === JSON.stringify(adminDraft), 'External update reset an unsaved owner form or ACL selection');
  assert(await owner.evaluate(`!document.getElementById('admin-panel').hidden`), 'External update changed the selected admin view');
}
async function captureMessageDraft() {
  return writer.evaluate(`({body:document.getElementById('message-input').value,reply:document.getElementById('reply-to').value,recipients:Array.from(document.querySelectorAll('#recipient-list input:checked')).map(e=>e.value).sort()})`);
}
async function preserveMessageDraft() {
  assert(JSON.stringify(await captureMessageDraft()) === JSON.stringify(messageDraft), 'External update reset message body, reply target or recipients');
  assert(await writer.evaluate(`${projectSelected()} && ${selectedChannel()}`), 'External update replaced the selected project/channel');
}
async function preserveNoteDraft() {
  assert(await writer.evaluate(`document.getElementById('note-dialog').open && document.getElementById('note-title').value===${js(run + ' unsaved title')} && document.getElementById('note-body').value===${js(run + ' unsaved note body')} && !document.getElementById('notes-panel').hidden && ${projectSelected()}`), 'External update reset the open note draft or selected notes view');
}

try {
  await check('isolated fixtures and certificate-pinned owned three-tab browser', setup);
  await check('workspace stream stays authenticated in admin, chat and zero-project views', async () => {
    await login(owner, 'owner'); await owner.click('nav-admin');
    await owner.wait(textIncludes('admin-principal-list', ids.writer), 'owner inventory');
    await login(writer, 'writer'); await selectFixture(writer);
    await login(viewer, 'viewer');
    assert(await viewer.evaluate(`document.querySelectorAll('#project-switcher button').length===0 && document.getElementById('login-panel').hidden`), 'Viewer fixture unexpectedly has a project');
    for (const tab of tabs) await tab.wait(() => tab.streaming(), 'authenticated workspace stream');
    await owner.fill('admin-principal-id', `${run}-unsaved`); await owner.fill('admin-principal-name', 'Unsaved owner account');
    await owner.fill('admin-principal-kind', 'viewer'); await owner.fill('admin-principal-runtime', 'unsaved-runtime');
    await owner.fill('admin-channel-project', ids.project); await owner.fill('admin-access-agent', ids.peer);
    await owner.fill('admin-access-project', ids.project); await owner.fill('admin-access-scope', 'channel');
    await owner.fill('admin-access-channel', ids.channel); await owner.fill('admin-access-level', 'read');
    adminDraft = await captureAdminDraft();
    await writer.fill('message-input', `${run} unsent message`); await writer.fill('reply-to', initialMessage.id);
    await writer.evaluate(`(()=>{const e=document.querySelector('#recipient-list input[value="${ids.peer}"]');if(e)e.checked=true;document.getElementById('message-input').focus();document.getElementById('message-input').setSelectionRange(2,5);})()`);
    messageDraft = await captureMessageDraft();
  });
  await check('external project creation appears live in owner navigation and inventory, preserving admin drafts', async () => {
    await createProject('new-project');
    await owner.visible(`${projectVisible('new-project')} && ${textIncludes('admin-project-list', ids['new-project'])}`, 'new project in navigation and admin');
    await preserveAdminDraft();
    assert(await writer.evaluate(`!(${projectVisible('new-project')})`), 'Unassigned project leaked to ordinary navigation');
  });
  await check('external channel creation/grant appears live without replacing selection or message draft', async () => {
    await createChannel('extra-channel', 'project'); await access('writer', 'channel', 'extra-channel', 'write');
    await writer.visible(textIncludes('channel-list', names['extra-channel']), 'new permitted channel');
    await preserveMessageDraft(); await preserveAdminDraft();
    assert(await writer.evaluate(`document.activeElement.id==='message-input' && document.getElementById('message-input').selectionStart===2 && document.getElementById('message-input').selectionEnd===5`), 'Live channel update stole typing focus or caret');
  });
  await check('viewer with zero projects receives grants live without refreshing or logging in again', async () => {
    const loginRequests = viewer.requests.filter(r => r.path === '/v1/me').length;
    await access('viewer', 'project', 'project', 'read'); await access('viewer', 'channel', 'channel', 'read');
    await viewer.visible(`${projectVisible('project')} && ${textIncludes('channel-list', names.channel)} && document.getElementById('login-panel').hidden`, 'first project/channel grant');
    assert(viewer.requests.filter(r => r.path === '/v1/me').length === loginRequests, 'Grant required reauthentication');
    await preserveMessageDraft();
  });
  await check('peer message arrives live while writer keeps unsent body, recipients and reply target', async () => {
    const message = await post('incoming');
    await writer.visible(textIncludes('message-list', message.body), 'peer message');
    await viewer.visible(textIncludes('message-list', message.body), 'viewer peer message');
    await preserveMessageDraft();
  });
  await check('peer heartbeat appears live in channel participants and owner inventory', async () => {
    const activity = `${run} live heartbeat activity`;
    await success('/v1/heartbeat', 'POST', { session_id: `${run}-session`, activity, runtime: 'browser-test-no-model' }, 'peer');
    await writer.visible(textIncludes('agent-list', activity), 'peer heartbeat');
    await owner.visible(textIncludes('admin-principal-list', activity), 'owner heartbeat inventory');
    await preserveMessageDraft(); await preserveAdminDraft();
  });
  await check('nonselected channel shows live activity and clears its badge only when viewed', async () => {
    await access('peer', 'channel', 'extra-channel', 'write');
    const incoming = await post('other-channel-incoming', 'extra-channel');
    const extraButton = `document.querySelector('[data-focus-key="channel:${ids['extra-channel']}"]')`;
    await writer.visible(`${extraButton}?.dataset.updated==='true' && ${extraButton}.textContent.includes('есть обновления')`, 'nonselected channel activity badge');
    await preserveMessageDraft();
    await writer.evaluate(`${extraButton}.click()`);
    await writer.wait(`${textIncludes('message-list', incoming.body)} && ${extraButton}?.dataset.updated==='false'`, 'viewed channel clears activity badge');
    await writer.evaluate(`document.querySelector('[data-focus-key="channel:${ids.channel}"]').click()`);
    await writer.wait(selectedChannel(), 'return to selected fixture channel');
  });
  await check('project note appears live while an unsaved note dialog and selected notes view stay intact', async () => {
    await writer.wait(`!document.getElementById('nav-notes').disabled`, 'channel navigation settled');
    await writer.click('nav-notes'); await writer.wait(`!document.getElementById('notes-panel').hidden && !document.getElementById('new-note-button').hidden && !document.getElementById('refresh-button').disabled`, 'notes ready');
    await writer.click('new-note-button'); await writer.fill('note-title', `${run} unsaved title`); await writer.fill('note-body', `${run} unsaved note body`);
    await writer.evaluate(`document.getElementById('note-body').focus();document.getElementById('note-body').setSelectionRange(3,7)`);
    const published = await note('external-note');
    await writer.visible(textIncludes('memory-list', published.title), 'published project note');
    await preserveNoteDraft();
    assert(await writer.evaluate(`document.activeElement.id==='note-body' && document.getElementById('note-body').selectionStart===3 && document.getElementById('note-body').selectionEnd===7`), 'Note update stole draft focus or caret');
  });
  await check('external principal and audit record appear live while owner administration form remains unsaved', async () => {
    await success('/v1/admin/principals', 'POST', { id: ids['new-principal'], name: names['new-principal'], kind: 'viewer', runtime: 'not-started' }, 'owner', 201);
    await owner.visible(`${textIncludes('admin-principal-list', ids['new-principal'])} && ${textIncludes('admin-audit-list', ids['new-principal'])}`, 'principal inventory and audit');
    await preserveAdminDraft(); await preserveNoteDraft();
    // The authenticated notes view contains only this run's fixtures; hide key widgets defensively.
    await writer.evaluate(`document.getElementById('api-key').style.visibility='hidden'`);
    // DOM evaluation/focus does not activate a tab; capture the foreground surface.
    await writer.call('Page.bringToFront');
    const screenshot = await writer.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    report.success_screenshot = `${runtime}/evidence/${run}-live-notes-success.png`;
    await writeFile(report.success_screenshot, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
  });
  await check('unrelated project messages, notes and channel names never leak to ordinary tabs', async () => {
    await createChannel('hidden-extra', 'hidden-project');
    const hiddenMessage = await post('hidden-sentinel', 'hidden-channel', []);
    const hiddenNote = await note('hidden-note-sentinel', 'hidden-project');
    await owner.visible(`Array.from(document.getElementById('admin-channel-project').options).some(o=>o.value===${js(ids['hidden-project'])})`, 'owner still has complete allowed inventory');
    await pause(1200);
    for (const tab of [writer, viewer]) {
      assert(await tab.evaluate(`![${js(names['hidden-project'])},${js(names['hidden-extra'])},${js(hiddenMessage.body)},${js(hiddenNote.title)}].some(s=>document.body.innerText.includes(s))`), 'Private project contents leaked through live refresh');
    }
    assert((await api(`/v1/channels/${ids['hidden-channel']}/messages`, 'GET', undefined, 'writer')).status === 404, 'Ordinary key reads hidden channel');
    await preserveNoteDraft();
  });
  await check('workspace reconnect catches missed note publication without reload or loss of draft', async () => {
    const starts = writer.workspaceStarts;
    await writer.call('Network.setBlockedURLs', { urls: [`${origin.origin}/v1/workspace/stream`] });
    await writer.evaluate('window.__testCutWorkspaceTransport()');
    await writer.wait(() => !writer.streaming(), 'forced transport interruption');
    const missed = await note('offline-catchup');
    await writer.call('Network.setBlockedURLs', { urls: [] });
    await writer.visible(textIncludes('memory-list', missed.title), 'reconnected workspace catch-up', 5000);
    await writer.wait(() => writer.workspaceStarts > starts && writer.streaming(), 'new authenticated workspace connection after interruption');
    await preserveNoteDraft();
  });
  await check('ACL removal clears stale viewer content live and regrant works without reauthentication', async () => {
    await access('viewer', 'project', 'project', 'none');
    await viewer.visible(`!(${projectVisible('project')}) && !document.getElementById('message-list').textContent.includes(${js(run)}) && !document.getElementById('memory-list').textContent.includes(${js(run)}) && document.getElementById('login-panel').hidden`, 'access removal clears stale content');
    await access('viewer', 'project', 'project', 'read'); await access('viewer', 'channel', 'channel', 'read');
    await viewer.visible(`${projectVisible('project')} && ${textIncludes('message-list', `${run}/incoming`)}`, 'access regrant restores permitted history');
    await preserveNoteDraft();
  });
  await check('archive clears ordinary content and draft live; restore returns access without relogin', async () => {
    await success(`/v1/admin/projects/${ids.project}/archive`, 'POST', {});
    for (const tab of [writer, viewer]) await tab.visible(`!(${projectVisible('project')}) && !document.getElementById('message-list').textContent.includes(${js(run)}) && !document.getElementById('memory-list').textContent.includes(${js(run)}) && document.getElementById('login-panel').hidden`, 'archive clears ordinary content');
    assert(await writer.evaluate(`!document.getElementById('note-dialog').open && document.getElementById('note-body').value===''`), 'Archive left a publishable stale note draft');
    await owner.visible(`document.querySelector('[data-project-id="${ids.project}"] .admin-project-state')?.dataset.archived==='true'`, 'owner archive inventory');
    await success(`/v1/admin/projects/${ids.project}/restore`, 'POST', {});
    for (const tab of [writer, viewer]) await tab.visible(projectVisible('project'), 'restored project access');
    await writer.wait(`!document.getElementById('composer-form').hidden`, 'restored writer permission');
  });
  await check('idle viewer key revocation logs out and clears protected content without user action', async () => {
    await viewer.wait(textIncludes('message-list', `${run}/incoming`), 'restored viewer history before revocation');
    await success(`/v1/admin/principals/${ids.viewer}/revoke-key`, 'POST', {});
    await viewer.visible(`!document.getElementById('login-panel').hidden && document.getElementById('connected-workspace').hidden && document.getElementById('api-key').value==='' && document.getElementById('message-list').textContent==='' && document.getElementById('memory-list').textContent===''`, 'idle revoked key locks and clears workspace');
    await viewer.wait(() => !viewer.streaming(), 'revocation closes workspace stream');
    assert((await api('/v1/me', 'GET', undefined, 'viewer')).status === 401, 'Revoked fixture key remains valid');
    for (const tab of [writer, owner]) assert(await tab.evaluate(`document.getElementById('login-panel').hidden`), 'Revoking viewer unexpectedly logged out an independent actor');
  });
  await check('external hard deletion clears owner archived history without manual refresh', async () => {
    await success(`/v1/admin/projects/${ids.project}/archive`, 'POST', {});
    await owner.wait(`document.querySelector('[data-project-id="${ids.project}"] .admin-project-state')?.dataset.archived==='true'`, 'archived fixture card');
    await owner.evaluate(`document.querySelector('[data-project-action="history"][data-project-id="${ids.project}"]').click()`);
    await owner.wait(textIncludes('message-list', `${run}/incoming`), 'owner archived history');
    const preview = await success(`/v1/admin/projects/${ids.project}/deletion-preview`);
    await success(`/v1/admin/projects/${ids.project}`, 'DELETE', { confirm_id: ids.project, expected_version: preview.project.lifecycle_version });
    await owner.visible(`!document.getElementById('message-list').textContent.includes(${js(`${run}/incoming`)}) && !document.getElementById('memory-list').textContent.includes(${js(`${run}/external-note`)}) && !document.getElementById('archived-project-notice').textContent.includes(${js(ids.project)})`, 'deleted owner history cleared');
    assert((await api(`/v1/messages/${initialMessage.id}`)).status === 404, 'Fixture deletion did not remove server history');
  });
  await check('logout clears protected DOM and drafts, aborts all streams, and prevents background reconnects', async () => {
    for (const tab of tabs) {
      await tab.click('logout-button');
      await tab.wait(`!document.getElementById('login-panel').hidden && document.getElementById('connected-workspace').hidden && document.getElementById('api-key').value==='' && document.getElementById('message-list').textContent==='' && document.getElementById('memory-list').textContent==='' && document.getElementById('admin-principal-list').textContent==='' && localStorage.length===0 && sessionStorage.length===0`, 'logout clears protected state');
      await tab.wait(() => ![...tab.active.values()].some(r => r.path.startsWith('/v1/')), 'logout aborts API/stream requests');
    }
    const requestCounts = tabs.map(tab => tab.requests.filter(r => r.path.startsWith('/v1/')).length);
    await createProject('logout-project'); await pause(1600);
    assert(tabs.every((tab, index) => tab.requests.filter(r => r.path.startsWith('/v1/')).length === requestCounts[index]), 'Logged-out tab issued a background API request or reconnect');
    assert(report.browser_errors.length === 0, 'Browser runtime exceptions were observed');
    report.asset_sha256_unchanged = (await Promise.all(Object.entries(report.asset_sha256).map(async ([path, digest]) => (await assetFingerprint(path)) === digest))).every(Boolean);
    assert(report.asset_sha256_unchanged, 'Staging assets changed during browser acceptance');
  });
} catch (error) {
  if (!report.cases.some(item => !item.passed)) {
    const item = { name: 'suite infrastructure', passed: false, error: redacted(error) };
    report.cases.push(item); console.log(JSON.stringify(item));
  }
  report.failure_diagnostics = [];
  for (const tab of tabs) {
    try {
      const controls = await tab.evaluate(`Object.fromEntries(['login-panel','connected-workspace','nav-notes','new-note-button','refresh-button','notes-panel','note-dialog','admin-panel'].map(id=>{const e=document.getElementById(id);return[id,{hidden:e.hidden,disabled:e.disabled,open:e.open}]}))`);
      // Never screenshot credentials, including accidental secret echoes in a diagnostic error.
      await tab.evaluate(`(()=>{for(const e of document.querySelectorAll('input,textarea'))e.value='';for(const e of document.querySelectorAll('code,pre'))e.textContent='[redacted for failure evidence]';})()`);
      await tab.call('Page.bringToFront');
      const screenshot = await tab.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const screenshotPath = `${runtime}/evidence/${run}-${tab.name}-failure.png`;
      await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
      report.failure_diagnostics.push({ tab: tab.name, controls, screenshot: screenshotPath });
    } catch { report.failure_diagnostics.push({ tab: tab.name, diagnostics_unavailable: true }); }
  }
} finally {
  // Revoke only keys minted for this run. Never touch seed/owner credentials.
  for (const actor of created) {
    try { await api(`/v1/admin/principals/${ids[actor]}/revoke-key`, 'POST', {}); } catch {}
  }
  for (const tab of tabs) { try { await tab.click('logout-button'); } catch {} tab.close(); }
  if (browserCDP) { try { await browserCDP.call('Browser.close'); } catch {} browserCDP.close(); }
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(3000)]);
    if (browser.exitCode === null) {
      browser.kill('SIGKILL');
      await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(3000)]);
    }
  }
  if (browserLog) await browserLog.close();
  // Chromium descendants can finish profile IO shortly after the main process.
  // Never let a transient ENOTEMPTY discard all completed acceptance evidence.
  if (profile) {
    try {
      if (browser && browser.exitCode === null) throw new Error('owned browser exit unconfirmed');
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
      report.browser_profile_removed = true;
    } catch {
      report.browser_profile_removed = false;
      report.retained_browser_profile = profile;
      report.cases.push({ name: 'owned browser profile cleanup', passed: false, error: 'Private profile retained; inspect owned browser before cleanup' });
    }
  }
  const seedUnchanged = createHash('sha256').update(await readFile(seedFile)).digest('hex') === initialSeedDigest;
  report.existing_seed_credentials_unchanged = seedUnchanged;
  report.browser_transport = tabs.map(tab => ({ tab: tab.name, workspace_connections: tab.workspaceStarts, workspace_ends: tab.workspaceEnds,
    api_requests: tab.requests.filter(r => r.path.startsWith('/v1/')).length }));
  report.finished_at = new Date().toISOString();
  const orderedLatencies = report.latencies.map(item => item.milliseconds).sort((a, b) => a - b);
  const midpoint = Math.floor(orderedLatencies.length / 2);
  report.observation_summary = { samples: orderedLatencies.length, max_ms: orderedLatencies.at(-1),
    median_ms: orderedLatencies.length % 2 ? orderedLatencies[midpoint] : (orderedLatencies[midpoint - 1] + orderedLatencies[midpoint]) / 2 };
  report.passed = report.cases.length === 17 && report.cases.every(item => item.passed) && seedUnchanged;
  const output = `${runtime}/evidence/workspace-realtime-gui.json`;
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, report: output }));
}
if (!report.passed) process.exitCode = 1;
