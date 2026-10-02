// Destructive lifecycle checks use only newly-created fixtures in isolated E2E DB.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import {runtimeDir, certificateFile} from '../scripts/operator-config.mjs';

process.umask(0o077);
const runtime = runtimeDir();
const base = 'https://127.0.0.1:18769/';
const ca = await readFile(certificateFile());
const owner = JSON.parse(await readFile(`${runtime}/secrets/admin-e2e-owner.json`, 'utf8')).key;
const run = `lifecycle-gui-${randomUUID().slice(0, 8)}`;
const ids = { project: `${run}-project`, channel: `${run}-channel`, agent: `${run}-agent`, control: `${run}-control`, controlChannel: `${run}-control-channel` };
let agentKey = '';
const report = { run, base_url: base, started_at: new Date().toISOString(), cases: [], runtime_errors: [], scope: 'Isolated E2E database; only run-prefixed fixture project deleted' };
const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = tabs.find(t => t.type === 'page' && t.url.startsWith(base));
if (!tab) throw new Error('Owned staging browser tab required');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let serial = 0, confirmNext = false;
const pending = new Map(), requests = [];
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const task = pending.get(message.id); clearTimeout(task.timer); pending.delete(message.id);
    message.error ? task.reject(new Error('Browser command failed')) : task.resolve(message.result);
  }
  if (message.method === 'Page.javascriptDialogOpening') { const accept = confirmNext; confirmNext = false; void call('Page.handleJavaScriptDialog', { accept }); }
  if (message.method === 'Runtime.exceptionThrown') report.runtime_errors.push(message.params.exceptionDetails.text);
  if (message.method === 'Network.requestWillBeSent' && /^(POST|PUT|DELETE)$/.test(message.params.request.method)) requests.push({ method: message.params.request.method, path: new URL(message.params.request.url).pathname });
};
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('Browser evaluation failed; no expression logged');
  return result.result.value;
}
async function wait(test, label = 'UI condition') {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (typeof test === 'string' ? await evaluate(test) : await test()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out`);
}
function assert(value, message) { if (!value) throw new Error(message); }
async function check(name, action) {
  try { await action(); report.cases.push({ name, passed: true }); }
  catch (error) { report.cases.push({ name, passed: false, error: error.message }); throw error; }
  finally { console.log(JSON.stringify(report.cases.at(-1))); }
}
function api(path, method = 'GET', body, key = owner) {
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(path, base), { ca, method, timeout: 10000, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(text) }); } catch { reject(new Error('Non-JSON API response')); } });
    });
    req.on('error', () => reject(new Error('Staging API unavailable'))); req.on('timeout', () => req.destroy()); req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function success(path, method = 'GET', body, key = owner) {
  const result = await api(path, method, body, key);
  assert(result.status >= 200 && result.status < 300, `Fixture request failed: ${method} ${path}, HTTP ${result.status}`);
  return result.data;
}
const projectPath = `/v1/admin/projects/${ids.project}`;
async function project() { return (await success('/v1/admin/overview')).projects.find(p => p.id === ids.project); }
async function fill(id, value) {
  await evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function login() {
  await fill('api-key', owner); await evaluate("document.getElementById('login-form').requestSubmit()");
  await wait("document.getElementById('login-panel').hidden && !document.getElementById('refresh-button').disabled");
  await admin();
}
async function admin() {
  await evaluate("document.getElementById('nav-admin').click()");
  await evaluate(`document.querySelector('[data-admin-section="projects"]').click()`);
  await wait(`!document.getElementById('admin-panel').hidden && document.getElementById('admin-project-list').textContent.includes('${ids.project}') && !document.getElementById('admin-principal-form').querySelector('button[type=submit]').disabled`);
}
async function idle() { await wait("!document.getElementById('admin-principal-form').querySelector('button[type=submit]').disabled"); }
async function action(name, confirm = true) {
  confirmNext = confirm;
  await evaluate(`document.querySelector('[data-project-action="${name}"][data-project-id="${ids.project}"]').click()`);
}
async function deletionDialog() {
  await action('delete');
  await wait("document.getElementById('admin-delete-dialog').open && document.getElementById('admin-delete-counts').textContent.length>0 && !document.getElementById('admin-delete-confirm').disabled");
}
async function closeDialog() { await evaluate("document.getElementById('admin-delete-cancel').click()"); }

try {
  // API fixture setup uses unique IDs; no seed identity is modified.
  await success('/v1/admin/principals', 'POST', { id: ids.agent, name: run, kind: 'agent', runtime: 'test-no-model' });
  for (const [projectID, channelID] of [[ids.project, ids.channel], [ids.control, ids.controlChannel]]) {
    await success('/v1/admin/projects', 'POST', { id: projectID, name: projectID });
    await success('/v1/admin/channels', 'POST', { id: channelID, name: channelID, project_id: projectID });
    await success('/v1/admin/access', 'PUT', { agent_id: ids.agent, scope: 'project', resource_id: projectID, access: 'write' });
    await success('/v1/admin/access', 'PUT', { agent_id: ids.agent, scope: 'channel', resource_id: channelID, access: 'write' });
  }
  agentKey = (await success(`/v1/admin/principals/${ids.agent}/rotate-key`, 'POST', {})).key;
  const first = (await success(`/v1/channels/${ids.channel}/messages`, 'POST', { client_id: `${run}-first`, body: 'Fixture retained in archive; not model work', recipient_ids: [ids.agent] }, agentKey)).message;
  await success(`/v1/channels/${ids.channel}/messages`, 'POST', { client_id: `${run}-reply`, body: 'Fixture reply', recipient_ids: [], reply_to: first.id }, agentKey);
  await success(`/v1/projects/${ids.project}/notes`, 'POST', { client_id: `${run}-note`, title: 'Fixture note', body: 'Retained while archived', source_message_id: first.id }, agentKey);
  await success(`/v1/channels/${ids.controlChannel}/messages`, 'POST', { client_id: `${run}-control-message`, body: 'Unrelated control must remain', recipient_ids: [] }, agentKey);
  const beforeMessages = JSON.stringify(await success(`/v1/channels/${ids.channel}/messages`, 'GET', undefined, agentKey));
  const beforeControl = JSON.stringify(await success(`/v1/channels/${ids.controlChannel}/messages`, 'GET', undefined, agentKey));
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: new URL('?lang=ru', base).href });
  await wait("document.readyState==='complete' && document.getElementById('transport-note')?.textContent.length>0"); await login();
  await check('active project cannot be deleted; archive cancellation is non-mutating', async () => {
    assert(await evaluate(`document.querySelector('[data-project-action="delete"][data-project-id="${ids.project}"]').disabled`), 'active delete enabled');
    const count = requests.length; await action('archive', false);
    assert(!(await project()).archived_at && requests.length === count, 'cancelled archive changed state');
  });
  await check('archive removes active navigation, blocks agent and preserves owner history', async () => {
    await action('archive'); await wait(async () => Boolean((await project())?.archived_at), 'archive persistence'); await idle();
    assert(!(await success('/v1/projects')).projects.some(p => p.id === ids.project), 'archive stayed active');
    assert((await api(`/v1/channels/${ids.channel}/messages`, 'GET', undefined, agentKey)).status === 404, 'archived agent access survives');
    await action('history');
    await wait("!document.getElementById('archived-project-notice').hidden && !document.getElementById('chat-panel').hidden && document.getElementById('message-list').textContent.includes('Fixture reply')");
    assert(await evaluate("document.getElementById('message-list').textContent.includes('Fixture reply') && document.getElementById('composer-form').hidden"), 'archive history unreadable or writable');
    await admin();
  });
  await check('restore returns identical history and previous channel permissions', async () => {
    await action('restore'); await wait(async () => !(await project()).archived_at, 'restore persistence'); await idle();
    assert(beforeMessages === JSON.stringify(await success(`/v1/channels/${ids.channel}/messages`, 'GET', undefined, agentKey)), 'restore changed history');
    assert((await success('/v1/projects', 'GET', undefined, agentKey)).projects.some(p => p.id === ids.project), 'prior project access not restored');
  });
  await check('delete preview shows scope and requires exact typed ID; cancel preserves project', async () => {
    await action('archive'); await wait(async () => Boolean((await project()).archived_at)); await idle(); await deletionDialog();
    const preview = await success(`${projectPath}/deletion-preview`);
    assert(preview.counts.messages === 2 && preview.counts.notes === 1 && preview.counts.channels === 1 && preview.counts.receipts === 1, 'preview counts inaccurate');
    await fill('admin-delete-confirm', `${ids.project}-wrong`);
    assert(await evaluate("document.getElementById('admin-delete-submit').disabled"), 'wrong ID enables deletion');
    await fill('admin-delete-confirm', ids.project);
    await wait("!document.getElementById('admin-delete-submit').disabled");
    const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(`${runtime}/evidence/project-delete-dialog.png`, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.getElementById('admin-delete-submit').scrollIntoView({block:'nearest'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const mobile = await evaluate("(()=>{const d=document.getElementById('admin-delete-dialog').getBoundingClientRect(),b=document.getElementById('admin-delete-submit').getBoundingClientRect();return {width:innerWidth,height:innerHeight,left:d.left,right:d.right,top:d.top,bottom:d.bottom,buttonTop:b.top,buttonBottom:b.bottom,overflow:document.documentElement.scrollWidth>innerWidth};})()");
    assert(!mobile.overflow && mobile.left >= 0 && mobile.right <= mobile.width && mobile.top >= 0 && mobile.bottom <= mobile.height && mobile.buttonTop >= 0 && mobile.buttonBottom <= mobile.height, 'mobile delete dialog or confirmation button inaccessible');
    report.mobile_delete_dialog = mobile;
    const mobileShot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(`${runtime}/evidence/project-delete-dialog-mobile.png`, Buffer.from(mobileShot.data, 'base64'), { mode: 0o600 });
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    const count = requests.filter(r => r.method === 'DELETE').length;
    await closeDialog(); assert(Boolean(await project()), 'cancel deleted project');
    assert(requests.filter(r => r.method === 'DELETE').length === count, 'cancel submitted DELETE');
  });
  await check('stale delete preview is rejected after restore and rearchive without automatic retry', async () => {
    await deletionDialog(); await fill('admin-delete-confirm', ids.project);
    await success(`${projectPath}/restore`, 'POST', {}); await success(`${projectPath}/archive`, 'POST', {});
    const count = requests.filter(r => r.method === 'DELETE').length;
    await evaluate("document.getElementById('admin-delete-submit').click()");
    await wait("document.getElementById('admin-delete-status').textContent.includes('409') || document.getElementById('admin-error').textContent.includes('409')");
    assert(Boolean(await project()), 'stale dialog deleted project');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert(requests.filter(r => r.method === 'DELETE').length === count + 1, 'DELETE automatically retried');
    await closeDialog(); await idle();
  });
  await check('logout clears pending destructive selection and typed ID', async () => {
    await deletionDialog(); await fill('admin-delete-confirm', ids.project);
    await evaluate("document.getElementById('logout-button').click()");
    assert(await evaluate("!document.getElementById('admin-delete-dialog').open && document.getElementById('admin-delete-confirm').value==='' && document.getElementById('admin-delete-target').textContent===''") , 'logout retained destructive target');
    await login();
  });
  await check('fresh confirmation deletes only fixture project; principal, control and audit survive', async () => {
    await deletionDialog(); assert(await evaluate("document.getElementById('admin-delete-confirm').value==='' && document.getElementById('admin-delete-submit').disabled"), 'new dialog inherited confirmation');
    await fill('admin-delete-confirm', ids.project); await evaluate("document.getElementById('admin-delete-submit').click()");
    await wait(async () => !(await project()), 'hard deletion'); await wait("!document.getElementById('admin-delete-dialog').open"); await idle();
    assert((await api(`/v1/messages/${first.id}`)).status === 404, 'deleted message remains accessible');
    assert((await success('/v1/me', 'GET', undefined, agentKey)).agent.id === ids.agent, 'principal or key deleted');
    assert(beforeControl === JSON.stringify(await success(`/v1/channels/${ids.controlChannel}/messages`, 'GET', undefined, agentKey)), 'unrelated history changed');
    const audit = await success('/v1/admin/audit?limit=500');
    assert(audit.entries.some(e => e.action === 'project.delete' && e.target_id === ids.project), 'deletion audit missing');
    assert((await api('/v1/admin/projects', 'POST', { id: ids.project, name: 'must not reuse' })).status === 409, 'retired project ID reused');
    assert((await api('/v1/admin/channels', 'POST', { id: ids.channel, name: 'must not reuse', project_id: ids.control })).status === 409, 'retired channel ID reused');
    assert(report.runtime_errors.length === 0, 'browser runtime errors');
  });
} finally {
  try { await api(`/v1/admin/principals/${ids.agent}/revoke-key`, 'POST', {}); } catch { /* isolated test cleanup only */ }
  try { await evaluate("document.getElementById('logout-button').click()"); } catch { /* browser may be gone */ }
  agentKey = ''; report.finished_at = new Date().toISOString(); report.passed = report.cases.length === 7 && report.cases.every(c => c.passed);
  report.mutations = requests;
  await writeFile(`${runtime}/evidence/project-lifecycle-gui.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); ws.close();
}
if (!report.passed) process.exitCode = 1;
