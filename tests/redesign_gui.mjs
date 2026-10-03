// Redesign acceptance: exclusive isolated agentlink_e2e staging and owned Chromium.
// The parent starts https://127.0.0.1:18769/; this suite never starts servers,
// models or adapters, changes seed keys, or accesses the production origin.
// Ten cases cover overview/error/empty states, role scope, all three attention
// states, cross-task draft/history isolation, compact receipts, realtime draft
// retention, admin section drafts, ACL clearing, mobile keyboard navigation,
// and logout. Controls are exercised through hit-tested CDP pointer/keyboard
// input. Evidence: private redesign-gui.json plus credential-checked screenshots.
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
const ownerFile = `${runtime}/secrets/admin-e2e-owner.json`;
const ownerStat = await lstat(ownerFile);
if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.mode & 0o077) throw new Error('E2E owner fixture must be private and regular');
const credentials = JSON.parse(await readFile(ownerFile, 'utf8'));
if (credentials.agent_id !== 'admin-e2e-owner') throw new Error('Wrong owner fixture identity');
const seedPath = `${runtime}/secrets/e2e-credentials.json`;
const seedHash = createHash('sha256').update(await readFile(seedPath)).digest('hex');
const run = `redesign-gui-${randomUUID().slice(0, 8)}`;
const ids = Object.fromEntries(['project', 'channel', 'side', 'private-channel', 'hidden-project', 'hidden-channel', 'empty-project', 'writer', 'peer', 'viewer'].map(name => [name, `${run}-${name}`]));
const hostile = '<img src=x onerror=window.redesignInjected=1>';
const taskTitle = `${run} ${hostile}`;
const names = {writer: `Writer ${hostile}`, peer: 'Fixture reviewer', viewer: 'Fixture observer'};
const keys = {owner: credentials.key}, secrets = new Set([credentials.key]);
const created = new Set(), tabs = [], sessions = [];
const report = {run, base, started_at: new Date().toISOString(), cases: [], browser_errors: [], assets: {}, screenshots: [], layouts: [],
  scope: 'Dedicated isolated E2E, run-prefixed API fixtures, owned Chromium, no model or production calls'};
const js = JSON.stringify;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const textHas = (id, value) => `document.getElementById(${js(id)})?.textContent.includes(${js(value)})`;
const metric = name => `document.getElementById('overview-metric-${name}').textContent.trim()`;
const visible = selector => `(()=>{const e=document.querySelector(${js(selector)});if(!e||e.closest('[hidden]'))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';})()`;
let browser, profile, log, browserCDP, port, writer, viewer, owner, task, initialMessage;
let taskEventSerial = 0;
function safeError(error) {
  let value = String(error?.message || error);
  for (const key of secrets) value = value.replaceAll(key, '[REDACTED]');
  return value.slice(0, 500);
}
async function check(name, action) {
  const start = performance.now();
  try { await action(); report.cases.push({name, passed: true, ms: Math.round(performance.now() - start)}); }
  catch (error) { report.cases.push({name, passed: false, error: safeError(error), ms: Math.round(performance.now() - start)}); throw error; }
  finally { console.log(JSON.stringify(report.cases.at(-1))); }
}
function request(path, method = 'GET', body, actor = 'owner', raw = false) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(new URL(path, base), {ca, method, timeout: 12000,
      headers: {Authorization: `Bearer ${keys[actor]}`, ...(payload === undefined ? {} : {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)})}}, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { const bytes = Buffer.concat(chunks); resolve({status: res.statusCode, data: raw ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null}); }
        catch { reject(new Error('Staging returned non-JSON data')); }
      });
    });
    req.on('error', () => reject(new Error('Isolated certificate-verified HTTPS request failed')));
    req.on('timeout', () => req.destroy()); req.end(payload);
  });
}
async function api(path, method = 'GET', body, actor = 'owner', expected = 200) {
  const result = await request(path, method, body, actor);
  assert(result.status === expected, `${method} ${path.split('?')[0]} returned ${result.status}, expected ${expected}`);
  return result.data;
}
const projectPath = suffix => `/v1/projects/${ids.project}/${suffix}`;
const grant = (actor, scope, resource, access) => api('/v1/admin/access', 'PUT', {agent_id: ids[actor], scope, resource_id: ids[resource], access});
async function postMessage(label, body = `Visible fixture message ${label}`, channel = 'channel') {
  return (await api(`/v1/channels/${ids[channel]}/messages`, 'POST', {client_id: `${run}-${label}`, body,
    recipient_ids: channel === 'channel' ? [ids.writer] : [], channel_only: channel !== 'channel'}, 'peer', 201)).message;
}
async function taskEvent(type, target = task, extra = {}, actor = 'writer') {
  const current = (await api(projectPath(`tasks/${target.id}`), 'GET', undefined, 'writer')).task;
  return api(projectPath(`tasks/${target.id}/events`), 'POST', {client_id: `${run}-event-${++taskEventSerial}`,
    expected_version: current.version, type, run_id: `${run}-run-${target.id}`,
    summary: `Browser fixture ${type}; no process launched`, ...extra}, actor, 201);
}

class CDP {
  constructor(url, name) {
    this.name = name; this.ws = new WebSocket(url); this.serial = 0; this.pending = new Map(); this.requests = []; this.active = new Map(); this.unsafeRequests = 0;
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error('Owned browser CDP unavailable')); });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const item = this.pending.get(message.id); clearTimeout(item.timer); this.pending.delete(message.id);
        message.error ? item.reject(new Error(`CDP ${item.method} failed`)) : item.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') report.browser_errors.push({tab: name, text: safeError(message.params.exceptionDetails.text)});
      if (message.method === 'Page.javascriptDialogOpening') void this.call('Page.handleJavaScriptDialog', {accept: false}).catch(() => {});
      if (message.method === 'Network.requestWillBeSent') {
        const r = message.params.request, url = new URL(r.url);
        if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.origin !== new URL(base).origin || /[?&](key|token|authorization)=/i.test(url.search))) this.unsafeRequests++;
        if (url.origin === new URL(base).origin) {
          const metadata = {method: r.method, path: url.pathname}; this.requests.push(metadata); this.active.set(message.params.requestId, metadata);
        }
      }
      if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) this.active.delete(message.params.requestId);
    };
  }
  async call(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 12000);
      this.pending.set(id, {method, resolve, reject, timer}); this.ws.send(JSON.stringify({id, method, params}));
    });
  }
  async eval(expression) {
    const result = await this.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (result.exceptionDetails) throw new Error(`Browser expression failed in ${this.name}; expression omitted`);
    return result.result.value;
  }
  async wait(expression, label, timeout = 6500) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (typeof expression === 'function' ? await expression() : await this.eval(expression)) return;
      await pause(70);
    }
    throw new Error(`${this.name}: ${label} timeout ${timeout}ms`);
  }
  async click(selector) {
    await this.call('Page.bringToFront');
    await this.wait(visible(selector), `visible control ${selector}`);
    let point;
    await this.wait(async () => {
      point = await this.eval(`(()=>{const e=document.querySelector(${js(selector)});if(!e)return null;e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,top=document.elementFromPoint(x,y);return {x,y,enabled:!e.disabled&&!e.closest('button:disabled,fieldset:disabled'),reachable:x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&(top===e||e.contains(top))};})()`);
      return point?.enabled && point.reachable;
    }, `enabled unobscured control ${selector}`);
    await this.call('Input.dispatchMouseEvent', {type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1});
    await this.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1});
  }
  async fill(id, value) {
    await this.click(`#${id}`);
    await this.call('Input.dispatchKeyEvent', {type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2});
    await this.call('Input.dispatchKeyEvent', {type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2});
    await this.call('Input.insertText', {text: value});
  }
  async key(key, code, virtualKey) {
    // CDP needs the character for native Enter activation (keypress/default
    // action), not just a synthetic keydown notification to JavaScript.
    await this.call('Input.dispatchKeyEvent', {type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, ...(key === 'Enter' ? {text: '\r', unmodifiedText: '\r'} : {})});
    await this.call('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey});
  }
  close() { this.ws.close(); }
}
async function newTab(name) {
  const target = await browserCDP.call('Target.createTarget', {url: 'about:blank'});
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const selected = targets.find(item => item.id === target.targetId); assert(selected, 'Owned target missing');
  const tab = new CDP(selected.webSocketDebuggerUrl, name); tabs.push(tab);
  await tab.call('Runtime.enable'); await tab.call('Page.enable'); await tab.call('Network.enable');
  await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
  await tab.call('Page.navigate', {url: new URL('?lang=ru', base).href});
  await tab.wait(`document.readyState==='complete' && !!document.getElementById('nav-overview')`, 'redesigned page', 15000);
  return tab;
}
async function login(tab, actor) {
  await tab.fill('api-key', keys[actor]); await tab.click('#login-button');
  await tab.wait(`document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled`, 'authenticated workspace', 15000);
  await selectProject(tab);
}
async function selectProject(tab, name = 'project') {
  await tab.click(`#project-switcher [data-focus-key="project:${ids[name]}"]`);
  await tab.wait(`${textHas('project-name', ids[name])} && !document.getElementById('refresh-button').disabled`, 'project loaded');
  await tab.wait(visible('#overview-panel'), 'project opens overview');
}
async function overview(tab) { await tab.click('#nav-overview'); await tab.wait(visible('#overview-panel'), 'overview visible'); }
async function channel(tab) {
  await tab.click(`#channel-list [data-focus-key="channel:${ids.channel}"]`);
  await tab.wait(`${visible('#chat-panel')} && !document.getElementById('refresh-button').disabled`, 'channel opens discussion');
}
async function screenshot(tab, label) {
  await tab.call('Page.bringToFront');
  const clean = await tab.eval(`(()=>{const secrets=${js([...secrets])};const values=[document.body.innerText,...Array.from(document.querySelectorAll('input,textarea')).map(e=>e.value)];return !secrets.some(key=>values.some(value=>value.includes(key)));})()`);
  assert(clean, 'Screenshot suppressed because secret material may be visible');
  const file = `${runtime}/evidence/${run}-${label}.png`;
  const shot = await tab.call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  await writeFile(file, Buffer.from(shot.data, 'base64'), {mode: 0o600}); report.screenshots.push({label, file});
}
async function setup() {
  for (const path of ['/', '/app.js', '/app.css']) {
    const result = await request(path, 'GET', undefined, 'owner', true); assert(result.status === 200, 'Staging asset unavailable');
    report.assets[path] = createHash('sha256').update(result.data).digest('hex');
  }
  assert((await api('/v1/me')).agent.id === 'admin-e2e-owner', 'Wrong staging owner');
  for (const actor of ['writer', 'peer', 'viewer']) {
    await api('/v1/admin/principals', 'POST', {id: ids[actor], name: names[actor], kind: actor === 'viewer' ? 'viewer' : 'agent', runtime: 'redesign-browser-no-model'}, 'owner', 201);
    created.add(actor); keys[actor] = (await api(`/v1/admin/principals/${ids[actor]}/rotate-key`, 'POST', {})).key; secrets.add(keys[actor]);
  }
  for (const name of ['project', 'hidden-project', 'empty-project']) await api('/v1/admin/projects', 'POST', {id: ids[name], name: ids[name]}, 'owner', 201);
  for (const [name, parent] of [['channel', 'project'], ['side', 'project'], ['private-channel', 'project'], ['hidden-channel', 'hidden-project']]) {
    await api('/v1/admin/channels', 'POST', {id: ids[name], name: ids[name], project_id: ids[parent]}, 'owner', 201);
  }
  for (const actor of ['writer', 'peer', 'viewer']) {
    const access = actor === 'viewer' ? 'read' : 'write'; await grant(actor, 'project', 'project', access);
    for (const name of ['channel', 'side']) await grant(actor, 'channel', name, access);
  }
  await grant('peer', 'channel', 'private-channel', 'write');
  await grant('peer', 'project', 'hidden-project', 'write'); await grant('peer', 'channel', 'hidden-channel', 'write');
  await postMessage('hidden', `Private marker ${ids['hidden-project']}`, 'hidden-channel');
  task = (await api(projectPath('tasks'), 'POST', {client_id: `${run}-task`, title: taskTitle, owner_id: ids.writer, reviewer_id: ids.peer,
    scope: ['fixtures/redesign.txt'], acceptance: ['Read-only browser display matches published data']}, 'writer', 201)).task;
  initialMessage = await postMessage('initial', `Literal message ${hostile}`);
  await api('/v1/heartbeat', 'POST', {session_id: `${run}-heartbeat`, activity: 'Synthetic browser fixture, no model activity', runtime: 'redesign-browser-no-model'}, 'writer');
  for (const status of ['delivered', 'accepted', 'uncertain']) await api(`/v1/messages/${initialMessage.id}/receipts`, 'POST', {status, session_id: `${run}-heartbeat`}, 'writer');
  for (const [label, name] of [['visible', 'channel'], ['restricted', 'private-channel']]) {
    const sessionID = `${run}-${label}-session`;
    await api(projectPath('sessions'), 'POST', {session_id: sessionID, channel_id: ids[name], run_id: `${run}-session-run`, task_role: 'reviewer',
      runtime: 'redesign-browser-no-model', model: 'none', activity: `${label} browser fixture`, ttl_seconds: 120, max_duration_seconds: 300}, 'peer', 201);
    sessions.push(sessionID);
  }
  profile = await mkdtemp(join(tmpdir(), 'agentlink-redesign-browser-'));
  log = await open(`${runtime}/evidence/${run}-browser.log`, 'wx', 0o600);
  const spki = createHash('sha256').update(new X509Certificate(ca).publicKey.export({type: 'spki', format: 'der'})).digest('base64');
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${spki}`, 'about:blank'], {stdio: ['ignore', log.fd, log.fd]});
  for (let attempt = 0; attempt < 100; attempt++) {
    assert(browser.exitCode === null, 'Owned Chromium exited');
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
    await pause(100);
  }
  assert(Number.isInteger(port) && port > 0, 'Owned browser readiness timeout');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); browserCDP = new CDP(version.webSocketDebuggerUrl, 'browser');
  writer = await newTab('writer'); viewer = await newTab('viewer'); owner = await newTab('owner');
  await login(writer, 'writer'); await login(viewer, 'viewer'); await login(owner, 'owner');
}

try {
  await check('default project overview renders real scoped data and inert literal labels', async () => {
    await setup();
    for (const tab of [writer, viewer]) {
      await tab.wait(`${metric('tasks')}==='1' && ${metric('channels')}==='2'`, 'scoped overview metrics');
      await tab.wait(textHas('overview-tasks', taskTitle), 'published task in overview');
      assert(await tab.eval(`${visible('#overview-title')} && ${visible('#overview-agents')} && ${visible('#overview-channels')} && ${visible('#overview-attention')}`), 'Overview sections are not visible');
      assert(await tab.eval(`!window.redesignInjected && !document.querySelector('#overview-panel img') && ${textHas('overview-agents', names.writer)}`), 'Overview content was interpreted as markup or principal missing');
      assert(await tab.eval(`/видим|доступн/i.test(document.getElementById('overview-note').textContent)`), 'Overview does not explain the limited visible-data scope');
      assert(await tab.eval(`!document.body.textContent.includes(${js(ids['hidden-project'])}) && !document.getElementById('overview-panel').textContent.includes(${js(ids['private-channel'])}) && !document.getElementById('overview-panel').textContent.includes(${js(`${run}-restricted-session`)})`), 'Unrelated project/channel/session leaked');
      assert(tab.requests.some(r => r.path === projectPath('tasks')) && tab.requests.some(r => r.path === projectPath('sessions')), 'Overview did not read real tasks and sessions');
    }
    await screenshot(viewer, 'desktop-overview');
  });
  await check('read-only roles and navigation never publish; overview task shortcut is clickable', async () => {
    for (const tab of [viewer, owner]) {
      await channel(tab); assert(await tab.eval(`document.getElementById('composer-form').hidden`), 'Read-only role can compose');
      await overview(tab); await tab.click('#overview-metric-tasks');
      await tab.wait(visible('#tasks-pane'), 'task metric shortcut');
      assert(await tab.eval(`document.getElementById('task-create-section').hidden && document.getElementById('task-event-form').hidden`), 'Read-only role can publish a task');
      await overview(tab);
    }
    assert(tabs.every(tab => tab.requests.filter(r => r.path.startsWith('/v1/')).every(r => r.method === 'GET')), 'Initial GUI navigation made a mutation');
  });
  await check('unavailable overview reads are not false zero totals and empty projects are explicit', async () => {
    await viewer.call('Network.setBlockedURLs', {urls: [`${base}v1/projects/${ids.project}/tasks*`]});
    try {
      const before = viewer.requests.filter(r => r.path === projectPath('tasks')).length;
      await viewer.click('#refresh-button');
      await viewer.wait(() => viewer.requests.filter(r => r.path === projectPath('tasks')).length > before, 'blocked task read attempted');
      await viewer.wait(`!document.getElementById('refresh-button').disabled`, 'failed refresh settled');
      assert(await viewer.eval(`${metric('tasks')}!=='0'`), 'Read failure displayed a false zero task count');
      await viewer.wait(`['overview-note','overview-tasks','api-error','connection-state'].some(id=>{const e=document.getElementById(id);return e&&!e.hidden&&/не подтверж|ошиб|недоступ|не получ|не удалось|повтор/i.test(e.textContent);})`, 'visible explanation of unconfirmed read');
      await channel(viewer); await overview(viewer);
      await viewer.wait(`${metric('tasks')}==='—' && document.getElementById('overview-note').dataset.stale==='true'`, 'first-read failure is unknown, not zero');
    } finally { await viewer.call('Network.setBlockedURLs', {urls: []}); }
    await viewer.click('#refresh-button'); await viewer.wait(`${metric('tasks')}==='1'`, 'task metric recovers');
    await viewer.call('Network.setBlockedURLs', {urls: [`${base}v1/projects/${ids.project}/sessions*`]});
    try {
      await viewer.click('#refresh-button');
      await viewer.wait(`${metric('tasks')}==='1' && /сессий.*не подтверждено/i.test(document.getElementById('overview-note').textContent)`, 'session outage does not discard readable tasks');
    } finally { await viewer.call('Network.setBlockedURLs', {urls: []}); }
    await grant('viewer', 'project', 'empty-project', 'read');
    await viewer.wait(`!!document.querySelector('[data-focus-key="project:${ids['empty-project']}"]')`, 'empty project grant live');
    await selectProject(viewer, 'empty-project');
    await viewer.wait(`${metric('tasks')}==='0' && ${metric('channels')}==='0'`, 'confirmed empty counts');
    assert(await viewer.eval(`/нет|пока|не созданы|не опубликован/i.test(document.getElementById('overview-tasks').textContent)`), 'Empty task state is not explained');
    await selectProject(viewer);
  });
  await check('attention states update live and task A overview task B navigation clears drafts and history', async () => {
    await overview(writer); await overview(viewer);
    const streams = [writer, viewer].map(tab => tab.requests.filter(r => r.path === '/v1/workspace/stream').length);
    const beforeAttention = await viewer.eval(metric('attention'));
    await taskEvent('run_started'); await taskEvent('uncertain');
    for (const tab of [writer, viewer]) {
      await tab.wait(`${textHas('overview-attention', taskTitle)} && /неопредел|uncertain/i.test(document.getElementById('overview-attention').textContent)`, 'uncertain task attention', 5000);
      assert(await tab.eval(`${metric('attention')}!=='0' && ${metric('tasks')}==='1'`), 'Uncertain task count missing');
    }
    assert([writer, viewer].every((tab, index) => tab.requests.filter(r => r.path === '/v1/workspace/stream').length === streams[index]), 'Task refresh restarted the authentication stream');
    report.attention_before = beforeAttention; report.attention_after = await viewer.eval(metric('attention'));
    const taskB = (await api(projectPath('tasks'), 'POST', {client_id: `${run}-task-b`, title: `${run} second independent task`,
      owner_id: ids.writer, reviewer_id: ids.peer, scope: ['fixtures/second.txt'], acceptance: ['Keep task drafts and history separate']}, 'writer', 201)).task;
    const bytes = Buffer.from(`${run} inert artifact fixture`);
    const artifact = (await api(projectPath('artifacts'), 'POST', {client_id: `${run}-review-artifact`, role: 'baseline',
      base_revision: 'browser-fixture-base', sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64')}, 'writer', 201)).artifact;
    const refs = [{artifact_id: artifact.id, role: artifact.role, sha256: artifact.sha256}];
    await taskEvent('run_started', taskB); await taskEvent('artifacts_ready', taskB, {artifacts: refs});
    const review = await taskEvent('review_requested', taskB, {artifacts: refs});
    await viewer.wait(`!!document.querySelector('#overview-attention [data-state="review_pending"]') && ${metric('tasks')}==='2' && ${metric('attention')}==='2'`, 'review pending appears in attention', 5000);
    await taskEvent('review_result', taskB, {artifacts: refs, review_request_id: review.event.id, verdict: 'changes_requested'}, 'peer');
    await viewer.wait(`!!document.querySelector('#overview-attention [data-state="changes_requested"]') && ${metric('attention')}==='2'`, 'requested changes remain in attention', 5000);
    await writer.click(`#overview-tasks [data-focus-key="overview-task:${task.id}"]`);
    await writer.wait(`!!document.querySelector('#task-detail [data-task-id="${task.id}"]') && ${visible('#task-event-form')}`, 'task A event form');
    await writer.wait(textHas('task-timeline', 'Browser fixture uncertain; no process launched'), 'task A history');
    await writer.fill('task-event-summary', `${run} private unsaved draft for task A`);
    await overview(writer);
    await writer.click(`#overview-tasks [data-focus-key="overview-task:${taskB.id}"]`);
    await writer.wait(`!!document.querySelector('#task-detail [data-task-id="${taskB.id}"]')`, 'task B selected from overview');
    assert(await writer.eval(`document.getElementById('task-event-summary').value==='' && !document.getElementById('task-timeline').textContent.includes('Browser fixture uncertain; no process launched')`), 'Task B inherited task A draft or history');
    await overview(writer);
    assert([writer, viewer].every((tab, index) => tab.requests.filter(r => r.path === '/v1/workspace/stream').length === streams[index]), 'Task/overview navigation restarted authentication stream');
  });
  await check('channel discussion shows compact uncertain receipt summary and inert message text', async () => {
    await channel(writer);
    await writer.wait(visible('#composer-form'), 'agent composer visible');
    const card = `#message-list [data-message-id="${initialMessage.id}"]`;
    await writer.wait(visible(`${card} details.message-details summary`), 'compact receipt summary');
    assert(await writer.eval(`(()=>{const d=document.querySelector(${js(`${card} details.message-details`)});return !d.open&&/неопредел|uncertain/i.test(d.querySelector('summary').textContent);})()`), 'Receipt uncertainty is hidden or details default to expanded');
    assert(await writer.eval(`!window.redesignInjected && !document.querySelector('#message-list img') && ${textHas('message-list', hostile)}`), 'Message markup executed or literal content missing');
    assert(await writer.eval(`(()=>{const d=document.querySelector(${js(`${card} details.message-details`)});return d.textContent.includes(${js(initialMessage.id)})&&!d.querySelector('summary').textContent.includes(${js(initialMessage.id)});})()`), 'Full ID is missing from details or clutters compact summary');
    await writer.click(`${card} details.message-details summary`);
    assert(await writer.eval(`document.querySelector(${js(`${card} details.message-details`)}).open`), 'Real summary click did not expand details');
  });
  await check('live message refresh preserves composer draft caret recipients reply and expanded details', async () => {
    await writer.fill('message-input', `${run} unsent draft`);
    await writer.eval(`(()=>{const e=document.getElementById('message-input');e.setSelectionRange(2,5);document.getElementById('reply-to').value=${js(initialMessage.id)};const r=document.querySelector('#recipient-list input[value="${ids.peer}"]');if(r)r.checked=true;})()`);
    const streams = writer.requests.filter(r => r.path === '/v1/workspace/stream').length;
    const incoming = await postMessage('live', `Live follow-up ${run}`);
    await writer.wait(`!!document.querySelector('#message-list [data-message-id="${incoming.id}"]')`, 'live message arrival', 5000);
    assert(await writer.eval(`document.getElementById('message-input').value===${js(`${run} unsent draft`)} && document.activeElement.id==='message-input' && document.getElementById('message-input').selectionStart===2 && document.getElementById('message-input').selectionEnd===5 && document.getElementById('reply-to').value===${js(initialMessage.id)} && document.querySelector('#recipient-list input[value="${ids.peer}"]')?.checked`), 'Live refresh replaced draft, focus, caret, recipient or reply');
    assert(await writer.eval(`document.querySelector('#message-list [data-message-id="${initialMessage.id}"] details.message-details').open`), 'Live refresh collapsed expanded message details');
    assert(writer.requests.filter(r => r.path === '/v1/workspace/stream').length === streams, 'Chat refresh restarted authentication stream');
    await writer.eval(`document.getElementById('current-channel').scrollIntoView({block:'start'})`); await screenshot(writer, 'desktop-chat');
  });
  await check('owner admin sections are reachable preserve drafts and cannot publish agent content', async () => {
    await owner.click('#nav-admin'); await owner.wait(visible('#admin-section-nav'), 'admin sections');
    await owner.click('#admin-section-nav [data-admin-section="accounts"]');
    await owner.fill('admin-principal-name', `${run} unsaved admin draft`);
    for (const section of ['projects', 'access', 'diagnostics', 'accounts']) await owner.click(`#admin-section-nav [data-admin-section="${section}"]`);
    assert(await owner.eval(`document.getElementById('admin-principal-name').value===${js(`${run} unsaved admin draft`)}`), 'Admin section navigation discarded an unsaved form');
    assert(owner.requests.filter(r => r.path.startsWith('/v1/')).every(r => r.method === 'GET'), 'Admin section navigation wrote to API');
    await channel(owner); assert(await owner.eval(`document.getElementById('composer-form').hidden`), 'Owner can impersonate a writer');
    await overview(owner);
  });
  await check('project revocation clears overview and old channel content before live regrant', async () => {
    await overview(viewer); await grant('viewer', 'project', 'project', 'none');
    await viewer.wait(`!document.querySelector('[data-focus-key="project:${ids.project}"]') && !document.getElementById('overview-panel').textContent.includes(${js(taskTitle)}) && !document.getElementById('message-list').textContent.includes(${js(hostile)})`, 'revoked content cleared', 6000);
    assert(await viewer.eval(`!document.getElementById('overview-panel').textContent.includes(${js(names.writer)}) && document.getElementById('message-input').value===''`), 'Revoked project retained participants or draft');
    await grant('viewer', 'project', 'project', 'read');
    for (const name of ['channel', 'side']) await grant('viewer', 'channel', name, 'read');
    // Rapid revoke/regrant can return to the same sampled revision. Permit the
    // existing eight-second fallback, not only an SSE notification (< 6.5s).
    await viewer.wait(`!!document.querySelector('[data-focus-key="project:${ids.project}"]')`, 'regrant discovered without relogin', 12000);
    await selectProject(viewer); await viewer.wait(`${metric('tasks')}==='2'`, 'restored overview data');
  });
  await check('mobile 360 and 390 navigation is keyboard usable dismissible and overflow free', async () => {
    for (const width of [360, 390]) {
      await viewer.call('Emulation.setDeviceMetricsOverride', {width, height: 844, deviceScaleFactor: 1, mobile: true});
      await viewer.call('Page.bringToFront'); await viewer.eval(`window.scrollTo(0,0)`);
      await viewer.wait(visible('#sidebar-toggle'), 'mobile menu toggle');
      assert(await viewer.eval(`document.getElementById('sidebar-toggle').getAttribute('aria-controls')==='workspace-navigation' && document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='false'`), 'Mobile menu initial ARIA state is wrong');
      await viewer.click('#sidebar-toggle');
      await viewer.wait(`document.body.classList.contains('nav-open') && document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='true'`, 'mobile menu open');
      await viewer.key('Escape', 'Escape', 27);
      await viewer.wait(`!document.body.classList.contains('nav-open') && document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='false'`, 'Escape dismisses menu');
      await viewer.eval(`document.getElementById('sidebar-toggle').focus()`); await viewer.key('Enter', 'Enter', 13);
      await viewer.wait(`document.body.classList.contains('nav-open')`, 'keyboard opens menu');
      await viewer.click(`#channel-list [data-focus-key="channel:${ids.channel}"]`);
      await viewer.wait(`${visible('#chat-panel')} && !document.body.classList.contains('nav-open')`, 'channel closes mobile menu');
      let layout = await viewer.eval(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,view:'chat'})`);
      report.layouts.push(layout); assert(layout.scrollWidth <= layout.width + 1, `Chat overflows mobile ${width}`);
      await viewer.click('#sidebar-toggle'); await viewer.click('#nav-overview');
      await viewer.wait(`${visible('#overview-panel')} && !document.body.classList.contains('nav-open')`, 'overview closes mobile menu');
      layout = await viewer.eval(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,view:'overview'})`);
      report.layouts.push(layout); assert(layout.scrollWidth <= layout.width + 1, `Overview overflows mobile ${width}`);
      await viewer.eval(`window.scrollTo(0,0)`); await screenshot(viewer, `mobile-overview-${width}`);
    }
  });
  await check('logout removes protected overview details and keys and aborts all realtime traffic', async () => {
    for (const tab of tabs) {
      // On mobile the logout control may live in the collapsed navigation.
      await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
      await tab.click('#logout-button');
      await tab.wait(`!document.getElementById('login-panel').hidden && document.getElementById('connected-workspace').hidden && document.getElementById('api-key').value==='' && ['overview-agents','overview-channels','overview-attention','overview-tasks','message-list','admin-principal-list'].every(id=>document.getElementById(id).textContent==='') && document.getElementById('message-input').value==='' && localStorage.length===0 && sessionStorage.length===0`, 'protected state cleared');
      await tab.wait(() => ![...tab.active.values()].some(r => r.path.startsWith('/v1/')), 'authenticated requests aborted');
    }
    const counts = tabs.map(tab => tab.requests.length); await pause(1200);
    assert(tabs.every((tab, index) => tab.requests.length === counts[index]), 'Logout restarted background requests');
    assert(tabs.every(tab => tab.unsafeRequests === 0), 'External requests or URL credentials observed');
    assert(report.browser_errors.length === 0, 'Browser runtime errors observed');
  });
} catch (error) {
  if (!report.cases.some(item => !item.passed)) report.cases.push({name: 'infrastructure', passed: false, error: safeError(error)});
  report.failure_controls = [];
  for (const tab of tabs) {
    try {
      report.failure_controls.push({tab: tab.name, active_requests: [...tab.active.values()], state: await tab.eval(`Object.fromEntries(['overview-panel','chat-panel','admin-panel','api-error','sidebar-toggle'].map(id=>{const e=document.getElementById(id);return [id,e?{hidden:e.hidden,disabled:e.disabled,expanded:e.getAttribute('aria-expanded')}:null];}))`)});
    } catch {}
  }
} finally {
  for (const tab of tabs) {
    try { await tab.eval(`document.getElementById('logout-button')?.click()`); } catch {}
    tab.close();
  }
  for (const sessionID of sessions) { try { await api(projectPath(`sessions/${sessionID}/close`), 'POST', {}, 'peer'); } catch {} }
  report.fixture_keys_revoked = true;
  for (const actor of created) {
    try { await api(`/v1/admin/principals/${ids[actor]}/revoke-key`, 'POST', {}); }
    catch { report.fixture_keys_revoked = false; }
  }
  if (browserCDP) { try { await browserCDP.call('Browser.close'); } catch {} browserCDP.close(); }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (browser?.exitCode === null && browser?.signalCode === null) {
      browser.kill(signal); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(3000)]);
    }
  }
  report.owned_browser_stopped = !browser || browser.exitCode !== null || browser.signalCode !== null;
  if (log) await log.close();
  if (profile && report.owned_browser_stopped) await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  try { report.existing_seed_unchanged = createHash('sha256').update(await readFile(seedPath)).digest('hex') === seedHash; } catch { report.existing_seed_unchanged = false; }
  try {
    report.assets_unchanged = (await Promise.all(Object.entries(report.assets).map(async ([path, digest]) => {
      const result = await request(path, 'GET', undefined, 'owner', true);
      return result.status === 200 && createHash('sha256').update(result.data).digest('hex') === digest;
    }))).every(Boolean);
  } catch { report.assets_unchanged = false; }
  report.finished_at = new Date().toISOString();
  report.passed = report.cases.length === 10 && report.cases.every(item => item.passed) && report.existing_seed_unchanged && report.assets_unchanged && report.fixture_keys_revoked && report.owned_browser_stopped;
  const output = `${runtime}/evidence/redesign-gui.json`;
  let serialized = JSON.stringify(report, null, 2) + '\n';
  for (const secret of secrets) serialized = serialized.replaceAll(secret, '[REDACTED]');
  await writeFile(output, serialized, {mode: 0o600});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, report: output}));
}
if (!report.passed) process.exitCode = 1;
