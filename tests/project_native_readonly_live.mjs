// GET-only acceptance against the deployed LAN GUI. Does not start models or
// create events. An operator triggers a harmless action in each owned CLI after
// WATCHER_READY; this watcher verifies the resulting records in the same page.
import {readFile, writeFile, mkdtemp, lstat, rm, open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, X509Certificate} from 'node:crypto';
import https from 'node:https';
import {liveSettings} from './live-operator-config.mjs';

process.umask(0o077);
const {runtime, origin, chrome, caPath, keyPath, ownerId, projectId, actors, deploymentPath} = liveSettings({actors: ['codex', 'claude'], deployment: true});
const activityPath = `/v1/projects/${projectId}/activity?limit=100`;
const expected = Object.fromEntries(['codex', 'claude'].map(name => [name, process.env[`AGENT_LINK_EXPECTED_${name.toUpperCase()}_SESSION`]]));
const assert = (value, category) => { if (!value) throw new Error(category); };
for (const value of Object.values(expected)) assert(/^native-[0-9a-f]{32}$/.test(value || ''), 'explicit_native_session_required');
const directory = await mkdtemp(runtime + '/evidence/project-native-live-');
const report = {started_at: new Date().toISOString(), origin, project_id: projectId, read_only: true,
  models_started: 0, expected_sessions: expected, cases: [], requests: [], denied: [], browser_errors: 0, interception_errors: 0, success: false};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, passed) => { assert(passed, name); report.cases.push({name, passed: true}); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let browser, profile, log, control, tab, key = '', leaf, stage = 'preflight';
const ca = await readFile(caPath);
const info = await lstat(keyPath);
assert(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077), 'private_owner_required');
key = (await readFile(keyPath, 'utf8')).trim();
assert(/^[0-9a-f]{64}$/.test(key), 'owner_key_format');
function get(path) {
  assert(path.startsWith('/') && !path.startsWith('//'), 'invalid_path');
  return new Promise((resolve, reject) => {
    const req = https.get(origin + path, {ca, timeout: 8000, headers: {Authorization: 'Bearer ' + key}}, res => {
      if (res.socket.getPeerCertificate().raw) leaf = res.socket.getPeerCertificate().raw;
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > 4 * 1024 * 1024) req.destroy(); else chunks.push(c); });
      res.on('end', () => res.statusCode === 200 && size <= 4 * 1024 * 1024 ? resolve(Buffer.concat(chunks)) : reject(Error('GET_failed')));
      res.on('error', () => reject(Error('GET_transport')));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => reject(Error('GET_transport')));
  });
}
const api = async path => JSON.parse(await get(path));
class CDP {
  constructor(url, page = false) {
    this.ws = new WebSocket(url); this.serial = 0; this.pending = new Map(); this.navigations = 0; this.streams = new Set(); this.chunks = 0;
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(Error('CDP_unavailable')); });
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const item = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(item.timer);
        msg.error ? item.reject(Error('CDP_failed')) : item.resolve(msg.result);
      }
      if (!page) return;
      if (msg.method === 'Runtime.exceptionThrown') report.browser_errors++;
      if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) this.navigations++;
      if (msg.method === 'Fetch.requestPaused') {
        const {request, requestId} = msg.params, url = new URL(request.url);
        const deny = request.method !== 'GET' || url.origin !== origin || url.username || url.password || /[?&](key|token|authorization)=/i.test(url.search);
        if (deny) report.denied.push({method: request.method, path: url.origin === origin ? url.pathname : '[off-origin]'});
        void this.call(deny ? 'Fetch.failRequest' : 'Fetch.continueRequest', deny ? {requestId, errorReason: 'BlockedByClient'} : {requestId})
          .catch(() => { report.interception_errors++; });
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const {request, requestId} = msg.params, url = new URL(request.url);
        report.requests.push({method: request.method, path: url.origin === origin ? url.pathname : '[off-origin]'});
        if (url.origin === origin && url.pathname === '/v1/workspace/stream') this.streams.add(requestId);
      }
      if (msg.method === 'Network.dataReceived' && this.streams.has(msg.params.requestId)) this.chunks++;
    };
  }
  async call(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.serial, timer = setTimeout(() => { this.pending.delete(id); reject(Error('CDP_timeout')); }, 10000);
      this.pending.set(id, {resolve, reject, timer}); this.ws.send(JSON.stringify({id, method, params}));
    });
  }
  async eval(expression) {
    const result = await this.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    assert(!result.exceptionDetails, 'browser_expression'); return result.result.value;
  }
  async wait(expression) {
    const start = Date.now();
    while (Date.now() - start < 15000) { if (await this.eval(expression)) return; await pause(100); }
    throw Error('browser_condition_timeout');
  }
  close() { this.ws.close(); }
}
const rows = `Array.from(document.querySelectorAll('#project-native-list [data-native-id]')).map(e=>({id:e.dataset.nativeId,type:e.dataset.nativeType,actor:e.dataset.actorId,session:e.dataset.sessionId,channel:e.dataset.channelId}))`;
try {
  check('trusted_https_owner', (await api('/v1/me')).agent.id === ownerId);
  const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));
  report.release = deployment.release; report.asset_sha256 = {};
  for (const [path, name] of [['/', 'index.html'], ['/app.js', 'app.js'], ['/app.css', 'app.css']]) {
    const actual = hash(await get(path));
    check('live_asset_' + name, actual === hash(await readFile(deployment.web_artifacts + '/' + name)));
    report.asset_sha256[name] = actual;
  }
  const initial = (await api(activityPath)).activity;
  check('existing_native_events', initial.length > 0);
  const spki = createHash('sha256').update(new X509Certificate(leaf).publicKey.export({type: 'spki', format: 'der'})).digest('base64');
  profile = await mkdtemp(join(tmpdir(), 'agent-link-project-live-'));
  log = await open(directory + '/browser.private.log', 'wx', 0o600);
  browser = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--ignore-certificate-errors-spki-list=' + spki, 'about:blank'], {stdio: ['ignore', log.fd, log.fd]});
  let port;
  for (let i = 0; i < 100; i++) {
    assert(browser.exitCode === null, 'browser_exited');
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
    await pause(100);
  }
  assert(port > 0, 'browser_port'); const debug = 'http://127.0.0.1:' + port;
  control = new CDP((await (await fetch(debug + '/json/version')).json()).webSocketDebuggerUrl);
  const target = await control.call('Target.createTarget', {url: 'about:blank'});
  const targets = await (await fetch(debug + '/json/list')).json();
  tab = new CDP(targets.find(t => t.id === target.targetId).webSocketDebuggerUrl, true);
  for (const method of ['Runtime.enable', 'Page.enable', 'Network.enable']) await tab.call(method);
  await tab.call('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]});
  stage = 'login'; await tab.call('Page.navigate', {url: new URL('/?lang=ru', origin).href});
  await tab.wait(`document.readyState==='complete' && !!document.getElementById('nav-project-native')`);
  await tab.eval(`(()=>{const e=document.getElementById('api-key');e.value=${JSON.stringify(key)};e.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-form').requestSubmit()})()`);
  await tab.wait(`document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled`);
  await tab.eval(`document.querySelector('#project-switcher [data-focus-key="project:${projectId}"]').click()`);
  await tab.wait(`!document.getElementById('nav-project-native').disabled`);
  stage = 'project_feed'; await tab.eval(`document.getElementById('nav-project-native').click()`);
  // Watch the complete technical stream without any publication or model action.
  await tab.eval(`{ const control=document.getElementById('project-native-technical'); if(control&&!control.checked) control.click(); }`);
  await tab.wait(`!document.getElementById('project-native-panel').hidden && document.querySelectorAll('#project-native-list [data-native-id]').length>0 && !document.getElementById('refresh-button').disabled`);
  const baseline = new Set((await tab.eval(rows)).map(r => r.id));
  check('real_existing_records_visible', initial.some(e => baseline.has(e.id)));
  check('project_default_all_channels', await tab.eval(`document.getElementById('project-native-channel').value==='' && document.getElementById('project-native-actor').value===''`));
  report.initial_dom_count = baseline.size;
  // Exclude records already stored but not yet painted. A delayed old event is
  // not proof of a fresh action triggered after WATCHER_READY.
  for (const event of (await api(activityPath)).activity) baseline.add(event.id);
  const timeOrigin = await tab.eval('performance.timeOrigin'), navigations = tab.navigations, streams = tab.streams.size, chunks = tab.chunks;
  check('workspace_sse_subscribed', streams > 0);
  const start = Date.now(); report.watcher_ready_at = new Date(start).toISOString(); stage = 'watch';
  console.log(JSON.stringify({phase: 'WATCHER_READY', evidence: directory + '/evidence.json', expected_sessions: expected}));
  const seen = new Map(); let complete = false;
  while (Date.now() - start < 180000) {
    for (const item of await tab.eval(rows)) if (!baseline.has(item.id) && !seen.has(item.id)) seen.set(item.id, {...item, first_seen_at: Date.now()});
    report.observed_dom_events = [...seen.values()];
    complete = Object.entries(expected).every(([name, session]) => [...seen.values()].some(r => r.session === session && r.actor === actors[name] && r.type === 'tool.completed'));
    if (complete) break;
    assert(!report.denied.length && !report.interception_errors, 'request_guard');
    await pause(100);
  }
  check('both_actual_cli_tool_completions_visible', complete);
  const current = (await api(activityPath)).activity;
  report.observed_events = current.filter(e => seen.has(e.id)).map(e => ({id: e.id, actor: e.actor_id, session: e.session_id, type: e.event_type, runtime: e.runtime,
    created_at: e.created_at, publication_to_visible_ms: seen.get(e.id).first_seen_at - Date.parse(e.created_at)}));
  check('both_completions_match_server_records', Object.entries(expected).every(([name, session]) => report.observed_events.some(e => e.session === session && e.actor === actors[name] && e.runtime === name && e.type === 'tool.completed')));
  check('both_completions_published_after_watcher_ready', Object.entries(expected).every(([name, session]) => report.observed_events.some(e => e.session === session && e.actor === actors[name] && e.type === 'tool.completed' && Date.parse(e.created_at) >= start)));
  check('same_document_without_reload', navigations === tab.navigations && timeOrigin === await tab.eval('performance.timeOrigin'));
  check('workspace_stream_not_restarted', streams === tab.streams.size);
  check('sse_data_received', tab.chunks > chunks);
  check('freshness_visible', await tab.eval(`document.getElementById('project-native-last-event').dataset.freshness==='fresh'`));
  for (const [name, width, height] of [['desktop', 1440, 1100], ['mobile', 390, 844]]) {
    await tab.call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 500});
    check(name + '_no_horizontal_overflow', await tab.eval('document.documentElement.scrollWidth<=innerWidth+1'));
    check(name + '_no_visible_credentials', await tab.eval(`!document.body.innerText.includes(${JSON.stringify(key)}) && !/glpat-|sk-ant-|Bearer [0-9a-f]{64}/.test(document.body.innerText)`));
    const shot = await tab.call('Page.captureScreenshot', {format: 'png'});
    await writeFile(directory + '/' + name + '.png', Buffer.from(shot.data, 'base64'), {flag: 'wx', mode: 0o600});
  }
  check('GET_only_no_blocked_requests', !report.denied.length && !report.interception_errors && report.requests.every(r => r.method === 'GET'));
  check('no_browser_errors', report.browser_errors === 0); report.success = true;
} catch (error) {
  report.failure_stage = stage; report.failure_code = String(error.message).replaceAll(key || '\0', '[REDACTED]').slice(0, 150);
} finally {
  if (tab) { try { await tab.eval(`document.getElementById('logout-button').click()`); } catch {} tab.close(); }
  if (control) { try { await control.call('Browser.close'); } catch {} control.close(); }
  for (const signal of ['SIGTERM', 'SIGKILL']) if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
    browser.kill(signal); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(2500)]);
  }
  report.owned_browser_stopped = !browser?.pid || browser.exitCode !== null || browser.signalCode !== null;
  if (log) await log.close();
  if (profile && report.owned_browser_stopped) await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  report.success = report.success && report.owned_browser_stopped; report.finished_at = new Date().toISOString();
  await writeFile(directory + '/evidence.json', JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({phase: 'COMPLETE', success: report.success, cases: report.cases.length, failure_stage: report.failure_stage, failure: report.failure_code, evidence: directory + '/evidence.json'}));
}
if (!report.success) process.exitCode = 1;
