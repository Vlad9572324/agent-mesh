// One-command isolated project CLI-feed browser regression.
// Own schema in agentlink_test, own loopback TLS server, own Chromium. No shared
// seed credentials, agentlink_e2e dependency, production URL or model invocation.
// Run only after the backend/web changes are integrated: node tests/project_native_gui.mjs
import {readFile, writeFile, mkdtemp, mkdir, copyFile, rm, open, lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, createHash, X509Certificate} from 'node:crypto';
import net from 'node:net';
import https from 'node:https';
import {runtimeDir, certificateFile, browserExecutable} from '../scripts/operator-config.mjs';

process.umask(0o077);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = runtimeDir(), chrome = browserExecutable(), caPath = certificateFile();
const run = `project-native-${randomUUID().slice(0, 8)}`;
const schema = `project_native_gui_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const ids = Object.fromEntries(['owner', 'writer', 'peer', 'viewer', 'project', 'other', 'alpha', 'beta', 'quiet', 'private', 'other-channel'].map(name => [name, `${run}-${name}`]));
const report = {run, schema, database: 'agentlink_test', started_at: new Date().toISOString(), cases: [], assets: {},
  browser_errors: [], requests: [], layouts: [], screenshots: [], models_started: 0,
  scope: 'Owned isolated schema, loopback TLS API and Chromium; no shared fixture keys or production requests'};
const tabs = [], keys = {}, secrets = new Set(), publicEvents = [], privateEvents = [];
const js = JSON.stringify, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
const eventSelector = item => `#project-native-list [data-native-id="${item.id}"]`;
const hasEvent = item => `!!document.querySelector(${js(eventSelector(item))})`;
const rows = `Array.from(document.querySelectorAll('#project-native-list [data-native-id]')).map(e=>({id:e.dataset.nativeId,channel:e.dataset.channelId}))`;
let directory, scratch, base, ca, pgEnv, sourceDSNHash, ownerKeyPath, childSerial = 0;
let server, serverLog, browser, browserLog, browserCDP, profile, schemaCreated = false, writer, viewer, owner;
let firstAlpha, lastBeta, oldQuiet, otherEvent, actorName = 'Agent <img src=x onerror=window.nativeFeedInjected=1>';
function safeError(error) { let value = String(error?.message || error); for (const key of secrets) value = value.replaceAll(key, '[REDACTED]'); return value.slice(0, 350); }
async function check(name, action) {
  const started = performance.now();
  try { await action(); report.cases.push({name, passed: true, ms: Math.round(performance.now() - started)}); }
  catch (error) { report.cases.push({name, passed: false, error: safeError(error)}); throw error; }
  finally { console.log(JSON.stringify(report.cases.at(-1))); }
}
async function privateRead(path) {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077), 'Expected private regular fixture file');
  return readFile(path);
}
async function command(binary, args, label, {env = process.env, input, timeout = 45000} = {}) {
  const index = ++childSerial;
  const result = await new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
    const stdout = [], stderr = []; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
    child.once('error', () => { clearTimeout(timer); reject(new Error(`Fixture command unavailable: ${label}`)); });
    child.once('exit', code => { clearTimeout(timer); resolveCommand({code, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)}); });
    child.stdin.end(input);
  });
  await writeFile(`${directory}/${index}-${label}.private.stdout`, result.stdout, {mode: 0o600, flag: 'wx'});
  await writeFile(`${directory}/${index}-${label}.private.stderr`, result.stderr, {mode: 0o600, flag: 'wx'});
  assert(result.code === 0 && !result.timedOut, `Fixture command failed: ${label}`); return result.stdout;
}
function sql(statement, label) {
  assert(/^project_native_gui_[a-f0-9]{16}$/.test(schema), 'Owned schema name invalid');
  return command(`${runtime}/pgsql/usr/lib/postgresql/14/bin/psql`, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], label, {env: pgEnv, input: statement, timeout: 20000});
}
async function isolatedServer() {
  directory = await mkdtemp(`${runtime}/evidence/project-native-gui-`);
  scratch = await mkdtemp(join(tmpdir(), 'agentlink-project-native-'));
  const source = await privateRead(`${runtime}/secrets/agentlink_test-dsn`); sourceDSNHash = hash(source);
  const url = new URL(source.toString('utf8').trim());
  assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && decodeURIComponent(url.pathname) === '/agentlink_test', 'Only loopback agentlink_test is allowed');
  assert(!url.searchParams.has('host') && !url.searchParams.has('port'), 'Ambiguous database endpoint');
  pgEnv = {...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: 'agentlink_test',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: url.searchParams.get('sslmode') || 'prefer',
    PGCONNECT_TIMEOUT: '5', LD_LIBRARY_PATH: `${runtime}/pgsql/usr/lib/x86_64-linux-gnu`};
  delete pgEnv.PGOPTIONS;
  assert((await sql('SELECT current_database();', 'database-boundary')).toString().trim() === 'agentlink_test', 'Wrong database');
  await sql(`CREATE SCHEMA "${schema}";`, 'create-owned-schema'); schemaCreated = true;
  url.searchParams.set('search_path', schema);
  const dsnPath = `${scratch}/database.private`; await writeFile(dsnPath, url.toString() + '\n', {mode: 0o600, flag: 'wx'});
  const binary = `${scratch}/agent-link`; await command('go', ['build', '-o', binary, './cmd/agent-link'], 'build', {timeout: 60000});
  const web = `${scratch}/web`; await mkdir(web, {mode: 0o700});
  for (const name of ['index.html', 'app.js', 'app.css']) { await copyFile(`${root}/web/${name}`, `${web}/${name}`); report.assets[name] = hash(await readFile(`${web}/${name}`)); }
  ownerKeyPath = `${scratch}/owner.private.json`;
  await command(binary, ['bootstrap-owner', '--database-url-file', dsnPath, '--owner-id', ids.owner, '--owner-name', 'Isolated browser owner', '--key-out', ownerKeyPath], 'bootstrap-owner');
  const credential = JSON.parse((await privateRead(ownerKeyPath)).toString('utf8'));
  assert(credential.agent_id === ids.owner, 'Wrong fresh fixture owner'); keys.owner = credential.key; secrets.add(keys.owner);
  const reservation = net.createServer(); await new Promise((resolveListen, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolveListen); });
  const port = reservation.address().port; await new Promise(resolveClose => reservation.close(resolveClose));
  base = `https://127.0.0.1:${port}/`; report.base = base;
  ca = await readFile(caPath);
  serverLog = await open(`${directory}/server.private.log`, 'wx', 0o600);
  server = spawn(binary, ['serve', '--database-url-file', dsnPath, '--listen', `127.0.0.1:${port}`, '--tls-cert', `${runtime}/secrets/server.crt`,
    '--tls-key', `${runtime}/secrets/server.key`, '--web-dir', web], {cwd: root, stdio: ['ignore', serverLog.fd, serverLog.fd]});
  let spawnFailed = false; server.once('error', () => { spawnFailed = true; });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    assert(!spawnFailed && server.exitCode === null, 'Owned TLS API exited');
    try { ready = (await api('/v1/me')).agent.id === ids.owner; if (ready) break; } catch {}
    await pause(100);
  }
  assert(ready, 'Owned TLS API did not start');
  assert((await api(`/v1/projects/${ids.project}/activity?limit=1`, 'GET', undefined, 'owner', 404)), 'Project activity route unavailable');
}
function request(path, method = 'GET', body, actor = 'owner', raw = false) {
  const url = new URL(path, base);
  assert(url.protocol === 'https:' && url.hostname === '127.0.0.1' && url.origin === new URL(base).origin, 'Fixture API refuses nonowned origin');
  return new Promise((resolveRequest, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(url, {ca, method, timeout: 10000, headers: {Authorization: `Bearer ${keys[actor]}`,
      ...(payload === undefined ? {} : {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)})}}, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('end', () => {
        try { const bytes = Buffer.concat(chunks); resolveRequest({status: res.statusCode, data: raw ? bytes : bytes.length ? JSON.parse(bytes.toString()) : null}); }
        catch { reject(new Error('Owned API invalid response')); }
      });
    });
    req.on('error', () => reject(new Error('Owned certificate-verified API unavailable'))); req.on('timeout', () => req.destroy()); req.end(payload);
  });
}
async function api(path, method = 'GET', body, actor = 'owner', expected = 200) {
  const result = await request(path, method, body, actor); assert(result.status === expected, `${method} ${path.split('?')[0]} status ${result.status}, expected ${expected}`); return result.data;
}
const grant = (actor, scope, resource, access) => api('/v1/admin/access', 'PUT', {agent_id: ids[actor], scope, resource_id: ids[resource], access});
const feedPath = (project = 'project', query = '') => `/v1/projects/${ids[project]}/activity?limit=100${query}`;
async function activity(type, channel = 'alpha', actor = 'writer') {
  return (await api(`/v1/channels/${ids[channel]}/activity`, 'POST', {client_id: `${run}-${randomUUID()}`,
    session_id: `${run}-${actor}-client-session`, runtime: actor === 'peer' ? 'claude' : 'codex', event_type: type,
    ...(type.startsWith('tool.') ? {tool_name: 'Read'} : {})}, actor, 201)).activity;
}
async function fixtures() {
  for (const actor of ['writer', 'peer', 'viewer']) {
    await api('/v1/admin/principals', 'POST', {id: ids[actor], name: actor === 'writer' ? actorName : ids[actor], kind: actor === 'viewer' ? 'viewer' : 'agent', runtime: 'browser-fixture-no-model'}, 'owner', 201);
    keys[actor] = (await api(`/v1/admin/principals/${ids[actor]}/rotate-key`, 'POST', {})).key; secrets.add(keys[actor]);
  }
  for (const name of ['project', 'other']) await api('/v1/admin/projects', 'POST', {id: ids[name], name: ids[name]}, 'owner', 201);
  for (const name of ['alpha', 'beta', 'quiet', 'private', 'other-channel']) await api('/v1/admin/channels', 'POST', {id: ids[name], name: ids[name], project_id: ids[name === 'other-channel' ? 'other' : 'project']}, 'owner', 201);
  for (const actor of ['writer', 'peer', 'viewer']) {
    const access = actor === 'viewer' ? 'read' : 'write';
    for (const name of ['project', 'other']) await grant(actor, 'project', name, access);
    for (const name of ['alpha', 'beta', 'quiet', 'other-channel']) await grant(actor, 'channel', name, access);
  }
  await grant('writer', 'channel', 'private', 'write');
  oldQuiet = await activity('session.ended', 'quiet', 'peer');
  // Backdate only this owned schema's fixture to check stale-event truthfulness
  // without waiting five minutes or altering production/browser wall clocks.
  assert(/^[a-f0-9]{32}$/.test(oldQuiet.id), 'Unexpected fixture event ID');
  await sql(`UPDATE "${schema}".native_activity SET created_at=clock_timestamp()-interval '10 minutes' WHERE id='${oldQuiet.id}';`, 'age-owned-fixture');
  oldQuiet = (await api(`/v1/channels/${ids.quiet}/activity?after_seq=0&limit=2`)).activity[0]; publicEvents.push(oldQuiet);
  for (let i = 0; i < 104; i++) { const event = await activity(i % 2 ? 'tool.completed' : 'turn.started'); publicEvents.push(event); firstAlpha ||= event; }
  for (let i = 0; i < 6; i++) { lastBeta = await activity('agent.waiting', 'beta', 'peer'); publicEvents.push(lastBeta); }
  privateEvents.push(await activity('session.started', 'private'));
  otherEvent = await activity('session.started', 'other-channel', 'peer');
}

class CDP {
  constructor(url, name) {
    this.ws = new WebSocket(url); this.name = name; this.serial = 0; this.pending = new Map(); this.requests = []; this.active = new Map();
    this.ready = new Promise((resolveSocket, reject) => { this.ws.onopen = resolveSocket; this.ws.onerror = () => reject(new Error('Owned CDP unavailable')); });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) { const item = this.pending.get(message.id); clearTimeout(item.timer); this.pending.delete(message.id); message.error ? item.reject(new Error(`CDP ${item.method} failed`)) : item.resolve(message.result); }
      if (message.method === 'Runtime.exceptionThrown') report.browser_errors.push({tab: name, category: message.params.exceptionDetails.text});
      if (message.method === 'Page.javascriptDialogOpening') void this.call('Page.handleJavaScriptDialog', {accept: false}).catch(() => {});
      if (message.method === 'Fetch.requestPaused') {
        const {request, requestId} = message.params, url = new URL(request.url);
        const deny = request.method !== 'GET' || url.origin !== new URL(base).origin;
        if (deny) report.browser_guard_failed = true;
        void this.call(deny ? 'Fetch.failRequest' : 'Fetch.continueRequest', deny ? {requestId, errorReason: 'BlockedByClient'} : {requestId}).catch(() => {});
      }
      if (message.method === 'Network.requestWillBeSent') {
        const req = message.params.request, url = new URL(req.url);
        const entry = {tab: name, method: req.method, path: url.origin === new URL(base).origin ? url.pathname : '[off-origin]', query: url.search};
        this.requests.push(entry); report.requests.push(entry); this.active.set(message.params.requestId, entry);
      }
      if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) this.active.delete(message.params.requestId);
    };
  }
  async call(method, params = {}) {
    await this.ready;
    return new Promise((resolveCall, reject) => { const id = ++this.serial, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, 10000);
      this.pending.set(id, {method, resolve: resolveCall, reject, timer}); this.ws.send(JSON.stringify({id, method, params})); });
  }
  async eval(expression) { const value = await this.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}); assert(!value.exceptionDetails, `Browser expression failed in ${this.name}, expression omitted`); return value.result.value; }
  async wait(expression, label, timeout = 6500) {
    const started = Date.now(); while (Date.now() - started < timeout) { if (typeof expression === 'function' ? await expression() : await this.eval(expression)) return; await pause(75); }
    throw new Error(`${this.name}: ${label} timeout`);
  }
  async click(selector) {
    await this.call('Page.bringToFront'); let point;
    await this.wait(async () => {
      point = await this.eval(`(()=>{const e=document.querySelector(${js(selector)});if(!e||e.closest('[hidden]'))return null;e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,t=document.elementFromPoint(x,y);return {x,y,ok:r.width>0&&r.height>0&&!e.disabled&&(t===e||e.contains(t))};})()`);
      return point?.ok;
    }, `clickable ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) await this.call('Input.dispatchMouseEvent', {type, x: point.x, y: point.y, button: 'left', clickCount: 1});
  }
  async fill(id, value) {
    await this.click(`#${id}`);
    await this.call('Input.dispatchKeyEvent', {type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2});
    await this.call('Input.dispatchKeyEvent', {type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2});
    await this.call('Input.insertText', {text: value});
  }
  async filter(id, value) {
    await this.wait(`!document.getElementById(${js(id)}).disabled && !!Array.from(document.getElementById(${js(id)}).options).find(e=>e.value===${js(value)})`, 'filter option');
    await this.eval(`(()=>{const e=document.getElementById(${js(id)});e.focus();e.value=${js(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  close() { this.ws.close(); }
}
const testingTransport = `(()=>{const original=window.fetch.bind(window);let transport;window.__holdNextProjectFeed='';window.__heldFeedReady=false;window.__releaseFeed=null;
  window.fetch=async(input,init)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);let options=init;
    if(url.pathname==='/v1/workspace/stream'){transport=new AbortController();options={...init,signal:init?.signal?AbortSignal.any([init.signal,transport.signal]):transport.signal};}
    const hold=window.__holdNextProjectFeed&&url.pathname===window.__holdNextProjectFeed;if(hold)window.__holdNextProjectFeed='';
    const response=await original(input,options);if(!hold)return response;
    // Buffer a REAL response before delaying delivery. Releasing it deliberately
    // outlives AbortSignal so application scope/auth guards must reject it.
    const bytes=await response.arrayBuffer(),headers=[...response.headers],status=response.status;
    window.__heldFeedReady=true;return new Promise(resolve=>{window.__releaseFeed=()=>{window.__heldFeedReady=false;window.__releaseFeed=null;resolve(new Response(bytes,{status,headers}));};});};
  window.__cutWorkspace=()=>transport?.abort();})();`;
async function browsers() {
  profile = await mkdtemp(join(tmpdir(), 'agentlink-project-native-browser-')); browserLog = await open(`${directory}/browser.private.log`, 'wx', 0o600);
  const spki = createHash('sha256').update(new X509Certificate(ca).publicKey.export({type: 'spki', format: 'der'})).digest('base64');
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${spki}`, 'about:blank'], {stdio: ['ignore', browserLog.fd, browserLog.fd]});
  let port, failed = false; browser.once('error', () => { failed = true; });
  for (let i = 0; i < 100; i++) { assert(!failed && browser.exitCode === null, 'Owned browser exited'); try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {} await pause(100); }
  assert(port > 0, 'Owned browser not ready'); const address = `http://127.0.0.1:${port}`;
  browserCDP = new CDP((await (await fetch(`${address}/json/version`)).json()).webSocketDebuggerUrl, 'browser');
  for (const actor of ['writer', 'viewer', 'owner']) {
    const target = await browserCDP.call('Target.createTarget', {url: 'about:blank'}), targets = await (await fetch(`${address}/json/list`)).json();
    const tab = new CDP(targets.find(item => item.id === target.targetId).webSocketDebuggerUrl, actor); tabs.push(tab);
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await tab.call(method);
    await tab.call('Page.addScriptToEvaluateOnNewDocument', {source: testingTransport});
    await tab.call('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]});
    await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
    await tab.call('Page.navigate', {url: new URL('?lang=ru', base).href}); await tab.wait(`document.readyState==='complete' && !!document.getElementById('nav-project-native')`, 'project feed page', 15000);
    if (actor === 'writer') writer = tab; else if (actor === 'viewer') viewer = tab; else owner = tab;
    await login(tab, actor);
  }
}
async function login(tab, actor) {
  await tab.fill('api-key', keys[actor]); await tab.click('#login-button');
  await tab.wait(`document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled`, 'login ready');
  await project(tab);
}
async function project(tab, name = 'project') {
  await tab.click(`#project-switcher [data-focus-key="project:${ids[name]}"]`);
  await tab.wait(`document.querySelector('[data-focus-key="project:${ids[name]}"]').getAttribute('aria-pressed')==='true' && !document.getElementById('refresh-button').disabled`, 'project selected');
  await feed(tab);
}
async function feed(tab) { await tab.click('#nav-project-native'); await tab.wait(`!document.getElementById('project-native-panel').hidden`, 'project feed opened'); }
async function resetFilters(tab) {
  await tab.filter('project-native-actor', ''); await tab.filter('project-native-channel', '');
  await tab.wait(`document.getElementById('project-native-actor').value==='' && document.getElementById('project-native-channel').value===''`, 'all filters');
}
async function holdRead(tab) {
  await tab.eval(`window.__heldFeedReady=false;window.__holdNextProjectFeed=${js(`/v1/projects/${ids.project}/activity`)}`);
  await tab.click('#refresh-button'); await tab.wait('window.__heldFeedReady===true', 'real feed response held');
}
async function screenshot(tab, label, width) {
  await tab.call('Page.bringToFront'); await tab.eval(`window.scrollTo(0,0)`);
  assert(await tab.eval(`(()=>{const keys=${js([...secrets])};return !keys.some(key=>document.body.innerText.includes(key)||Array.from(document.querySelectorAll('input,textarea')).some(e=>e.value.includes(key)));})()`), 'Screenshot could contain secret');
  const file = `${directory}/${label}.png`; const shot = await tab.call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  await writeFile(file, Buffer.from(shot.data, 'base64'), {mode: 0o600, flag: 'wx'}); report.screenshots.push({label, width, file});
}
async function stopChild(child) {
  for (const signal of ['SIGTERM', 'SIGKILL']) if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill(signal); await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), pause(2500)]); }
  return !child || !child.pid || child.exitCode !== null || child.signalCode !== null;
}

try {
  await check('owned schema TLS fixtures and browser load latest project events without choosing a channel', async () => {
    await isolatedServer(); await fixtures(); await browsers();
    const expected = (await api(feedPath(), 'GET', undefined, 'viewer')).activity;
    await viewer.wait(`${rows}.length===100`, 'first bounded page');
    assert(JSON.stringify((await viewer.eval(rows)).map(e => e.id)) === JSON.stringify(expected.map(e => e.id)), 'Project feed differs from DESC API page');
    assert(await viewer.eval(`!document.querySelector(${js(eventSelector(privateEvents[0]))}) && !document.getElementById('project-native-list').textContent.includes(${js(ids.private)}) && !document.querySelector('#project-native-list img') && !window.nativeFeedInjected`), 'Hidden channel or executable actor markup leaked');
    await owner.wait(hasEvent(privateEvents[0]), 'owner private channel visibility');
    assert(await viewer.eval(`!document.querySelector('#project-native-panel form') && /клиент|самоотч|не проверено/i.test(document.getElementById('project-native-panel').textContent)`), 'Project feed provenance/write boundary missing');
    assert(!report.browser_guard_failed && report.requests.every(r => r.method === 'GET'), 'Read-only GUI attempted a mutation');
  });
  await check('actor/channel filters intersect and empty filtered results are explicit', async () => {
    await viewer.filter('project-native-channel', ids.beta);
    await viewer.wait(`${rows}.length===6 && ${rows}.every(e=>e.channel===${js(ids.beta)})`, 'channel intersection');
    await viewer.filter('project-native-actor', ids.writer);
    await viewer.wait(`${rows}.length===0 && document.getElementById('project-native-last-event').dataset.freshness==='empty'`, 'empty actor/channel filter');
    assert(await viewer.eval(`/нет|не найден|пока/i.test(document.getElementById('project-native-list').textContent)`), 'Empty feed claims activity');
    await viewer.filter('project-native-actor', ids.peer); await viewer.wait(`${rows}.length===6`, 'matching actor/channel filter');
    await resetFilters(viewer); await viewer.wait(`${rows}.length===100`, 'all project events restored');
  });
  await check('opaque load older pagination is complete ordered duplicate-free and bounded', async () => {
    await viewer.click('#project-native-more'); await viewer.wait(`${rows}.length===111`, 'older page appended');
    const expected = [...publicEvents].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).map(e => e.id);
    const actual = (await viewer.eval(rows)).map(e => e.id);
    assert(new Set(actual).size === 111 && JSON.stringify(actual) === JSON.stringify(expected), 'Older events missing, duplicated or unordered');
    assert(viewer.requests.some(r => r.path === `/v1/projects/${ids.project}/activity` && new URLSearchParams(r.query).has('before')), 'Older page did not use opaque cursor');
    assert(await viewer.eval(`document.getElementById('project-native-more').hidden || document.getElementById('project-native-more').disabled`), 'End of history still allows duplicate loads');
  });
  await check('last-event freshness dates an observation not a live model or server lease', async () => {
    await viewer.filter('project-native-channel', ids.quiet);
    await viewer.wait(`${rows}.length===1 && document.getElementById('project-native-last-event').dataset.freshness==='stale'`, 'old observation stale');
    assert(await viewer.eval(`/событи|наблюден|отч[её]т/i.test(document.getElementById('project-native-last-event').textContent) && /не.*(модел|работ|выполн)|не доказыв/i.test(document.getElementById('project-native-panel').textContent)`), 'Freshness overclaims model execution');
    await viewer.filter('project-native-channel', ids.beta);
    await viewer.wait(`document.getElementById('project-native-last-event').dataset.freshness==='fresh'`, 'recent observation fresh');
    await resetFilters(viewer);
  });
  await check('channel native remains scoped and project SSE catchup preserves an unsent chat draft', async () => {
    await writer.click(`#channel-list [data-focus-key="channel:${ids.alpha}"]`);
    await writer.wait(`!document.getElementById('composer-form').hidden && !document.getElementById('refresh-button').disabled`, 'writer chat');
    await writer.fill('message-input', `${run} unsent chat draft`); await writer.click('#tab-native');
    await writer.wait(`!!document.querySelector('#native-activity-list [data-native-id="${firstAlpha.id}"]')`, 'legacy channel native');
    assert(await writer.eval(`!document.querySelector('#native-activity-list [data-native-id="${lastBeta.id}"]')`), 'Project aggregation changed legacy channel scope');
    await feed(writer); await writer.wait(`${rows}.length>0`, 'project feed before interruption');
    const navigations = await writer.eval('performance.timeOrigin');
    await writer.eval('window.__cutWorkspace()');
    for (let i = 0; i < 2; i++) await activity('turn.completed', 'beta', 'peer');
    const latest = await activity('turn.completed', 'alpha', 'writer');
    await writer.wait(hasEvent(latest), 'SSE reconnect catchup', 12000); await viewer.wait(hasEvent(latest), 'live update in idle viewer');
    assert(await writer.eval(`performance.timeOrigin===${navigations} && document.getElementById('message-input').value===${js(`${run} unsent chat draft`)} && document.querySelector('#project-native-list [data-native-id]').dataset.nativeId===${js(latest.id)}`), 'Catchup lost draft/reloaded or missed latest-first event');
    await writer.wait(`document.querySelector('[data-focus-key="channel:${ids.alpha}"]').dataset.updated==='true'`, 'selected chat gets update hint while project feed is open');
    await writer.click(`#channel-list [data-focus-key="channel:${ids.alpha}"]`);
    await writer.wait(`!document.getElementById('composer-form').hidden && !document.getElementById('refresh-button').disabled`, 'same chat roundtrip');
    assert(await writer.eval(`document.getElementById('message-input').value===${js(`${run} unsent chat draft`)}`), 'Project feed to same chat discarded unsent draft');
    await feed(writer);
  });
  await check('late project response cannot refill the next project cache', async () => {
    await holdRead(viewer); await project(viewer, 'other'); await viewer.wait(hasEvent(otherEvent), 'other project activity');
    await viewer.eval('window.__releaseFeed()'); await pause(250);
    assert(await viewer.eval(`${rows}.length===1 && ${hasEvent(otherEvent)} && !document.getElementById('project-native-list').textContent.includes(${js(ids.alpha)})`), 'Late old-project response leaked into new project');
    await project(viewer); await viewer.wait(`${rows}.length>0`, 'original project restored');
  });
  await check('channel ACL revocation removes loaded rows and ignores held pre-revocation responses', async () => {
    // First exercise unattended SSE revocation, without an artificial stalled
    // request preventing the application's serialized refresh from progressing.
    await grant('viewer', 'channel', 'alpha', 'none');
    await viewer.wait(`!Array.from(document.getElementById('project-native-channel').options).some(e=>e.value===${js(ids.alpha)}) && !${rows}.some(e=>e.channel===${js(ids.alpha)})`, 'revoked channel pruned', 10000);
    await grant('viewer', 'channel', 'alpha', 'read');
    await viewer.wait(`Array.from(document.getElementById('project-native-channel').options).some(e=>e.value===${js(ids.alpha)})`, 'first grant returns', 12000);
    await holdRead(viewer); await grant('viewer', 'channel', 'alpha', 'none');
    // Re-enter the view to supersede the deliberately unabortable old response,
    // then verify an acknowledged current ACL cannot be undone by that response.
    await viewer.click('#nav-overview'); await feed(viewer);
    await viewer.wait(`!Array.from(document.getElementById('project-native-channel').options).some(e=>e.value===${js(ids.alpha)}) && !${rows}.some(e=>e.channel===${js(ids.alpha)})`, 'current ACL reconciled', 10000);
    await viewer.eval('window.__releaseFeed()'); await pause(250);
    assert(await viewer.eval(`!${rows}.some(e=>e.channel===${js(ids.alpha)})`), 'Held response restored revoked channel content');
    await grant('viewer', 'channel', 'alpha', 'read');
    await viewer.wait(`Array.from(document.getElementById('project-native-channel').options).some(e=>e.value===${js(ids.alpha)})`, 'grant returns', 12000);
  });
  await check('key rotation logs out idle feed and held authenticated data cannot repopulate DOM', async () => {
    await holdRead(viewer);
    keys.viewer = (await api(`/v1/admin/principals/${ids.viewer}/rotate-key`, 'POST', {})).key; secrets.add(keys.viewer);
    await viewer.wait(`!document.getElementById('login-panel').hidden && document.getElementById('project-native-list').textContent===''`, 'rotated-key logout', 12000);
    await viewer.eval('window.__releaseFeed()'); await pause(200);
    assert(await viewer.eval(`document.getElementById('project-native-list').textContent==='' && document.getElementById('api-key').value===''`), 'Late authenticated response survived key rotation');
    await login(viewer, 'viewer'); await viewer.wait(`${rows}.length>0`, 'new key reads original identity data');
  });
  await check('mobile project activity filters and timeline fit 360 and 390 pixel viewports', async () => {
    await screenshot(viewer, 'project-cli-desktop', 1440);
    for (const width of [360, 390]) {
      await viewer.call('Emulation.setDeviceMetricsOverride', {width, height: 844, deviceScaleFactor: 1, mobile: true});
      await viewer.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const layout = await viewer.eval(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,filters:Array.from(document.querySelectorAll('#project-native-channel,#project-native-actor')).map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right};})})`);
      report.layouts.push(layout); assert(layout.scrollWidth <= layout.width + 1 && layout.filters.every(r => r.left >= 0 && r.right <= width + 1), 'Project feed mobile overflow');
      await screenshot(viewer, `project-cli-mobile-${width}`, width);
    }
  });
  await check('project ACL removal and logout clear every activity field and stop authenticated traffic', async () => {
    await grant('writer', 'project', 'project', 'none');
    await writer.wait(`!document.querySelector('[data-focus-key="project:${ids.project}"]') && !document.getElementById('project-native-list').textContent.includes(${js(ids.alpha)}) && document.getElementById('message-input').value===''`, 'project revoke clears protected cache', 10000);
    for (const tab of tabs) {
      await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
      await tab.click('#logout-button');
      await tab.wait(`!document.getElementById('login-panel').hidden && document.getElementById('project-native-list').textContent==='' && document.getElementById('project-native-last-event').textContent==='' && document.getElementById('project-native-status').textContent==='' && localStorage.length===0 && sessionStorage.length===0`, 'logout activity cleared');
      await tab.wait(() => ![...tab.active.values()].some(r => r.path.startsWith('/v1/')), 'requests aborted');
    }
    const counts = tabs.map(tab => tab.requests.length); await pause(1200);
    assert(tabs.every((tab, index) => tab.requests.length === counts[index]), 'Logout reconnected');
    assert(!report.browser_guard_failed && report.browser_errors.length === 0, 'Browser safety/runtime failure');
  });
} catch (error) {
  if (!report.cases.some(item => !item.passed)) report.cases.push({name: 'infrastructure', passed: false, error: safeError(error)});
  report.failure_controls = [];
  for (const tab of tabs) { try { report.failure_controls.push({tab: tab.name, state: await tab.eval(`({login:document.getElementById('login-panel')?.hidden,panel:document.getElementById('project-native-panel')?.hidden,status:document.getElementById('project-native-status')?.textContent,freshness:document.getElementById('project-native-last-event')?.dataset.freshness,rows:${rows}.length})`)}); } catch {} }
} finally {
  for (const tab of tabs) { try { await tab.eval(`window.__releaseFeed?.();document.getElementById('logout-button')?.click()`); } catch {} tab.close(); }
  if (browserCDP) { try { await browserCDP.call('Browser.close'); } catch {} browserCDP.close(); }
  report.owned_browser_stopped = await stopChild(browser);
  report.owned_server_stopped = await stopChild(server);
  if (browserLog) await browserLog.close(); if (serverLog) await serverLog.close();
  if (schemaCreated && report.owned_server_stopped) {
    try { await sql(`DROP SCHEMA "${schema}" CASCADE;`, 'drop-owned-schema'); report.owned_schema_removed = true; }
    catch { report.owned_schema_removed = false; }
  } else report.owned_schema_removed = !schemaCreated;
  try { report.source_test_DSN_unchanged = hash(await privateRead(`${runtime}/secrets/agentlink_test-dsn`)) === sourceDSNHash; } catch { report.source_test_DSN_unchanged = false; }
  if (profile && report.owned_browser_stopped) await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  if (scratch && report.owned_server_stopped && report.owned_schema_removed) await rm(scratch, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  report.finished_at = new Date().toISOString();
  report.success = report.cases.length === 10 && report.cases.every(item => item.passed) && report.owned_browser_stopped && report.owned_server_stopped && report.owned_schema_removed && report.source_test_DSN_unchanged;
  const output = directory ? `${directory}/evidence.json` : `${runtime}/evidence/project-native-gui-setup-failed.json`;
  let serialized = JSON.stringify(report, null, 2) + '\n'; for (const key of secrets) serialized = serialized.replaceAll(key, '[REDACTED]');
  await writeFile(output, serialized, {mode: 0o600, flag: 'wx'});
  console.log(JSON.stringify({success: report.success, cases: report.cases.length, owned_schema_removed: report.owned_schema_removed, owned_server_stopped: report.owned_server_stopped,
    owned_browser_stopped: report.owned_browser_stopped, evidence: output}));
}
if (!report.success) process.exitCode = 1;
