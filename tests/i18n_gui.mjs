// One-command isolated English/Russian interface browser regression.
// Own schema in agentlink_test, own loopback TLS server, own Chromium. No shared
// seed credentials, agentlink_e2e dependency, production URL or model invocation.
// Run only after the backend/web changes are integrated: node tests/i18n_gui.mjs
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
const run = `i18n-${randomUUID().slice(0, 8)}`;
const schema = `i18n_gui_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const ids = Object.fromEntries(['owner', 'writer', 'peer', 'viewer', 'target', 'project', 'other', 'alpha', 'beta', 'private', 'other-channel'].map(name => [name, `${run}-${name}`]));
const report = {run, schema, database: 'agentlink_test', started_at: new Date().toISOString(), cases: [], assets: {},
  browser_errors: [], requests: [], layouts: [], screenshots: [], models_started: 0,
  scope: 'Owned isolated schema, loopback TLS API and Chromium; no shared fixture keys or production requests'};
const tabs = [], keys = {}, secrets = new Set(), fixturesData = {}, snapshots = {};
const textFixtures = {project: 'Карта проекта', other: 'Project map — long project navigation title for mobile layout and stable user-supplied English text', writer: 'На связи', peer: 'Online', alpha: 'Задачи и ревью', beta: 'Tasks and review', task: 'Требует внимания', secondTask: 'Needs attention', memory: 'Память проекта', note: 'Сохранить', message: 'Принято', reply: 'Accepted', draft: 'Черновик draft', activity: 'Ожидание'};
const allowedRussian = ['Русский', ...Object.values(textFixtures).filter(value => /[А-Яа-яЁё]/.test(value))];
const js = JSON.stringify, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
let directory, scratch, base, ca, pgEnv, sourceDSNHash, ownerKeyPath, childSerial = 0;
let server, serverLog, browser, browserLog, browserCDP, profile, schemaCreated = false, writer, viewer, owner;
const bodyMarker = 'Память проекта';
report.language_changes = []; report.dialogs = []; report.untranslated = []; report.stream_lifecycle = [];
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
  assert(/^i18n_gui_[a-f0-9]{16}$/.test(schema), 'Owned schema name invalid');
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
  directory = await mkdtemp(`${runtime}/evidence/i18n-gui-`);
  scratch = await mkdtemp(join(tmpdir(), 'agentlink-i18n-'));
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
const unique = () => run + '-' + randomUUID();
async function fixtures() {
  for (const actor of ['writer', 'peer', 'viewer', 'target']) {
    await api('/v1/admin/principals', 'POST', {id: ids[actor], name: textFixtures[actor] || ids[actor],
      kind: ['viewer', 'target'].includes(actor) ? 'viewer' : 'agent', runtime: 'i18n-fixture-no-model'}, 'owner', 201);
    if (actor !== 'target') { keys[actor] = (await api('/v1/admin/principals/' + ids[actor] + '/rotate-key', 'POST', {})).key; secrets.add(keys[actor]); }
  }
  for (const name of ['project', 'other']) await api('/v1/admin/projects', 'POST', {id: ids[name], name: textFixtures[name]}, 'owner', 201);
  for (const name of ['alpha', 'beta', 'other-channel']) await api('/v1/admin/channels', 'POST', {id: ids[name], name: textFixtures[name] || ids[name], project_id: ids[name === 'other-channel' ? 'other' : 'project']}, 'owner', 201);
  for (const actor of ['writer', 'peer', 'viewer']) {
    const access = actor === 'viewer' ? 'read' : 'write';
    for (const name of ['project', 'other']) await grant(actor, 'project', name, access);
    for (const name of ['alpha', 'beta', 'other-channel']) await grant(actor, 'channel', name, access);
  }
  fixturesData.message = (await api('/v1/channels/' + ids.alpha + '/messages', 'POST', {client_id: unique(), body: textFixtures.message, recipient_ids: [ids.peer]}, 'writer', 201)).message;
  fixturesData.reply = (await api('/v1/channels/' + ids.alpha + '/messages', 'POST', {client_id: unique(), body: textFixtures.reply, recipient_ids: [ids.peer], reply_to: fixturesData.message.id}, 'writer', 201)).message;
  await api('/v1/heartbeat', 'POST', {session_id: run + '-receipt-session', activity: textFixtures.activity, runtime: 'fixture'}, 'peer');
  for (const status of ['delivered', 'accepted', 'uncertain']) await api('/v1/messages/' + fixturesData.message.id + '/receipts', 'POST', {status, session_id: run + '-receipt-session'}, 'peer');
  fixturesData.native = (await api('/v1/channels/' + ids.alpha + '/activity', 'POST', {client_id: unique(), session_id: run + '-native',
    runtime: 'codex', event_type: 'tool.completed', tool_name: 'Read'}, 'writer', 201)).activity;
  for (const [key, title] of [['task', textFixtures.task], ['secondTask', textFixtures.secondTask]]) {
    fixturesData[key] = (await api(projectPath('tasks'), 'POST', {client_id: unique(), title, owner_id: ids.writer,
      reviewer_id: ids.peer, scope: ['fixture/example.txt'], acceptance: ['No models started']}, 'writer', 201)).task;
  }
  await api(projectPath('tasks/' + fixturesData.task.id + '/events'), 'POST', {client_id: unique(), expected_version: 1, type: 'run_started',
    run_id: run + '-task-run', summary: textFixtures.note}, 'writer', 201);
  await api(projectPath('tasks/' + fixturesData.task.id + '/events'), 'POST', {client_id: unique(), expected_version: 2, type: 'uncertain',
    run_id: run + '-task-run', summary: textFixtures.message}, 'writer', 201);
  fixturesData.memory = (await api(projectPath('memory'), 'POST', {client_id: unique(), title: textFixtures.memory, body: bodyMarker}, 'writer', 201)).memory;
  fixturesData.note = (await api(projectPath('notes'), 'POST', {client_id: unique(), title: textFixtures.note, body: textFixtures.message}, 'writer', 201)).note;
  const bytes = Buffer.from('No models or commands started');
  fixturesData.artifact = (await api(projectPath('artifacts'), 'POST', {client_id: unique(), role: 'evidence', base_revision: 'i18n-fixture',
    sha256: hash(bytes), content_base64: bytes.toString('base64')}, 'writer', 201)).artifact;
  fixturesData.session = (await api(projectPath('sessions'), 'POST', {session_id: run + '-session', channel_id: ids.alpha, run_id: run + '-lease-run',
    task_role: 'writer', runtime: 'fixture', model: 'no-model', activity: textFixtures.activity, ttl_seconds: 120, max_duration_seconds: 300}, 'writer', 201)).session;
  // Legacy heartbeat freshness expires after 30 seconds. Fix the owned fixture
  // as already stale AFTER recording its real receipts, so an unrelated timed
  // expiry does not emit a workspace update inside a no-network locale probe.
  await sql(`UPDATE "${schema}".principals SET last_seen_at=clock_timestamp()-interval '10 minutes' WHERE id='${ids.peer}';`, 'stable-owned-presence');
}
class CDP {
  constructor(url, name) {
    this.ws = new WebSocket(url); this.name = name; this.serial = 0; this.pending = new Map(); this.requests = []; this.active = new Map(); this.streamEvidence = new Map();
    this.ready = new Promise((resolveSocket, reject) => { this.ws.onopen = resolveSocket; this.ws.onerror = () => reject(new Error('Owned CDP unavailable')); });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) { const item = this.pending.get(message.id); clearTimeout(item.timer); this.pending.delete(message.id); message.error ? item.reject(new Error(`CDP ${item.method} failed`)) : item.resolve(message.result); }
      if (message.method === 'Runtime.exceptionThrown') report.browser_errors.push({tab: name, category: message.params.exceptionDetails.text});
      if (message.method === 'Page.javascriptDialogOpening') { const entry = {tab: this.name, type: message.params.type, text: safeError(message.params.message)}; this.lastDialog = entry; report.dialogs.push(entry); void this.call('Page.handleJavaScriptDialog', {accept: Boolean(this.acceptDialog)}).catch(() => {}); }
      if (message.method === 'Fetch.requestPaused') {
        const {request, requestId} = message.params, url = new URL(request.url);
        const allowedMutation = request.method === 'POST' && this.allowedMutation === url.pathname && url.origin === new URL(base).origin;
        if (allowedMutation) this.allowedMutation = '';
        const deny = url.origin !== new URL(base).origin || request.method !== 'GET' && !allowedMutation;
        const fixtureFailure = Boolean(this.blockMap && /\/map$/.test(url.pathname));
        if (deny) report.browser_guard_failed = true;
        void this.call(deny || fixtureFailure ? 'Fetch.failRequest' : 'Fetch.continueRequest', deny || fixtureFailure ? {requestId, errorReason: 'BlockedByClient'} : {requestId}).catch(() => {});
      }
      if (message.method === 'Network.requestWillBeSent') {
        const req = message.params.request, url = new URL(req.url);
        const entry = {tab: name, method: req.method, path: url.origin === new URL(base).origin ? url.pathname : '[off-origin]', query: url.search, at: Date.now(), loader_id: message.params.loaderId, frame_id: message.params.frameId};
        this.requests.push(entry); report.requests.push(entry); this.active.set(message.params.requestId, entry);
        if (url.pathname === '/v1/workspace/stream') { const stream = {tab: name, request_id: message.params.requestId, started_at: entry.at, chunks: []}; this.streamEvidence.set(message.params.requestId, stream); report.stream_lifecycle.push(stream); }
      }
      // Chromium can omit loadingFailed for an HTTP/2 fetch when its entire
      // document is destroyed by reload. Retire only requests owned by the
      // previous loader of this same frame, and report document disposal
      // distinctly from an observed network abort. Locale changes do not
      // navigate, so their strict request-ID identity checks are unaffected.
      if (message.method === 'Page.frameNavigated') {
        const frame = message.params.frame;
        for (const [requestId, entry] of this.active) {
          if (entry.frame_id !== frame.id || !entry.loader_id || entry.loader_id === frame.loaderId) continue;
          this.active.delete(requestId);
          const stream = this.streamEvidence.get(requestId);
          if (stream && !stream.ended_at) { stream.ended_at = Date.now(); stream.end_event = 'Page.frameNavigated'; stream.document_disposed = true; }
        }
      }
      if (message.method === 'Network.responseReceived') {
        const entry = this.active.get(message.params.requestId); if (entry) { entry.status = message.params.response.status; entry.protocol = message.params.response.protocol; }
        const stream = this.streamEvidence.get(message.params.requestId); if (stream) { stream.status = message.params.response.status; stream.protocol = message.params.response.protocol; }
      }
      if (message.method === 'Network.dataReceived') { const stream = this.streamEvidence.get(message.params.requestId); if (stream && stream.chunks.length < 40) stream.chunks.push({at: Date.now(), bytes: message.params.dataLength}); }
      if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) { const stream = this.streamEvidence.get(message.params.requestId); if (stream) { stream.ended_at = Date.now(); stream.end_event = message.method; stream.error = message.params.errorText; stream.canceled = message.params.canceled; } }
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
const testingTransport = `(()=>{const original=window.fetch.bind(window);window.__fetches=[];window.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);window.__fetches.push({path:url.pathname,method:init?.method||'GET',at:Date.now(),stack:new Error().stack});return original(input,init);};})();`;
async function browsers() {
  profile = await mkdtemp(join(tmpdir(), 'agentlink-i18n-browser-')); browserLog = await open(`${directory}/browser.private.log`, 'wx', 0o600);
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
    await tab.call('Page.navigate', {url: base}); await tab.wait(`document.readyState==='complete' && !!document.getElementById('language-select')`, 'bilingual page', 15000);
    if (actor === 'writer') writer = tab; else if (actor === 'viewer') viewer = tab; else owner = tab;
  }
}


async function keyboard(tab, key, code, number) {
  const text = key === 'Enter' ? {text: '\r', unmodifiedText: '\r'} : {};
  await tab.call('Input.dispatchKeyEvent', {type: 'keyDown', key, code, windowsVirtualKeyCode: number, ...text});
  await tab.call('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode: number});
}
async function idle(tab, quiet = 100) {
  await tab.wait(() => ![...tab.active.values()].some(r => r.path.startsWith('/v1/') && !r.path.endsWith('/stream')), 'API settled', 10000);
  for (let attempt = 0; attempt < 8; attempt++) { const count = tab.requests.length; await pause(quiet); if (count === tab.requests.length && ![...tab.active.values()].some(r => r.path.startsWith('/v1/') && !r.path.endsWith('/stream'))) return; }
  throw new Error('API did not become quiet');
}
const streams = tab => [...tab.active.entries()].filter(([, r]) => r.path.endsWith('/stream')).map(([id]) => id).sort();
async function language(tab, lang, {dispatch = false} = {}) {
  // Restoring a background tab legitimately schedules a visibility catch-up.
  // Bring it forward BEFORE settling and measuring the language operation.
  await tab.call('Page.bringToFront');
  await idle(tab, 750); const before = {at: Date.now(), requests: tab.requests.length, streams: streams(tab), fetches: await tab.eval('window.__fetches.length'), timeOrigin: await tab.eval('performance.timeOrigin')};
  if (dispatch) {
    // Native <dialog> makes the global selector inert to pointer input. This is
    // an explicitly programmatic rendering regression, not an interaction claim.
    await tab.eval("(()=>{const e=document.getElementById('language-select');e.value=" + js(lang) + ";e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  } else {
    await tab.click('#language-select');
    await keyboard(tab, lang === 'en' ? 'Home' : 'End', lang === 'en' ? 'Home' : 'End', lang === 'en' ? 36 : 35);
    await keyboard(tab, 'Enter', 'Enter', 13);
  }
  await tab.wait("document.documentElement.lang===" + js(lang) + " && document.getElementById('language-select').value===" + js(lang) + " && new URLSearchParams(location.search).get('lang')===" + js(lang), 'selected UI language/URL');
  await pause(750);
  const after = {requests: tab.requests.length, streams: streams(tab), fetches: await tab.eval('window.__fetches.length'), timeOrigin: await tab.eval('performance.timeOrigin')};
  report.language_changes.push({tab: tab.name, language: lang, dispatch_only: dispatch, started_at: before.at, finished_at: Date.now(), streams_before: before.streams, streams_after: after.streams, requests_added: after.requests - before.requests, fetches_added: after.fetches - before.fetches,
    same_streams: JSON.stringify(before.streams) === JSON.stringify(after.streams), same_document: before.timeOrigin === after.timeOrigin});
  assert(after.requests === before.requests && after.fetches === before.fetches, 'Language change issued a network request');
  assert(JSON.stringify(before.streams) === JSON.stringify(after.streams) && before.timeOrigin === after.timeOrigin, 'Language change restarted SSE or document');
  assert(await tab.eval("localStorage.length===0 && sessionStorage.length===0 && !/[?&](?:key|token|authorization)=/i.test(location.search)"), 'Language switch persisted auth data/storage');
}
async function english(tab, label) {
  await tab.wait("document.documentElement.lang==='en'", 'English document');
  const untranslated = await tab.eval("(()=>{const allowed=" + js(allowedRussian) + ";const clean=value=>allowed.reduce((out,text)=>out.split(text).join(''),value);const values=[document.title],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode()){const e=text.parentElement;if(!e||e.closest('[hidden],script,style,.message-avatar')||!e.getClientRects().length)continue;values.push(text.data);}for(const e of document.querySelectorAll('[aria-label],[placeholder],[title]')){if(!e.getClientRects().length||e.closest('[hidden]'))continue;for(const a of ['aria-label','placeholder','title'])if(e.hasAttribute(a))values.push(e.getAttribute(a));}return values.flatMap(value=>clean(value).split('\\n')).map(s=>s.trim()).filter(s=>/[А-Яа-яЁё]/.test(s)).slice(0,15);})()");
  if (untranslated.length) report.untranslated.push({label, tab: tab.name, text: untranslated.map(safeError)});
  assert(untranslated.length === 0, 'Untranslated Russian UI in English: ' + label);
  assert(await tab.eval("/Project map/i.test(document.getElementById('nav-project-map').textContent) && /Tasks/i.test(document.getElementById('nav-tasks').textContent)"), 'Important navigation not translated to English');
}
async function login(tab, actor) {
  await tab.fill('api-key', keys[actor]); await tab.click('#login-button');
  await tab.wait("document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled", 'login ready', 15000);
  await project(tab);
  await tab.wait(() => streams(tab).length > 0, 'authenticated SSE stream', 8000);
}
async function project(tab, name = 'project') {
  await tab.click('#project-switcher [data-focus-key="project:' + ids[name] + '"]');
  await tab.wait("document.querySelector('[data-focus-key=\"project:" + ids[name] + "\"]').getAttribute('aria-pressed')==='true' && !document.getElementById('refresh-button').disabled", 'selected fixture project');
  await idle(tab);
}
async function pane(tab, name, panel = name + '-pane') {
  await tab.click('#nav-' + name); await tab.wait("!document.getElementById(" + js(panel) + ").hidden", 'open ' + name); await idle(tab);
}
async function map(tab) {
  await pane(tab, 'project-map', 'project-map-panel');
  await tab.wait("Array.from(document.querySelectorAll('#project-map-counts [data-count-state]')).length===14 && Array.from(document.querySelectorAll('#project-map-counts [data-count-state]')).every(e=>['ready','partial'].includes(e.dataset.countState))", 'map snapshot ready');
}
async function selectMap(tab, type, id) {
  await tab.filter('project-map-type', type); await tab.fill('project-map-search', '');
  await tab.click('#project-map-entities [data-entity-type="' + type + '"][data-entity-id="' + id + '"]');
  await tab.wait("document.querySelector('#project-map-detail [data-entity-id]')?.dataset.entityId===" + js(id), 'selected map node');
}
async function roundtrip(tab, stateExpression, label) {
  await idle(tab); const before = await tab.eval(stateExpression);
  await language(tab, 'ru');
  assert(JSON.stringify(await tab.eval(stateExpression)) === JSON.stringify(before), 'Russian switch changed ' + label);
  await language(tab, 'en'); await english(tab, label);
  assert(JSON.stringify(await tab.eval(stateExpression)) === JSON.stringify(before), 'English switch changed ' + label);
}
async function screenshot(tab, label, width) {
  await tab.call('Page.bringToFront'); await tab.eval('window.scrollTo(0,0)');
  assert(await tab.eval("(()=>{const keys=" + js([...secrets]) + ";return !keys.some(key=>document.body.innerText.includes(key)||Array.from(document.querySelectorAll('input,textarea')).some(e=>e.value.includes(key)));})()"), 'Screenshot could contain secret');
  const file = directory + '/' + label + '.png', shot = await tab.call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  await writeFile(file, Buffer.from(shot.data, 'base64'), {mode: 0o600, flag: 'wx'}); report.screenshots.push({label, width, file});
}
async function stopChild(child) {
  for (const signal of ['SIGTERM', 'SIGKILL']) if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill(signal); await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), pause(2500)]); }
  return !child || !child.pid || child.exitCode !== null || child.signalCode !== null;
}

try {
  await check('English is default; login language changes preserve masked key and use URL only', async () => {
    await isolatedServer(); await fixtures(); await browsers();
    for (const tab of tabs) {
      assert(await tab.eval("document.documentElement.lang==='en' && document.getElementById('language-select').value==='en' && !new URLSearchParams(location.search).has('lang') && !document.getElementById('login-panel').hidden"), 'Fresh tab not default English login');
      assert(await tab.eval("document.querySelector('#language-select option[value=\"en\"]').textContent==='English' && document.querySelector('#language-select option[value=\"ru\"]').textContent==='Русский'"), 'Language selector options inaccessible');
    }
    await english(writer, 'default login');
    await writer.fill('api-key', keys.writer); await writer.eval("document.getElementById('api-key').setSelectionRange(3,11)");
    const state = "({sameKey:document.getElementById('api-key').value===" + js(keys.writer) + ",type:document.getElementById('api-key').type,start:document.getElementById('api-key').selectionStart,end:document.getElementById('api-key').selectionEnd})";
    await roundtrip(writer, state, 'masked login key/caret');
    assert(await writer.eval("new URLSearchParams(location.search).get('lang')==='en' && document.getElementById('api-key').type==='password'"), 'Language URL/key masking incorrect');
    await writer.fill('api-key', '');
  });
  await check('authenticated overview and project identity translate without reconnecting SSE or user names', async () => {
    for (const actor of ['writer', 'viewer', 'owner']) await login({writer, viewer, owner}[actor], actor);
    await english(viewer, 'overview status and attention');
    const original = "({project:document.querySelector('#project-switcher [aria-pressed=\"true\"]')?.dataset.focusKey,name:document.getElementById('overview-title').textContent,taskCount:document.getElementById('overview-metric-tasks').textContent})";
    assert(await viewer.eval("document.getElementById('overview-title').textContent===" + js(textFixtures.project) + " && document.getElementById('overview-attention').textContent.includes(" + js(textFixtures.task) + ")"), 'User strings matching UI labels were translated in English');
    assert(await viewer.eval("document.getElementById('overview-agents').textContent.includes(" + js(textFixtures.writer) + ") && document.getElementById('overview-agents').textContent.includes(" + js(textFixtures.peer) + ")"), 'User account display names were translated');
    await roundtrip(viewer, original, 'selected project and counts');
    assert(await viewer.eval("document.getElementById('connection-state').textContent.trim().length>8 && document.getElementById('overview-note').textContent.trim().length>20"), 'Dynamic connection/source labels missing');
    await project(viewer, 'other'); await roundtrip(viewer, "document.getElementById('overview-title').textContent", 'English project name');
    assert(await viewer.eval("document.getElementById('overview-title').textContent===" + js(textFixtures.other)), 'English user name was translated to Russian');
    await project(viewer); await screenshot(viewer, 'i18n-overview-en-desktop', 1440);
  });
  await check('chat receipts dynamic text and live events translate while drafts selections and open details survive', async () => {
    await writer.click('#channel-list [data-focus-key="channel:' + ids.alpha + '"]');
    await writer.wait("!document.getElementById('composer-form').hidden && !!document.querySelector('#message-list [data-message-id=\"" + fixturesData.message.id + "\"]')", 'chat fixture'); await idle(writer);
    await writer.click('#message-list details[data-message-id="' + fixturesData.message.id + '"] summary');
    await writer.click('#recipient-list input[value="' + ids.peer + '"]');
    await writer.fill('message-input', textFixtures.draft); await writer.eval("document.getElementById('message-input').setSelectionRange(2,8)");
    const expression = "({draft:document.getElementById('message-input').value,start:document.getElementById('message-input').selectionStart,end:document.getElementById('message-input').selectionEnd,checked:Array.from(document.querySelectorAll('#recipient-list input:checked')).map(e=>e.value),details:document.querySelector('#message-list details[data-message-id=\"" + fixturesData.message.id + "\"]').open,messages:Array.from(document.querySelectorAll('#message-list .message-text')).map(e=>e.textContent)})";
    await english(writer, 'chat receipts and statuses'); await roundtrip(writer, expression, 'chat draft/caret/recipient/details/body');
    assert(await writer.eval("document.querySelector('#message-list [data-message-id=\"" + fixturesData.message.id + "\"] .message-text').textContent===" + js(textFixtures.message) + " && document.querySelector('#message-list [data-message-id=\"" + fixturesData.reply.id + "\"] .message-text').textContent===" + js(textFixtures.reply)), 'Message bodies matching status labels were translated');
    await language(writer, 'ru'); const documentID = await writer.eval('performance.timeOrigin');
    const live = (await api('/v1/channels/' + ids.alpha + '/messages', 'POST', {client_id: unique(), body: textFixtures.note, recipient_ids: [ids.peer]}, 'writer', 201)).message;
    await writer.wait("!!document.querySelector('#message-list [data-message-id=\"" + live.id + "\"]')", 'live message in chosen language', 12000); await idle(writer);
    assert(await writer.eval("performance.timeOrigin===" + documentID + " && document.getElementById('message-input').value===" + js(textFixtures.draft)), 'Live update lost draft/reloaded');
    await language(writer, 'en'); await english(writer, 'live translated chat');
  });
  await check('map dynamic metadata and relations translate without losing filters selected entity or user label', async () => {
    await map(viewer); await selectMap(viewer, 'task', fixturesData.task.id);
    await viewer.fill('project-map-search', textFixtures.task);
    const expression = "({type:document.getElementById('project-map-type').value,search:document.getElementById('project-map-search').value,key:document.getElementById('project-map-detail').dataset.entityKey,counts:Array.from(document.querySelectorAll('#project-map-counts [data-count-value]')).map(e=>[e.dataset.entityType,e.dataset.countValue]),relations:Array.from(document.querySelectorAll('#project-map-relations [data-relation-type]')).map(e=>[e.dataset.relationType,e.dataset.source,e.dataset.target]),title:document.querySelector('#project-map-detail h3').textContent})";
    await english(viewer, 'map live metadata'); await roundtrip(viewer, expression, 'map filters/selection/counts/relations');
    assert(await viewer.eval("document.querySelector('#project-map-detail h3').textContent===" + js(textFixtures.task) + " && /Project map/i.test(document.getElementById('project-map-title').textContent)"), 'Map mixed up UI title and user title');
    await viewer.filter('project-map-type', ''); await viewer.fill('project-map-search', '');
    await screenshot(viewer, 'i18n-map-en-desktop', 1440);
  });
  await check('project CLI timeline filters and fresh empty statuses localize with stable connection', async () => {
    await pane(viewer, 'project-native', 'project-native-panel');
    await viewer.wait("!!document.querySelector('#project-native-list [data-native-id=\"" + fixturesData.native.id + "\"]')", 'project native fixture');
    await viewer.filter('project-native-actor', ids.writer); await viewer.filter('project-native-channel', ids.alpha); await idle(viewer);
    const expression = "({actor:document.getElementById('project-native-actor').value,channel:document.getElementById('project-native-channel').value,freshness:document.getElementById('project-native-last-event').dataset.freshness,ids:Array.from(document.querySelectorAll('#project-native-list [data-native-id]')).map(e=>e.dataset.nativeId)})";
    await english(viewer, 'native dynamic event/freshness'); await roundtrip(viewer, expression, 'native filters/event identity');
    await viewer.filter('project-native-channel', ids.beta);
    await viewer.wait("document.getElementById('project-native-last-event').dataset.freshness==='empty'", 'empty native observation'); await idle(viewer);
    await roundtrip(viewer, expression, 'native empty status');
    assert(await viewer.eval("document.getElementById('project-native-list').textContent.trim().length>10 && document.getElementById('project-native-last-event').textContent.trim().length>10"), 'Empty status disappeared in English');
  });
  await check('coordination and notes localize while task memory and modal drafts remain exact', async () => {
    await pane(writer, 'tasks');
    await writer.click('#task-list [data-focus-key="task:' + fixturesData.task.id + '"]');
    await writer.wait("document.querySelector('#task-detail [data-task-id]')?.dataset.taskId===" + js(fixturesData.task.id) + " && !document.getElementById('task-event-form').hidden", 'selected uncertain task');
    await writer.fill('task-event-summary', textFixtures.draft); await writer.eval("document.getElementById('task-event-summary').setSelectionRange(1,6)");
    await roundtrip(writer, "({task:document.querySelector('#task-detail [data-task-id]').dataset.taskId,kind:document.getElementById('task-event-kind').value,summary:document.getElementById('task-event-summary').value,start:document.getElementById('task-event-summary').selectionStart,end:document.getElementById('task-event-summary').selectionEnd})", 'task state/actions/draft');
    assert(await writer.eval("document.querySelector('#task-detail h4').textContent===" + js(textFixtures.task)), 'Task user title translated');
    await pane(writer, 'memory'); await writer.wait("!document.getElementById('memory-edit').hidden", 'memory loaded');
    await writer.click('#memory-edit'); await writer.fill('memory-body', textFixtures.draft); await writer.eval("document.getElementById('memory-body').setSelectionRange(2,7)");
    await roundtrip(writer, "({title:document.getElementById('memory-title').value,body:document.getElementById('memory-body').value,start:document.getElementById('memory-body').selectionStart,end:document.getElementById('memory-body').selectionEnd,history:document.querySelector('#memory-history .coordination-body')?.textContent})", 'memory draft/caret/history');
    await pane(writer, 'artifacts'); await english(writer, 'artifact role/status');
    await pane(writer, 'sessions'); await english(writer, 'session claims/status');
    await pane(writer, 'notes', 'notes-panel'); await english(writer, 'published notes');
    assert(await writer.eval("document.querySelector('#memory-list .note-title').textContent===" + js(textFixtures.note) + " && document.querySelector('#memory-list .note-text').textContent===" + js(textFixtures.message)), 'Published note content translated');
    await writer.click('#new-note-button'); await writer.fill('note-title', textFixtures.note); await writer.fill('note-body', textFixtures.draft);
    await writer.eval("document.getElementById('note-body').setSelectionRange(3,6)");
    const modal = await writer.eval("({title:document.getElementById('note-title').value,body:document.getElementById('note-body').value,start:document.getElementById('note-body').selectionStart,end:document.getElementById('note-body').selectionEnd})");
    for (const lang of ['ru', 'en']) {
      await language(writer, lang, {dispatch: true});
      assert(await writer.eval("document.getElementById('note-dialog').open"), 'Language closed note dialog');
      assert(JSON.stringify(await writer.eval("({title:document.getElementById('note-title').value,body:document.getElementById('note-body').value,start:document.getElementById('note-body').selectionStart,end:document.getElementById('note-body').selectionEnd})")) === JSON.stringify(modal), 'Language changed note modal draft');
    }
    await english(writer, 'note modal'); await writer.click('#note-cancel');
  });
  await check('admin sections confirmations and one-time key dialog retain local state across languages', async () => {
    await pane(owner, 'admin', 'admin-panel');
    await owner.fill('admin-principal-name', textFixtures.draft);
    await roundtrip(owner, "({name:document.getElementById('admin-principal-name').value,section:document.querySelector('#admin-section-nav [aria-pressed=\"true\"]').dataset.adminSection})", 'admin account form');
    for (const section of ['projects', 'access', 'diagnostics', 'accounts']) {
      await owner.click('#admin-section-nav [data-admin-section="' + section + '"]'); await english(owner, 'admin ' + section);
    }
    const selector = '#admin-principal-list [data-admin-action="rotate-key"][data-principal-id="' + ids.target + '"]';
    for (const lang of ['en', 'ru']) {
      if (await owner.eval('document.documentElement.lang') !== lang) await language(owner, lang);
      owner.lastDialog = null; owner.acceptDialog = false; const requestCount = owner.requests.length;
      await owner.click(selector); await owner.wait(() => Boolean(owner.lastDialog), 'localized key confirmation');
      const text = owner.lastDialog.text;
      assert(lang === 'en' ? !/[А-Яа-яЁё]/.test(text) && /key/i.test(text) : /ключ/i.test(text), 'Confirmation not in selected language');
      assert(owner.requests.length === requestCount && !await owner.eval("document.getElementById('admin-key-dialog').open"), 'Cancelled key confirmation mutated or opened secret dialog');
    }
    await language(owner, 'en');
    owner.allowedMutation = '/v1/admin/principals/' + ids.target + '/rotate-key'; owner.acceptDialog = true;
    await owner.click(selector); await owner.wait("document.getElementById('admin-key-dialog').open && document.getElementById('admin-issued-key').value.length===64", 'owned disposable key issued');
    owner.acceptDialog = false; keys.target = await owner.eval("document.getElementById('admin-issued-key').value"); secrets.add(keys.target);
    await owner.eval("window.__issuedKeyElement=document.getElementById('admin-issued-key');document.getElementById('admin-issued-key').setSelectionRange(2,9)");
    // The deliberate fixture key mutation also emits an independent workspace
    // hint. Settle its 1-second server poll and REST catch-up before measuring.
    await idle(owner, 2000);
    for (const lang of ['ru', 'en']) {
      await language(owner, lang, {dispatch: true});
      assert(await owner.eval("document.getElementById('admin-key-dialog').open && window.__issuedKeyElement===document.getElementById('admin-issued-key') && document.getElementById('admin-issued-key').value===" + js(keys.target) + " && document.getElementById('admin-issued-key').selectionStart===2 && document.getElementById('admin-issued-key').selectionEnd===9"), 'Language changed one-time key/dialog/caret');
    }
    await english(owner, 'one-time key modal'); await owner.click('#admin-key-close');
    assert(await owner.eval("!document.getElementById('admin-key-dialog').open && document.getElementById('admin-issued-key').value===''"), 'Closing key dialog retained secret');
    assert(report.requests.filter(r => r.method !== 'GET').every(r => r.tab === 'owner' && r.method === 'POST' && r.path === '/v1/admin/principals/' + ids.target + '/rotate-key') && report.requests.filter(r => r.method !== 'GET').length === 1, 'Unexpected browser mutation');
  });
  await check('login and map errors switch languages in place without retry or false-zero data', async () => {
    // Exercise connected lazy map labels after their project scope is cleared.
    await map(viewer);
    await viewer.click('#logout-button'); await viewer.wait("!document.getElementById('login-panel').hidden", 'viewer logout for login error');
    await viewer.fill('api-key', 'not-a-valid-owned-key'); await viewer.click('#login-button');
    await viewer.wait("!document.getElementById('login-error').hidden && !document.getElementById('login-button').disabled", 'visible authentication error');
    await english(viewer, 'English login error');
    const keyText = await viewer.eval("document.getElementById('api-key').value");
    await language(viewer, 'ru');
    assert(await viewer.eval("/[А-Яа-яЁё]/.test(document.getElementById('login-error').textContent) && document.getElementById('api-key').value===" + js(keyText)), 'Error switch lost input or stayed English');
    await language(viewer, 'en'); await english(viewer, 'translated login error'); await login(viewer, 'viewer');
    await map(viewer); viewer.blockMap = true; await viewer.click('#refresh-button');
    await viewer.wait("!document.getElementById('project-map-error').hidden", 'map network error');
    await english(viewer, 'English map error');
    await roundtrip(viewer, "({states:Array.from(document.querySelectorAll('#project-map-counts [data-count-state]')).map(e=>[e.dataset.entityType,e.dataset.countState,e.dataset.countValue]),key:document.getElementById('project-map-detail').dataset.entityKey})", 'stale map error/counts');
    assert(await viewer.eval("Array.from(document.querySelectorAll('#project-map-counts [data-count-state]')).every(e=>e.dataset.countState==='stale' && !e.hasAttribute('data-count-value'))"), 'Translation converted unknown/stale counts to zero');
    viewer.blockMap = false; await viewer.click('#refresh-button');
    await viewer.wait("document.getElementById('project-map-error').hidden", 'map recovers');
  });
  await check('mobile selector fits 320 360 390 and Russian reload retains only URL preference', async () => {
    await project(viewer, 'other');
    for (const width of [320, 360, 390]) {
      await viewer.call('Emulation.setDeviceMetricsOverride', {width, height: 844, deviceScaleFactor: 1, mobile: true});
      for (const lang of ['ru', 'en']) {
        await language(viewer, lang);
        const layout = await viewer.eval("(()=>{const r=document.getElementById('language-select').getBoundingClientRect();return {language:document.documentElement.lang,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,left:r.left,right:r.right,height:r.height};})()");
        report.layouts.push(layout); assert(layout.scrollWidth <= width + 1 && layout.left >= 0 && layout.right <= width + 1 && layout.height >= 40, 'Mobile language UI overflow/inaccessible');
      }
      await viewer.click('#sidebar-toggle'); await keyboard(viewer, 'Escape', 'Escape', 27);
      assert(await viewer.eval("!document.body.classList.contains('nav-open')"), 'Escape stopped closing mobile navigation');
    }
    await screenshot(viewer, 'i18n-mobile-en', 390);
    await language(viewer, 'ru'); await screenshot(viewer, 'i18n-mobile-ru', 390);
    assert(await viewer.eval("new URLSearchParams(location.search).get('lang')==='ru' && localStorage.length===0 && sessionStorage.length===0"), 'Russian preference not URL-only');
    await viewer.call('Page.reload');
    await viewer.wait("document.readyState==='complete' && document.documentElement.lang==='ru' && !document.getElementById('login-panel').hidden && document.getElementById('language-select').value==='ru'", 'Russian reload', 15000);
    assert(await viewer.eval("document.getElementById('api-key').value==='' && localStorage.length===0 && sessionStorage.length===0 && document.getElementById('project-map-entities').textContent===''"), 'Reload retained key/protected cache');
    await language(viewer, 'en'); await english(viewer, 'mobile logged-out English');
    await screenshot(viewer, 'i18n-login-en-mobile', 390);
  });
  await check('logout clears credentials and protected data without language-triggered traffic', async () => {
    for (const tab of tabs) {
      await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
      if (await tab.eval("document.getElementById('login-panel').hidden")) await tab.click('#logout-button');
      await tab.wait("!document.getElementById('login-panel').hidden && document.getElementById('api-key').value==='' && document.getElementById('admin-issued-key').value==='' && document.getElementById('message-list').textContent==='' && localStorage.length===0 && sessionStorage.length===0", 'logout protected data cleared');
      await tab.wait(() => ![...tab.active.values()].some(r => r.path.startsWith('/v1/')), 'logout streams aborted');
    }
    const requestCounts = tabs.map(tab => tab.requests.length); await pause(1200);
    assert(tabs.every((tab, i) => tab.requests.length === requestCounts[i]), 'Logged-out client reconnected');
    assert(report.language_changes.length >= 30 && report.language_changes.every(change => change.requests_added === 0 && change.fetches_added === 0 && change.same_streams && change.same_document), 'Insufficient zero-request language coverage');
    assert(!report.browser_guard_failed && report.browser_errors.length === 0 && report.untranslated.length === 0, 'Browser runtime/security/translation failure');
  });
} catch (error) {
  if (!report.cases.some(item => !item.passed)) report.cases.push({name: 'infrastructure', passed: false, error: safeError(error)});
  report.failure_controls = [];
  for (const tab of tabs) { try { report.failure_controls.push({tab: tab.name, state: await tab.eval(`({login:document.getElementById('login-panel')?.hidden,panel:document.getElementById('project-map-panel')?.hidden,language:document.documentElement.lang,languageURL:new URLSearchParams(location.search).get('lang'),overviewTitle:document.getElementById('overview-title')?.textContent,overviewNote:document.getElementById('overview-note')?.textContent,status:document.getElementById('project-map-status')?.textContent,error:document.getElementById('project-map-error')?.textContent,apiError:document.getElementById('api-error')?.textContent,fetches:window.__fetches.slice(-10)})`)}); } catch {} }
} finally {
  for (const tab of tabs) { try { await tab.eval(`document.getElementById('logout-button')?.click()`); } catch {} tab.close(); }
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
  const output = directory ? `${directory}/evidence.json` : `${runtime}/evidence/i18n-gui-setup-failed.json`;
  let serialized = JSON.stringify(report, null, 2) + '\n'; for (const key of secrets) serialized = serialized.replaceAll(key, '[REDACTED]');
  await writeFile(output, serialized, {mode: 0o600, flag: 'wx'});
  console.log(JSON.stringify({success: report.success, cases: report.cases.length, owned_schema_removed: report.owned_schema_removed, owned_server_stopped: report.owned_server_stopped,
    owned_browser_stopped: report.owned_browser_stopped, evidence: output}));
}
if (!report.success) process.exitCode = 1;
