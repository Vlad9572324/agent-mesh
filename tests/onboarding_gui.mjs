// Isolated owner onboarding wizard and one-use package browser regression.
// Own schema in agentlink_test, own loopback TLS server, own Chromium. No shared
// seed credentials, agentlink_e2e dependency, production URL or model invocation.
// Run after onboarding backend/web/packager integration: node tests/onboarding_gui.mjs
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
const run = `onboarding-${randomUUID().slice(0, 8)}`;
const schema = `onboarding_gui_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const ids = Object.fromEntries(['owner', 'writer', 'peer', 'viewer', 'project', 'other', 'alpha', 'beta', 'quiet', 'private', 'other-channel', 'invitee', 'cancelled', 'invalid'].map(name => [name, `${run}-${name}`]));
const report = {run, schema, database: 'agentlink_test', started_at: new Date().toISOString(), cases: [], assets: {},
  browser_errors: [], requests: [], layouts: [], screenshots: [], models_started: 0,
  scope: 'Owned isolated schema, loopback TLS API and Chromium; no shared fixture keys or production requests'};
const tabs = [], keys = {}, secrets = new Set();
const allowedMutations = new Set();
const js = JSON.stringify, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
let directory, scratch, base, ca, pgEnv, sourceDSNHash, ownerKeyPath, childSerial = 0;
let server, serverLog, browser, browserLog, browserCDP, profile, schemaCreated = false, writer, viewer, owner;
let confirmNext = false;
let actorName = 'Agent <img src=x onerror=window.nativeFeedInjected=1>';
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
  assert(/^onboarding_gui_[a-f0-9]{16}$/.test(schema), 'Owned schema name invalid');
  return command(`${runtime}/pgsql/usr/lib/postgresql/14/bin/psql`, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], label, {env: pgEnv, input: statement, timeout: 20000});
}
async function isolatedServer() {
  directory = await mkdtemp(`${runtime}/evidence/onboarding-gui-`);
  scratch = await mkdtemp(join(tmpdir(), 'agentlink-onboarding-'));
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
    '--tls-key', `${runtime}/secrets/server.key`, '--web-dir', web, '--public-url', new URL(base).origin,
    '--onboarding-ca-file', caPath], {cwd: root, stdio: ['ignore', serverLog.fd, serverLog.fd]});
  let spawnFailed = false; server.once('error', () => { spawnFailed = true; });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    assert(!spawnFailed && server.exitCode === null, 'Owned TLS API exited');
    try { ready = (await api('/v1/me')).agent.id === ids.owner; if (ready) break; } catch {}
    await pause(100);
  }
  assert(ready, 'Owned TLS API did not start');
}
function request(path, method = 'GET', body, actor = 'owner', raw = false) {
  const url = new URL(path, base);
  assert(url.protocol === 'https:' && url.hostname === '127.0.0.1' && url.origin === new URL(base).origin, 'Fixture API refuses nonowned origin');
  return new Promise((resolveRequest, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(url, {ca, method, timeout: 10000, headers: {...(actor === null ? {} : {Authorization: `Bearer ${keys[actor]}`}),
      ...(payload === undefined ? {} : {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)})}}, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('end', () => {
        try { const bytes = Buffer.concat(chunks); resolveRequest({status: res.statusCode, headers: res.headers, data: raw ? bytes : bytes.length ? JSON.parse(bytes.toString()) : null}); }
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

}

class CDP {
  constructor(url, name) {
    this.ws = new WebSocket(url); this.name = name; this.serial = 0; this.pending = new Map(); this.requests = []; this.active = new Map();
    this.ready = new Promise((resolveSocket, reject) => { this.ws.onopen = resolveSocket; this.ws.onerror = () => reject(new Error('Owned CDP unavailable')); });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) { const item = this.pending.get(message.id); clearTimeout(item.timer); this.pending.delete(message.id); message.error ? item.reject(new Error(`CDP ${item.method} failed`)) : item.resolve(message.result); }
      if (message.method === 'Runtime.exceptionThrown') report.browser_errors.push({tab: name, category: message.params.exceptionDetails.text});
      if (message.method === 'Page.javascriptDialogOpening') { const accept = name === 'owner' && confirmNext; confirmNext = false; void this.call('Page.handleJavaScriptDialog', {accept}).catch(() => {}); }
      if (message.method === 'Fetch.requestPaused') {
        const {request, requestId} = message.params, url = new URL(request.url);
        const deny = url.origin !== new URL(base).origin || request.method !== 'GET' && !(name === 'owner' && allowedMutations.has(request.method + ' ' + url.pathname));
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
async function browsers() {
  profile = await mkdtemp(join(tmpdir(), 'agentlink-onboarding-browser-')); browserLog = await open(`${directory}/browser.private.log`, 'wx', 0o600);
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
    await tab.call('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]});
    await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
    await tab.call('Page.navigate', {url: new URL('?lang=ru', base).href}); await tab.wait(`document.readyState==='complete' && !!document.getElementById('nav-admin')`, 'project feed page', 15000);
    if (actor === 'writer') writer = tab; else if (actor === 'viewer') viewer = tab; else owner = tab;
    await login(tab, actor);
  }
}
async function login(tab, actor) {
  await tab.fill('api-key', keys[actor]); await tab.click('#login-button');
  await tab.wait(`document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled`, 'login ready');
}
async function admin(tab) {
  await tab.click('#nav-admin');
  await tab.wait(`!document.getElementById('admin-panel').hidden && !document.getElementById('refresh-button').disabled`, 'owner administration');
  await tab.click('[data-admin-section="onboarding"]');
  await tab.wait(`!document.getElementById('admin-onboarding-panel').hidden`, 'onboarding wizard');
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

async function invitationFor(agent = ids.invitee) {
  return (await api('/v1/admin/onboarding')).invitations.find(item => item.agent_id === agent && item.status === 'pending');
}
async function generatedCommand() {
  await owner.wait(`document.getElementById('admin-onboarding-dialog').open && document.getElementById('admin-onboarding-command').value.length>0`, 'one-use connection command');
  const value = await owner.eval(`document.getElementById('admin-onboarding-command').value`);
  const tokens = value.match(/\b[0-9a-f]{64}\b/g) || [];
  assert(tokens.length === 1, 'Connection command must contain exactly one invitation capability');
  const token = tokens[0]; secrets.add(token);
  const metadata = await api('/v1/admin/onboarding');
  assert(value.includes(new URL(base).origin) && value.includes('/connect/install.sh') && value.includes('bash -o pipefail')
    && value.includes('--pinnedpubkey') && value.includes(metadata.spki_pin) && value.includes('curl --disable')
    && value.includes('--noproxy'), 'Connection command lost its origin, failure boundary, TLS pin or curl configuration isolation');
  assert(!value.includes(keys.owner), 'Owner key appeared in agent onboarding command');
  assert(await owner.eval(`localStorage.length===0 && sessionStorage.length===0 && !location.href.includes(${js(token)})`), 'Invitation persisted in browser storage or URL');
  return token;
}
async function closeCommand(token) {
  await owner.click('#admin-onboarding-close');
  await owner.wait(`!document.getElementById('admin-onboarding-dialog').open && document.getElementById('admin-onboarding-command').value===''`, 'close forgets command');
  assert(await owner.eval(`!document.body.innerText.includes(${js(token)})`), 'Closed invitation remains in visible text');
}
async function invitationAction(invitation, action) {
  allowedMutations.add(`POST /v1/admin/onboarding/${invitation.id}/${action}`);
  confirmNext = true;
  await owner.click(`#admin-onboarding-list [data-invitation-id="${invitation.id}"] [data-onboarding-action="${action}"]`);
}
async function inspectPackage(bytes) {
  const packagePath = `${scratch}/redeemed.private.tar.gz`;
  await writeFile(packagePath, bytes, {mode: 0o600, flag: 'wx'});
  const inspect = `import hashlib,json,pathlib,sys,tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
 members=archive.getmembers()
 names=[item.name for item in members]
 assert len(names)==len(set(names)) and len(names)<100
 assert sum(item.size for item in members)<=8*1024*1024
 assert all(item.isfile() and item.mode==0o600 and not pathlib.PurePosixPath(item.name).is_absolute() and '..' not in pathlib.PurePosixPath(item.name).parts for item in members)
 files={item.name:archive.extractfile(item).read() for item in members}
 manifest=json.loads(files.pop('MANIFEST.json'))
 assert manifest['version']==1 and set(manifest['files'])==set(files)
 assert all(meta['size']==len(files[name]) and meta['sha256']==hashlib.sha256(files[name]).hexdigest() for name,meta in manifest['files'].items())
 required={'profile.json','agent.key','ca.crt','connect.py','README.md','PROMPT.md','connectors/scripts/agent-link-cli.py','connectors/LICENSE','connectors/NOTICE'}
 assert required<=set(files)
 print(json.dumps({'profile':json.loads(files['profile.json']),'key':files['agent.key'].decode().strip(),'file_count':len(files)+1,'ca_sha256':hashlib.sha256(files['ca.crt']).hexdigest()}))
`;
  return JSON.parse((await command('python3', ['-B', '-c', inspect, packagePath], 'inspect-private-package')).toString('utf8'));
}

let token, invitation;
try {
  await check('isolated owner wizard is enabled without startup mutations and denied to other roles', async () => {
    await isolatedServer(); await fixtures(); await browsers();
    for (const actor of ['writer', 'viewer']) {
      const tab = actor === 'writer' ? writer : viewer;
      assert(await tab.eval(`document.getElementById('nav-admin').hidden || !!document.getElementById('nav-admin').closest('[hidden]')`), 'Nonowner sees administration');
      await api('/v1/admin/onboarding', 'GET', undefined, actor, 403);
    }
    await api('/v1/admin/onboarding', 'GET', undefined, null, 401);
    await admin(owner);
    const metadata = await api('/v1/admin/onboarding');
    assert(metadata.enabled === true && metadata.public_url === new URL(base).origin && /^sha256\/\//.test(metadata.spki_pin), 'Onboarding deployment trust metadata differs');
    assert(report.requests.every(item => item.method === 'GET'), 'Opening wizard mutated state');
    const installer = await request('/connect/install.sh', 'GET', undefined, null, true);
    assert(installer.status === 200 && installer.data.includes(Buffer.from('python')) && !installer.data.includes(Buffer.from(keys.owner)), 'Public bootstrap unavailable or contains owner key');
  });
  await check('invalid cross-project channel selection leaves no partial agent or grants', async () => {
    await api('/v1/admin/onboarding', 'POST', {id: ids.invalid, name: 'Rejected fixture', project_id: ids.project,
      channel_ids: [ids['other-channel']], runtime: 'auto', expires_in_hours: 12}, 'owner', 404);
    const inventory = await api('/v1/admin/overview');
    assert(!inventory.principals.some(item => item.id === ids.invalid) && !inventory.project_members.some(item => item.agent_id === ids.invalid)
      && !(await api('/v1/admin/onboarding')).invitations.some(item => item.agent_id === ids.invalid), 'Invalid onboarding partially committed');
  });
  await check('owner creates an inactive agent with exactly selected communication scope and a one-use command', async () => {
    await owner.fill('admin-onboarding-id', ids.invitee);
    await owner.fill('admin-onboarding-name', 'New helper <img src=x onerror=window.onboardingInjected=1>');
    await owner.filter('admin-onboarding-project', ids.project);
    await owner.wait(`document.querySelectorAll('#admin-onboarding-channels input[type=checkbox]').length===4`, 'selected project channel choices');
    assert(await owner.eval(`!document.querySelector('#admin-onboarding-channels input[value="${ids['other-channel']}"]')`), 'Wizard exposes another project channel');
    for (const channel of ['alpha', 'beta']) await owner.click(`#admin-onboarding-channels input[value="${ids[channel]}"]`);
    await owner.filter('admin-onboarding-runtime', 'auto'); await owner.filter('admin-onboarding-expiry', '24');
    allowedMutations.add('POST /v1/admin/onboarding');
    await owner.click('#admin-onboarding-submit');
    token = await generatedCommand(); invitation = await invitationFor();
    assert(invitation && invitation.runtime === 'auto' && invitation.channel_ids.join(',') === [ids.alpha, ids.beta].sort().join(','), 'Invitation did not retain selected runtime/channels');
    const hours = (Date.parse(invitation.expires_at) - Date.parse(invitation.created_at)) / 3600000;
    assert(hours > 23.99 && hours <= 24.01, 'Invitation lifetime differs from selected 24 hours');
    const inventory = await api('/v1/admin/overview');
    assert(inventory.principals.find(item => item.id === ids.invitee)?.key_active === false, 'Agent key active before redemption');
    const projects = inventory.project_members.filter(item => item.agent_id === ids.invitee);
    const channels = inventory.channel_members.filter(item => item.agent_id === ids.invitee);
    assert(projects.length === 1 && projects[0].project_id === ids.project && projects[0].can_write && channels.length === 2
      && channels.every(item => [ids.alpha, ids.beta].includes(item.channel_id) && item.can_write), 'Wizard granted a broader or read-only scope');
    assert(!JSON.stringify([inventory, await api('/v1/admin/onboarding'), await api('/v1/admin/audit')]).includes(token), 'Raw invitation leaked through administrative history');
    await closeCommand(token);
    assert(await owner.eval(`!document.querySelector('#admin-onboarding-list img') && !window.onboardingInjected`), 'Agent name executed as markup');
  });
  await check('reissue and revoke invalidate previous commands while closed results stay forgotten', async () => {
    const first = token;
    await invitationAction(invitation, 'reissue'); token = await generatedCommand(); invitation = await invitationFor();
    assert(token !== first, 'Reissue reused the old capability');
    await api('/connect/redeem', 'POST', {token: first}, null, 410);
    await closeCommand(token);
    await invitationAction(invitation, 'revoke');
    await owner.wait(async () => (await api('/v1/admin/onboarding')).invitations.find(item => item.id === invitation.id)?.status === 'revoked', 'invitation revocation completed');
    await api('/connect/redeem', 'POST', {token}, null, 410);
    await invitationAction(invitation, 'reissue'); token = await generatedCommand(); invitation = await invitationFor();
    await closeCommand(token);
  });
  await check('public redemption returns verified private files and one scoped agent key exactly once', async () => {
    const response = await request('/connect/redeem', 'POST', {token}, null, true);
    assert(response.status === 200 && response.headers['cache-control'] === 'no-store' && response.headers['x-content-type-options'] === 'nosniff', 'Secret package transport headers or status differ');
    const contents = await inspectPackage(response.data); secrets.add(contents.key); keys.invitee = contents.key;
    assert(/^[0-9a-f]{64}$/.test(contents.key) && contents.ca_sha256 === hash(ca), 'Package key or configured trust certificate differs');
    const profile = contents.profile;
    assert(profile.version === 1 && profile.agent_id === ids.invitee && profile.project_id === ids.project && profile.url === new URL(base).origin
      && profile.runtime === 'auto' && profile.channel_ids.join(',') === [ids.alpha, ids.beta].sort().join(','), 'Redeemed profile changed the intended identity or scope');
    assert((await api('/v1/me', 'GET', undefined, 'invitee')).agent.id === ids.invitee, 'Redeemed key authenticates the wrong identity');
    for (const channel of ['alpha', 'beta']) await api(`/v1/channels/${ids[channel]}/messages`, 'GET', undefined, 'invitee');
    for (const channel of ['private', 'other-channel']) await api(`/v1/channels/${ids[channel]}/messages`, 'GET', undefined, 'invitee', 404);
    await api('/v1/admin/onboarding', 'GET', undefined, 'invitee', 403);
    await api('/connect/redeem', 'POST', {token}, null, 410);
    const metadata = await api('/v1/admin/onboarding');
    assert(metadata.invitations.find(item => item.id === invitation.id)?.status === 'claimed', 'Redeemed invitation not recorded as claimed');
    const publicHistory = JSON.stringify([metadata, await api('/v1/admin/overview'), await api('/v1/admin/audit')]);
    assert(!publicHistory.includes(token) && !publicHistory.includes(contents.key), 'Capability or personal key persisted in administrative output');
    report.package = {file_count: contents.file_count, sha256: hash(response.data), agent_id: profile.agent_id, runtime: profile.runtime};
  });
  await check('Russian English mobile and logout retain no onboarding command or protected inventory', async () => {
    await owner.click('#refresh-button'); await owner.wait(`!document.getElementById('refresh-button').disabled`, 'claimed invitation refresh');
    for (const language of ['en', 'ru']) {
      await owner.filter('language-select', language);
      assert(await owner.eval(`document.documentElement.lang===${js(language)} && document.getElementById('admin-onboarding-command').value===''`), 'Language switch restored invitation secret');
      const title = await owner.eval(`document.getElementById('admin-onboarding-title').textContent`);
      assert((language === 'ru' ? /агент/i : /agent/i).test(title), 'Onboarding title not translated');
    }
    await screenshot(owner, 'onboarding-desktop', 1440);
    await owner.call('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
    assert(await owner.eval('document.documentElement.scrollWidth<=innerWidth+1'), 'Onboarding wizard overflows mobile viewport');
    await screenshot(owner, 'onboarding-mobile-390', 390);
    for (const tab of tabs) {
      await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
      await tab.click('#logout-button');
      await tab.wait(`!document.getElementById('login-panel').hidden && document.getElementById('admin-onboarding-command').value==='' && document.getElementById('admin-onboarding-list').textContent==='' && localStorage.length===0 && sessionStorage.length===0`, 'logout clears onboarding data');
    }
    assert(!report.browser_guard_failed && report.browser_errors.length === 0, 'Browser crossed mutation/origin boundary or raised a runtime error');
  });
} catch (error) {
  if (!report.cases.some(item => !item.passed)) report.cases.push({name: 'infrastructure', passed: false, error: safeError(error)});
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
  report.success = report.cases.length === 6 && report.cases.every(item => item.passed) && report.owned_browser_stopped && report.owned_server_stopped && report.owned_schema_removed && report.source_test_DSN_unchanged;
  const output = directory ? `${directory}/evidence.json` : `${runtime}/evidence/onboarding-gui-setup-failed.json`;
  let serialized = JSON.stringify(report, null, 2) + '\n'; for (const key of secrets) serialized = serialized.replaceAll(key, '[REDACTED]');
  await writeFile(output, serialized, {mode: 0o600, flag: 'wx'});
  console.log(JSON.stringify({success: report.success, cases: report.cases.length, owned_schema_removed: report.owned_schema_removed,
    owned_server_stopped: report.owned_server_stopped, owned_browser_stopped: report.owned_browser_stopped, evidence: output}));
}
if (!report.success) process.exitCode = 1;
