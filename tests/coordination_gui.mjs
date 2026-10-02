// Dedicated loopback staging only. Creates run-prefixed fixtures and an owned
// Chromium; never launches a model, changes seed keys or uses production APIs.
// Coordinate exclusive use of agentlink_e2e with the parent before running.
import {readFile, writeFile, mkdtemp, rm, open, lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID, createHash, X509Certificate} from 'node:crypto';
import https from 'node:https';
import {runtimeDir, certificateFile, browserExecutable} from '../scripts/operator-config.mjs';

process.umask(0o077);
const runtime = runtimeDir(), chrome = browserExecutable(), caPath = certificateFile();
const base = process.env.AGENT_LINK_GUI_BASE || 'https://127.0.0.1:18769/';
if (base !== 'https://127.0.0.1:18769/') throw new Error('Only dedicated isolated E2E staging is permitted');
const ca = await readFile(caPath);
const ownerFile = `${runtime}/secrets/admin-e2e-owner.json`, ownerStat = await lstat(ownerFile);
if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.mode & 0o077) throw new Error('E2E owner fixture must be private and regular');
const credentials = JSON.parse(await readFile(ownerFile, 'utf8'));
if (credentials.agent_id !== 'admin-e2e-owner') throw new Error('Wrong owner fixture identity');
const seedPath = `${runtime}/secrets/e2e-credentials.json`;
const seedHash = createHash('sha256').update(await readFile(seedPath)).digest('hex');
const run = `coord-gui-${randomUUID().slice(0, 8)}`;
const ids = Object.fromEntries(['project', 'channel', 'private-channel', 'hidden-project', 'hidden-channel', 'writer', 'reviewer', 'viewer'].map(name => [name, `${run}-${name}`]));
const keys = {owner: credentials.key}, secrets = new Set([credentials.key]), created = new Set(), tabs = [];
const report = {run, base, started_at: new Date().toISOString(), cases: [], browser_errors: [], assets: {}, scope: 'Isolated E2E, run-prefixed data, no model/process controller calls'};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = JSON.stringify;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const textHas = (id, value) => `document.getElementById(${js(id)}).textContent.includes(${js(value)})`;
let browser, profile, log, browserCDP, port, writer, reviewer, viewer, owner, task, memory, refs;
function safeError(error) { let value = String(error.message || error); for (const key of secrets) value = value.replaceAll(key, '[REDACTED]'); return value.slice(0, 500); }
const browserStopped = () => !browser?.pid || browser.exitCode !== null || browser.signalCode !== null;
async function waitBrowserExit(timeout) {
  if (browserStopped()) return true;
  await new Promise(resolve => {
    let timer;
    const done = () => { clearTimeout(timer); browser.removeListener('exit', done); resolve(); };
    browser.once('exit', done); timer = setTimeout(done, timeout);
    if (browserStopped()) done();
  });
  return browserStopped();
}
async function check(name, action) {
  const start = performance.now();
  try { await action(); report.cases.push({name, passed: true, ms: Math.round(performance.now() - start)}); }
  catch (error) { report.cases.push({name, passed: false, error: safeError(error)}); throw error; }
  finally { console.log(JSON.stringify(report.cases.at(-1))); }
}
function request(path, method = 'GET', body, actor = 'owner', raw = false) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(new URL(path, base), {ca, method, timeout: 15000, headers: {Authorization: `Bearer ${keys[actor]}`, ...(payload === undefined ? {} : {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)})}}, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        try { const bytes = Buffer.concat(chunks); resolve({status: res.statusCode, data: raw ? bytes : JSON.parse(bytes.toString('utf8'))}); }
        catch { reject(new Error('Staging returned non-JSON data')); }
      });
    });
    req.on('error', () => reject(new Error('Isolated certificate-verified HTTPS request failed'))); req.on('timeout', () => req.destroy()); req.end(payload);
  });
}
async function api(path, method = 'GET', body, actor = 'owner', expected = 200) {
  const response = await request(path, method, body, actor);
  assert(response.status === expected, `${method} ${path.split('?')[0]} returned ${response.status}, expected ${expected}`); return response.data;
}
const projectPath = suffix => `/v1/projects/${ids.project}/${suffix}`;
const grant = (actor, scope, resource, access) => api('/v1/admin/access', 'PUT', {agent_id: ids[actor], scope, resource_id: ids[resource], access});
async function artifact(role, content = `${run}/${role}`, actor = 'writer') {
  const bytes = Buffer.from(content);
  return (await api(projectPath('artifacts'), 'POST', {client_id: `${run}-${role}-${randomUUID()}`, role, base_revision: 'fixture-base', sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64')}, actor, 201)).artifact;
}
class CDP {
  constructor(url, name) {
    this.name = name; this.ws = new WebSocket(url); this.serial = 0; this.pending = new Map(); this.requests = []; this.active = new Map();
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error('Owned browser CDP unavailable')); });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) { const item = this.pending.get(message.id); clearTimeout(item.timer); this.pending.delete(message.id); message.error ? item.reject(new Error(`CDP ${item.method} failed`)) : item.resolve(message.result); }
      if (message.method === 'Runtime.exceptionThrown') report.browser_errors.push({tab: name, text: message.params.exceptionDetails.text});
      if (message.method === 'Page.javascriptDialogOpening') void this.call('Page.handleJavaScriptDialog', {accept: false});
      if (message.method === 'Network.requestWillBeSent') { const r = message.params.request, url = new URL(r.url); if (url.origin === new URL(base).origin) { const meta = {method: r.method, path: url.pathname}; this.requests.push(meta); this.active.set(message.params.requestId, meta); } }
      if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) this.active.delete(message.params.requestId);
    };
  }
  async call(method, params = {}) { await this.ready; return new Promise((resolve, reject) => { const id = ++this.serial; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15000); this.pending.set(id, {method, resolve, reject, timer}); this.ws.send(JSON.stringify({id, method, params})); }); }
  async eval(expression) { const value = await this.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}); if (value.exceptionDetails) throw new Error(`Browser expression failed in ${this.name}`); return value.result.value; }
  async wait(expression, label, timeout = 6000) { const begin = Date.now(); while (Date.now() - begin < timeout) { if (typeof expression === 'function' ? await expression() : await this.eval(expression)) return; await pause(70); } throw new Error(`${this.name}: ${label} timeout ${timeout}ms`); }
  async fill(id, value) { await this.eval(`(()=>{const e=document.getElementById(${js(id)});e.focus();e.value=${js(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async click(id) { await this.eval(`document.getElementById(${js(id)}).click()`); }
  async submit(id) { await this.eval(`document.getElementById(${js(id)}).requestSubmit()`); }
  close() { this.ws.close(); }
}
async function newTab(name) {
  const target = await browserCDP.call('Target.createTarget', {url: 'about:blank'});
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const tab = new CDP(targets.find(item => item.id === target.targetId).webSocketDebuggerUrl, name); tabs.push(tab);
  await tab.call('Runtime.enable'); await tab.call('Page.enable'); await tab.call('Network.enable');
  await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
  await tab.call('Page.navigate', {url: new URL('?lang=ru', base).href}); await tab.wait(`document.readyState==='complete' && !!document.getElementById('nav-tasks')`, 'new page', 15000);
  return tab;
}
async function login(tab, actor) {
  await tab.fill('api-key', keys[actor]); await tab.submit('login-form');
  await tab.wait(`document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled`, 'login ready', 15000);
  await tab.eval(`Array.from(document.querySelectorAll('#project-switcher button')).find(e=>e.textContent===${js(ids.project)}).click()`);
  await tab.wait(textHas('project-name', ids.project), 'fixture selected');
  await tab.wait(`!document.getElementById('refresh-button').disabled`, 'project loaded');
}
async function pane(tab, name) { await tab.wait(`!document.getElementById('nav-${name}').disabled`, 'pane enabled'); await tab.click(`nav-${name}`); await tab.wait(`!document.getElementById('${name}-pane').hidden`, 'pane selected'); }
async function detail() { return (await api(projectPath(`tasks/${task.id}`), 'GET', undefined, 'writer')).task; }
async function eventForm(tab, type, summary, artifactIds) {
  await tab.wait(`!document.getElementById('task-event-form').hidden && Array.from(document.getElementById('task-event-kind').options).some(e=>e.value===${js(type)})`, `action ${type}`);
  await tab.fill('task-event-kind', type); await tab.fill('task-event-summary', summary);
  if (artifactIds) await tab.fill('task-event-artifacts', artifactIds.join('\n'));
}
async function waitState(tab, expected) { await tab.wait(`document.querySelector('#task-detail .coordination-state')?.dataset.state===${js(expected)}`, `task state ${expected}`); }
async function setup() {
  for (const path of ['/', '/app.js', '/app.css']) { const result = await request(path, 'GET', undefined, 'owner', true); assert(result.status === 200, 'Asset unavailable'); report.assets[path] = createHash('sha256').update(result.data).digest('hex'); }
  assert((await api('/v1/me')).agent.id === 'admin-e2e-owner', 'Wrong staging owner');
  for (const actor of ['writer', 'reviewer', 'viewer']) {
    await api('/v1/admin/principals', 'POST', {id: ids[actor], name: ids[actor], kind: actor === 'viewer' ? 'viewer' : 'agent', runtime: 'coordination-browser-no-model'}, 'owner', 201);
    created.add(actor); keys[actor] = (await api(`/v1/admin/principals/${ids[actor]}/rotate-key`, 'POST', {})).key; secrets.add(keys[actor]);
  }
  for (const name of ['project', 'hidden-project']) await api('/v1/admin/projects', 'POST', {id: ids[name], name: ids[name]}, 'owner', 201);
  for (const [name, project] of [['channel', 'project'], ['private-channel', 'project'], ['hidden-channel', 'hidden-project']]) await api('/v1/admin/channels', 'POST', {id: ids[name], name: ids[name], project_id: ids[project]}, 'owner', 201);
  for (const actor of ['writer', 'reviewer', 'viewer']) { const access = actor === 'viewer' ? 'read' : 'write'; await grant(actor, 'project', 'project', access); await grant(actor, 'channel', 'channel', access); }
  await grant('reviewer', 'channel', 'private-channel', 'write'); await grant('reviewer', 'project', 'hidden-project', 'write'); await grant('reviewer', 'channel', 'hidden-channel', 'write');
  const artifacts = []; for (const role of ['baseline', 'implementation', 'test', 'evidence', 'bundle']) artifacts.push(await artifact(role));
  refs = artifacts.map(a => ({artifact_id: a.id, role: a.role, sha256: a.sha256}));
  profile = await mkdtemp(join(tmpdir(), 'agentlink-coordination-browser-')); log = await open(`${runtime}/evidence/${run}-browser.log`, 'wx', 0o600);
  const spki = createHash('sha256').update(new X509Certificate(ca).publicKey.export({type: 'spki', format: 'der'})).digest('base64');
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${spki}`, 'about:blank'], {stdio: ['ignore', log.fd, log.fd]});
  for (let i = 0; i < 100; i++) { assert(browser.exitCode === null, 'Owned browser exited'); try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {} await pause(100); }
  assert(port > 0, 'No owned browser port'); const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); browserCDP = new CDP(version.webSocketDebuggerUrl, 'browser');
  writer = await newTab('writer'); reviewer = await newTab('reviewer'); viewer = await newTab('viewer'); owner = await newTab('owner');
  await login(writer, 'writer'); await login(reviewer, 'reviewer'); await login(viewer, 'viewer'); await login(owner, 'owner');
}
try {
  await setup();
  await check('startup and read-only navigation do not mutate; viewer/owner cannot publish coordination records', async () => {
    for (const tab of tabs) { await pane(tab, 'tasks'); await tab.wait(textHas('task-list', 'нет задач'), 'empty task list'); }
    for (const tab of [viewer, owner]) assert(await tab.eval(`document.getElementById('task-create-section').hidden && document.getElementById('task-event-form').hidden`), 'Read-only actor has write controls');
    assert(tabs.every(tab => tab.requests.filter(r => r.path.startsWith('/v1/')).every(r => r.method === 'GET')), 'Startup/nav issued mutation');
    assert(await writer.eval(`!document.getElementById('task-create-section').hidden`), 'Writer capability missing');
  });
  await check('writer creates scoped task with separate reviewer; live cards and safe plain text propagate', async () => {
    await writer.eval(`document.getElementById('task-create-section').open=true`);
    for (const [id, value] of Object.entries({'task-title': `${run} <img src=x onerror=alert(1)>`, 'task-owner': ids.writer, 'task-reviewer': ids.reviewer, 'task-scope': 'src/example.go\ntests/example_test.go', 'task-acceptance': 'All fixture checks pass\nReview the exact artifact set'})) await writer.fill(id, value);
    await writer.submit('task-create-form');
    await writer.wait(`!!document.querySelector('#task-detail [data-task-id]')`, 'new task detail');
    task = (await api(projectPath('tasks'), 'GET', undefined, 'writer')).tasks[0];
    for (const tab of [viewer, reviewer]) await tab.wait(textHas('task-list', task.title), 'live task creation');
    assert(await viewer.eval(`!document.querySelector('#task-list img') && !document.querySelector('#task-detail img')`), 'Task title interpreted as markup');
  });
  await check('task run/artifacts/review are typed explicit events; all artifact roles remain distinct', async () => {
    await eventForm(writer, 'run_started', 'Fixture run registration only; no command launch'); await writer.submit('task-event-form'); await waitState(writer, 'running');
    await eventForm(writer, 'artifacts_ready', 'Exact immutable fixture set', refs.map(a => a.artifact_id)); await writer.submit('task-event-form'); await waitState(writer, 'artifacts_ready');
    for (const ref of refs) assert(await writer.eval(textHas('task-detail', ref.role)), `Missing artifact role ${ref.role}`);
    await eventForm(writer, 'review_requested', 'Please review the exact full set'); await writer.submit('task-event-form');
    await waitState(reviewer, 'review_pending');
    assert(await reviewer.eval(`!Array.from(document.getElementById('task-event-kind').options).some(e=>e.value==='completion_reported')`), 'Reviewer can claim owner completion');
    await eventForm(reviewer, 'review_result', 'Separate reviewer fixture report'); await reviewer.fill('task-review-verdict', 'approved'); await reviewer.submit('task-event-form'); await waitState(writer, 'approved');
    assert(await writer.eval(`!Array.from(document.getElementById('task-event-kind').options).some(e=>e.value==='completion_reported')`), 'Completion enabled without passed external report');
  });
  await check('external verification report and claimed completion never become server-proven success', async () => {
    await eventForm(reviewer, 'verification_reported', 'Independent actor supplied fixture evidence, no execution by server');
    await reviewer.fill('task-check-command', 'fixture-check --not-executed-by-gui'); await reviewer.fill('task-check-result', 'passed'); await reviewer.fill('task-check-exit', '0');
    await reviewer.fill('task-check-artifact', refs.find(a => a.role === 'evidence').artifact_id); await reviewer.submit('task-event-form');
    await writer.wait(textHas('task-detail', 'Внешний отчёт проверки: passed'), 'external verification live');
    await eventForm(writer, 'completion_reported', 'Writer claims completion based on attributed reports'); await writer.submit('task-event-form'); await waitState(viewer, 'completion_reported');
    assert(await viewer.eval(textHas('task-timeline', 'не проверенный сервером успех')), 'Claim/proof distinction missing');
    assert(await viewer.eval(textHas('task-timeline', 'отдельный ревьюер')), 'Separate reviewer provenance missing');
    assert((await detail()).state === 'completion_reported', 'Unexpected server terminal state');
  });
  await check('artifact upload hashes explicit selected file; roles/base/SHA metadata and download are safe', async () => {
    await pane(writer, 'artifacts'); await writer.wait(textHas('artifact-list', refs[0].sha256), 'artifact list');
    await writer.eval(`document.getElementById('artifact-upload-section').open=true`);
    await writer.fill('artifact-role', 'evidence'); await writer.fill('artifact-base', 'gui-upload-base');
    await writer.eval(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${js(`${run} immutable GUI bytes`)}],'fixture.txt',{type:'text/plain'}));document.getElementById('artifact-file').files=transfer.files;})()`);
    await writer.submit('artifact-form'); await writer.wait(textHas('artifact-list', 'gui-upload-base'), 'uploaded artifact live');
    const artifactRow = (await api(projectPath('artifacts'), 'GET', undefined, 'writer')).artifacts.find(a => a.base_revision === 'gui-upload-base');
    assert(artifactRow.sha256 === createHash('sha256').update(`${run} immutable GUI bytes`).digest('hex'), 'GUI hash mismatch');
    await writer.eval(`document.querySelector('[data-artifact-id="${artifactRow.id}"] button').click()`);
    await writer.wait(textHas('coordination-status', 'SHA-256 сверены'), 'authenticated download verified');
    await pane(viewer, 'artifacts'); await viewer.wait(textHas('artifact-list', 'gui-upload-base'), 'reader artifact list');
    assert(await viewer.eval(`document.getElementById('artifact-upload-section').hidden`), 'Viewer has upload control');
  });
  await check('versioned memory create/edit preserves immutable history; stale CAS gets one 409 without overwrite', async () => {
    await pane(writer, 'memory'); await writer.wait(`!document.getElementById('memory-new').hidden`, 'memory write capability'); await writer.click('memory-new');
    await writer.fill('memory-title', `${run} selected context`); await writer.fill('memory-body', 'Version one <script>window.privateLeak=1</script>'); await writer.submit('memory-form');
    await writer.wait(textHas('project-memory-detail', 'Текущая версия 1'), 'memory created'); memory = (await api(projectPath('memory'), 'GET', undefined, 'writer')).memory[0];
    await writer.click('memory-select-current');
    assert(await writer.eval(`JSON.parse(document.getElementById('memory-selected-refs').textContent).memory_refs[0].memory_id===${js(memory.id)} && JSON.parse(document.getElementById('memory-selected-refs').textContent).memory_refs[0].version===1 && !document.getElementById('memory-copy-refs').disabled`), 'Explicit versioned memory reference missing');
    await writer.click('memory-edit'); await writer.fill('memory-body', 'Unsaved version one draft');
    await api(projectPath(`memory/${memory.id}`), 'PUT', {client_id: `${run}-external-memory`, expected_version: 1, title: memory.title, body: 'External version two'}, 'reviewer');
    await writer.wait(textHas('project-memory-detail', 'Текущая версия 2'), 'external version live');
    assert(await writer.eval(`document.getElementById('memory-copy-refs').disabled && JSON.parse(document.getElementById('memory-selected-refs').textContent).memory_refs[0].version===1 && document.querySelector('#memory-selected-list [data-stale="true"]')!==null`), 'Selected memory reference silently rebased after change');
    assert(await writer.eval(`document.getElementById('memory-body').value==='Unsaved version one draft' && document.activeElement.id==='memory-body'`), 'Realtime replaced memory draft/focus');
    const before = writer.requests.filter(r => r.method === 'PUT' && r.path.endsWith(`/memory/${memory.id}`)).length;
    await writer.submit('memory-form'); await writer.wait(textHas('coordination-error', '409'), 'stale memory conflict'); await pause(1000);
    assert(writer.requests.filter(r => r.method === 'PUT' && r.path.endsWith(`/memory/${memory.id}`)).length === before + 1, 'CAS mutation auto-retried');
    assert((await api(projectPath(`memory/${memory.id}`), 'GET', undefined, 'writer')).memory.version === 2, 'Stale GUI overwrote current memory');
    await writer.click('memory-cancel'); await writer.click('memory-edit'); await writer.fill('memory-body', 'Explicit version three'); await writer.submit('memory-form'); await writer.wait(textHas('project-memory-detail', 'Текущая версия 3'), 'memory updated');
    assert(await writer.eval(textHas('memory-history', 'Version one <script>')), 'Original history missing');
    assert(await writer.eval(`!window.privateLeak && !document.querySelector('#memory-history script')`), 'Memory interpreted as markup');
    await writer.click('memory-select-current');
    assert(await writer.eval(`!document.getElementById('memory-copy-refs').disabled && JSON.parse(document.getElementById('memory-selected-refs').textContent).memory_refs[0].version===3`), 'Explicit current-version reselection failed');
  });
  await check('sessions are channel-filtered read-only presence, distinct from task success', async () => {
    await pane(viewer, 'sessions');
    for (const [label, channel] of [['visible', 'channel'], ['hidden', 'private-channel']]) await api(projectPath('sessions'), 'POST', {session_id: `${run}-${label}-session`, channel_id: ids[channel], run_id: `${run}-session-run`, task_role: 'reviewer', runtime: 'fixture', model: 'no-model', activity: `${label} fixture session`, ttl_seconds: 10, max_duration_seconds: 60}, 'reviewer', 201);
    await viewer.wait(textHas('session-list', `${run}-visible-session`), 'session live');
    assert(await viewer.eval(`!document.getElementById('session-list').textContent.includes(${js(`${run}-hidden-session`)}) && !document.querySelector('#sessions-pane button')`), 'Hidden session leaked or controls exposed');
    await api(projectPath(`sessions/${run}-visible-session/close`), 'POST', {}, 'reviewer'); await viewer.wait(textHas('session-list', 'Сессия закрыта'), 'session closed');
    assert(await viewer.eval(textHas('sessions-pane', 'не доказывает завершение')), 'Session lifecycle misrepresented');
  });
  await check('new panes preserve selected chat draft and use a single authentication-level realtime stream', async () => {
    await writer.eval(`document.querySelector('#channel-list button').click()`); await writer.wait(`!document.getElementById('composer-form').hidden`, 'chat writable'); await writer.fill('message-input', 'Unsent chat draft survives pane navigation');
    const streamsBefore = writer.requests.filter(r => r.path === '/v1/workspace/stream').length;
    await pane(writer, 'tasks'); await writer.wait(textHas('task-detail', task.id), 'task current');
    await writer.eval(`document.querySelector('#channel-list button').click()`); await writer.wait(`!document.getElementById('ordinary-workbench').hidden`, 'return chat');
    assert(await writer.eval(`document.getElementById('message-input').value==='Unsent chat draft survives pane navigation'`), 'New pane discarded chat draft');
    assert(writer.requests.filter(r => r.path === '/v1/workspace/stream').length === streamsBefore, 'View changes restarted auth stream');
  });
  await check('project ACL revocation clears task/memory/session/artifact content and drafts; later grant is discovered', async () => {
    await pane(writer, 'memory'); await writer.wait(`!document.getElementById('memory-edit').hidden`, 'edit memory before revoke'); await writer.click('memory-edit'); await writer.fill('memory-body', 'Private pending draft to clear');
    await grant('writer', 'project', 'project', 'none');
    await writer.wait(`document.getElementById('project-memory-detail').textContent==='' && document.getElementById('task-detail').textContent==='' && document.getElementById('artifact-list').textContent==='' && document.getElementById('memory-body').value==='' && document.getElementById('login-panel').hidden`, 'ACL clears all coordination');
    await grant('writer', 'project', 'project', 'write'); await grant('writer', 'channel', 'channel', 'write');
    await writer.wait(`Array.from(document.querySelectorAll('#project-switcher button')).some(e=>e.textContent===${js(ids.project)})`, 'grant auto-discovered');
    assert(await writer.eval(`!document.getElementById('project-switcher').textContent.includes(${js(ids['hidden-project'])})`), 'Hidden project exposed');
  });
  await check('mobile panes fit viewport; logout clears every protected pane and stops reconnects', async () => {
    await pane(viewer, 'memory'); await viewer.wait(textHas('project-memory-detail', 'Explicit version three'), 'viewer context');
    await viewer.call('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
    assert(await viewer.eval(`document.documentElement.scrollWidth<=innerWidth+1`), 'Coordination pane overflows mobile viewport');
    for (const tab of tabs) { await tab.click('logout-button'); await tab.wait(`!document.getElementById('login-panel').hidden && document.getElementById('coordination-panel').hidden && ['task-list','task-detail','task-timeline','project-memory-detail','memory-history','artifact-list','session-list'].every(id=>document.getElementById(id).textContent==='') && document.getElementById('memory-body').value==='' && localStorage.length===0 && sessionStorage.length===0`, 'logout protected state cleared'); await tab.wait(() => ![...tab.active.values()].some(r => r.path.startsWith('/v1/')), 'streams aborted'); }
    const counts = tabs.map(t => t.requests.length); await pause(1400); assert(tabs.every((t, index) => t.requests.length === counts[index]), 'Logout caused reconnect/read');
    assert(report.browser_errors.length === 0, 'Browser runtime exception');
  });
} catch (error) {
  if (!report.cases.some(item => !item.passed)) report.cases.push({name: 'infrastructure', passed: false, error: safeError(error)});
  report.failure_controls = [];
  for (const tab of tabs) { try { report.failure_controls.push({tab: tab.name, active_requests: [...tab.active.values()], state: await tab.eval(`Object.fromEntries(['tasks-pane','memory-pane','task-event-form','task-event-kind','task-event-submit','memory-form','coordination-error','coordination-status','api-error'].map(id=>{const e=document.getElementById(id);return[id,{hidden:e.hidden,disabled:e.disabled,text:['coordination-error','coordination-status','api-error'].includes(id)?e.textContent:undefined}]}))`)}); } catch {} }
} finally {
  for (const tab of tabs) { try { await tab.click('logout-button'); } catch {} tab.close(); }
  for (const actor of created) { try { await api(`/v1/admin/principals/${ids[actor]}/revoke-key`, 'POST', {}); } catch {} }
  if (browserCDP) { try { await browserCDP.call('Browser.close'); } catch {} browserCDP.close(); }
  // Browser.close acknowledges before Chromium finishes writing its profile.
  // Wait for our exact child, including after escalation, before owned cleanup.
  if (!await waitBrowserExit(3000)) {
    browser.kill('SIGTERM');
    if (!await waitBrowserExit(3000)) { browser.kill('SIGKILL'); await waitBrowserExit(3000); }
  }
  report.owned_browser_stopped = browserStopped(); report.owned_profile_removed = !profile;
  if (log) await log.close();
  if (profile && report.owned_browser_stopped) {
    try { await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); report.owned_profile_removed = true; }
    catch (error) { report.cleanup_error = safeError(error); }
  }
  report.existing_seed_unchanged = createHash('sha256').update(await readFile(seedPath)).digest('hex') === seedHash;
  report.assets_unchanged = (await Promise.all(Object.entries(report.assets).map(async ([path, digest]) => createHash('sha256').update((await request(path, 'GET', undefined, 'owner', true)).data).digest('hex') === digest))).every(Boolean);
  report.finished_at = new Date().toISOString(); report.passed = report.cases.length === 10 && report.cases.every(item => item.passed) && report.existing_seed_unchanged && report.assets_unchanged && report.owned_browser_stopped && report.owned_profile_removed;
  const output = `${runtime}/evidence/coordination-gui.json`; await writeFile(output, JSON.stringify(report, null, 2) + '\n', {mode: 0o600}); console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, report: output}));
}
if (!report.passed) process.exitCode = 1;
