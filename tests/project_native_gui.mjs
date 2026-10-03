// One-command isolated project CLI-feed browser regression.
// Own schema in agentlink_test, own loopback TLS server, own Chromium. No shared
// seed credentials, agentlink_e2e dependency, production URL or model invocation.
// Run only after the backend/web changes are integrated: node tests/project_native_gui.mjs
// Focused quiet-feed regression: node tests/project_native_gui.mjs --quiet-only
// Focused sender receipt regression: node tests/project_native_gui.mjs --receipts-only
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
const quietOnly = process.argv.includes('--quiet-only');
const receiptsOnly = process.argv.includes('--receipts-only');
if (quietOnly && receiptsOnly) throw new Error('Choose one focused browser suite');
const technicalTypes = new Set(['session.started', 'session.ended', 'turn.started', 'turn.completed',
  'tool.started', 'tool.completed', 'agent.waiting', 'inbox.offered']);
const quietTechnical = [], quietImportant = [];
const runtime = runtimeDir(), chrome = browserExecutable(), caPath = certificateFile();
const run = `project-native-${randomUUID().slice(0, 8)}`;
const schema = `project_native_gui_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const ids = Object.fromEntries(['owner', 'writer', 'peer', 'viewer', 'project', 'other', 'alpha', 'beta', 'quiet', 'private', 'other-channel'].map(name => [name, `${run}-${name}`]));
const readPaths = new Set(['alpha', 'beta', 'quiet', 'other-channel'].map(name => `/v1/channels/${ids[name]}/read`));
const allowedBrowserRequest = item => item.method === 'GET' || item.method === 'PUT' && readPaths.has(item.path) && ['writer', 'viewer', 'owner'].includes(item.tab);
const report = {run, schema, database: 'agentlink_test', started_at: new Date().toISOString(), cases: [], assets: {},
  browser_errors: [], requests: [], layouts: [], screenshots: [], models_started: 0,
  scope: 'Owned isolated schema, loopback TLS API and Chromium; no shared fixture keys or production requests'};
report.mode = receiptsOnly ? 'native-receipts' : quietOnly ? 'quiet' : 'project-feed';
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
async function activity(type, channel = 'alpha', actor = 'writer', messageId) {
  return (await api(`/v1/channels/${ids[channel]}/activity`, 'POST', {client_id: `${run}-${randomUUID()}`,
    session_id: `${run}-${actor}-client-session`, runtime: actor === 'peer' ? 'claude' : 'codex', event_type: type,
    ...(type.startsWith('tool.') ? {tool_name: 'Read'} : {}), ...(messageId ? {message_id: messageId} : {})}, actor, 201)).activity;
}
async function message(channel = 'alpha', body = 'Isolated meaningful message', actor = 'peer') {
  return (await api(`/v1/channels/${ids[channel]}/messages`, 'POST', {
    client_id: `${run}-${randomUUID()}`, body, recipient_ids: [ids[actor === 'peer' ? 'writer' : 'peer']],
  }, actor, 201)).message;
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
  if (receiptsOnly) return;
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
        const deny = url.origin !== new URL(base).origin || !allowedBrowserRequest({method: request.method, path: url.pathname, tab: name});
        if (deny) report.browser_guard_failed = true;
        if (!deny && receiptsOnly && this.failNextNativeReceipt && url.pathname.endsWith('/native-receipts')) {
          this.failNextNativeReceipt = false;
          // One explicit browser-boundary fault, restricted to the owned origin.
          // The next refresh again receives the real authenticated aggregate.
          void this.call('Fetch.fulfillRequest', {requestId, responseCode: 503, body: ''}).catch(() => {});
        } else void this.call(deny ? 'Fetch.failRequest' : 'Fetch.continueRequest', deny ? {requestId, errorReason: 'BlockedByClient'} : {requestId}).catch(() => {});
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
    if (receiptsOnly) {
      // Isolate the actual SSE refresh path: suppress only the eight-second
      // fallback poll, while preserving all fetch/timeout/refresh behavior.
      await tab.call('Page.addScriptToEvaluateOnNewDocument', {source: `(()=>{const timeout=window.setTimeout.bind(window);window.__suppressedPolls=0;window.setTimeout=(fn,delay,...args)=>{if(delay===8000){window.__suppressedPolls++;return timeout(()=>{},delay);}return timeout(fn,delay,...args);};})()`});
    }
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
  // The historical regression deliberately inspects every archived event.
  // The quiet regression keeps the product's default until testing the toggle.
  if (!quietOnly && !receiptsOnly && !await tab.eval(`document.getElementById('project-native-technical').checked`)) await tab.click('#project-native-technical');
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

async function receiptCases() {
  let reference, acceptedOnly, legacyBefore;
  const article = item => `document.querySelector('#message-list article[data-message-id="${item.id}"]')`;
  const summary = item => `${article(item)}?.querySelector('.receipt-summary')?.textContent || ''`;
  const state = item => `${article(item)}?.querySelector('[data-native-receipt]')?.dataset.nativeReceipt`;
  await check('sender initially sees stored message with no native or legacy acceptance', async () => {
    await isolatedServer(); await fixtures();
    reference = await message('alpha', 'Sender receipt: offered then viewed through real SSE', 'writer');
    acceptedOnly = await message('alpha', 'Acceptance report must not invent offered, viewed or completion', 'writer');
    legacyBefore = JSON.stringify(reference.receipts);
    assert((reference.receipts || []).every(row => !row.delivered_at && !row.accepted_at && !row.uncertain_at), 'Fixture legacy state was already confirmed');
    await browsers();
    await writer.click(`#channel-list [data-focus-key="channel:${ids.alpha}"]`);
    await writer.wait(`${state(reference)}==='none' && !document.getElementById('refresh-button').disabled`, 'sender message loaded');
    assert(/доставка не подтверждена/.test(await writer.eval(summary(reference))), 'Missing reports falsely confirmed delivery');
    assert(await writer.eval(`window.__suppressedPolls>0 && document.getElementById('connection-state').dataset.state==='connected'`), 'Real SSE connection not established or fallback poll not disabled');
  });
  await check('offered report changes sender summary through SSE without claiming viewed', async () => {
    await activity('inbox.offered', 'alpha', 'peer', reference.id);
    await writer.wait(`${state(reference)}==='offered'`, 'SSE offered receipt');
    const text = await writer.eval(summary(reference));
    assert(/предложено CLI.*по отчёту коннектора/.test(text) && !/просмотрено|принято/.test(text), 'Offered became viewed or accepted');
    assert(await writer.eval(`${article(reference)}.querySelector('[data-native-stage="seen"]').dataset.confirmed==='false'`), 'Offered synthesized viewed stage');
  });
  await check('viewed report replaces unconfirmed primary status while preserving legacy data and localization', async () => {
    await activity('inbox.seen', 'alpha', 'peer', reference.id);
    await writer.wait(`${state(reference)}==='seen'`, 'SSE viewed receipt');
    assert(/просмотрено.*по отчёту коннектора/.test(await writer.eval(summary(reference))), 'Sender did not see native viewed report');
    assert(!/не подтверждена/.test(await writer.eval(summary(reference))), 'Primary summary still says delivery unconfirmed');
    const current = (await api(`/v1/messages/${reference.id}`, 'GET', undefined, 'writer')).message;
    assert(JSON.stringify(current.receipts) === legacyBefore, 'Native report rewrote legacy receipt data');
    await writer.click(`#message-list article[data-message-id="${reference.id}"] .receipt-summary`);
    assert(await writer.eval(`${article(reference)}.textContent.includes('первую запись каждого отчёта сервером') && ${article(reference)}.textContent.includes('Подтверждения адаптера')`), 'Report time semantics or separate legacy section absent');
    await writer.filter('language-select', 'en');
    assert(/viewed · connector report/.test(await writer.eval(summary(reference))), 'Receipt summary did not translate');
    await screenshot(writer, 'native-receipts-sender-desktop', 1440);
  });
  await check('accepted-only report is not completion and leaves earlier stages unreported', async () => {
    await activity('inbox.accepted', 'alpha', 'peer', acceptedOnly.id);
    await writer.wait(`${state(acceptedOnly)}==='accepted'`, 'SSE accepted receipt');
    assert(/accepted, not necessarily completed · connector report/.test(await writer.eval(summary(acceptedOnly))), 'Accepted summary lost completion boundary');
    const stages = await writer.eval(`Array.from(${article(acceptedOnly)}.querySelectorAll('[data-native-stage]')).map(e=>[e.dataset.nativeStage,e.dataset.confirmed])`);
    assert(JSON.stringify(stages) === JSON.stringify([['offered', 'false'], ['seen', 'false'], ['accepted', 'true']]), 'Accepted synthesized offered or viewed');
    assert(writer.requests.some(item => item.path === `/v1/channels/${ids.alpha}/native-receipts` && new URLSearchParams(item.query).getAll('message_id').length === 2), 'Chat did not use aggregate loaded-message request');
  });
  await check('aggregate failure is visible in primary status and recovery reloads actual reports', async () => {
    writer.failNextNativeReceipt = true; await writer.click('#refresh-button');
    await writer.wait(`${state(reference)}==='unavailable' && !document.getElementById('refresh-button').disabled`, 'native aggregate unavailable');
    const text = await writer.eval(summary(reference));
    assert(/connector status unavailable/.test(text) && !/delivery unconfirmed|viewed/.test(text), 'Failure was hidden behind empty or old receipt status');
    await writer.filter('language-select', 'ru');
    assert(/статус коннектора недоступен/.test(await writer.eval(summary(reference))), 'Primary unavailable status was not translated');
    await writer.click('#refresh-button');
    await writer.wait(`${state(reference)}==='seen' && ${state(acceptedOnly)}==='accepted'`, 'actual aggregate recovered');
    assert((await writer.eval(`${article(reference)}.textContent`)).includes('Подтверждения адаптера'), 'Russian details retained legacy jargon');
    await writer.filter('language-select', 'en');
  });
  await check('late real aggregate cannot refill another channel; mobile and logout remain private', async () => {
    await writer.eval(`window.__heldFeedReady=false;window.__holdNextProjectFeed=${js(`/v1/channels/${ids.alpha}/native-receipts`)}`);
    await writer.click('#refresh-button'); await writer.wait('window.__heldFeedReady===true', 'real native aggregate response held');
    await writer.click(`#channel-list [data-focus-key="channel:${ids.beta}"]`);
    await writer.wait(`!document.getElementById('refresh-button').disabled && !${article(reference)}`, 'next channel ready');
    await writer.eval('window.__releaseFeed()'); await pause(200);
    assert(!await writer.eval(`!!${article(reference)}`), 'Late aggregate restored previous channel content');
    await writer.click(`#channel-list [data-focus-key="channel:${ids.alpha}"]`);
    await writer.wait(`${state(reference)}==='seen' && ${state(acceptedOnly)}==='accepted'`, 'receipt cache rebuilt in original channel');
    await writer.click(`#message-list article[data-message-id="${reference.id}"] .receipt-summary`);
    await writer.call('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
    assert(await writer.eval('document.documentElement.scrollWidth<=innerWidth+1'), 'Receipt details overflow mobile viewport');
    await screenshot(writer, 'native-receipts-sender-mobile-390', 390);
    for (const tab of tabs) {
      await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
      await tab.click('#logout-button');
      await tab.wait(`!document.getElementById('login-panel').hidden && document.getElementById('message-list').textContent==='' && localStorage.length===0 && sessionStorage.length===0`, 'logout clears messages and reports');
    }
    assert(!report.browser_guard_failed && report.browser_errors.length === 0 && report.requests.every(allowedBrowserRequest), 'Browser runtime or request-boundary failure');
  });
}

async function quietCases() {
  const hidden = id => `Number(document.getElementById(${js(id)}).dataset.hiddenCount)`;
  const projectRows = `Array.from(document.querySelectorAll('#project-native-list [data-native-id]')).map(e=>e.dataset.nativeId)`;
  const channelRows = `Array.from(document.querySelectorAll('#native-activity-list [data-native-id]')).map(e=>e.dataset.nativeId)`;
  let allPublic;
  await check('quiet default retains failures and explicit inbox decisions while counting hidden technical reports', async () => {
    await isolatedServer(); await fixtures();
    const reference = await message('alpha', 'Reference for explicit viewed and accepted reports');
    for (const type of technicalTypes) quietTechnical.push(await activity(type, 'alpha', 'writer', type.startsWith('inbox.') ? reference.id : undefined));
    for (const type of ['tool.failed', 'inbox.seen', 'inbox.accepted']) quietImportant.push(await activity(type, 'alpha', 'writer', type.startsWith('inbox.') ? reference.id : undefined));
    allPublic = [...publicEvents, ...quietTechnical, ...quietImportant];
    await browsers();
    const page = (await api(feedPath(), 'GET', undefined, 'viewer')).activity;
    const important = page.filter(event => !technicalTypes.has(event.event_type));
    await viewer.wait(`${projectRows}.length===${important.length} && ${hidden('project-native-technical-notice')}===${page.length - important.length}`, 'quiet first page');
    assert(JSON.stringify(await viewer.eval(projectRows)) === JSON.stringify(important.map(event => event.id)), 'Quiet feed changed important event identities or order');
    assert(quietImportant.every(event => important.some(item => item.id === event.id)), 'Fixture important events are outside tested page');
    assert(await viewer.eval(`!document.getElementById('project-native-technical').checked && !document.querySelector('#project-native-list img') && !window.nativeFeedInjected`), 'Default toggle or safe actor rendering regressed');
    assert(await viewer.eval(`document.getElementById('project-native-last-event').dataset.freshness==='fresh'`), 'Hidden reports erased actual observation freshness');
  });
  await check('technical-only scope states hidden data honestly and reveal preference survives filters', async () => {
    await viewer.filter('project-native-channel', ids.beta);
    await viewer.wait(`${projectRows}.length===0 && ${hidden('project-native-technical-notice')}===6`, 'technical-only channel');
    assert(await viewer.eval(`/техническ/i.test(document.getElementById('project-native-list').textContent) && document.getElementById('project-native-last-event').dataset.freshness!=='empty'`), 'Hidden-only scope falsely claimed no activity');
    await viewer.click('#project-native-technical');
    await viewer.wait(`${projectRows}.length===6 && ${hidden('project-native-technical-notice')}===0`, 'reveal all six reports');
    await viewer.filter('project-native-actor', ids.writer);
    await viewer.wait(`${projectRows}.length===0 && document.getElementById('project-native-last-event').dataset.freshness==='empty'`, 'genuinely empty actor intersection');
    assert(await viewer.eval(`document.getElementById('project-native-technical').checked`), 'Actor filter reset reveal preference');
    await viewer.filter('project-native-actor', ids.peer); await viewer.wait(`${projectRows}.length===6`, 'matching actor restored');
    await resetFilters(viewer); await viewer.wait(`${projectRows}.length===100`, 'revealed bounded first page');
  });
  await check('reveal retains complete ordered opaque-cursor history and hiding does not erase loaded records', async () => {
    await viewer.click('#project-native-more'); await viewer.wait(`${projectRows}.length===${allPublic.length}`, 'all earlier rows loaded');
    const expected = [...allPublic].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).map(event => event.id);
    assert(JSON.stringify(await viewer.eval(projectRows)) === JSON.stringify(expected), 'Technical toggle changed history order, scope or completeness');
    assert(viewer.requests.some(request => request.path === `/v1/projects/${ids.project}/activity` && new URLSearchParams(request.query).has('before')), 'Pagination did not retain opaque cursor');
    await viewer.click('#project-native-technical');
    await viewer.wait(`${projectRows}.length===3 && ${hidden('project-native-technical-notice')}===${allPublic.length - 3}`, 'hide preserves loaded history counter');
    await viewer.click('#project-native-technical'); await viewer.wait(`${projectRows}.length===${allPublic.length}`, 'cached history revealed again');
    await viewer.click('#project-native-technical');
  });
  await check('channel CLI and ordinary event feeds share quiet mode without dropping their messages', async () => {
    await viewer.click(`#channel-list [data-focus-key="channel:${ids.alpha}"]`);
    await viewer.wait(`!document.getElementById('channel-toolbar').hidden && !document.getElementById('refresh-button').disabled`, 'channel selected');
    await viewer.click('#tab-native');
    await viewer.wait(`${channelRows}.length===3 && ${hidden('native-technical-notice')}>0`, 'important channel reports visible');
    assert(await viewer.eval(`!document.getElementById('native-technical').checked`), 'Channel navigation reset shared preference');
    assert(JSON.stringify(await viewer.eval(channelRows)) === JSON.stringify([...quietImportant].reverse().map(event => event.id)), 'Channel quiet mode omitted explicit inbox decisions');
    await viewer.click('#native-technical');
    await viewer.wait(`${channelRows}.length===115 && ${hidden('native-technical-notice')}===0`, 'all channel reports restored');
    await viewer.click('#native-technical'); await viewer.click('#tab-activity');
    await viewer.wait(`document.querySelectorAll('#activity-list article').length===1 && ${hidden('activity-technical-notice')}>0`, 'ordinary event feed retains message event');
    assert(await viewer.eval(`!document.getElementById('activity-technical').checked && /сообщен/i.test(document.getElementById('activity-list').textContent)`), 'Quiet channel events hid the message');
    await viewer.click('#activity-technical');
    await viewer.wait(`document.querySelectorAll('#activity-list article').length>1 && ${hidden('activity-technical-notice')}===0`, 'ordinary event diagnostic history revealed');
    await viewer.click('#activity-technical');
  });
  await check('project map keeps important reports visible and explicit native type reveals technical entities', async () => {
    await viewer.click('#nav-project-map');
    await viewer.wait(`!document.getElementById('project-map-panel').hidden && document.querySelector('#project-map-counts [data-entity-type="native"]')?.dataset.countState!=='loading'`, 'project map snapshot');
    await viewer.wait(`${hidden('project-map-technical-notice')}>0`, 'map counts hidden technical sample');
    const defaultNative = await viewer.eval(`Array.from(document.querySelectorAll('#project-map-entities [data-entity-type="native"]')).map(e=>e.dataset.entityId)`);
    assert(quietImportant.every(event => defaultNative.includes(event.id)) && !quietTechnical.some(event => defaultNative.includes(event.id)), 'Default map concealed important reports or exposed routine ones');
    const sampleCount = await viewer.eval(`Number(document.querySelector('#project-map-counts [data-entity-type="native"]').dataset.countShown)`);
    await viewer.click(`#project-map-entities [data-entity-type="channel"][data-entity-id="${ids.alpha}"]`);
    await viewer.wait(`${hidden('project-map-relations-status')}>0 && document.querySelector('#project-map-detail [data-entity-id="${ids.alpha}"]')!==null`, 'channel relations count hidden technical reports');
    const relatedIds = `Array.from(document.querySelectorAll('#project-map-relations [data-entity-id]')).map(e=>e.dataset.entityId)`;
    const quietRelated = await viewer.eval(relatedIds);
    assert(!quietTechnical.some(event => quietRelated.includes(event.id)), 'Quiet relation panel exposed routine reports hidden from the entity list');
    assert(quietImportant.every(event => quietRelated.includes(event.id)), 'Quiet relation panel hid failures or explicit inbox decisions');
    const hiddenRelations = await viewer.eval(hidden('project-map-relations-status'));
    await viewer.click('#project-map-technical');
    await viewer.wait(`${hidden('project-map-relations-status')}===0`, 'reveal restores technical relation count');
    const allRelated = await viewer.eval(relatedIds);
    assert(quietTechnical.every(event => allRelated.includes(event.id)) && quietImportant.every(event => allRelated.includes(event.id)), 'Revealing relations did not restore the actual sampled event identities');
    await viewer.click('#project-map-technical');
    await viewer.wait(`${hidden('project-map-relations-status')}===${hiddenRelations}`, 'hiding restores relation count');
    assert(JSON.stringify(await viewer.eval(relatedIds))===JSON.stringify(quietRelated), 'Relation toggle deleted, reordered or failed to conceal sampled reports');
    await viewer.filter('project-map-type', 'native');
    await viewer.wait(`document.querySelectorAll('#project-map-entities [data-entity-type="native"]').length===${sampleCount} && ${hidden('project-map-technical-notice')}===0`, 'explicit native type includes technical reports');
    assert(await viewer.eval(`!document.getElementById('project-map-technical').checked`), 'Explicit entity type changed shared preference');
    await viewer.click(`#project-map-entities [data-entity-id="${quietTechnical.at(-1).id}"]`);
    await viewer.wait(`document.querySelector('#project-map-detail [data-entity-id="${quietTechnical.at(-1).id}"]')!==null`, 'technical record remains inspectable');
    await viewer.click('#project-map-detail [data-target-view="project-native"]');
    await viewer.wait(`!document.getElementById('project-native-panel').hidden && document.getElementById('project-native-channel').value===${js(ids.alpha)}`, 'map opens actual channel feed');
  });
  await check('technical-only bursts never create channel message badges but a real message does', async () => {
    await resetFilters(viewer);
    const channelButton = `document.querySelector('[data-focus-key="channel:${ids.beta}"]')`;
    assert(await viewer.eval(`${channelButton}.dataset.updated!=='true'`), 'Badge fixture must start without unread messages');
    const channelBefore = (await api(`/v1/projects/${ids.project}/channels`, 'GET', undefined, 'viewer')).channels.find(channel => channel.id === ids.beta);
    assert(Object.hasOwn(channelBefore, 'latest_message_seq'), 'Backend must expose independent message sequence');
    for (const type of ['turn.started', 'tool.completed', 'agent.waiting']) await activity(type, 'beta', 'peer');
    const channelAfter = (await api(`/v1/projects/${ids.project}/channels`, 'GET', undefined, 'viewer')).channels.find(channel => channel.id === ids.beta);
    assert(channelAfter.latest_seq > channelBefore.latest_seq && channelAfter.latest_message_seq === channelBefore.latest_message_seq, 'Technical events changed message sequence or failed to advance full cursor');
    await viewer.click('#refresh-button'); await viewer.wait(`!document.getElementById('refresh-button').disabled`, 'technical burst refresh');
    assert(await viewer.eval(`${channelButton}.dataset.updated!=='true'`), 'Technical-only reports created a channel badge');
    const actualMessage = await message('beta', 'A real peer message must produce a channel badge');
    await viewer.wait(`${channelButton}.dataset.updated==='true'`, 'real peer message badge', 12000);
    const deliverySQL = `SET search_path TO "${schema}"; SELECT json_build_object('native',(SELECT json_agg(n ORDER BY id) FROM native_activity n),'receipts',(SELECT json_agg(r ORDER BY message_id,agent_id) FROM receipts r))::text;`;
    const deliveryBefore = (await sql(deliverySQL, 'delivery-before-gui-read')).toString();
    await viewer.click(`#channel-list [data-focus-key="channel:${ids.beta}"]`);
    await viewer.wait(`!document.getElementById('refresh-button').disabled && ${channelButton}.dataset.updated!=='true'`, 'opening message channel clears badge');
    assert(await viewer.eval(`document.getElementById('chat-panel').textContent.includes(${js(actualMessage.body)})`), 'Real badge did not correspond to a rendered message');
    const recorded = (await api('/v1/navigation', 'GET', undefined, 'viewer')).channels.find(channel => channel.id === ids.beta);
    assert(recorded.unread_messages === 0 && recorded.last_read_seq === actualMessage.seq, 'Visible discussion was not recorded at its actual message position');
    assert((await sql(deliverySQL, 'delivery-after-gui-read')).toString() === deliveryBefore, 'GUI read altered native events or delivery receipts');
  });
  await check('Russian English refresh and mobile views preserve reveal preference and logout clears content', async () => {
    await feed(viewer); await viewer.click('#project-native-technical');
    for (const language of ['en', 'ru']) {
      await viewer.filter('language-select', language);
      await viewer.click('#refresh-button'); await viewer.wait(`!document.getElementById('refresh-button').disabled`, 'language refresh');
      assert(await viewer.eval(`document.documentElement.lang===${js(language)} && document.getElementById('project-native-technical').checked && ${hidden('project-native-technical-notice')}===0`), 'Language or refresh reset reveal preference');
      const label = await viewer.eval(`document.querySelector('label[for="project-native-technical"]').textContent`);
      assert((language === 'ru' ? /техническ/i : /technical/i).test(label), 'Technical control was not translated');
    }
    await viewer.click('#project-native-technical');
    await screenshot(viewer, 'quiet-project-cli-desktop', 1440);
    await viewer.call('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
    assert(await viewer.eval(`document.documentElement.scrollWidth<=innerWidth+1`), 'Quiet controls overflow mobile viewport');
    await screenshot(viewer, 'quiet-project-cli-mobile-390', 390);
    for (const tab of tabs) {
      await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
      await tab.click('#logout-button');
      await tab.wait(`!document.getElementById('login-panel').hidden && localStorage.length===0 && sessionStorage.length===0 && document.getElementById('project-native-technical-notice').textContent===''`, 'logout clears quiet controls and storage');
    }
    assert(!report.browser_guard_failed && report.browser_errors.length===0 && report.requests.every(allowedBrowserRequest), 'Unexpected browser mutation or runtime failure');
  });
}

try {
  if (receiptsOnly) {
    await receiptCases();
  } else if (quietOnly) {
    await quietCases();
  } else {
  await check('owned schema TLS fixtures and browser load latest project events without choosing a channel', async () => {
    await isolatedServer(); await fixtures(); await browsers();
    const expected = (await api(feedPath(), 'GET', undefined, 'viewer')).activity;
    await viewer.wait(`${rows}.length===100`, 'first bounded page');
    assert(JSON.stringify((await viewer.eval(rows)).map(e => e.id)) === JSON.stringify(expected.map(e => e.id)), 'Project feed differs from DESC API page');
    assert(await viewer.eval(`!document.querySelector(${js(eventSelector(privateEvents[0]))}) && !document.getElementById('project-native-list').textContent.includes(${js(ids.private)}) && !document.querySelector('#project-native-list img') && !window.nativeFeedInjected`), 'Hidden channel or executable actor markup leaked');
    await owner.wait(hasEvent(privateEvents[0]), 'owner private channel visibility');
    assert(await viewer.eval(`!document.querySelector('#project-native-panel form') && /клиент|самоотч|не проверено/i.test(document.getElementById('project-native-panel').textContent)`), 'Project feed provenance/write boundary missing');
    assert(!report.browser_guard_failed && report.requests.every(allowedBrowserRequest), 'GUI attempted a mutation beyond its owned read cursors');
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
    assert(await writer.eval(`document.querySelector('[data-focus-key="channel:${ids.alpha}"]').dataset.updated!=='true'`), 'Technical reports caused a message update hint');
    await message('alpha', 'Message update hint fixture');
    await writer.wait(`document.querySelector('[data-focus-key="channel:${ids.alpha}"]').dataset.updated==='true'`, 'new message gets update hint while project feed is open');
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
  }
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
  report.success = report.cases.length === (receiptsOnly ? 6 : quietOnly ? 7 : 10) && report.cases.every(item => item.passed) && report.owned_browser_stopped && report.owned_server_stopped && report.owned_schema_removed && report.source_test_DSN_unchanged;
  const output = directory ? `${directory}/evidence.json` : `${runtime}/evidence/project-native-gui-setup-failed.json`;
  let serialized = JSON.stringify(report, null, 2) + '\n'; for (const key of secrets) serialized = serialized.replaceAll(key, '[REDACTED]');
  await writeFile(output, serialized, {mode: 0o600, flag: 'wx'});
  console.log(JSON.stringify({success: report.success, cases: report.cases.length, owned_schema_removed: report.owned_schema_removed, owned_server_stopped: report.owned_server_stopped,
    owned_browser_stopped: report.owned_browser_stopped, evidence: output}));
}
if (!report.success) process.exitCode = 1;
