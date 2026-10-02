// Native CLI activity browser acceptance. Dedicated loopback staging fixtures and owned
// Chromium; never launches a model, changes seed keys or uses production APIs.
// Coordinate exclusive use of agentlink_e2e with the parent before running.
// Project-wide latest-first/filter/cursor/cache regressions are independently
// covered by `node tests/project_native_gui.mjs`; that companion owns its test
// schema, TLS API and Chromium and needs no shared E2E server or fixture keys.
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
const run = `native-gui-${randomUUID().slice(0, 8)}`;
const ids = Object.fromEntries(['project', 'channel', 'private-channel', 'hidden-project', 'hidden-channel', 'writer', 'reviewer', 'viewer'].map(name => [name, `${run}-${name}`]));
const keys = {owner: credentials.key}, secrets = new Set([credentials.key]), created = new Set(), tabs = [];
const report = {run, base, started_at: new Date().toISOString(), cases: [], browser_errors: [], assets: {}, scope: 'Isolated E2E, run-prefixed data, no model/process controller calls'};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = JSON.stringify;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const textHas = (id, value) => `document.getElementById(${js(id)}).textContent.includes(${js(value)})`;
let browser, profile, log, browserCDP, port, writer, viewer, owner, initial, inboxMessage;
function safeError(error) { let value = String(error.message || error); for (const key of secrets) value = value.replaceAll(key, '[REDACTED]'); return value.slice(0, 500); }
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
  await tab.call('Page.navigate', {url: new URL('?lang=ru', base).href}); await tab.wait(`document.readyState==='complete' && !!document.getElementById('tab-native')`, 'new page', 15000);
  return tab;
}
async function login(tab, actor) {
  await tab.fill('api-key', keys[actor]); await tab.submit('login-form');
  await tab.wait(`document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled`, 'login ready', 15000);
  await tab.eval(`Array.from(document.querySelectorAll('#project-switcher button')).find(e=>e.textContent===${js(ids.project)}).click()`);
  await tab.wait(textHas('project-name', ids.project), 'fixture selected');
  await tab.wait(`!document.getElementById('refresh-button').disabled`, 'project loaded');
  await tab.eval(`document.querySelector('#channel-list [data-focus-key="channel:${ids.channel}"]').click()`);
  await tab.wait(`!document.getElementById('chat-panel').hidden && !document.getElementById('refresh-button').disabled`, 'channel opened from overview');
}

const activityPath = channel => `/v1/channels/${ids[channel]}/activity`;
async function activity(type, options = {}) {
  const channel = options.channel || 'channel', actor = options.actor || 'writer';
  const body = {client_id: `${run}-${randomUUID()}`, session_id: `${run}-${channel}-session`, runtime: actor === 'writer' ? 'codex' : 'claude', event_type: type, ...(options.tool ? {tool_name: options.tool} : {}), ...(options.message ? {message_id: options.message} : {})};
  return (await api(activityPath(channel), 'POST', body, actor, 201)).activity;
}
const hasNative = item => `!!document.querySelector('#native-activity-list [data-native-id="${item.id}"]')`;
async function nativeTab(tab) { await tab.click('tab-native'); await tab.wait(`!document.getElementById('native-panel').hidden`, 'native tab'); }
async function selectChannel(tab, channel) {
  await tab.eval(`document.querySelector('#channel-list [data-focus-key="channel:${ids[channel]}"]').click()`);
  await tab.wait(textHas('current-channel', ids[channel]), 'channel selection');
  await nativeTab(tab);
}
async function setup() {
  for (const path of ['/', '/app.js', '/app.css']) { const result = await request(path, 'GET', undefined, 'owner', true); assert(result.status === 200, 'Asset unavailable'); report.assets[path] = createHash('sha256').update(result.data).digest('hex'); }
  assert((await api('/v1/me')).agent.id === 'admin-e2e-owner', 'Wrong staging owner');
  ids.side = `${run}-side`;
  for (const actor of ['writer', 'reviewer', 'viewer']) {
    await api('/v1/admin/principals', 'POST', {id: ids[actor], name: ids[actor], kind: actor === 'viewer' ? 'viewer' : 'agent', runtime: 'native-browser-no-model'}, 'owner', 201);
    created.add(actor); keys[actor] = (await api(`/v1/admin/principals/${ids[actor]}/rotate-key`, 'POST', {})).key; secrets.add(keys[actor]);
  }
  await api('/v1/admin/projects', 'POST', {id: ids.project, name: ids.project}, 'owner', 201);
  for (const name of ['channel', 'side', 'private-channel']) await api('/v1/admin/channels', 'POST', {id: ids[name], name: ids[name], project_id: ids.project}, 'owner', 201);
  for (const actor of ['writer', 'reviewer', 'viewer']) {
    const access = actor === 'viewer' ? 'read' : 'write';
    await grant(actor, 'project', 'project', access);
    for (const channel of ['channel', 'side']) await grant(actor, 'channel', channel, access);
  }
  await grant('writer', 'channel', 'private-channel', 'write');
  initial = await activity('session.started');
  await activity('session.started', {channel: 'private-channel'});
  profile = await mkdtemp(join(tmpdir(), 'agentlink-native-browser-')); log = await open(`${runtime}/evidence/${run}-browser.log`, 'wx', 0o600);
  const spki = createHash('sha256').update(new X509Certificate(ca).publicKey.export({type: 'spki', format: 'der'})).digest('base64');
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${spki}`, 'about:blank'], {stdio: ['ignore', log.fd, log.fd]});
  for (let i = 0; i < 100; i++) { assert(browser.exitCode === null, 'Owned browser exited'); try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {} await pause(100); }
  assert(port > 0, 'No owned browser port'); const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); browserCDP = new CDP(version.webSocketDebuggerUrl, 'browser');
  writer = await newTab('writer'); viewer = await newTab('viewer'); owner = await newTab('owner');
  await login(writer, 'writer'); await login(viewer, 'viewer'); await login(owner, 'owner');
}
try {
  await setup();
  await check('native tab is read-only, channel scoped and explicitly client-reported', async () => {
    for (const tab of tabs) { await nativeTab(tab); await tab.wait(hasNative(initial), 'initial native report'); }
    assert(tabs.every(tab => tab.requests.filter(r => r.path.startsWith('/v1/')).every(r => r.method === 'GET')), 'GUI navigation issued mutation');
    for (const tab of tabs) assert(await tab.eval(`document.getElementById('native-activity-list').textContent.includes('не проверено сервером') && !document.querySelector('#native-panel form') && !document.getElementById('native-activity-list').textContent.includes(${js(ids['private-channel'])})`), 'Wrong native provenance/scope');
  });
  await check('live turn/tool events preserve chat draft and do not restart authentication stream', async () => {
    await writer.click('tab-chat'); await writer.fill('message-input', 'Unsent draft during native activity'); await nativeTab(writer);
    const streams = writer.requests.filter(r => r.path === '/v1/workspace/stream').length;
    const turn = await activity('turn.started');
    const tool = await activity('tool.started', {tool: 'Read'});
    const failed = await activity('tool.failed', {tool: 'Read'});
    const completed = await activity('turn.completed');
    for (const tab of [writer, viewer]) {
      await tab.wait(hasNative(completed), 'live native completion');
      for (const item of [turn, tool, failed]) assert(await tab.eval(hasNative(item)), 'Native event missing');
      assert(await tab.eval(textHas('native-activity-list', 'не подтверждает выполнение задачи')), 'Turn completion overclaimed');
    }
    assert(await writer.eval(`document.getElementById('message-input').value==='Unsent draft during native activity'`), 'Native refresh discarded chat draft');
    assert(writer.requests.filter(r => r.path === '/v1/workspace/stream').length === streams, 'Native tab restarted auth stream');
    const status = await request(activityPath('channel'), 'POST', {client_id: 'reject-raw', session_id: 'test', runtime: 'codex', event_type: 'tool.started', command: 'DO NOT PUBLISH'}, 'writer');
    assert(status.status === 400, 'Raw command field accepted');
    assert(await viewer.eval(`!document.getElementById('native-activity-list').textContent.includes('DO NOT PUBLISH')`), 'Raw command leaked');
  });
  await check('inbox offer and acceptance remain distinct and never change legacy receipts', async () => {
    inboxMessage = (await api(`/v1/channels/${ids.channel}/messages`, 'POST', {client_id: `${run}-inbox`, body: 'PRIVATE MESSAGE BODY NOT NATIVE TELEMETRY', recipient_ids: [ids.writer]}, 'reviewer', 201)).message;
    const before = (await api(`/v1/messages/${inboxMessage.id}`, 'GET', undefined, 'writer')).message.receipts;
    const offered = await activity('inbox.offered', {message: inboxMessage.id});
    await viewer.wait(hasNative(offered), 'native inbox offer');
    assert(await viewer.eval(textHas('native-activity-list', 'Предложено — не значит принято')), 'Offer/acceptance distinction missing');
    const accepted = await activity('inbox.accepted', {message: inboxMessage.id}); await viewer.wait(hasNative(accepted), 'native inbox acceptance');
    assert(await viewer.eval(textHas('native-activity-list', 'не legacy-receipt')), 'Legacy receipt distinction missing');
    const after = (await api(`/v1/messages/${inboxMessage.id}`, 'GET', undefined, 'writer')).message.receipts;
    assert(JSON.stringify(before) === JSON.stringify(after), 'Native reports changed receipts');
    assert(await viewer.eval(`!document.getElementById('native-activity-list').textContent.includes('PRIVATE MESSAGE BODY')`), 'Native timeline exposed message body');
    const denied = await request(activityPath('channel'), 'POST', {client_id: 'forged-inbox', session_id: 'test', runtime: 'claude', event_type: 'inbox.accepted', message_id: inboxMessage.id}, 'reviewer');
    assert(denied.status === 404, 'Nonrecipient forged inbox acceptance');
  });
  await check('unselected channel activity gives update hint; changing channels clears old timeline', async () => {
    const other = await activity('agent.waiting', {channel: 'side'});
    await viewer.wait(`document.querySelector('#channel-list [data-focus-key="channel:${ids.side}"]')?.dataset.updated==='true'`, 'other-channel activity hint');
    assert(await viewer.eval(`!document.querySelector('#native-activity-list [data-native-id="${other.id}"]')`), 'Other channel event mixed into selection');
    await selectChannel(viewer, 'side'); await viewer.wait(hasNative(other), 'selected side activity');
    assert(await viewer.eval(`!document.querySelector('#native-activity-list [data-native-id="${initial.id}"]')`), 'Old channel native content retained');
    await selectChannel(viewer, 'channel'); await viewer.wait(hasNative(initial), 'return original activity');
    assert(await viewer.eval(`!document.querySelector('#native-activity-list [data-native-id="${other.id}"]')`), 'Side data mixed after return');
  });
  await check('revoked channel access clears native data; later grant returns without relogin', async () => {
    await grant('viewer', 'channel', 'channel', 'none');
    await viewer.wait(`!document.querySelector('#channel-list [data-focus-key="channel:${ids.channel}"]') && !document.querySelector('#native-activity-list [data-native-id="${initial.id}"]')`, 'native ACL revoked');
    await grant('viewer', 'channel', 'channel', 'read');
    // A rapid revoke/regrant may restore the exact sampled SSE revision. The
    // documented eight-second REST fallback must also fit within this deadline.
    await viewer.wait(`!!document.querySelector('#channel-list [data-focus-key="channel:${ids.channel}"]')`, 'native channel grant returns', 12000);
    await selectChannel(viewer, 'channel'); await viewer.wait(hasNative(initial), 'native history after regrant');
  });
  await check('archive hides ordinary native activity while owner retains read-only history', async () => {
    await api(`/v1/admin/projects/${ids.project}/archive`, 'POST', {});
    for (const tab of [writer, viewer]) await tab.wait(`document.getElementById('native-activity-list').textContent==='' && !document.getElementById('project-switcher').textContent.includes(${js(ids.project)})`, 'archive clears native data');
    await owner.wait(textHas('archived-project-notice', ids.project), 'owner archived history notice');
    assert(await owner.eval(hasNative(initial)), 'Owner lost archived native history');
    await api(`/v1/admin/projects/${ids.project}/restore`, 'POST', {});
    for (const tab of [writer, viewer]) await tab.wait(`document.getElementById('project-switcher').textContent.includes(${js(ids.project)})`, 'restore project');
    await selectChannel(viewer, 'channel'); await viewer.wait(hasNative(initial), 'restored native history');
  });
  await check('mobile native tab fits; logout clears native fields and aborts realtime', async () => {
    await viewer.call('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
    assert(await viewer.eval(`document.documentElement.scrollWidth<=innerWidth+1`), 'Native pane overflows mobile');
    for (const tab of tabs) { await tab.click('logout-button'); await tab.wait(`!document.getElementById('login-panel').hidden && document.getElementById('native-activity-list').textContent==='' && document.getElementById('native-activity-scope').textContent==='' && document.getElementById('native-history-notice').textContent==='' && localStorage.length===0 && sessionStorage.length===0`, 'native logout clearing'); await tab.wait(() => ![...tab.active.values()].some(r => r.path.startsWith('/v1/')), 'native logout abort'); }
    const counts = tabs.map(t => t.requests.length); await pause(1200); assert(tabs.every((t, index) => t.requests.length === counts[index]), 'Logout reconnected');
    assert(report.browser_errors.length === 0, 'Browser runtime errors');
  });
} catch (error) {
  if (!report.cases.some(item => !item.passed)) report.cases.push({name: 'infrastructure', passed: false, error: safeError(error)});
  report.failure_controls = [];
  for (const tab of tabs) { try { report.failure_controls.push({tab: tab.name, active_requests: [...tab.active.values()], state: await tab.eval(`Object.fromEntries(['native-panel','native-activity-scope','native-history-notice','api-error'].map(id=>{const e=document.getElementById(id);return[id,{hidden:e.hidden,text:e.textContent}]}))`)}); } catch {} }
} finally {
  for (const tab of tabs) { try { await tab.click('logout-button'); } catch {} tab.close(); }
  for (const actor of created) { try { await api(`/v1/admin/principals/${ids[actor]}/revoke-key`, 'POST', {}); } catch {} }
  if (browserCDP) { try { await browserCDP.call('Browser.close'); } catch {} browserCDP.close(); }
  if (browser?.exitCode === null) { browser.kill('SIGTERM'); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(3000)]); if (browser.exitCode === null) browser.kill('SIGKILL'); }
  if (log) await log.close(); if (profile) await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  report.existing_seed_unchanged = createHash('sha256').update(await readFile(seedPath)).digest('hex') === seedHash;
  report.assets_unchanged = (await Promise.all(Object.entries(report.assets).map(async ([path, digest]) => createHash('sha256').update((await request(path, 'GET', undefined, 'owner', true)).data).digest('hex') === digest))).every(Boolean);
  report.finished_at = new Date().toISOString(); report.passed = report.cases.length === 7 && report.cases.every(item => item.passed) && report.existing_seed_unchanged && report.assets_unchanged;
  const output = `${runtime}/evidence/native-gui.json`; await writeFile(output, JSON.stringify(report, null, 2) + '\n', {mode: 0o600}); console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, report: output}));
}
if (!report.passed) process.exitCode = 1;
