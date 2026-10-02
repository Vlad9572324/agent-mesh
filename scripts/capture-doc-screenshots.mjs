// Capture the actual GUI with fictional documentation fixtures, never live data.
// Requires the same private loopback test database, TLS fixture and Chromium as
// tests/i18n_gui.mjs. Run: node scripts/capture-doc-screenshots.mjs
// All API mutations precede browser capture and target one disposable schema.
import {readFile, writeFile, mkdtemp, mkdir, copyFile, rm, open, lstat, readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, createHash, X509Certificate} from 'node:crypto';
import net from 'node:net';
import https from 'node:https';
import {runtimeDir, certificateFile, browserExecutable} from './operator-config.mjs';

process.umask(0o077);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// --check-safety stays offline and needs no operator settings.
let runtime, chrome, caPath;
const output = join(root, 'docs/assets/screenshots');
const schema = `docs_gui_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const ids = {owner: 'workspace-owner', writer: 'codex', reviewer: 'claude', viewer: 'taylor', project: 'atlas-sdk', engineering: 'engineering', reviews: 'reviews', releases: 'release-notes'};
const report = {started_at: new Date().toISOString(), schema, database: 'agentlink_test',
  purpose: 'Actual current GUI, fictional Atlas SDK documentation fixtures; no production data or model processes',
  assets: {}, requests: [], browser_errors: [], screenshots: [], model_processes_started: 0};
const keys = {}, secrets = new Set(), data = {}, tabs = [];
const js = JSON.stringify, pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
let evidence, scratch, base, ca, pgEnv, sourceDSNHash, server, serverLog, browser, browserLog, browserCDP, profile;
let schemaCreated = false, fixturesComplete = false, serial = 0;
function safe(error) { let text = String(error?.message || error); for (const key of secrets) text = text.replaceAll(key, '[REDACTED]'); return text.slice(0, 400); }
async function privateRead(path) {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077), 'Expected private regular fixture file');
  return readFile(path);
}
async function command(binary, args, label, {env = process.env, input, timeout = 60000} = {}) {
  const result = await new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
    const stdout = [], stderr = []; let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
    child.once('error', () => { clearTimeout(timer); reject(new Error(`Fixture command unavailable: ${label}`)); });
    child.once('exit', code => { clearTimeout(timer); resolveCommand({code, expired, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)}); });
    child.stdin.end(input);
  });
  const number = ++serial;
  await writeFile(`${evidence}/${number}-${label}.private.stdout`, result.stdout, {mode: 0o600, flag: 'wx'});
  await writeFile(`${evidence}/${number}-${label}.private.stderr`, result.stderr, {mode: 0o600, flag: 'wx'});
  assert(result.code === 0 && !result.expired, `Fixture command failed: ${label}`); return result.stdout;
}
function sql(statement, label) {
  assert(/^docs_gui_[a-f0-9]{16}$/.test(schema), 'Invalid owned schema');
  return command(`${runtime}/pgsql/usr/lib/postgresql/14/bin/psql`, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], label, {env: pgEnv, input: statement, timeout: 20000});
}
async function sourceHashes() {
  const names = ['go.mod', 'go.sum'];
  async function collect(directory) {
    for (const item of await readdir(join(root, directory), {withFileTypes: true})) {
      const path = `${directory}/${item.name}`;
      if (item.isDirectory()) await collect(path); else if (item.isFile() && /\.(go|sql)$/.test(item.name)) names.push(path);
    }
  }
  await collect('cmd'); await collect('internal');
  const files = {}; for (const name of names.sort()) files[name] = hash(await readFile(join(root, name))); return files;
}
async function setup() {
  runtime = runtimeDir(); chrome = browserExecutable(); caPath = certificateFile();
  evidence = await mkdtemp(`${runtime}/evidence/docs-screenshots-`);
  scratch = await mkdtemp(join(tmpdir(), 'agentlink-docs-'));
  const source = await privateRead(`${runtime}/secrets/agentlink_test-dsn`); sourceDSNHash = hash(source);
  const url = new URL(source.toString('utf8').trim());
  assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && decodeURIComponent(url.pathname) === '/agentlink_test', 'Only loopback agentlink_test is permitted');
  assert(!url.searchParams.has('host') && !url.searchParams.has('port'), 'Ambiguous database endpoint');
  pgEnv = {...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: 'agentlink_test',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: url.searchParams.get('sslmode') || 'prefer',
    PGCONNECT_TIMEOUT: '5', LD_LIBRARY_PATH: `${runtime}/pgsql/usr/lib/x86_64-linux-gnu`};
  delete pgEnv.PGOPTIONS;
  assert((await sql('SELECT current_database();', 'database-boundary')).toString().trim() === 'agentlink_test', 'Unexpected database');
  await sql(`CREATE SCHEMA "${schema}";`, 'create-owned-schema'); schemaCreated = true;
  url.searchParams.set('search_path', schema);
  const dsn = join(scratch, 'database.private'); await writeFile(dsn, url.toString() + '\n', {mode: 0o600, flag: 'wx'});
  const sourceFiles = await sourceHashes(), binary = join(scratch, 'agent-link');
  await command('go', ['build', '-trimpath', '-o', binary, './cmd/agent-link'], 'build');
  assert(JSON.stringify(sourceFiles) === JSON.stringify(await sourceHashes()), 'Backend changed during build');
  report.backend = {source_files: sourceFiles, source_sha256: hash(JSON.stringify(sourceFiles)), binary_sha256: hash(await readFile(binary)), flags: ['-trimpath']};
  const web = join(scratch, 'web'); await mkdir(web, {mode: 0o700});
  for (const name of ['index.html', 'app.js', 'app.css']) {
    await copyFile(join(root, 'web', name), join(web, name)); report.assets[name] = hash(await readFile(join(web, name)));
  }
  const ownerPath = join(scratch, 'owner.private.json');
  await command(binary, ['bootstrap-owner', '--database-url-file', dsn, '--owner-id', ids.owner, '--owner-name', 'Workspace administrator', '--key-out', ownerPath], 'bootstrap-owner');
  const owner = JSON.parse((await privateRead(ownerPath)).toString());
  assert(owner.agent_id === ids.owner, 'Unexpected fixture owner'); keys.owner = owner.key; secrets.add(owner.key);
  const reservation = net.createServer();
  await new Promise((resolveListen, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolveListen); });
  const port = reservation.address().port; await new Promise(resolveClose => reservation.close(resolveClose));
  base = `https://127.0.0.1:${port}/`; report.private_origin = base;
  ca = await readFile(caPath);
  serverLog = await open(`${evidence}/server.private.log`, 'wx', 0o600);
  server = spawn(binary, ['serve', '--database-url-file', dsn, '--listen', `127.0.0.1:${port}`, '--tls-cert', `${runtime}/secrets/server.crt`,
    '--tls-key', `${runtime}/secrets/server.key`, '--web-dir', web], {cwd: root, stdio: ['ignore', serverLog.fd, serverLog.fd]});
  let failed = false; server.once('error', () => { failed = true; });
  for (let attempt = 0; attempt < 80; attempt++) {
    assert(!failed && server.exitCode === null, 'Owned server exited');
    try { if ((await api('/v1/me')).agent.id === ids.owner) return; } catch {}
    await pause(100);
  }
  throw new Error('Owned TLS server unavailable');
}
async function api(path, method = 'GET', body, actor = 'owner', expected = 200) {
  const url = new URL(path, base);
  assert(url.protocol === 'https:' && url.hostname === '127.0.0.1' && url.origin === new URL(base).origin, 'Nonowned API origin rejected');
  assert(!fixturesComplete || method === 'GET', 'Capture phase is read-only');
  const result = await new Promise((resolveRequest, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(url, {ca, method, timeout: 10000, headers: {Authorization: `Bearer ${keys[actor]}`,
      ...(payload === undefined ? {} : {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)})}}, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('end', () => {
        try { resolveRequest({status: res.statusCode, data: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null}); }
        catch { reject(new Error('Owned API invalid response')); }
      });
    });
    req.on('error', () => reject(new Error('Owned TLS API request failed'))); req.on('timeout', () => req.destroy()); req.end(payload);
  });
  assert(result.status === expected, `${method} ${url.pathname}: ${result.status}, expected ${expected}`); return result.data;
}
const project = tail => `/v1/projects/${ids.project}/${tail}`;
const unique = () => 'docs-' + randomUUID();
const grant = (actor, scope, resource, access) => api('/v1/admin/access', 'PUT', {agent_id: ids[actor], scope, resource_id: ids[resource], access});
async function task(title, scope, acceptance) {
  return (await api(project('tasks'), 'POST', {client_id: unique(), title, owner_id: ids.writer, reviewer_id: ids.reviewer, scope, acceptance}, 'writer', 201)).task;
}
async function event(task, type, summary, extra = {}, actor = 'writer') {
  const current = (await api(project('tasks/' + task.id), 'GET', undefined, actor)).task;
  return (await api(project('tasks/' + task.id + '/events'), 'POST', {client_id: unique(), expected_version: current.version, type,
    run_id: 'demo-' + task.id, summary, ...extra}, actor, 201)).event;
}
async function fixtures() {
  for (const [actor, name, kind] of [['writer', 'Codex · implementation', 'agent'], ['reviewer', 'Claude · review', 'agent'], ['viewer', 'Taylor · project lead', 'viewer']]) {
    await api('/v1/admin/principals', 'POST', {id: ids[actor], name, kind, runtime: 'documentation demo'}, 'owner', 201);
    keys[actor] = (await api('/v1/admin/principals/' + ids[actor] + '/rotate-key', 'POST', {})).key; secrets.add(keys[actor]);
  }
  await api('/v1/admin/projects', 'POST', {id: ids.project, name: 'Atlas SDK'}, 'owner', 201);
  for (const name of ['engineering', 'reviews', 'releases']) await api('/v1/admin/channels', 'POST', {id: ids[name], name: ids[name], project_id: ids.project}, 'owner', 201);
  for (const actor of ['writer', 'reviewer', 'viewer']) {
    const access = actor === 'viewer' ? 'read' : 'write';
    await grant(actor, 'project', 'project', access);
    for (const name of ['engineering', 'reviews', 'releases']) await grant(actor, 'channel', name, access);
  }
  async function message(body, actor = 'writer', channel = 'engineering', extra = {}) {
    return (await api(`/v1/channels/${ids[channel]}/messages`, 'POST', {client_id: unique(), body,
      recipient_ids: [ids[actor === 'writer' ? 'reviewer' : 'writer']], ...extra}, actor, 201)).message;
  }
  data.brief = await message('Atlas SDK v0.8: keep retries predictable, make pagination easy to follow, and document every public option.\n\nThis is a fictional documentation workspace; no live model processes are connected.');
  await message('Review focus: cancellation must stop retries, Retry-After needs a clear upper bound, and examples should work without a real API key.', 'reviewer', 'engineering', {reply_to: data.brief.id});
  data.handoff = await message('The retry policy draft is ready for independent review. The task includes its scope, acceptance criteria, and a linked implementation artifact.');
  await message('I have requested one change: explain whether a cancelled request consumes the retry budget. The pagination examples can be reviewed separately.', 'reviewer');
  await message('Review checklist\n• Check behavior against the task acceptance criteria.\n• Keep implementation and review reports separate.\n• Record uncertainty rather than implying a check passed.', 'reviewer', 'reviews');
  await message('v0.8 documentation preview: retry policy, pagination examples, and migration notes. Release approval is still pending.', 'writer', 'releases');
  await api('/v1/heartbeat', 'POST', {session_id: 'demo-review-receipts', activity: 'Fictional documentation fixture; no live model', runtime: 'documentation demo'}, 'reviewer');
  for (const status of ['delivered', 'accepted']) await api('/v1/messages/' + data.handoff.id + '/receipts', 'POST', {status, session_id: 'demo-review-receipts'}, 'reviewer');
  const bytes = Buffer.from('Fictional Atlas SDK retry policy draft. Documentation fixture only; not executable code or test evidence.\n');
  data.artifact = (await api(project('artifacts'), 'POST', {client_id: unique(), role: 'implementation', base_revision: 'atlas-sdk-demo',
    sha256: hash(bytes), content_base64: bytes.toString('base64')}, 'writer', 201)).artifact;
  const refs = [{artifact_id: data.artifact.id, role: data.artifact.role, sha256: data.artifact.sha256}];
  await task('Polish the release checklist', ['Release notes', 'Maintainer checklist'], ['Separate release approval from automated checks.']);
  await task('Document request timeouts', ['API reference · timeouts'], ['Distinguish connection and total request timeouts.']);
  data.migration = await task('Write the v0.8 migration guide', ['Migration guide', 'Configuration compatibility'], ['List renamed options with replacements.', 'Keep the quick-start example self-contained.']);
  data.retry = await task('Define the retry and cancellation policy', ['HTTP client · retry policy', 'Public configuration reference'], ['Respect cancellation before every retry.', 'Document Retry-After limits and default backoff.', 'Keep retry behavior consistent across examples.']);
  await event(data.retry, 'run_started', 'Documentation fixture: a recorded implementation stage, not a running model.');
  await event(data.retry, 'artifacts_ready', 'Retry policy draft is attached for review.', {artifacts: refs});
  const review = await event(data.retry, 'review_requested', 'Please review cancellation semantics and the public defaults.', {artifacts: refs});
  await event(data.retry, 'review_result', 'Clarify whether cancellation consumes the retry budget before approval.', {artifacts: refs, review_request_id: review.id, verdict: 'changes_requested'}, 'reviewer');
  data.pagination = await task('Add cursor pagination examples', ['SDK guide · pagination', 'Example response envelopes'], ['Show the first page and the next cursor.', 'Explain the empty-page and end-of-list cases.']);
  await event(data.pagination, 'run_started', 'Documentation fixture: example authoring stage recorded.');
  await event(data.pagination, 'artifacts_ready', 'Example outline is ready for independent review.', {artifacts: refs});
  await event(data.pagination, 'review_requested', 'Review the next-cursor example and the end-of-list explanation.', {artifacts: refs});
  data.memory = (await api(project('memory'), 'POST', {client_id: unique(), title: 'SDK design decisions',
    body: 'Keep transport details behind a small client interface.\n\nRetries must respect cancellation. Examples use placeholders, never real credentials. A review report is not evidence that automated checks ran.'}, 'writer', 201)).memory;
  await api(project('memory/' + data.memory.id), 'PUT', {client_id: unique(), expected_version: 1, title: 'SDK design decisions',
    body: 'Keep transport details behind a small client interface.\n\nRetries must respect cancellation and have a documented upper bound. Examples use placeholders, never real credentials. A review report is not evidence that automated checks ran.'}, 'writer');
  await api(project('notes'), 'POST', {client_id: unique(), title: 'Release scope · v0.8',
    body: 'Retry policy, cursor pagination, and migration guidance. This workspace contains fictional documentation examples only.', source_message_id: data.brief.id}, 'writer', 201);
  for (const [actor, channel, type, tool] of [
    ['writer', 'engineering', 'session.started'], ['reviewer', 'reviews', 'session.started'],
    ['writer', 'engineering', 'tool.completed', 'Read'], ['reviewer', 'reviews', 'tool.completed', 'Read'],
    ['writer', 'engineering', 'turn.completed'], ['reviewer', 'reviews', 'turn.completed'],
  ]) await api(`/v1/channels/${ids[channel]}/activity`, 'POST', {client_id: unique(), session_id: 'documentation-demo-' + ids[actor],
    runtime: actor === 'writer' ? 'codex' : 'claude', event_type: type, ...(tool ? {tool_name: tool} : {})}, actor, 201);
  // Leave no fresh heartbeat or execution lease that could suggest a live model.
  await sql(`UPDATE "${schema}".principals SET last_seen_at=clock_timestamp()-interval '12 minutes' WHERE id='${ids.reviewer}';`, 'stale-demo-heartbeat');
  fixturesComplete = true; report.capture_started_at = new Date().toISOString();
}

class CDP {
  constructor(url, name) {
    this.ws = new WebSocket(url); this.name = name; this.serial = 0; this.pending = new Map(); this.active = new Map(); this.requests = [];
    this.ready = new Promise((resolveReady, reject) => { this.ws.onopen = resolveReady; this.ws.onerror = () => reject(new Error('Owned CDP unavailable')); });
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) { const item = this.pending.get(msg.id); clearTimeout(item.timer); this.pending.delete(msg.id); msg.error ? item.reject(new Error(`CDP ${item.method} failed`)) : item.resolve(msg.result); }
      if (msg.method === 'Runtime.exceptionThrown') report.browser_errors.push({tab: name, category: msg.params.exceptionDetails.text});
      if (msg.method === 'Page.javascriptDialogOpening') { report.unexpected_dialog = true; void this.call('Page.handleJavaScriptDialog', {accept: false}).catch(() => {}); }
      if (msg.method === 'Fetch.requestPaused') {
        const {request, requestId} = msg.params, url = new URL(request.url);
        const deny = request.method !== 'GET' || url.origin !== new URL(base).origin;
        if (deny) report.browser_guard_failed = true;
        void this.call(deny ? 'Fetch.failRequest' : 'Fetch.continueRequest', deny ? {requestId, errorReason: 'BlockedByClient'} : {requestId}).catch(() => {});
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const req = msg.params.request, url = new URL(req.url);
        const entry = {tab: name, method: req.method, path: url.origin === new URL(base).origin ? url.pathname : '[off-origin]', at: Date.now()};
        this.requests.push(entry); report.requests.push(entry); this.active.set(msg.params.requestId, entry);
      }
      if (['Network.loadingFinished', 'Network.loadingFailed'].includes(msg.method)) this.active.delete(msg.params.requestId);
    };
  }
  async call(method, params = {}) {
    await this.ready;
    return new Promise((resolveCall, reject) => { const id = ++this.serial, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, 10000);
      this.pending.set(id, {method, resolve: resolveCall, reject, timer}); this.ws.send(JSON.stringify({id, method, params})); });
  }
  async eval(expression) { const result = await this.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}); assert(!result.exceptionDetails, 'Browser expression failed'); return result.result.value; }
  async wait(expression, label, timeout = 12000) {
    const start = Date.now(); while (Date.now() - start < timeout) { if (typeof expression === 'function' ? await expression() : await this.eval(expression)) return; await pause(75); } throw new Error(`Browser timeout: ${label}`);
  }
  async click(selector) {
    await this.call('Page.bringToFront'); let point;
    await this.wait(async () => {
      point = await this.eval(`(()=>{const e=document.querySelector(${js(selector)});if(!e||e.closest('[hidden]'))return null;e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,t=document.elementFromPoint(x,y);return {x,y,ok:r.width>0&&r.height>0&&!e.disabled&&(t===e||e.contains(t))};})()`); return point?.ok;
    }, 'clickable ' + selector);
    for (const type of ['mousePressed', 'mouseReleased']) await this.call('Input.dispatchMouseEvent', {type, x: point.x, y: point.y, button: 'left', clickCount: 1});
  }
  async fill(id, value) { await this.click('#' + id); await this.call('Input.dispatchKeyEvent', {type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2}); await this.call('Input.dispatchKeyEvent', {type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2}); await this.call('Input.insertText', {text: value}); }
  close() { this.ws.close(); }
}
async function browsers() {
  profile = await mkdtemp(join(tmpdir(), 'agentlink-docs-browser-')); browserLog = await open(`${evidence}/browser.private.log`, 'wx', 0o600);
  const spki = hashCertificate(ca);
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${spki}`, 'about:blank'], {stdio: ['ignore', browserLog.fd, browserLog.fd]});
  let port, failed = false; browser.once('error', () => { failed = true; });
  for (let i = 0; i < 100; i++) { assert(!failed && browser.exitCode === null, 'Owned Chromium exited'); try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {} await pause(100); }
  assert(port > 0, 'Owned Chromium unavailable'); const address = `http://127.0.0.1:${port}`;
  browserCDP = new CDP((await (await fetch(`${address}/json/version`)).json()).webSocketDebuggerUrl, 'browser');
  for (const actor of ['writer', 'owner']) {
    const target = await browserCDP.call('Target.createTarget', {url: 'about:blank'}), targets = await (await fetch(`${address}/json/list`)).json();
    const tab = new CDP(targets.find(item => item.id === target.targetId).webSocketDebuggerUrl, actor); tabs.push(tab);
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await tab.call(method);
    await tab.call('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]});
    await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
    await tab.call('Page.navigate', {url: base}); await tab.wait("document.readyState==='complete' && !!document.getElementById('language-select')", 'English GUI');
    assert(await tab.eval("document.documentElement.lang==='en'"), 'Expected default English');
    await tab.fill('api-key', keys[actor]); await tab.click('#login-button');
    await tab.wait("document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled", 'sign-in');
    await tab.click('#project-switcher [data-focus-key="project:' + ids.project + '"]'); await idle(tab);
  }
}
function hashCertificate(certificate) { return createHash('sha256').update(new X509Certificate(certificate).publicKey.export({type: 'spki', format: 'der'})).digest('base64'); }
async function idle(tab) {
  await tab.wait(() => ![...tab.active.values()].some(r => r.path.startsWith('/v1/') && !r.path.endsWith('/stream')), 'GET data settled');
  await pause(200);
}
async function pane(tab, name, panel) {
  await tab.click('#nav-' + name); await tab.wait(`!document.getElementById(${js(panel)}).hidden && !document.getElementById('refresh-button').disabled`, name + ' ready'); await idle(tab);
}
function captureSafetyExpression(fixtureKeys) {
  return String.raw`(()=>{const text=document.body.innerText,values=Array.from(document.querySelectorAll('input,textarea')).map(e=>e.value).join('\n'),keys=${js(fixtureKeys)},combined=text+'\n'+values;return {secret:keys.some(key=>combined.includes(key))||/glpat-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|Bearer\s+[a-f0-9]{64}/i.test(combined),privateText:/\b(?:\d{1,3}\.){3}\d{1,3}\b|localhost|\/home\/[^/\s]+\/|\/root\/|docs_gui_|agentlink_test/.test(combined),login:document.getElementById('login-panel').hidden,dialog:!!document.querySelector('dialog[open]'),width:innerWidth,scrollWidth:document.documentElement.scrollWidth};})()`;
}
function checkCaptureSafety() {
  // Compile the EXACT expression sent to Runtime.evaluate, not a second copy
  // of the regexes. This catches mistakes in template-literal escaping before
  // any database connection, credential read, or browser launch.
  const fixtureKey = 'a'.repeat(64);
  const evaluate = new Function('document', 'innerWidth', 'return ' + captureSafetyExpression([fixtureKey]));
  const cases = [
    ['127.0.0.1', 'privateText'], ['https://127.0.0.1:12345/', 'privateText'],
    ['198.51.100.23', 'privateText'], ['/home/example/private', 'privateText'],
    ['localhost', 'privateText'], ['docs_gui_example', 'privateText'], ['agentlink_test', 'privateText'],
    ['Bearer ' + 'b'.repeat(64), 'secret'], ['glpat-' + 'fictional-docs-token', 'secret'],
    ['sk-ant-fictional-docs-token', 'secret'], [fixtureKey, 'secret'],
  ];
  function result(text, value = '') {
    return evaluate({body: {innerText: text}, querySelectorAll: () => [{value}], getElementById: () => ({hidden: true}),
      querySelector: () => null, documentElement: {scrollWidth: 1440}}, 1440);
  }
  for (const [sample, field] of cases) {
    assert(result(sample)[field], 'Safety guard failed visible positive case: ' + field);
    assert(result('Atlas SDK', sample)[field], 'Safety guard failed form positive case: ' + field);
  }
  for (const sample of ['Atlas SDK · Codex · implementation', 'Scope: retries, pagination, independent review', 'Synthetic record: 0cc4a2f04a9076f4f1498db97af42a05']) {
    const actual = result(sample); assert(!actual.secret && !actual.privateText, 'Safety guard rejected benign fixture text');
  }
  report.safety_self_test = {passed: true, positive_cases: cases.length * 2, negative_cases: 3, expression: 'same emitted browser expression'};
}
async function screenshot(tab, name, {width = 1440, height = 1100, scroll = 'top'} = {}) {
  await tab.call('Page.bringToFront'); await idle(tab);
  await tab.call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 600});
  // Navigation clicks can leave nested lists and the sidebar scrolled. Use
  // ordinary scrolling only; do not hide, rewrite, or restyle any UI element.
  await tab.eval("for(const element of document.querySelectorAll('*'))if(element.scrollHeight>element.clientHeight)element.scrollTop=0;window.scrollTo(0,0)");
  if (scroll !== 'top') await tab.eval(`document.querySelector(${js(scroll)}).scrollIntoView({block:'start'})`);
  await tab.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: width - 8, y: 80});
  await tab.eval('document.fonts.ready'); await pause(200);
  const safety = await tab.eval(captureSafetyExpression([...secrets]));
  assert(await tab.eval("document.title.startsWith('Agent Mesh') && document.querySelector('.brand').textContent.includes('Agent Mesh')"), 'Screenshot product brand mismatch');
  assert(!safety.secret && !safety.privateText && safety.login && !safety.dialog, 'Public screenshot failed privacy checks');
  assert(safety.scrollWidth <= width + 1, 'Screenshot layout overflow');
  assert(!report.browser_guard_failed && !report.unexpected_dialog && report.browser_errors.length === 0, 'Browser capture guard/runtime failure');
  const shot = await tab.call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false}), bytes = Buffer.from(shot.data, 'base64');
  const privatePath = join(evidence, name + '.png'); await writeFile(privatePath, bytes, {mode: 0o600, flag: 'wx'});
  report.screenshots.push({name, width, height, language: await tab.eval('document.documentElement.lang'), public_path: `docs/assets/screenshots/${name}.png`, private_path: privatePath, sha256: hash(bytes), safety});
  console.log(JSON.stringify({captured: name, width, height}));
}
async function stop(child) {
  for (const signal of ['SIGTERM', 'SIGKILL']) if (child?.pid && child.exitCode === null && child.signalCode === null) { child.kill(signal); await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), pause(2500)]); }
  return !child || !child.pid || child.exitCode !== null || child.signalCode !== null;
}

checkCaptureSafety();
if (process.argv.includes('--check-safety')) { console.log(JSON.stringify(report.safety_self_test)); process.exit(0); }
try {
  await setup(); await fixtures(); await browsers();
  const [writer, owner] = tabs;
  await writer.wait("document.getElementById('overview-title').textContent==='Atlas SDK' && document.getElementById('overview-metric-tasks').textContent==='5'", 'curated overview');
  await screenshot(writer, 'overview-en');
  await pane(writer, 'project-map', 'project-map-panel');
  await writer.wait("document.querySelectorAll('#project-map-counts [data-count-state=ready]').length===14", 'actual map snapshot');
  await screenshot(writer, 'project-map-en');
  await writer.eval("(()=>{const select=document.getElementById('project-map-type');select.value='task';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await writer.click('#project-map-entities [data-entity-type="task"][data-entity-id="' + data.retry.id + '"]');
  await writer.wait("document.querySelector('#project-map-detail h3')?.textContent==='Define the retry and cancellation policy'", 'map task relationships');
  await screenshot(writer, 'project-map-live-en', {height: 1450, scroll: '.map-explorer'});
  await writer.click('#channel-list [data-focus-key="channel:engineering"]');
  await writer.wait("!!document.querySelector('#message-list [data-message-id=\"" + data.handoff.id + "\"]') && !document.getElementById('composer-form').hidden", 'discussion ready');
  await screenshot(writer, 'chat-en');
  await pane(writer, 'tasks', 'tasks-pane');
  await writer.click('#task-list [data-focus-key="task:' + data.migration.id + '"]');
  await writer.wait("document.querySelector('#task-detail [data-task-id]')?.dataset.taskId===" + js(data.migration.id), 'selected task');
  await screenshot(writer, 'tasks-en');
  await pane(writer, 'project-native', 'project-native-panel');
  await writer.wait("document.querySelectorAll('#project-native-list [data-native-id]').length===6", 'CLI fixture timeline');
  await screenshot(writer, 'cli-feed-en');
  await pane(owner, 'admin', 'admin-panel');
  await owner.click('#admin-section-nav [data-admin-section="projects"]'); await screenshot(owner, 'admin-en');
  await pane(writer, 'overview', 'overview-panel');
  await screenshot(writer, 'overview-mobile-en', {width: 390, height: 844});
  assert(report.requests.every(request => request.method === 'GET' && request.path !== '[off-origin]'), 'Capture made a write or external request');
  assert(JSON.stringify(report.backend.source_files) === JSON.stringify(await sourceHashes()), 'Backend changed during capture');
  for (const [name, expected] of Object.entries(report.assets)) assert(hash(await readFile(join(root, 'web', name))) === expected, 'Web assets changed during capture');
  report.capture_complete = true;
} catch (error) { report.error = safe(error); console.error(JSON.stringify({error: report.error})); }
finally {
  for (const tab of tabs) { try { await tab.eval("document.getElementById('logout-button')?.click()"); } catch {} tab.close(); }
  if (browserCDP) { try { await browserCDP.call('Browser.close'); } catch {} browserCDP.close(); }
  report.owned_browser_stopped = await stop(browser); report.owned_server_stopped = await stop(server);
  if (browserLog) await browserLog.close(); if (serverLog) await serverLog.close();
  if (schemaCreated && report.owned_server_stopped) {
    try { await sql(`DROP SCHEMA "${schema}" CASCADE;`, 'drop-owned-schema'); report.owned_schema_removed = true; } catch { report.owned_schema_removed = false; }
  } else report.owned_schema_removed = !schemaCreated;
  if (sourceDSNHash) {
    try { report.source_test_DSN_unchanged = hash(await privateRead(`${runtime}/secrets/agentlink_test-dsn`)) === sourceDSNHash; } catch { report.source_test_DSN_unchanged = false; }
  }
  if (profile && report.owned_browser_stopped) await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  if (scratch && report.owned_server_stopped && report.owned_schema_removed) await rm(scratch, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  report.success = report.capture_complete === true && report.screenshots.length === 8 && report.owned_browser_stopped && report.owned_server_stopped && report.owned_schema_removed && report.source_test_DSN_unchanged;
  if (report.success) {
    await mkdir(output, {recursive: true});
    for (const shot of report.screenshots) await copyFile(shot.private_path, join(root, shot.public_path));
  }
  report.finished_at = new Date().toISOString();
  if (evidence) { let text = JSON.stringify(report, null, 2) + '\n'; for (const key of secrets) text = text.replaceAll(key, '[REDACTED]'); await writeFile(join(evidence, 'evidence.json'), text, {mode: 0o600, flag: 'wx'}); }
  console.log(JSON.stringify({success: report.success, screenshots: report.screenshots.length, cleanup: report.owned_browser_stopped && report.owned_server_stopped && report.owned_schema_removed, evidence: evidence && join(evidence, 'evidence.json')}));
}
if (!report.success) process.exitCode = 1;
