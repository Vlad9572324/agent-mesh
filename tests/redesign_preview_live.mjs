// READ-ONLY candidate preview over existing live GET data, NOT a deployment.
// Four exact static URLs are fulfilled inside one owned browser from the frozen
// candidate. Every off-origin or non-GET browser request is denied and fails the
// run. No fixture creation, API mutation, provider/model call or server launch.
import {readFile, writeFile, mkdtemp, lstat, rm, open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, X509Certificate, randomUUID} from 'node:crypto';
import https from 'node:https';
import {liveSettings} from './live-operator-config.mjs';

process.umask(0o077);
const {runtime, origin, chrome, caPath, keyPath, ownerId, projectId, channelId, webPath: candidate} = liveSettings({channel: true, web: true});
const base = origin + '/', projectPath = `/v1/projects/${projectId}`;
const description = 'Candidate preview over existing live GET data; production assets unchanged; NOT deployed UI evidence';
const run = `redesign-preview-live-${randomUUID().slice(0, 8)}`;
const output = `${runtime}/evidence/redesign-preview-live.json`;
const assetPaths = ['/', '/app.css', '/app.js'];
const files = {'/': 'index.html', '/index.html': 'index.html', '/app.css': 'app.css', '/app.js': 'app.js'};
const types = {'index.html': 'text/html; charset=utf-8', 'app.css': 'text/css; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8'};
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const report = {run, description, started_at: new Date().toISOString(), origin, candidate_directory: candidate,
  read_only: true, models_started: 0, server_started: false, deployment_performed: false, project_id: projectId, channel_id: channelId,
  cases: [], requests: [], denied_requests: [], browser_errors: 0, interception_errors: 0, screenshots: [], candidate_assets: {}, fulfilled_assets: [],
  live_assets_before: {}, live_assets_after: {}, success: false};
const assets = new Map(), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = JSON.stringify;
const assert = (value, code) => { if (!value) throw new Error(code); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let browser, profile, log, control, tab, key = '', ca, leaf, stage = 'preflight', spawnError = false;
function redact(error) { return String(error?.message || error).replaceAll(key || '\0', '[REDACTED]').slice(0, 240); }
function check(name, passed, facts = {}) { assert(passed, name); report.cases.push({name, passed: true, ...facts}); }
async function regular(path, privateFile = false) {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && (!privateFile || !(info.mode & 0o077)), 'expected_regular_safe_file');
  return readFile(path);
}
function get(path, authenticated = false) {
  const url = new URL(path, base);
  assert(url.origin === origin && !url.username && !url.password, 'node_GET_wrong_origin');
  report.requests.push({source: 'verified-node', method: 'GET', path: url.pathname});
  return new Promise((resolve, reject) => {
    const request = https.get(url, {ca, rejectUnauthorized: true, timeout: 8000,
      headers: authenticated ? {Authorization: `Bearer ${key}`} : {}}, response => {
      const certificate = response.socket.getPeerCertificate();
      if (certificate.raw) leaf = certificate.raw; // Captured only after verified CA/hostname TLS.
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) request.destroy(); else chunks.push(chunk); });
      response.on('end', () => {
        if (response.statusCode !== 200 || size > 4 * 1024 * 1024) reject(new Error('verified_GET_failed'));
        else resolve({bytes: Buffer.concat(chunks), headers: response.headers});
      });
      response.on('error', () => reject(new Error('verified_GET_transport_failed')));
    });
    request.on('timeout', () => request.destroy()); request.on('error', () => reject(new Error('verified_GET_transport_failed')));
  });
}

class CDP {
  constructor(url, page = false) {
    this.ws = new WebSocket(url); this.serial = 0; this.pending = new Map(); this.active = new Map(); this.responses = [];
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error('owned_CDP_unavailable')); });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const item = this.pending.get(message.id); clearTimeout(item.timer); this.pending.delete(message.id);
        message.error ? item.reject(new Error(`CDP_${item.method}_failed`)) : item.resolve(message.result);
      }
      if (!page) return;
      if (message.method === 'Runtime.exceptionThrown') report.browser_errors++;
      if (message.method === 'Page.javascriptDialogOpening') void this.call('Page.handleJavaScriptDialog', {accept: false}).catch(() => {});
      if (message.method === 'Fetch.requestPaused') void this.intercept(message.params).catch(() => { report.interception_errors++; });
      if (message.method === 'Network.requestWillBeSent') {
        const request = message.params.request, url = new URL(request.url);
        // Metadata only: never record headers, query strings, bodies or response content.
        report.requests.push({source: 'browser', method: request.method, path: url.origin === origin ? url.pathname : '[off-origin]'});
        this.active.set(message.params.requestId, url.origin === origin ? url.pathname : '[off-origin]');
      }
      if (message.method === 'Network.responseReceived') {
        const response = message.params.response, url = new URL(response.url);
        if (url.origin === origin) this.responses.push({path: url.pathname, status: response.status});
      }
      if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) this.active.delete(message.params.requestId);
    };
  }
  async intercept({request, requestId}) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== origin || url.username || url.password || /[?&](key|token|authorization)=/i.test(url.search)) {
      report.denied_requests.push({method: request.method, path: url.origin === origin ? url.pathname : '[off-origin]'});
      await this.call('Fetch.failRequest', {requestId, errorReason: 'BlockedByClient'}); return;
    }
    if (!url.search && assets.has(url.pathname)) {
      const asset = assets.get(url.pathname);
      await this.call('Fetch.fulfillRequest', {requestId, responseCode: 200, responseHeaders: [
        {name: 'Content-Type', value: types[files[url.pathname]]}, {name: 'Content-Security-Policy', value: csp},
        {name: 'Cache-Control', value: 'no-store'}, {name: 'X-Content-Type-Options', value: 'nosniff'},
        {name: 'Referrer-Policy', value: 'no-referrer'}, {name: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()'},
      ], body: asset.toString('base64')});
      report.fulfilled_assets.push({path: url.pathname, sha256: digest(asset)});
    } else await this.call('Fetch.continueRequest', {requestId});
  }
  async call(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP_${method}_timeout`)); }, 10000);
      this.pending.set(id, {resolve, reject, timer}); this.ws.send(JSON.stringify({id, method, params}));
    });
  }
  async eval(expression) {
    const result = await this.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    assert(!result.exceptionDetails, 'browser_expression_failed_expression_omitted'); return result.result.value;
  }
  async wait(expression, label, timeout = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      assert(report.denied_requests.length === 0 && report.interception_errors === 0, 'request_guard_failed');
      if (typeof expression === 'function' ? await expression() : await this.eval(expression)) return;
      await pause(80);
    }
    throw new Error(`browser_${label}_timeout`);
  }
  async click(selector) {
    await this.call('Page.bringToFront'); let point;
    await this.wait(async () => {
      point = await this.eval(`(()=>{const e=document.querySelector(${js(selector)});if(!e||e.closest('[hidden]'))return null;e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,t=document.elementFromPoint(x,y);return {x,y,ok:r.width>0&&r.height>0&&!e.disabled&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&(t===e||e.contains(t))};})()`);
      return point?.ok;
    }, 'visible_click_target');
    await this.call('Input.dispatchMouseEvent', {type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1});
    await this.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1});
  }
  close() { this.ws.close(); }
}
async function screenshot(label, width, height) {
  await tab.call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 600});
  await tab.call('Page.bringToFront');
  await tab.eval(`window.scrollTo(0,0);document.querySelector('.workspace')?.scrollTo(0,0);document.querySelector('.workspace-body')?.scrollTo(0,0)`);
  await tab.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const safe = await tab.eval(`(()=>{const key=${js(key)};const body=document.body.innerText;const fields=Array.from(document.querySelectorAll('input,textarea'));return !body.includes(key)&&!fields.some(e=>e.value.includes(key))&&document.getElementById('api-key').value===''&&document.getElementById('admin-issued-key').value===''&&!/(?:sk-[A-Za-z0-9_-]{24,}|sk-ant-[A-Za-z0-9_-]{12,}|glpat-[A-Za-z0-9_-]{12,}|Bearer[ \\t]+[a-f0-9]{64})/i.test(body);})()`);
  assert(safe, 'screenshot_suppressed_possible_secret');
  const layout = await tab.eval(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight})`);
  assert(layout.scrollWidth <= layout.width + 1, 'candidate_preview_horizontal_overflow');
  const file = `${runtime}/evidence/${run}-candidate-${label}.png`;
  const shot = await tab.call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  await writeFile(file, Buffer.from(shot.data, 'base64'), {mode: 0o600, flag: 'wx'});
  report.screenshots.push({label: `${description} — ${label}`, file, ...layout});
}

try {
  ca = await regular(caPath);
  key = (await regular(keyPath, true)).toString('utf8').trim();
  assert(/^[a-f0-9]{64}$/.test(key), 'owner_key_format');
  for (const [path, filename] of Object.entries(files)) {
    const bytes = await regular(`${candidate}/${filename}`); assets.set(path, bytes); report.candidate_assets[path] = digest(bytes);
  }
  for (const path of assetPaths) {
    const response = await get(path); report.live_assets_before[path] = digest(response.bytes);
    assert(response.headers['content-security-policy'] === csp, 'live_CSP_differs_from_preserved_policy');
  }
  const identity = JSON.parse((await get('/v1/me', true)).bytes.toString('utf8'));
  check('CA_verified_live_owner_identity', identity.agent?.id === ownerId && identity.agent?.kind === 'owner');
  const expectedTasks = JSON.parse((await get(projectPath + '/tasks', true)).bytes.toString('utf8'));
  const expectedChannels = JSON.parse((await get(projectPath + '/channels', true)).bytes.toString('utf8'));
  assert(Array.isArray(expectedTasks.tasks) && Array.isArray(expectedChannels.channels), 'expected_live_lists_missing');
  report.preflight_counts = {tasks: expectedTasks.tasks.length, channels: expectedChannels.channels.length};
  assert(leaf, 'verified_leaf_missing');
  const spki = createHash('sha256').update(new X509Certificate(leaf).publicKey.export({type: 'spki', format: 'der'})).digest('base64');
  report.CA_verified_leaf_sha256 = digest(leaf);
  profile = await mkdtemp(join(tmpdir(), 'agentlink-candidate-preview-'));
  log = await open(`${runtime}/evidence/${run}-browser.private.log`, 'wx', 0o600);
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${spki}`, 'about:blank'], {stdio: ['ignore', log.fd, log.fd]});
  browser.once('error', () => { spawnError = true; });
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert(!spawnError && browser.exitCode === null, 'owned_browser_failed_to_start');
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
    await pause(100);
  }
  assert(Number.isInteger(port) && port > 0, 'owned_browser_port_missing');
  const address = `http://127.0.0.1:${port}`;
  control = new CDP((await (await fetch(`${address}/json/version`)).json()).webSocketDebuggerUrl);
  const target = await control.call('Target.createTarget', {url: 'about:blank'});
  const targets = await (await fetch(`${address}/json/list`)).json();
  tab = new CDP(targets.find(item => item.id === target.targetId).webSocketDebuggerUrl, true);
  for (const method of ['Runtime.enable', 'Page.enable', 'Network.enable']) await tab.call(method);
  await tab.call('Network.setCacheDisabled', {cacheDisabled: true});
  await tab.call('Network.setBypassServiceWorker', {bypass: true});
  await tab.call('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]});
  await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
  stage = 'candidate_page'; await tab.call('Page.navigate', {url: base});
  await tab.wait(`document.readyState==='complete' && !!document.getElementById('nav-overview')`, 'candidate_loaded');
  stage = 'login';
  await tab.eval(`(()=>{const e=document.getElementById('api-key');e.value=${js(key)};e.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-form').requestSubmit();})()`);
  await tab.wait(`document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled`, 'login_ready');
  stage = 'project_overview'; await tab.click(`#project-switcher [data-focus-key="project:${projectId}"]`);
  await tab.wait(`!document.getElementById('overview-panel').hidden && document.querySelector('#project-switcher [data-focus-key="project:${projectId}"]')?.getAttribute('aria-pressed')==='true' && !document.getElementById('refresh-button').disabled && /^[0-9]+[+]?$/.test(document.getElementById('overview-metric-tasks').textContent.trim()) && /^[0-9]+$/.test(document.getElementById('overview-metric-channels').textContent.trim()) && document.getElementById('overview-note').dataset.stale==='false'`, 'overview_real_data');
  report.overview_metrics = await tab.eval(`Object.fromEntries(['agents','tasks','attention','channels'].map(name=>[name,document.getElementById('overview-metric-'+name).textContent.trim()]))`);
  check('overview_live_tasks_channels_loaded', tab.responses.some(r => r.path === projectPath + '/tasks' && r.status === 200) && tab.responses.some(r => r.path === projectPath + '/channels' && r.status === 200));
  check('owner_preview_cannot_publish', await tab.eval(`document.getElementById('composer-form').hidden`));
  await screenshot('desktop-overview', 1440, 1100);
  stage = 'mobile_overview'; await screenshot('mobile-overview', 390, 844);
  stage = 'desktop_chat'; await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
  await tab.click(`#channel-list [data-focus-key="channel:${channelId}"]`);
  await tab.wait(`!document.getElementById('chat-panel').hidden && !document.getElementById('refresh-button').disabled && document.getElementById('message-list').textContent.length>0`, 'chat_real_data');
  await screenshot('desktop-chat', 1440, 1100);
  check('candidate_exact_bytes_fulfilled', assetPaths.every(path => report.fulfilled_assets.some(item => item.path === path && item.sha256 === report.candidate_assets[path])));
  check('only_live_GET_requests', report.denied_requests.length === 0 && report.requests.every(item => item.method === 'GET') && report.interception_errors === 0);
  check('no_browser_javascript_errors', report.browser_errors === 0);
  report.success = true;
} catch (error) {
  report.failure_stage = stage; report.failure_code = redact(error);
  if (tab) {
    report.API_response_metadata = tab.responses;
    try { report.failure_controls = await tab.eval(`({overviewHidden:document.getElementById('overview-panel')?.hidden,stale:document.getElementById('overview-note')?.dataset.stale,selected:document.querySelector('#project-switcher [data-focus-key="project:${projectId}"]')?.getAttribute('aria-pressed'),tasks:document.getElementById('overview-metric-tasks')?.textContent,channels:document.getElementById('overview-metric-channels')?.textContent})`); } catch {}
  }
} finally {
  if (tab) { try { await tab.eval(`document.getElementById('logout-button')?.click()`); } catch {} tab.close(); }
  if (control) { try { await control.call('Browser.close'); } catch {} control.close(); }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
      browser.kill(signal); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(2500)]);
    }
  }
  report.owned_browser_stopped = !browser || !browser.pid || browser.exitCode !== null || browser.signalCode !== null;
  if (log) await log.close();
  if (profile && report.owned_browser_stopped) await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  try {
    for (const path of assetPaths) report.live_assets_after[path] = digest((await get(path)).bytes);
    report.production_assets_unchanged = assetPaths.every(path => report.live_assets_before[path] && report.live_assets_before[path] === report.live_assets_after[path]);
    report.candidate_files_unchanged = (await Promise.all(Object.entries(files).map(async ([path, name]) => digest(await regular(`${candidate}/${name}`)) === report.candidate_assets[path]))).every(Boolean);
  } catch { report.production_assets_unchanged = false; report.candidate_files_unchanged = false; }
  report.success = report.success && report.owned_browser_stopped && report.production_assets_unchanged && report.candidate_files_unchanged && report.denied_requests.length === 0 && report.interception_errors === 0;
  report.finished_at = new Date().toISOString();
  await writeFile(output, (JSON.stringify(report, null, 2) + '\n').replaceAll(key || '\0', '[REDACTED]'), {mode: 0o600});
  console.log(JSON.stringify({success: report.success, description, screenshots: report.screenshots.map(item => item.file), failure_stage: report.failure_stage,
    failure: report.failure_code, production_assets_unchanged: report.production_assets_unchanged, owned_browser_stopped: report.owned_browser_stopped, report: output}));
}
if (!report.success) process.exitCode = 1;
