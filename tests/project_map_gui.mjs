// One-command isolated project map browser regression.
// Own schema in agentlink_test, own loopback TLS server, own Chromium. No shared
// seed credentials, agentlink_e2e dependency, production URL or model invocation.
// Run only after the backend/web changes are integrated: node tests/project_map_gui.mjs
import {readFile, writeFile, mkdtemp, mkdir, copyFile, rm, open, lstat, readdir} from 'node:fs/promises';
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
const run = `project-map-${randomUUID().slice(0, 8)}`;
const schema = `project_map_gui_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const ids = Object.fromEntries(['owner', 'writer', 'peer', 'viewer', 'project', 'other', 'alpha', 'beta', 'private', 'other-channel'].map(name => [name, `${run}-${name}`]));
const report = {run, schema, database: 'agentlink_test', started_at: new Date().toISOString(), cases: [], assets: {},
  browser_errors: [], requests: [], layouts: [], screenshots: [], models_started: 0,
  scope: 'Owned isolated schema, loopback TLS API and Chromium; no shared fixture keys or production requests'};
const tabs = [], keys = {}, secrets = new Set(), fixturesData = {}, snapshots = {};
const types = ['project','agent','channel','message','receipt','native','session','task','run','artifact','memory','memory-version','note','task-event'];
const js = JSON.stringify, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
const rows = `Array.from(document.querySelectorAll('#project-map-entities [data-entity-key]')).map(e=>({key:e.dataset.entityKey,type:e.dataset.entityType,id:e.dataset.entityId}))`;
const entitySelector = item => `#project-map-entities [data-entity-key=${js(item.key)}]`;
const counts = `Array.from(document.querySelectorAll('#project-map-counts [data-entity-type]')).map(e=>({type:e.dataset.entityType,state:e.dataset.countState,value:e.dataset.countValue}))`;
let directory, scratch, base, ca, pgEnv, sourceDSNHash, ownerKeyPath, childSerial = 0;
let server, serverLog, browser, browserLog, browserCDP, profile, schemaCreated = false, writer, viewer, owner;
const actorName = 'Agent <img src=x onerror=window.mapInjected=1>';
const bodyMarker = `${run}-BODY-NOT-FOR-MAP`, taskTitle = `${run} <img src=x onerror=window.mapInjected=1>`;
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
  assert(/^project_map_gui_[a-f0-9]{16}$/.test(schema), 'Owned schema name invalid');
  return command(`${runtime}/pgsql/usr/lib/postgresql/14/bin/psql`, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], label, {env: pgEnv, input: statement, timeout: 20000});
}
async function backendSources() {
  const paths = ['go.mod', 'go.sum'];
  async function collect(directory) {
    for (const item of await readdir(`${root}/${directory}`, {withFileTypes: true})) {
      const path = `${directory}/${item.name}`;
      if (item.isDirectory()) await collect(path);
      else if (item.isFile() && /\.(go|sql)$/.test(item.name)) paths.push(path);
    }
  }
  await collect('cmd'); await collect('internal');
  const files = {};
  for (const path of paths.sort()) files[path] = hash(await readFile(`${root}/${path}`));
  return files;
}
async function isolatedServer() {
  directory = await mkdtemp(`${runtime}/evidence/project-map-gui-`);
  scratch = await mkdtemp(join(tmpdir(), 'agentlink-project-map-'));
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
  const sources = await backendSources(), binary = `${scratch}/agent-link`;
  await command('go', ['build', '-o', binary, './cmd/agent-link'], 'build', {timeout: 60000});
  assert(JSON.stringify(sources) === JSON.stringify(await backendSources()), 'Backend sources changed during build; retry after source freeze');
  report.backend = {source_sha256: hash(JSON.stringify(sources)), source_files: sources, binary_sha256: hash(await readFile(binary)), built_at: new Date().toISOString()};
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
  assert((await api(`/v1/projects/${ids.project}/map?limit=25`, 'GET', undefined, 'owner', 404)), 'Project map route unavailable');
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

const projectPath = (tail = '', name = 'project') => '/v1/projects/' + ids[name] + '/' + tail;
const mapPath = name => projectPath('map?limit=25', name || 'project');
const unique = () => run + '-' + randomUUID();
async function message(channel = 'alpha', actor = 'writer', extra = {}) {
  return (await api('/v1/channels/' + ids[channel] + '/messages', 'POST', {client_id: unique(), body: bodyMarker, recipient_ids: [ids.peer], ...extra}, actor, 201)).message;
}
async function activity(type, channel = 'alpha', actor = 'writer', extra = {}) {
  return (await api('/v1/channels/' + ids[channel] + '/activity', 'POST', {client_id: unique(), session_id: run + '-coincident-session',
    runtime: actor === 'peer' ? 'claude' : 'codex', event_type: type, ...extra}, actor, 201)).activity;
}
async function taskEvent(type, extra = {}, actor = 'writer') {
  const task = (await api(projectPath('tasks/' + fixturesData.task.id), 'GET', undefined, actor)).task;
  return api(projectPath('tasks/' + task.id + '/events'), 'POST', {client_id: unique(), expected_version: task.version, type,
    run_id: run + '-task-run', summary: bodyMarker, ...extra}, actor, 201);
}
async function fixtures() {
  for (const actor of ['writer', 'peer', 'viewer']) {
    await api('/v1/admin/principals', 'POST', {id: ids[actor], name: actor === 'writer' ? actorName : ids[actor],
      kind: actor === 'viewer' ? 'viewer' : 'agent', runtime: 'browser-fixture-no-model'}, 'owner', 201);
    keys[actor] = (await api('/v1/admin/principals/' + ids[actor] + '/rotate-key', 'POST', {})).key; secrets.add(keys[actor]);
  }
  for (const name of ['project', 'other']) await api('/v1/admin/projects', 'POST', {id: ids[name], name: ids[name]}, 'owner', 201);
  for (const name of ['alpha', 'beta', 'private', 'other-channel']) await api('/v1/admin/channels', 'POST', {id: ids[name], name: ids[name], project_id: ids[name === 'other-channel' ? 'other' : 'project']}, 'owner', 201);
  for (const actor of ['writer', 'peer', 'viewer']) {
    const access = actor === 'viewer' ? 'read' : 'write';
    for (const name of ['project', 'other']) await grant(actor, 'project', name, access);
    for (const name of ['alpha', 'beta', 'private', 'other-channel']) await grant(actor, 'channel', name, access);
  }
  fixturesData.message = await message();
  fixturesData.reply = await message('alpha', 'writer', {reply_to: fixturesData.message.id});
  fixturesData.privateMessage = await message('private');
  fixturesData.note = (await api(projectPath('notes'), 'POST', {client_id: unique(), title: run + ' public note', body: bodyMarker, source_message_id: fixturesData.message.id}, 'writer', 201)).note;
  fixturesData.hiddenSourceNote = (await api(projectPath('notes'), 'POST', {client_id: unique(), title: run + ' note after ACL change', body: bodyMarker, source_message_id: fixturesData.privateMessage.id}, 'writer', 201)).note;
  await api('/v1/heartbeat', 'POST', {session_id: run + '-coincident-session', activity: bodyMarker, runtime: 'fixture'}, 'peer');
  for (const status of ['delivered', 'accepted', 'uncertain']) await api('/v1/messages/' + fixturesData.message.id + '/receipts', 'POST', {status, session_id: run + '-coincident-session'}, 'peer');
  fixturesData.native = await activity('session.started');
  fixturesData.inbox = await activity('inbox.offered', 'alpha', 'peer', {message_id: fixturesData.message.id});
  fixturesData.privateNative = await activity('session.started', 'private');
  fixturesData.artifacts = [];
  for (let i = 0; i < 26; i++) {
    const bytes = Buffer.from(bodyMarker + '-' + i);
    fixturesData.artifacts.push((await api(projectPath('artifacts'), 'POST', {client_id: unique(), role: 'implementation',
      base_revision: 'fixture-' + i, sha256: hash(bytes), content_base64: bytes.toString('base64')}, 'writer', 201)).artifact);
  }
  fixturesData.task = (await api(projectPath('tasks'), 'POST', {client_id: unique(), title: taskTitle, owner_id: ids.writer,
    reviewer_id: ids.peer, scope: ['fixture/example.txt'], acceptance: ['No models started']}, 'writer', 201)).task;
  fixturesData.secondTask = (await api(projectPath('tasks'), 'POST', {client_id: unique(), title: run + ' second task', owner_id: ids.writer,
    reviewer_id: ids.peer, scope: ['fixture/second.txt'], acceptance: ['Explicit navigation']}, 'writer', 201)).task;
  fixturesData.runEvent = (await taskEvent('run_started')).event;
  fixturesData.refs = fixturesData.artifacts.slice(0, 1).map(a => ({artifact_id: a.id, role: a.role, sha256: a.sha256}));
  await taskEvent('artifacts_ready', {artifacts: fixturesData.refs});
  fixturesData.reviewRequest = (await taskEvent('review_requested', {artifacts: fixturesData.refs})).event;
  await taskEvent('review_result', {artifacts: fixturesData.refs, review_request_id: fixturesData.reviewRequest.id, verdict: 'changes_requested'}, 'peer');
  fixturesData.memory = (await api(projectPath('memory'), 'POST', {client_id: unique(), title: run + ' memory', body: bodyMarker}, 'writer', 201)).memory;
  await api(projectPath('memory/' + fixturesData.memory.id), 'PUT', {client_id: unique(), expected_version: 1, title: fixturesData.memory.title, body: bodyMarker + '-v2'}, 'writer');
  for (const channel of ['alpha', 'private']) {
    fixturesData[channel + 'Session'] = (await api(projectPath('sessions'), 'POST', {session_id: run + (channel === 'alpha' ? '-coincident-session' : '-hidden-session'),
      channel_id: ids[channel], run_id: run + '-task-run', task_role: 'writer', runtime: 'fixture', model: 'no-model',
      activity: bodyMarker, ttl_seconds: 120, max_duration_seconds: 300}, 'writer', 201)).session;
  }
  // This note was valid when published. A later normal ACL change must not
  // expose its now-hidden source message identity through map metadata.
  await grant('viewer', 'channel', 'private', 'none');
  await grant('peer', 'channel', 'private', 'none');
  for (const actor of ['writer', 'viewer', 'owner']) snapshots[actor] = await api(mapPath(), 'GET', undefined, actor);
}
class CDP {
  constructor(url, name) {
    this.ws = new WebSocket(url); this.name = name; this.serial = 0; this.pending = new Map(); this.requests = []; this.active = new Map();
    this.ready = new Promise((resolveSocket, reject) => { this.ws.onopen = resolveSocket; this.ws.onerror = () => reject(new Error('Owned CDP unavailable')); });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) { const item = this.pending.get(message.id); clearTimeout(item.timer); this.pending.delete(message.id); message.error ? item.reject(new Error(`CDP ${item.method} failed`)) : item.resolve(message.result); }
      if (message.method === 'Runtime.exceptionThrown') report.browser_errors.push({tab: name, category: message.params.exceptionDetails.text});
      if (message.method === 'Page.javascriptDialogOpening') void this.call('Page.handleJavaScriptDialog', {accept: Boolean(this.acceptDialog)}).catch(() => {});
      if (message.method === 'Fetch.requestPaused') {
        const {request, requestId} = message.params, url = new URL(request.url);
        const deny = request.method !== 'GET' || url.origin !== new URL(base).origin;
        const fixtureFailure = Boolean(this.blockMap && /\/map$/.test(url.pathname));
        if (deny) report.browser_guard_failed = true;
        void this.call(deny || fixtureFailure ? 'Fetch.failRequest' : 'Fetch.continueRequest', deny || fixtureFailure ? {requestId, errorReason: 'BlockedByClient'} : {requestId}).catch(() => {});
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
const testingTransport = `(()=>{const original=window.fetch.bind(window);let transport;window.__holdNextProjectMap='';window.__heldMapReady=false;window.__releaseMap=null;
  window.fetch=async(input,init)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);let options=init;
    if(url.pathname==='/v1/workspace/stream'){transport=new AbortController();options={...init,signal:init?.signal?AbortSignal.any([init.signal,transport.signal]):transport.signal};}
    const hold=window.__holdNextProjectMap&&url.pathname===window.__holdNextProjectMap;if(hold)window.__holdNextProjectMap='';
    const response=await original(input,options);if(!hold)return response;
    // Buffer a REAL response before delaying delivery. Releasing it deliberately
    // outlives AbortSignal so application scope/auth guards must reject it.
    const bytes=await response.arrayBuffer(),headers=[...response.headers],status=response.status;
    window.__heldMapReady=true;return new Promise(resolve=>{window.__releaseMap=()=>{window.__heldMapReady=false;window.__releaseMap=null;resolve(new Response(bytes,{status,headers}));};});};
  window.__cutWorkspace=()=>transport?.abort();})();`;
async function browsers() {
  profile = await mkdtemp(join(tmpdir(), 'agentlink-project-map-browser-')); browserLog = await open(`${directory}/browser.private.log`, 'wx', 0o600);
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
    await tab.call('Page.navigate', {url: new URL('?lang=ru', base).href}); await tab.wait(`document.readyState==='complete' && !!document.getElementById('nav-project-map')`, 'project feed page', 15000);
    if (actor === 'writer') writer = tab; else if (actor === 'viewer') viewer = tab; else owner = tab;
    await login(tab, actor);
  }
}

async function login(tab, actor) {
  await tab.fill('api-key', keys[actor]); await tab.click('#login-button');
  await tab.wait("document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled", 'login ready');
  await project(tab);
}
async function project(tab, name = 'project') {
  await tab.click('#project-switcher [data-focus-key="project:' + ids[name] + '"]');
  await tab.wait("document.querySelector('[data-focus-key=\"project:" + ids[name] + "\"]').getAttribute('aria-pressed')==='true' && !document.getElementById('refresh-button').disabled", 'project selected');
  await map(tab);
}
async function map(tab) {
  await tab.click('#nav-project-map');
  await tab.wait("!document.getElementById('project-map-panel').hidden", 'map opened');
  // Relationship/schema assertions below intentionally inspect all entity types.
  await tab.eval("if (!document.getElementById('project-map-technical').checked) document.getElementById('project-map-technical').click()");
}
async function ready(tab) {
  await tab.wait("Array.from(document.querySelectorAll('#project-map-counts [data-count-state]')).length===14 && Array.from(document.querySelectorAll('#project-map-counts [data-count-state]')).every(e=>['ready','partial'].includes(e.dataset.countState))", 'confirmed map counts');
}
async function resetFilters(tab) {
  await tab.filter('project-map-type', ''); await tab.fill('project-map-search', '');
  await tab.wait("document.getElementById('project-map-type').value==='' && document.getElementById('project-map-search').value===''", 'all map entities');
}
function findNode(type, id, actor = 'viewer') {
  const item = snapshots[actor].nodes.find(n => n.type === type && (id === undefined || n.id === id));
  assert(item, 'Fixture map node missing: ' + type); return item;
}
async function selectNode(tab, item) {
  await resetFilters(tab); await tab.click(entitySelector(item));
  await tab.wait("document.querySelector(" + js(entitySelector(item)) + ")?.getAttribute('aria-pressed')==='true'", 'selected map entity');
}
async function holdRead(tab) {
  await tab.eval("window.__heldMapReady=false;window.__holdNextProjectMap=" + js(projectPath('map')));
  await tab.click('#refresh-button'); await tab.wait('window.__heldMapReady===true', 'real map response held');
}
async function keyboard(tab, key, code, keyCode) {
  const text = key === 'Enter' ? {text: '\r', unmodifiedText: '\r'} : {};
  await tab.call('Input.dispatchKeyEvent', {type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, ...text});
  await tab.call('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode});
}
async function screenshot(tab, label, width, focus) {
  await tab.call('Page.bringToFront');
  await tab.eval(focus ? "document.querySelector(" + js(focus) + ").scrollIntoView({block:'start'});window.scrollBy(0,-85)" : 'window.scrollTo(0,0)');
  assert(await tab.eval("(()=>{const keys=" + js([...secrets]) + ";return !keys.some(key=>document.body.innerText.includes(key)||Array.from(document.querySelectorAll('input,textarea')).some(e=>e.value.includes(key)));})()"), 'Screenshot could contain secret');
  const file = directory + '/' + label + '.png', shot = await tab.call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  await writeFile(file, Buffer.from(shot.data, 'base64'), {mode: 0o600, flag: 'wx'}); report.screenshots.push({label, width, file});
}
async function stopChild(child) {
  for (const signal of ['SIGTERM', 'SIGKILL']) if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill(signal); await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), pause(2500)]); }
  return !child || !child.pid || child.exitCode !== null || child.signalCode !== null;
}

try {
  await check('owned TLS map loads fourteen real types; concepts and role ACL stay separate', async () => {
    await isolatedServer(); await fixtures(); await browsers(); await ready(viewer); await ready(owner);
    const snapshot = snapshots.viewer;
    assert(snapshot.read_only === true && snapshot.project.id === ids.project, 'Wrong map scope/read-only contract');
    assert(types.every(type => snapshot.groups.some(g => g.type === type && g.total > 0)), 'Rich fixture does not cover all fourteen node types');
    const actual = await viewer.eval(rows), expected = snapshot.nodes.map(n => n.key).sort();
    assert(JSON.stringify(actual.map(n => n.key).sort()) === JSON.stringify(expected), 'Map catalog differs from authorized API snapshot');
    for (const group of snapshot.groups) {
      const count = (await viewer.eval(counts)).find(c => c.type === group.type);
      assert(Number(count?.value) === group.total && count.state === (group.truncated ? 'partial' : 'ready'), 'Incorrect confirmed count: ' + group.type);
    }
    assert(await viewer.eval("Array.from(document.querySelectorAll('#project-map-schema [data-map-type]')).map(e=>e.dataset.mapType).sort().join(',')===" + js([...types].sort().join(','))), 'Concept schema omits a real entity type');
    assert(await viewer.eval("/ACL/.test(document.getElementById('project-map-schema').textContent) && /ключ/i.test(document.getElementById('project-map-schema').textContent) && /не.*соедин|разные/.test(document.getElementById('project-map-schema').textContent)"), 'Conceptual access/observation boundary missing');
    assert(snapshot.nodes.every(n => types.includes(n.type) && !['body','summary','scope','acceptance','sha256','activity','key','key_hash','payload','command'].some(field => Object.hasOwn(n.meta, field))) && !JSON.stringify(snapshot).includes(bodyMarker) && !JSON.stringify(snapshot).includes(fixturesData.refs[0].sha256), 'Map includes fake concept instances or raw content');
    const hidden = [ids.private, fixturesData.privateMessage.id, fixturesData.privateNative.id, run + '-hidden-session'];
    assert(hidden.every(value => !JSON.stringify(snapshot).includes(value)), 'Hidden channel/reference metadata leaked through API map');
    assert(await viewer.eval(js(hidden) + ".every(value=>!document.getElementById('project-map-panel').textContent.includes(value)) && document.getElementById('project-map-admin').hidden"), 'Viewer sees hidden entity or administration action');
    await selectNode(owner, findNode('channel', ids.private, 'owner'));
    assert(await owner.eval("!document.getElementById('project-map-admin').hidden && !document.querySelector('#project-map-panel form')"), 'Owner inspection changed into publication');
    const readStart = viewer.requests.length; await viewer.click('#refresh-button');
    await viewer.wait(() => viewer.requests.slice(readStart).some(r => r.path === projectPath('map')) && ![...viewer.active.values()].some(r => r.path === projectPath('map')), 'map-only refresh');
    const mapReads = viewer.requests.slice(readStart).filter(r => r.path.startsWith('/v1/'));
    assert(mapReads.some(r => r.path === projectPath('map')) && mapReads.every(r => r.path === '/v1/projects' || r.path === '/v1/workspace/stream' || r.path === projectPath('channels') || r.path === projectPath('map')), 'Map mode downloaded content or per-entity endpoints');
    report.map_only_refresh_paths = mapReads.map(r => r.path);
    assert(!report.browser_guard_failed && report.requests.every(r => r.method === 'GET'), 'Map navigation attempted a browser mutation');
  });
  await check('opaque nodes explicit edges limited counts and untrusted labels remain truthful', async () => {
    const snapshot = snapshots.viewer, byKey = new Map(snapshot.nodes.map(n => [n.key, n]));
    const artifact = snapshot.groups.find(g => g.type === 'artifact');
    assert(artifact.total === 26 && artifact.shown === 25 && artifact.truncated, 'Fixture did not exercise per-type bound');
    assert(snapshot.edges.every(e => byKey.has(e.source) && byKey.has(e.target)), 'Edge exposes an excluded endpoint');
    assert(!snapshot.edges.some(e => {
      const kinds = [byKey.get(e.source).type, byKey.get(e.target).type];
      return kinds.includes('session') && (kinds.includes('native') || kinds.includes('run') || kinds.includes('receipt')) ||
        kinds.includes('native') && kinds.includes('receipt') ||
        kinds.includes('task') && (kinds.includes('memory') || kinds.includes('memory-version'));
    }), 'Coincident identifiers fabricated a persisted relationship');
    const task = findNode('task', fixturesData.task.id), sourceMessage = findNode('message', fixturesData.message.id);
    const related = (a, b) => snapshot.edges.some(e => e.source === a.key && e.target === b.key || e.source === b.key && e.target === a.key);
    assert(related(task, findNode('run', run + '-task-run')), 'Actual task/run relationship omitted');
    assert(related(sourceMessage, findNode('message', fixturesData.reply.id)), 'Actual message reply omitted');
    assert(related(sourceMessage, findNode('native', fixturesData.inbox.id)), 'Explicit inbox/message relationship omitted');
    assert(related(findNode('memory', fixturesData.memory.id), findNode('memory-version')), 'Actual immutable memory version relationship omitted');
    assert(related(findNode('note', fixturesData.note.id), sourceMessage), 'Actual note source omitted');
    const before = viewer.requests.length;
    for (const item of [task, findNode('session'), findNode('native', fixturesData.native.id), findNode('receipt'), findNode('memory-version')]) {
      await selectNode(viewer, item);
      const actual = await viewer.eval("Array.from(document.querySelectorAll('#project-map-relations [data-relation-type]')).map(e=>({source:e.dataset.source,target:e.dataset.target,kind:e.dataset.relationType}))");
      const expected = snapshot.edges.filter(e => e.source === item.key || e.target === item.key).slice(0, 30).map(({source, target, kind}) => ({source, target, kind}));
      assert(JSON.stringify(actual) === JSON.stringify(expected), 'Selected entity relation DOM differs from explicit snapshot edges');
    }
    assert(!viewer.requests.slice(before).some(r => /\/tasks\/[^/]+$|\/memory\/[^/]+$|\/messages$/.test(r.path)), 'Map detail caused per-node content fetch');
    await selectNode(viewer, task);
    assert(await viewer.eval("document.getElementById('project-map-detail').textContent.includes(" + js(taskTitle) + ") && !document.querySelector('#project-map-panel img,#project-map-panel script') && !window.mapInjected && !document.getElementById('project-map-panel').textContent.includes(" + js(bodyMarker) + ")"), 'Untrusted title executed or content leaked');
    assert(await viewer.eval("/25/.test(document.getElementById('project-map-boundary').textContent) && /не означает|не доказывает/.test(document.getElementById('project-map-boundary').textContent)"), 'Truncation/absent-edge explanation missing');
  });
  await check('local filters survive delayed reads; empty failure and stale counts are not false zero', async () => {
    await holdRead(viewer);
    await viewer.filter('project-map-type', 'task'); await viewer.fill('project-map-search', 'second task');
    await viewer.wait(rows + ".length===1 && " + rows + "[0].id===" + js(fixturesData.secondTask.id), 'local filtered task');
    await viewer.eval('window.__releaseMap()'); await ready(viewer);
    assert(await viewer.eval("document.getElementById('project-map-search').value==='second task' && " + rows + ".length===1"), 'Delayed response reset current local search/filter');
    await resetFilters(viewer); viewer.blockMap = true; await viewer.click('#refresh-button');
    await viewer.wait("!document.getElementById('project-map-error').hidden && " + counts + ".every(c=>c.state==='stale' && c.value===undefined)", 'failed refresh marked stale');
    assert(await viewer.eval("/не подтвержден/i.test(document.getElementById('project-map-status').textContent)"), 'Stale counts still claim success');
    await project(viewer, 'other');
    await viewer.wait("!document.getElementById('project-map-error').hidden && " + counts + ".every(c=>c.state==='error' && c.value===undefined) && " + rows + ".length===0", 'initial failed snapshot unknown');
    assert(await viewer.eval("/не установлено|не получен/.test(document.getElementById('project-map-status').textContent)"), 'Initial failure interpreted as zero');
    viewer.blockMap = false; await viewer.click('#refresh-button'); await ready(viewer);
    assert((await viewer.eval(counts)).find(c => c.type === 'task').value === '0', 'Confirmed empty group not distinguished from unknown');
    await project(viewer); await ready(viewer);
  });
  await check('map targets preserve same chat/task/memory drafts and explicitly discard different task draft', async () => {
    // Owned-schema bulk fixtures exercise the real differing list windows:
    // /tasks orders creation time, /map orders last update. The old, recently
    // updated real task remains in the map but falls outside /tasks' 1000 rows.
    assert(/^[a-f0-9]{32}$/.test(fixturesData.task.id), 'Unexpected task fixture ID');
    await sql(`UPDATE "${schema}".link_tasks SET created_at=clock_timestamp()-interval '10 minutes' WHERE id='${fixturesData.task.id}';
      INSERT INTO "${schema}".link_tasks(id,project_id,title,owner_id,reviewer_id,scope,acceptance,created_by,client_id,payload_hash,created_at,updated_at)
      SELECT md5('${run}-window-'||n),'${ids.project}','Bounded task fixture '||n,'${ids.writer}','${ids.peer}',
        '["fixture/window"]'::jsonb,'["Fixture list boundary only"]'::jsonb,'${ids.writer}','${run}-window-'||n,
        decode('${hash(Buffer.from(run + '-window'))}','hex'),clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '2 minutes'
      FROM generate_series(1,1000) AS n;`, 'owned-task-window-fixtures');
    const boundedTasks = await api(projectPath('tasks'), 'GET', undefined, 'writer');
    assert(boundedTasks.truncated && boundedTasks.tasks.length === 1000 && !boundedTasks.tasks.some(t => t.id === fixturesData.task.id), 'Target did not fall outside real task list window');
    assert((await api(mapPath(), 'GET', undefined, 'writer')).nodes.some(n => n.type === 'task' && n.id === fixturesData.task.id), 'Recently updated target absent from map window');
    report.out_of_window_navigation = {task_list_size: boundedTasks.tasks.length, target_in_task_list: false, target_in_map: true, fixture_schema: schema};
    await writer.click('#channel-list [data-focus-key="channel:' + ids.alpha + '"]');
    await writer.wait("!document.getElementById('composer-form').hidden && !document.getElementById('refresh-button').disabled", 'writer chat ready');
    await writer.fill('message-input', run + ' unsent chat');
    await map(writer); await ready(writer); await selectNode(writer, findNode('channel', ids.alpha, 'writer'));
    await writer.click('#project-map-detail [data-target-view="chat"][data-target-channel-id="' + ids.alpha + '"]');
    await writer.wait("!document.getElementById('composer-form').hidden", 'map channel target');
    assert(await writer.eval("document.getElementById('message-input').value===" + js(run + ' unsent chat')), 'Map roundtrip discarded same chat draft');
    await map(writer); await ready(writer); await selectNode(writer, findNode('task', fixturesData.task.id, 'writer'));
    const targetReadStart = writer.requests.length;
    await writer.click('#project-map-detail [data-target-view="tasks"][data-target-entity-id="' + fixturesData.task.id + '"]');
    await writer.wait("document.querySelector('#task-detail [data-task-id]')?.dataset.taskId===" + js(fixturesData.task.id) + " && !document.getElementById('task-event-form').hidden", 'map task target');
    assert(writer.requests.slice(targetReadStart).some(r => r.path === projectPath('tasks/' + fixturesData.task.id)), 'Explicit out-of-window map target did not issue exact authorized detail GET');
    await writer.fill('task-event-summary', run + ' unsent task event');
    await map(writer); await ready(writer); await selectNode(writer, findNode('task', fixturesData.task.id, 'writer'));
    await writer.click('#project-map-detail [data-target-view="tasks"]');
    await writer.wait("!document.getElementById('tasks-pane').hidden && !document.getElementById('refresh-button').disabled", 'same task roundtrip');
    assert(await writer.eval("document.getElementById('task-event-summary').value===" + js(run + ' unsent task event')), 'Same task draft lost');
    await map(writer); await ready(writer); await selectNode(writer, findNode('task', fixturesData.secondTask.id, 'writer'));
    // The first explicit navigation declines the application's confirmation.
    await writer.click('#project-map-detail [data-target-view="tasks"]'); await pause(100);
    assert(await writer.eval("!document.getElementById('project-map-panel').hidden && document.getElementById('task-event-summary').value===" + js(run + ' unsent task event')), 'Declining discard lost draft or navigated');
    writer.acceptDialog = true; await writer.click('#project-map-detail [data-target-view="tasks"]'); writer.acceptDialog = false;
    await writer.wait("document.querySelector('#task-detail [data-task-id]')?.dataset.taskId===" + js(fixturesData.secondTask.id), 'second task target');
    assert(await writer.eval("document.getElementById('task-event-summary').value==='' && !document.getElementById('task-timeline').textContent.includes(" + js(fixturesData.reviewRequest.id) + ")"), 'Different task inherited draft/history');
    await map(writer); await ready(writer); await selectNode(writer, findNode('memory', fixturesData.memory.id, 'writer'));
    await writer.click('#project-map-detail [data-target-view="memory"]');
    await writer.wait("!document.getElementById('memory-edit').hidden", 'map memory target'); await writer.click('#memory-edit');
    await writer.fill('memory-body', run + ' unsent memory');
    await map(writer); await ready(writer); await selectNode(writer, findNode('memory', fixturesData.memory.id, 'writer'));
    await writer.click('#project-map-detail [data-target-view="memory"]');
    await writer.wait("!document.getElementById('memory-form').hidden", 'same memory roundtrip');
    assert(await writer.eval("document.getElementById('memory-body').value===" + js(run + ' unsent memory')), 'Same memory draft lost');
    await map(writer); await ready(writer);
  });
  await check('late old-project snapshot cannot refill current project cache or selections', async () => {
    await holdRead(viewer); await project(viewer, 'other'); await ready(viewer);
    await viewer.eval('window.__releaseMap()'); await pause(200);
    const expected = await api(mapPath('other'), 'GET', undefined, 'viewer');
    assert(JSON.stringify((await viewer.eval(rows)).map(n => n.key).sort()) === JSON.stringify(expected.nodes.map(n => n.key).sort()), 'Late snapshot populated another project');
    assert(await viewer.eval("!document.getElementById('project-map-panel').textContent.includes(" + js(fixturesData.task.id) + ") && document.getElementById('project-map-search').value===''"), 'Old project detail/search survived');
    await project(viewer); await ready(viewer);
  });
  await check('new known entity reaches idle map without reload and preserves selected filter', async () => {
    await viewer.filter('project-map-type', 'note'); const before = await viewer.eval('performance.timeOrigin');
    await viewer.eval('window.__cutWorkspace()');
    fixturesData.liveNote = (await api(projectPath('notes'), 'POST', {client_id: unique(), title: run + ' live note', body: bodyMarker}, 'writer', 201)).note;
    await viewer.wait(rows + ".some(n=>n.id===" + js(fixturesData.liveNote.id) + ")", 'live map update/catchup', 12000);
    assert(await viewer.eval("performance.timeOrigin===" + before + " && document.getElementById('project-map-type').value==='note'"), 'Live update reloaded/reset local filter');
    assert((await viewer.eval(counts)).find(c => c.type === 'note').value === '3', 'Live count stale');
    await resetFilters(viewer);
  });
  await check('ACL change prunes map metadata and late pre-revocation snapshot cannot restore it', async () => {
    await grant('viewer', 'channel', 'alpha', 'none');
    await viewer.wait("!document.querySelector('[data-focus-key=\"channel:" + ids.alpha + "\"]') && !document.getElementById('project-map-panel').textContent.includes(" + js(fixturesData.message.id) + ")", 'idle channel ACL clears map', 10000);
    await ready(viewer);
    assert(await viewer.eval("!document.getElementById('project-map-panel').textContent.includes(" + js(ids.alpha) + ")"), 'Revoked channel remains map metadata');
    await grant('viewer', 'channel', 'alpha', 'read');
    await viewer.wait("!!document.querySelector('[data-focus-key=\"channel:" + ids.alpha + "\"]')", 'channel restored', 12000); await ready(viewer);
    await holdRead(viewer); await grant('viewer', 'channel', 'alpha', 'none');
    await viewer.click('#nav-overview'); await map(viewer); await ready(viewer);
    await viewer.wait("!document.querySelector('[data-focus-key=\"channel:" + ids.alpha + "\"]')", 'current ACL acknowledged');
    await viewer.eval('window.__releaseMap()'); await pause(200);
    assert(await viewer.eval("!document.getElementById('project-map-panel').textContent.includes(" + js(fixturesData.message.id) + ") && !document.getElementById('project-map-panel').textContent.includes(" + js(ids.alpha) + ")"), 'Late response restored hidden map/reference');
    await grant('viewer', 'channel', 'alpha', 'read');
    await viewer.wait("!!document.querySelector('[data-focus-key=\"channel:" + ids.alpha + "\"]')", 'channel regrant', 12000);
    await ready(viewer);
  });
  await check('key rotation clears every map field and held authenticated response stays discarded', async () => {
    await holdRead(viewer);
    keys.viewer = (await api('/v1/admin/principals/' + ids.viewer + '/rotate-key', 'POST', {})).key; secrets.add(keys.viewer);
    await viewer.wait("!document.getElementById('login-panel').hidden && document.getElementById('project-map-entities').textContent===''", 'key revocation locks map', 12000);
    await viewer.eval('window.__releaseMap()'); await pause(200);
    assert(await viewer.eval("['project-map-entities','project-map-detail','project-map-relations','project-map-counts','project-map-status','project-map-boundary'].every(id=>document.getElementById(id).textContent==='') && document.getElementById('api-key').value===''"), 'Rotated key left protected map content');
    await login(viewer, 'viewer'); await ready(viewer);
  });
  await check('map keyboard navigation and layout fit desktop and mobile 360/390', async () => {
    await resetFilters(viewer); await screenshot(viewer, 'project-map-desktop', 1440);
    await screenshot(viewer, 'project-map-desktop-live', 1440, '#project-map-live');
    for (const width of [360, 390]) {
      await viewer.call('Emulation.setDeviceMetricsOverride', {width, height: 844, deviceScaleFactor: 1, mobile: true});
      await viewer.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const layout = await viewer.eval("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,controls:Array.from(document.querySelectorAll('#project-map-type,#project-map-search')).map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right};})})");
      report.layouts.push(layout); assert(layout.scrollWidth <= layout.width + 1 && layout.controls.every(r => r.left >= 0 && r.right <= width + 1), 'Map mobile horizontal overflow');
      await viewer.click('#sidebar-toggle');
      await viewer.wait("document.body.classList.contains('nav-open') && document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='true'", 'mobile menu opens');
      await keyboard(viewer, 'Escape', 'Escape', 27);
      await viewer.wait("!document.body.classList.contains('nav-open') && document.getElementById('sidebar-toggle').getAttribute('aria-expanded')==='false'", 'Escape closes mobile nav');
      await viewer.eval("document.querySelector('#project-map-schema [data-map-type=\"task\"]').focus()");
      await keyboard(viewer, 'Enter', 'Enter', 13);
      await viewer.wait("document.getElementById('project-map-type').value==='task' && document.activeElement.id==='project-map-type'", 'keyboard conceptual type navigation');
      const task = findNode('task', fixturesData.task.id);
      await viewer.eval("document.querySelector(" + js(entitySelector(task)) + ").focus()");
      await keyboard(viewer, 'Enter', 'Enter', 13);
      await viewer.wait("document.activeElement.id==='project-map-detail' && document.getElementById('project-map-detail').dataset.entityKey===" + js(task.key), 'keyboard selection announces detail');
      await screenshot(viewer, 'project-map-mobile-' + width, width);
      if (width === 390) {
        await screenshot(viewer, 'project-map-mobile-390-live', width, '#project-map-live');
        await screenshot(viewer, 'project-map-mobile-390-detail', width, '#project-map-detail');
      }
    }
  });
  await check('project ACL removal and logout clear protected map/drafts and stop requests', async () => {
    await grant('writer', 'project', 'project', 'none');
    await writer.wait("!document.querySelector('[data-focus-key=\"project:" + ids.project + "\"]') && !document.getElementById('project-map-panel').textContent.includes(" + js(fixturesData.task.id) + ") && document.getElementById('message-input').value==='' && document.getElementById('memory-body').value===''", 'project revoke clears map and drafts', 12000);
    for (const tab of tabs) {
      await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false}); await tab.click('#logout-button');
      await tab.wait("!document.getElementById('login-panel').hidden && ['project-map-counts','project-map-entities','project-map-detail','project-map-relations','project-map-status','project-map-boundary','project-map-error'].every(id=>document.getElementById(id).textContent==='') && localStorage.length===0 && sessionStorage.length===0", 'logout map cleared');
      await tab.wait(() => ![...tab.active.values()].some(r => r.path.startsWith('/v1/')), 'logout requests aborted');
    }
    const observed = tabs.map(tab => tab.requests.length); await pause(1200);
    assert(tabs.every((tab, index) => tab.requests.length === observed[index]), 'Logout reconnected');
    assert(!report.browser_guard_failed && report.browser_errors.length === 0, 'Browser runtime/GET-only safety failed');
  });
} catch (error) {
  if (!report.cases.some(item => !item.passed)) report.cases.push({name: 'infrastructure', passed: false, error: safeError(error)});
  report.failure_controls = [];
  for (const tab of tabs) { try { report.failure_controls.push({tab: tab.name, state: await tab.eval(`({login:document.getElementById('login-panel')?.hidden,panel:document.getElementById('project-map-panel')?.hidden,status:document.getElementById('project-map-status')?.textContent,error:document.getElementById('project-map-error')?.textContent,counts:${counts},rows:${rows}.length})`)}); } catch {} }
} finally {
  for (const tab of tabs) { try { await tab.eval(`window.__releaseMap?.();document.getElementById('logout-button')?.click()`); } catch {} tab.close(); }
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
  const output = directory ? `${directory}/evidence.json` : `${runtime}/evidence/project-map-gui-setup-failed.json`;
  let serialized = JSON.stringify(report, null, 2) + '\n'; for (const key of secrets) serialized = serialized.replaceAll(key, '[REDACTED]');
  await writeFile(output, serialized, {mode: 0o600, flag: 'wx'});
  console.log(JSON.stringify({success: report.success, cases: report.cases.length, owned_schema_removed: report.owned_schema_removed, owned_server_stopped: report.owned_server_stopped,
    owned_browser_stopped: report.owned_browser_stopped, evidence: output}));
}
if (!report.success) process.exitCode = 1;
