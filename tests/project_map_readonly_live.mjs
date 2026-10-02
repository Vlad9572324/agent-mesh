// GET-only acceptance of the deployed project map. No fixture writes, model
// calls, CLI operations or static-asset substitution. Only an owned browser.
import {readFile, writeFile, mkdtemp, lstat, rm, open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, X509Certificate} from 'node:crypto';
import https from 'node:https';
import {liveSettings} from './live-operator-config.mjs';

process.umask(0o077);
const {runtime, origin, chrome, caPath, keyPath, ownerId, projectId, deploymentPath} = liveSettings({deployment: true});
const assert = (value, category) => { if (!value) throw new Error(category); };
const directory = await mkdtemp(runtime + '/evidence/project-map-live-');
const report = {started_at: new Date().toISOString(), origin, project_id: projectId, read_only: true,
  models_started: 0, cases: [], requests: [], denied: [], locale_switches: [], screenshots: [], browser_errors: 0, interception_errors: 0, success: false};
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
    this.ws = new WebSocket(url); this.serial = 0; this.pending = new Map(); this.navigations = 0; this.streams = new Set(); this.activeStreams = new Set(); this.streamResponses = new Map(); this.streamChunks = new Map(); this.chunks = 0;
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
        if (url.origin === origin && url.pathname === '/v1/workspace/stream') { this.streams.add(requestId); this.activeStreams.add(requestId); this.streamChunks.set(requestId, 0); }
      }
      if (msg.method === 'Network.responseReceived' && this.streams.has(msg.params.requestId)) {
        const response = msg.params.response;
        this.streamResponses.set(msg.params.requestId, {protocol: response.protocol, status: response.status, mime_type: response.mimeType});
      }
      if (msg.method === 'Network.dataReceived' && this.streams.has(msg.params.requestId)) {
        this.chunks++; this.streamChunks.set(msg.params.requestId, this.streamChunks.get(msg.params.requestId) + 1);
      }
      if (['Network.loadingFinished', 'Network.loadingFailed'].includes(msg.method)) this.activeStreams.delete(msg.params.requestId);
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
try {
  check('trusted_https_owner', (await api('/v1/me')).agent.id === ownerId);
  const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));
  report.release = deployment.release; report.asset_sha256 = {};
  for (const [path, name] of [['/', 'index.html'], ['/app.js', 'app.js'], ['/app.css', 'app.css']]) {
    const actual = hash(await get(path));
    check('live_asset_' + name, actual === hash(await readFile(deployment.web_artifacts + '/' + name)));
    report.asset_sha256[name] = actual;
  }
  const initial = await api(`/v1/projects/${projectId}/map?limit=25`);
  check('scoped_metadata_snapshot', initial.project.id === projectId && initial.read_only === true && Array.isArray(initial.nodes) && Array.isArray(initial.edges));
  const nodeKeys = new Set(initial.nodes.map(n => n.key));
  check('edges_reference_only_loaded_nodes', initial.edges.every(e => nodeKeys.has(e.source) && nodeKeys.has(e.target)));
  check('bounded_groups_consistent', initial.groups.every(g => g.shown <= 25 && g.total >= g.shown && g.truncated === (g.total > g.shown)));
  report.groups = initial.groups;
  const spki = createHash('sha256').update(new X509Certificate(leaf).publicKey.export({type: 'spki', format: 'der'})).digest('base64');
  profile = await mkdtemp(join(tmpdir(), 'agent-link-map-live-'));
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
  stage = 'login'; await tab.call('Page.navigate', {url: origin + '/'});
  await tab.wait(`document.readyState==='complete' && !!document.getElementById('nav-project-map')`);
  check('english_default_before_login', await tab.eval(`document.documentElement.lang==='en' && document.getElementById('language-select').value==='en' && document.title.startsWith('Agent Mesh') && document.getElementById('login-button').textContent==='Connect'`));
  await tab.eval(`(()=>{const e=document.getElementById('api-key');e.value=${JSON.stringify(key)};e.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-form').requestSubmit()})()`);
  await tab.wait(`document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled`);
  await tab.eval(`document.querySelector('#project-switcher [data-focus-key="project:${projectId}"]').click()`);
  await tab.wait(`!document.getElementById('nav-project-map').disabled`);
  stage = 'project_map'; await tab.eval(`document.getElementById('nav-project-map').click()`);
  await tab.wait(`!document.getElementById('project-map-panel').hidden && document.querySelectorAll('#project-map-entities [data-entity-key]').length>0 && !document.getElementById('refresh-button').disabled`);
  check('concept_schema_separate_from_live_data', await tab.eval(`!!document.getElementById('project-map-schema') && !!document.getElementById('project-map-live')`));
  const shown = await tab.eval(`Array.from(document.querySelectorAll('#project-map-entities [data-entity-key]')).map(e=>e.dataset.entityKey)`);
  check('actual_entities_not_demo', shown.length > 0 && shown.every(k => nodeKeys.has(k)));
  check('workspace_sse_subscribed', tab.streams.size > 0);
  stage = 'idle_http2_stream';
  for (let i = 0; i < 30 && ![...tab.activeStreams].some(id => tab.streamResponses.has(id)); i++) await pause(100);
  const idleRequest = [...tab.activeStreams][0], idleResponse = tab.streamResponses.get(idleRequest);
  check('http2_workspace_stream_established', tab.activeStreams.size === 1 && idleResponse?.protocol === 'h2' && idleResponse.status === 200 && idleResponse.mime_type === 'text/event-stream');
  const idleStart = performance.now(), idleStreamsBefore = tab.streams.size, idleChunksBefore = tab.streamChunks.get(idleRequest) || 0;
  // No UI action or fixture write: ordinary GET polling may continue. Survive
  // the former ten-second deadline with the exact same HTTP/2 SSE request.
  await pause(12050);
  report.idle_http2_stream = {request_id: idleRequest, protocol: idleResponse.protocol, elapsed_ms: Math.round(performance.now() - idleStart),
    streams_before: idleStreamsBefore, streams_after: tab.streams.size, active_request_ids: [...tab.activeStreams],
    chunks_before: idleChunksBefore, chunks_after: tab.streamChunks.get(idleRequest) || 0};
  check('idle_http2_stream_survives_12s', report.idle_http2_stream.elapsed_ms >= 12000 && tab.activeStreams.size === 1 && tab.activeStreams.has(idleRequest) && tab.streams.size === idleStreamsBefore && report.idle_http2_stream.chunks_after > idleChunksBefore);
  stage = 'channel_focus';
  await tab.eval(`(()=>{const e=document.getElementById('project-map-type');e.value='channel';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await tab.wait(`!!document.querySelector('#project-map-entities [data-entity-type="channel"]')`);
  await tab.eval(`document.querySelector('#project-map-entities [data-entity-type="channel"]').click()`);
  await tab.wait(`document.getElementById('project-map-relations').textContent.length>0`);
  const relations = await tab.eval(`Array.from(document.querySelectorAll('#project-map-relations [data-source][data-target]')).map(e=>({source:e.dataset.source,target:e.dataset.target,kind:e.dataset.relationType}))`);
  check('visible_relations_match_server', relations.length > 0 && relations.every(e => initial.edges.some(a => a.source === e.source && a.target === e.target && a.kind === e.kind)));

  // Keep a real selected entity and a nonempty filter through both locale
  // changes. The UI may continue its normal GET-only polling in the background.
  await tab.eval(`(()=>{const chosen=document.querySelector('#project-map-entities [aria-pressed="true"]');const search=document.getElementById('project-map-search');search.value=chosen.dataset.entityId;search.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const selectionExpression = `({key:document.getElementById('project-map-detail').dataset.entityKey||'',type:document.getElementById('project-map-type').value,query:document.getElementById('project-map-search').value})`;
  const selected = await tab.eval(selectionExpression);
  check('locale_has_selected_entity_and_filter', Boolean(selected.key && selected.query && selected.type === 'channel'));
  async function switchLanguage(language, authenticated) {
    const prefix = (authenticated ? 'map' : 'logout') + '_locale_' + language;
    const before = {streams: tab.streams.size, active: [...tab.activeStreams].sort(), navigations: tab.navigations};
    await tab.eval(`(()=>{const select=document.getElementById('language-select');select.value=${JSON.stringify(language)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await tab.wait(`document.documentElement.lang===${JSON.stringify(language)} && document.getElementById('language-select').value===${JSON.stringify(language)} && new URLSearchParams(location.search).get('lang')===${JSON.stringify(language)}`);
    await pause(150);
    check(prefix + '_labels_and_brand', await tab.eval(`document.title.startsWith('Agent Mesh') && document.querySelector('.brand').textContent.includes('Agent Mesh') && document.getElementById('nav-project-map').textContent.includes(${JSON.stringify(language === 'ru' ? 'Карта проекта' : 'Project map')}) && document.getElementById('language-select').getBoundingClientRect().height>=40`));
    check(prefix + '_no_navigation', tab.navigations === before.navigations);
    // This records that no replacement was observed during the switch window;
    // it is not a general availability guarantee or a claim about later retries.
    check(prefix + '_same_workspace_stream', tab.streams.size === before.streams && JSON.stringify([...tab.activeStreams].sort()) === JSON.stringify(before.active) && (!authenticated || before.active.length > 0));
    if (authenticated) check(prefix + '_same_selection_and_filter', JSON.stringify(await tab.eval(selectionExpression)) === JSON.stringify(selected));
    else check(prefix + '_stays_logged_out', await tab.eval(`!document.getElementById('login-panel').hidden && document.getElementById('connected-workspace').hidden && !document.body.classList.contains('authenticated') && document.getElementById('api-key').value==='' && document.getElementById('project-map-entities').childElementCount===0 && document.getElementById('project-map-detail').childElementCount===0`));
    report.locale_switches.push({language, authenticated, streams_before: before.streams, streams_after: tab.streams.size, active_streams_before: before.active.length, active_streams_after: tab.activeStreams.size});
  }
  for (const language of ['ru', 'en']) {
    stage = 'map_locale_' + language;
    await switchLanguage(language, true);
    for (const [name, width, height] of [['desktop', 1440, 1100], ['mobile', 390, 844]]) {
      await tab.call('Page.bringToFront');
      await tab.call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: width < 500});
      const prefix = (language === 'ru' ? '' : language + '_') + name;
      // Retain the original four viewport assertions and original RU filenames.
      check(prefix + '_no_horizontal_overflow', await tab.eval('document.documentElement.scrollWidth<=innerWidth+1'));
      check(prefix + '_no_visible_credentials', await tab.eval(`!document.body.innerText.includes(${JSON.stringify(key)}) && !/glpat-|sk-ant-|Bearer [0-9a-f]{64}/.test(document.body.innerText)`));
      check(prefix + '_language_control_accessible', await tab.eval(`(()=>{const select=document.getElementById('language-select'),r=select.getBoundingClientRect();return r.height>=40 && r.width>0 && r.left>=0 && r.right<=innerWidth && !select.disabled && select.labels.length>0 && select.tabIndex>=0;})()`));
      for (const [section, element] of [['schema', 'project-map-schema'], ['relations', 'project-map-detail']]) {
        await tab.eval(`document.getElementById(${JSON.stringify(element)}).scrollIntoView({block:'start'})`);
        const shot = await tab.call('Page.captureScreenshot', {format: 'png'});
        const filename = (language === 'ru' ? '' : language + '-') + name + '-' + section + '.png';
        await writeFile(directory + '/' + filename, Buffer.from(shot.data, 'base64'), {flag: 'wx', mode: 0o600});
        report.screenshots.push({language, viewport: name, section, filename});
      }
    }
  }
  stage = 'navigate';
  await tab.call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false});
  await tab.eval(`document.querySelector('#project-map-detail [data-target-view="chat"]').click()`);
  await tab.wait(`!document.getElementById('chat-panel').hidden && !document.getElementById('refresh-button').disabled`);
  check('channel_navigation_reaches_real_chat', await tab.eval(`document.getElementById('project-map-panel').hidden && !!document.querySelector('#channel-list [aria-pressed="true"]')`));
  stage = 'logout_locales';
  await tab.eval(`document.getElementById('logout-button').click()`);
  await tab.wait(`!document.getElementById('login-panel').hidden && document.getElementById('connected-workspace').hidden`);
  for (let i = 0; i < 30 && tab.activeStreams.size; i++) await pause(100);
  check('logout_closed_workspace_stream', tab.activeStreams.size === 0);
  for (const language of ['ru', 'en']) await switchLanguage(language, false);
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
