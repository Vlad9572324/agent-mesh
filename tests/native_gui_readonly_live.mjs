// Explicit live GET-only browser watcher. Never creates fixtures or runs models.
// Run under operator coordination; after WATCHER_READY another actor may publish
// lifecycle events. This process only observes and closes its own browser.
import {readFile, writeFile, mkdtemp, chmod, lstat, rm, open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, X509Certificate} from 'node:crypto';
import https from 'node:https';
import {liveSettings} from './live-operator-config.mjs';

process.umask(0o077);
const {runtime, origin, chrome, caPath, keyPath, ownerId, projectId, channelId, actors, baselineId} = liveSettings({channel: true, actors: ['codex'], baseline: true});
const base = origin + '/', activityPath = `/v1/channels/${channelId}/activity`;
const directory = await mkdtemp(runtime + '/evidence/native-live-gui-'); await chmod(directory, 0o700);
const report = {started_at: new Date().toISOString(), origin, read_only: true, models_started: 0,
  project_id: projectId, channel_id: channelId, cases: [], requests: [], stream_chunks: [], blocked_mutations: [], browser_errors: 0, success: false};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, category) => { if (!value) throw new Error(category); };
const check = (name, value, facts = {}) => { assert(value, name); report.cases.push({name, passed: true, ...facts}); };
let browser, profile, log, control, tab, key, leaf, stage = 'preflight';
const ca = await readFile(caPath);
const keyInfo = await lstat(keyPath);
assert(keyInfo.isFile() && !keyInfo.isSymbolicLink() && !(keyInfo.mode & 0o077), 'private_owner_required');
key = (await readFile(keyPath, 'utf8')).trim();
assert(/^[a-f0-9]{64}$/.test(key), 'invalid_owner_key');

function get(path) {
  return new Promise((resolve, reject) => {
    const request = https.get(new URL(path, base), {ca, rejectUnauthorized: true, timeout: 8000,
      headers: {Authorization: 'Bearer ' + key}}, response => {
      const certificate = response.socket.getPeerCertificate();
      if (certificate.raw) leaf = certificate.raw; // Only after verified CA/hostname TLS.
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 2097152) request.destroy(); else chunks.push(chunk); });
      response.on('end', () => { try { assert(response.statusCode === 200 && size <= 2097152, 'GET_failed'); resolve(JSON.parse(Buffer.concat(chunks))); } catch { reject(new Error('GET_invalid_response')); } });
      response.on('error', () => reject(new Error('GET_transport_failed')));
    });
    request.on('timeout', () => request.destroy()); request.on('error', () => reject(new Error('GET_transport_failed')));
  });
}

class CDP {
  constructor(url, page = false) {
    this.ws = new WebSocket(url); this.serial = 0; this.pending = new Map(); this.paths = new Map(); this.streams = new Set(); this.navigations = 0;
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error('CDP_unavailable')); });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) { const item = this.pending.get(message.id); clearTimeout(item.timer); this.pending.delete(message.id); message.error ? item.reject(new Error('CDP_failed')) : item.resolve(message.result); }
      if (!page) return;
      if (message.method === 'Runtime.exceptionThrown') report.browser_errors++;
      if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) this.navigations++;
      if (message.method === 'Fetch.requestPaused') {
        const {request, requestId} = message.params, url = new URL(request.url), deny = url.origin === origin && request.method !== 'GET';
        if (deny) report.blocked_mutations.push({method: request.method, path: url.pathname});
        void this.call(deny ? 'Fetch.failRequest' : 'Fetch.continueRequest', deny ? {requestId, errorReason: 'BlockedByClient'} : {requestId}).catch(() => {});
      }
      if (message.method === 'Network.requestWillBeSent') {
        const request = message.params.request, url = new URL(request.url);
        if (url.origin === origin) {
          this.paths.set(message.params.requestId, url.pathname); report.requests.push({method: request.method, path: url.pathname, at: Date.now()});
          if (url.pathname === '/v1/workspace/stream') this.streams.add(message.params.requestId);
        }
      }
      if (message.method === 'Network.dataReceived' && this.paths.get(message.params.requestId) === '/v1/workspace/stream') report.stream_chunks.push({at: Date.now(), bytes: message.params.dataLength});
    };
  }
  async call(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => { const id = ++this.serial, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP_timeout')); }, 10000);
      this.pending.set(id, {resolve, reject, timer}); this.ws.send(JSON.stringify({id, method, params})); });
  }
  async eval(expression) { const result = await this.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}); assert(!result.exceptionDetails, 'browser_expression_failed'); return result.result.value; }
  async wait(expression) { const start = Date.now(); while (Date.now() - start < 15000) { if (await this.eval(expression)) return; await pause(70); } throw new Error('browser_condition_timeout'); }
  close() { this.ws.close(); }
}
const snapshot = `Array.from(document.querySelectorAll('#native-activity-list [data-native-id]')).map(e=>{const t=e.querySelector('.activity-meta')?.textContent||'',a=t.match(/\\(([A-Za-z0-9_.:-]+)\\) · (codex|claude)/);return{id:e.dataset.nativeId,type:e.dataset.nativeType,actor_id:a?.[1]||null,runtime:a?.[2]||null,session:t.match(/Сессия CLI: ([A-Za-z0-9_.:-]+)/)?.[1]||null,seq:Number(t.match(/seq (\\d+)/)?.[1]||0)}})`;
try {
  check('verified_https_owner_identity', (await get('/v1/me')).agent.id === ownerId);
  const initial = await get(activityPath + '?after_seq=0&limit=100');
  const baseline = initial.activity.find(event => event.id === baselineId && event.event_type === 'session.ended');
  check('configured_codex_session_ended', baseline?.runtime === 'codex' && baseline.actor_id === actors.codex, {event_id: baseline?.id, session_id: baseline?.session_id, seq: baseline?.seq});
  report.baseline_max_seq = Math.max(0, ...initial.activity.map(event => event.seq));
  assert(leaf, 'verified_leaf_missing'); const cert = new X509Certificate(leaf);
  const spki = createHash('sha256').update(cert.publicKey.export({type: 'spki', format: 'der'})).digest('base64');
  report.ca_verified_leaf_sha256 = createHash('sha256').update(leaf).digest('hex');
  profile = await mkdtemp(join(tmpdir(), 'agentlink-live-readonly-')); await chmod(profile, 0o700); log = await open(directory + '/browser.private.log', 'wx', 0o600);
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--ignore-certificate-errors-spki-list=' + spki, 'about:blank'], {stdio: ['ignore', log.fd, log.fd]});
  let port;
  for (let index = 0; index < 100; index++) { assert(browser.exitCode === null, 'browser_exited'); try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {} await pause(100); }
  assert(port > 0, 'missing_browser_port'); const address = 'http://127.0.0.1:' + port;
  control = new CDP((await (await fetch(address + '/json/version')).json()).webSocketDebuggerUrl);
  const target = await control.call('Target.createTarget', {url: 'about:blank'}), targets = await (await fetch(address + '/json/list')).json();
  tab = new CDP(targets.find(item => item.id === target.targetId).webSocketDebuggerUrl, true);
  for (const method of ['Runtime.enable', 'Page.enable', 'Network.enable']) await tab.call(method);
  await tab.call('Fetch.enable', {patterns: [{urlPattern: origin + '/*', requestStage: 'Request'}]});
  stage = 'page'; await tab.call('Page.navigate', {url: new URL('?lang=ru', base).href}); await tab.wait(`document.readyState==='complete'&&!!document.getElementById('tab-native')`);
  stage = 'login'; await tab.eval(`(()=>{const e=document.getElementById('api-key');e.value=${JSON.stringify(key)};e.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-form').requestSubmit()})()`);
  await tab.wait(`document.getElementById('login-panel').hidden&&!document.getElementById('refresh-button').disabled`);
  stage = 'project'; await tab.eval(`document.querySelector('#project-switcher [data-focus-key="project:${projectId}"]').click()`);
  await tab.wait(`!!document.querySelector('#channel-list [data-focus-key="channel:${channelId}"]')&&!document.getElementById('refresh-button').disabled`);
  stage = 'channel'; await tab.eval(`document.querySelector('#channel-list [data-focus-key="channel:${channelId}"]').click()`);
  await tab.wait(`document.querySelector('#channel-list [data-focus-key="channel:${channelId}"]').getAttribute('aria-pressed')==='true'&&!document.getElementById('refresh-button').disabled`);
  stage = 'activity'; await tab.eval(`document.getElementById('tab-native').click()`);
  // Reveal the full timeline locally; this remains a GET-only deployment watcher.
  await tab.eval(`{ const control=document.getElementById('native-technical'); if(control&&!control.checked) control.click(); }`);
  await tab.wait(`!document.getElementById('native-panel').hidden&&!!document.querySelector('#native-activity-list [data-native-id="${baseline.id}"]')`);
  check('actual_existing_event_visible_in_activity_cli', true, {event_id: baseline.id});
  report.initial_dom_count = (await tab.eval(snapshot)).length; report.time_origin = await tab.eval('performance.timeOrigin');
  const watchNavigations = tab.navigations, watchStarted = Date.now(); report.watcher_ready_at = new Date(watchStarted).toISOString(); report.workspace_stream_count_before = tab.streams.size;
  check('workspace_sse_subscribed', tab.streams.size > 0); stage = 'watch';
  console.log(JSON.stringify({phase: 'WATCHER_READY', evidence: directory + '/evidence.json', baseline_seq: report.baseline_max_seq, initial_dom_count: report.initial_dom_count, workspace_streams: tab.streams.size}));
  const seen = new Map(); let completed;
  while (Date.now() - watchStarted < 180000) {
    for (const row of await tab.eval(snapshot)) if (row.seq > report.baseline_max_seq && !seen.has(row.id)) seen.set(row.id, {...row, first_seen_at: Date.now()});
    // Retain partial observations even if the publisher is delayed or another
    // assertion fails. GUI freshness needs one real event, not a lifecycle pair:
    // providers may run SessionStart only lazily on the first model prompt.
    report.observed_dom_events = [...seen.values()];
    completed = [...seen.values()].find(row => ['session.started', 'session.ended'].includes(row.type)
      && row.actor_id === actors.codex && row.runtime === 'codex' && row.session !== baseline.session_id);
    if (completed) break;
    await pause(100);
  }
  report.final_dom_count = (await tab.eval(snapshot)).length;
  report.same_document = tab.navigations === watchNavigations && await tab.eval('performance.timeOrigin') === report.time_origin;
  report.workspace_stream_count_after = tab.streams.size;
  assert(completed, 'new_codex_lifecycle_event_not_observed');
  const events = (await get(activityPath + '?after_seq=' + report.baseline_max_seq + '&limit=100')).activity;
  const session = events.filter(event => event.session_id === completed.session && event.actor_id === actors.codex && event.runtime === 'codex');
  report.observed_events = session.map(event => { const dom = seen.get(event.id); return {id: event.id, session_id: event.session_id, event_type: event.event_type, seq: event.seq, created_at: event.created_at, first_visible_at: dom ? new Date(dom.first_seen_at).toISOString() : null, publication_to_visible_ms: dom ? dom.first_seen_at - Date.parse(event.created_at) : null}; });
  check('new_codex_lifecycle_event_without_reload', session.length > 0 && session.some(event => event.id === completed.id) && session.every(event => seen.has(event.id)));
  check('same_document_no_navigation_reload', report.same_document);
  check('workspace_stream_not_restarted', tab.streams.size === report.workspace_stream_count_before);
  check('sse_data_arrived_during_watch', report.stream_chunks.some(chunk => chunk.at >= watchStarted));
  check('all_browser_requests_get_only', !report.blocked_mutations.length && report.requests.every(request => request.method === 'GET'));
  check('no_browser_javascript_exception', report.browser_errors === 0);
  report.final_dom_count = (await tab.eval(snapshot)).length; report.max_publication_to_visible_ms = Math.max(...report.observed_events.map(event => event.publication_to_visible_ms)); report.success = true;
} catch (error) { report.failure_stage = stage; report.failure_category = error.name; report.failure_code = String(error.message).replaceAll(key, '[REDACTED]').slice(0, 120); }
finally {
  if (tab) { try { await tab.eval(`document.getElementById('logout-button').click()`); } catch {} tab.close(); }
  if (control) { try { await control.call('Browser.close'); } catch {} control.close(); }
  if (browser?.exitCode === null) { browser.kill('SIGTERM'); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(3000)]); if (browser.exitCode === null) { browser.kill('SIGKILL'); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(2000)]); } }
  report.owned_browser_stopped = !browser || browser.exitCode !== null || browser.signalCode !== null;
  if (log) await log.close(); if (profile) await rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  report.finished_at = new Date().toISOString(); report.success = report.success && report.owned_browser_stopped;
  await writeFile(directory + '/evidence.json', JSON.stringify(report, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  console.log(JSON.stringify({phase: 'COMPLETE', success: report.success, cases: report.cases.length, failure_stage: report.failure_stage, failure: report.failure_code, observed_events: report.observed_events, max_publication_to_visible_ms: report.max_publication_to_visible_ms, owned_browser_stopped: report.owned_browser_stopped, evidence: directory + '/evidence.json'}));
}
if (!report.success) process.exitCode = 1;
