// Real browser/API admin acceptance. Mutates only run-prefixed QA entities.
import { readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import {runtimeDir, serviceOrigin, certificateFile} from '../scripts/operator-config.mjs';

process.umask(0o077);
const runtime = runtimeDir();
const base = serviceOrigin() + '/';
const ca = await readFile(certificateFile());
const ownerCredentials = JSON.parse(await readFile(process.env.AGENT_LINK_GUI_OWNER_FILE || `${runtime}/secrets/owner-pilot.json`, 'utf8'));
const ownerKey = ownerCredentials.key;
const viewerKey = process.env.AGENT_LINK_GUI_CREDENTIALS_FILE
  ? JSON.parse(await readFile(process.env.AGENT_LINK_GUI_CREDENTIALS_FILE, 'utf8')).keys['viewer-pilot']
  : (await readFile(`${runtime}/secrets/viewer-pilot.key`, 'utf8')).trim();
const prefix = `gui-admin-${randomUUID().slice(0, 8)}`;
const ids = { agent: `${prefix}-agent`, project: `${prefix}-project`, channel: `${prefix}-channel` };
const report = { run: prefix, base_url: base, started_at: new Date().toISOString(), cases: [], layouts: [], runtimeErrors: [], scope: 'Owned browser and run-prefixed QA entities only; no model runs' };
const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = tabs.find(item => item.type === 'page' && item.url.startsWith(base));
if (!tab) throw new Error('Owned pilot test browser is not running');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let serial = 0;
let confirmNext = false;
let issuedKey = '';
const pending = new Map();
const mutatingRequests = [];
socket.onmessage = event => {
  const value = JSON.parse(event.data);
  if (value.id && pending.has(value.id)) {
    const task = pending.get(value.id); clearTimeout(task.timer); pending.delete(value.id);
    if (value.error) task.reject(new Error('DevTools command failed')); else task.resolve(value.result);
  }
  if (value.method === 'Page.javascriptDialogOpening') {
    const accept = confirmNext; confirmNext = false;
    void call('Page.handleJavaScriptDialog', { accept });
  }
  if (value.method === 'Runtime.exceptionThrown') report.runtimeErrors.push(value.params.exceptionDetails.text);
  if (value.method === 'Network.requestWillBeSent' && /^(POST|PUT|DELETE)$/.test(value.params.request.method)) {
    // Only method/path, never headers or request bodies.
    mutatingRequests.push({ method: value.params.request.method, path: new URL(value.params.request.url).pathname });
  }
};
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('Browser evaluation failed; no expression or credentials logged');
  return result.result.value;
}
async function waitFor(expression) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('UI condition timed out');
}
function assert(value, message) { if (!value) throw new Error(message); }
async function check(name, action) {
  try { await action(); report.cases.push({ name, passed: true }); }
  catch (error) { report.cases.push({ name, passed: false, error: error.message }); throw error; }
  finally { console.log(JSON.stringify(report.cases.at(-1))); }
}
function api(path, key = ownerKey, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(path, base), { ca, method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, timeout: 10000 }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(text) }); } catch { reject(new Error('API did not return JSON')); } });
    });
    request.on('error', () => reject(new Error('HTTPS API unavailable')));
    request.on('timeout', () => request.destroy()); request.end(body ? JSON.stringify(body) : undefined);
  });
}
async function login(key) {
  await evaluate(`document.getElementById('api-key').value=${JSON.stringify(key)};document.getElementById('login-form').requestSubmit()`);
  await waitFor(`document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled`);
}
async function fill(id, value) {
  await evaluate(`(()=>{const field=document.getElementById(${JSON.stringify(id)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function submit(form, confirm = false) {
  confirmNext = confirm;
  await evaluate(`document.getElementById(${JSON.stringify(form)}).requestSubmit()`);
}
async function inventoryUntil(test) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const result = await api('/v1/admin/overview');
    if (result.status === 200 && test(result.data)) return result.data;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error('Expected admin state not persisted');
}
async function waitIdle() {
  await waitFor(`!document.getElementById('admin-principal-form').querySelector('button[type=submit]').disabled`);
}
async function clickKey(action, confirm = true) {
  confirmNext = confirm;
  await evaluate(`document.querySelector('[data-admin-action="${action}"][data-principal-id="${ids.agent}"]').click()`);
}
async function closeKey() {
  await evaluate(`document.getElementById('admin-key-close').click()`);
  assert(await evaluate(`!document.getElementById('admin-key-dialog').open && document.getElementById('admin-issued-key').value===''`), 'closed key dialog retained secret');
}
try {
  await call('Runtime.enable'); await call('Network.enable'); await call('Page.enable');
  await call('Page.navigate', { url: new URL('?lang=ru', base).href });
  await waitFor(`document.readyState==='complete' && document.getElementById('transport-note')?.textContent.length>0`);
  await check('viewer has no admin controls or API access', async () => {
    await login(viewerKey);
    assert(await evaluate(`document.getElementById('nav-admin').hidden || document.getElementById('nav-admin').closest('[hidden]')!==null`), 'viewer sees admin navigation');
    assert((await api('/v1/admin/overview', viewerKey)).status === 403, 'viewer admin API accepted');
    await evaluate(`document.getElementById('logout-button').click()`);
  });
  await check('owner opens administration with no startup mutations', async () => {
    const before = mutatingRequests.length;
    await login(ownerKey);
    await evaluate(`document.getElementById('nav-admin').click()`);
    await waitFor(`!document.getElementById('admin-panel').hidden && document.getElementById('admin-principal-list').textContent.includes('claude-pilot')`);
    await waitIdle();
    assert(mutatingRequests.length === before, 'opening admin mutated state');
    assert(await evaluate(`document.getElementById('composer-form').hidden && localStorage.length===0 && sessionStorage.length===0`), 'owner can impersonate or browser stores key');
  });
  await check('create inactive agent, project and channel through real forms', async () => {
    await fill('admin-principal-id', ids.agent); await fill('admin-principal-name', `${prefix} <img src=x onerror=alert(1)>`);
    await fill('admin-principal-kind', 'agent'); await fill('admin-principal-runtime', 'qa');
    await submit('admin-principal-form');
    const overview = await inventoryUntil(x => x.principals.some(p => p.id === ids.agent));
    assert(!overview.principals.find(p => p.id === ids.agent).key_active, 'new principal key active before issuance');
    await waitIdle();
    await evaluate(`document.querySelector('[data-admin-section="projects"]').click()`);
    await fill('admin-project-id', ids.project); await fill('admin-project-name', `${prefix} test project`);
    await submit('admin-project-form'); await inventoryUntil(x => x.projects.some(p => p.id === ids.project)); await waitIdle();
    await waitFor(`Array.from(document.getElementById('admin-channel-project').options).some(o=>o.value==='${ids.project}')`);
    await fill('admin-channel-id', ids.channel); await fill('admin-channel-name', 'QA channel'); await fill('admin-channel-project', ids.project);
    await submit('admin-channel-form'); await inventoryUntil(x => x.channels.some(c => c.id === ids.channel)); await waitIdle();
    assert(await evaluate(`!document.getElementById('admin-principal-list').querySelector('img')`), 'principal name rendered as markup');
  });
  await check('grant explicit project and channel access', async () => {
    await evaluate(`document.querySelector('[data-admin-section="access"]').click()`);
    await fill('admin-access-agent', ids.agent); await fill('admin-access-project', ids.project);
    await fill('admin-access-scope', 'project'); await fill('admin-access-level', 'write');
    await submit('admin-access-form', true);
    await inventoryUntil(x => x.project_members.some(m => m.agent_id === ids.agent && m.project_id === ids.project && m.can_write)); await waitIdle();
    await fill('admin-access-agent', ids.agent); await fill('admin-access-project', ids.project); await fill('admin-access-scope', 'channel');
    await fill('admin-access-channel', ids.channel); await fill('admin-access-level', 'write');
    await submit('admin-access-form', true);
    await inventoryUntil(x => x.channel_members.some(m => m.agent_id === ids.agent && m.channel_id === ids.channel && m.can_write)); await waitIdle();
  });
  await check('rotation confirmation cancellation makes no request', async () => {
    await evaluate(`document.querySelector('[data-admin-section="accounts"]').click()`);
    const before = mutatingRequests.length; await clickKey('rotate-key', false);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert(mutatingRequests.length === before, 'cancelled key rotation reached server');
  });
  await check('one-time key works, is cleared on close, and is absent from inventory/audit', async () => {
    await clickKey('rotate-key');
    await waitFor(`document.getElementById('admin-key-dialog').open && document.getElementById('admin-issued-key').value.length===64`);
    issuedKey = await evaluate(`document.getElementById('admin-issued-key').value`);
    assert((await api('/v1/me', issuedKey)).data.agent.id === ids.agent, 'issued key wrong identity');
    assert((await api(`/v1/channels/${ids.channel}/messages`, issuedKey)).status === 200, 'assigned channel unavailable');
    const overview = await api('/v1/admin/overview'); const audit = await api('/v1/admin/audit');
    assert(!JSON.stringify([overview.data, audit.data]).includes(issuedKey), 'secret in admin records');
    assert(await evaluate(`localStorage.length===0 && sessionStorage.length===0`), 'one-time key stored in browser storage');
    await closeKey(); await waitIdle();
  });
  await check('second rotation invalidates the old key without changing identity', async () => {
    const previous = issuedKey; await clickKey('rotate-key');
    await waitFor(`document.getElementById('admin-key-dialog').open && document.getElementById('admin-issued-key').value.length===64`);
    issuedKey = await evaluate(`document.getElementById('admin-issued-key').value`);
    assert((await api('/v1/me', previous)).status === 401, 'old key survives rotation');
    assert((await api('/v1/me', issuedKey)).data.agent.id === ids.agent, 'rotation changed principal');
    await closeKey(); await waitIdle();
  });
  await check('project removal revokes subordinate channel grants', async () => {
    await fill('admin-access-agent', ids.agent); await fill('admin-access-project', ids.project); await fill('admin-access-scope', 'project'); await fill('admin-access-level', 'none');
    await submit('admin-access-form', true);
    await inventoryUntil(x => !x.project_members.some(m => m.agent_id === ids.agent && m.project_id === ids.project) && !x.channel_members.some(m => m.agent_id === ids.agent && m.channel_id === ids.channel));
    assert((await api(`/v1/channels/${ids.channel}/messages`, issuedKey)).status === 404, 'removed access still reads channel');
    await waitIdle();
  });
  await check('revoke button disables only the QA principal key', async () => {
    await clickKey('revoke-key'); await inventoryUntil(x => !x.principals.find(p => p.id === ids.agent).key_active);
    assert((await api('/v1/me', issuedKey)).status === 401, 'revoked key still authorized');
    assert((await api('/v1/me', viewerKey)).status === 200, 'existing viewer affected');
    assert((await api('/v1/me')).status === 200, 'owner locked out'); await waitIdle();
  });
  await check('audit and diagnostic panels render and desktop/mobile do not overflow', async () => {
    await evaluate(`document.querySelector('[data-admin-section="diagnostics"]').click()`);
    await waitFor(`document.getElementById('admin-audit-list').textContent.includes('${ids.agent}')`);
    assert(await evaluate(`document.getElementById('admin-delivery-list')!==null`), 'delivery diagnostics absent');
    for (const [name, width, height] of [['desktop', 1440, 1100], ['mobile', 390, 1000]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const layout = await evaluate(`({name:'${name}',width:innerWidth,scrollWidth:document.documentElement.scrollWidth})`);
      report.layouts.push(layout); assert(layout.scrollWidth <= layout.width, `${name} horizontal overflow`);
      const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(`${runtime}/evidence/admin-gui-${name}.png`, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
    }
  });
  await check('logout clears protected admin data and secret fields', async () => {
    await evaluate(`document.getElementById('logout-button').click()`);
    assert(await evaluate(`!document.getElementById('login-panel').hidden && document.getElementById('admin-principal-list').textContent==='' && document.getElementById('admin-issued-key').value==='' && localStorage.length===0 && sessionStorage.length===0`), 'logout retained protected data');
    assert(report.runtimeErrors.length === 0, 'browser runtime errors observed');
  });
} finally {
  // Cleanup affects only this run's newly created test identity. No shared keys.
  try { await api(`/v1/admin/principals/${ids.agent}/revoke-key`, ownerKey, 'POST', {}); } catch { /* report evidence retained */ }
  issuedKey = '';
  try { await evaluate(`document.getElementById('logout-button').click()`); } catch { /* browser may be gone */ }
  report.finished_at = new Date().toISOString();
  report.passed = report.cases.length === 11 && report.cases.every(item => item.passed);
  report.mutating_requests = mutatingRequests;
  await writeFile(`${runtime}/evidence/admin-gui-report.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  socket.close();
}
if (!report.passed) process.exitCode = 1;
