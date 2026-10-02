import { readFile, writeFile } from 'node:fs/promises';
import {runtimeDir, serviceOrigin} from '../scripts/operator-config.mjs';

const runtime = runtimeDir();
const base = serviceOrigin() + '/';
const evidence = `${runtime}/evidence`;
const tabs = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tab = tabs.find(item => item.type === 'page' && item.url.startsWith(base));
if (!tab) throw new Error('No owned pilot browser tab');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let sequence = 0;
const pending = new Map();
const report = { base_url: base, cases: [], layouts: [], runtimeErrors: [], requestURLs: [], started_at: new Date().toISOString() };
const urls = new Set();
ws.onmessage = event => {
  const value = JSON.parse(event.data);
  if (value.id && pending.has(value.id)) {
    const task = pending.get(value.id); clearTimeout(task.timer); pending.delete(value.id);
    if (value.error) task.reject(new Error(JSON.stringify(value.error))); else task.resolve(value.result);
  }
  if (value.method === 'Runtime.exceptionThrown') report.runtimeErrors.push(value.params.exceptionDetails.text);
  if (value.method === 'Network.requestWillBeSent') urls.add(value.params.request.url);
};
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + (result.exceptionDetails.exception?.description || 'evaluation failed'));
  return result.result.value;
}
async function waitFor(expression, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`UI condition timed out: ${expression}`);
}
function assert(value, message) { if (!value) throw new Error(message); }
async function check(name, action) {
  try { await action(); report.cases.push({ name, passed: true }); }
  catch (error) { report.cases.push({ name, passed: false, error: error.message }); }
  console.log(JSON.stringify(report.cases.at(-1)));
}
async function login(id) {
  const key = process.env.AGENT_LINK_GUI_CREDENTIALS_FILE
    ? JSON.parse(await readFile(process.env.AGENT_LINK_GUI_CREDENTIALS_FILE, 'utf8')).keys[id]
    : (await readFile(`${runtime}/secrets/${id}.key`, 'utf8')).trim();
  // Key travels only through local DevTools into the exact owned HTTPS tab. Never logged.
  await evaluate(`document.getElementById('api-key').value=${JSON.stringify(key)}; document.getElementById('login-form').requestSubmit()`);
  await waitFor(`document.getElementById('login-panel').hidden && document.querySelectorAll('#channel-list button').length > 0 && !document.getElementById('api-error').hidden === false`);
  await waitFor(`!document.getElementById('refresh-button').disabled`);
}
async function screenshot(name, width, height) {
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const layout = await evaluate(`({name:${JSON.stringify(name)},width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth,bodyFont:getComputedStyle(document.querySelector('.message-text')||document.body).fontSize})`);
  report.layouts.push(layout); assert(!layout.overflow, `${name} page overflow`);
  const metrics = await call('Page.getLayoutMetrics');
  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(metrics.cssContentSize.height, 5000), scale: 1 } });
  await writeFile(`${evidence}/gui-live-${name}.png`, Buffer.from(shot.data, 'base64'), { mode: 0o600 });
}
try {
  await call('Runtime.enable'); await call('Network.enable'); await call('Page.enable');
  await call('Page.navigate', { url: new URL('?lang=ru', base).href });
  await waitFor(`document.readyState==='complete' && document.getElementById('transport-note')?.textContent.length>0`);
  await check('locked initial screen exposes no project data or stored key', async () => {
    assert(await evaluate(`!document.getElementById('login-panel').hidden && document.getElementById('connected-workspace').hidden && document.getElementById('api-key').value==='' && localStorage.length===0 && sessionStorage.length===0`), 'initial data or persistence');
  });
  await check('invalid key rejected with visible error', async () => {
    await evaluate(`document.getElementById('api-key').value='0'.repeat(64);document.getElementById('login-form').requestSubmit()`);
    await waitFor(`!document.getElementById('login-error').hidden && !document.getElementById('login-button').disabled`);
    assert(await evaluate(`document.getElementById('connected-workspace').hidden`), 'invalid key unlocked data');
  });
  await login('viewer-pilot');
  await waitFor(`document.querySelectorAll('.message').length>=8`);
  await check('viewer sees persisted messages and separate receipt facts', async () => {
    assert(await evaluate(`document.querySelectorAll('.message').length>=8 && document.querySelectorAll('.receipt-row').length>=8 && document.getElementById('composer-form').hidden && document.getElementById('new-note-button').hidden`), 'missing messages/receipts or viewer writer access');
    assert(await evaluate(`document.getElementById('api-key').value==='' && localStorage.length===0 && sessionStorage.length===0`), 'key persisted after authentication');
  });
  await check('authorized SSE establishes live hint stream', () => waitFor(`document.getElementById('connection-state').textContent.includes('На связи')`));
  await check('message search and empty state are local and reversible', async () => {
    await evaluate(`document.getElementById('search-input').value='no-such-message-qa-2346';document.getElementById('search-input').dispatchEvent(new Event('input',{bubbles:true}))`);
    assert(await evaluate(`document.querySelectorAll('.message').length===0`), 'search not filtering');
    await evaluate(`document.getElementById('search-input').value='';document.getElementById('search-input').dispatchEvent(new Event('input',{bubbles:true}))`);
    assert(await evaluate(`document.querySelectorAll('.message').length>=8`), 'search did not restore messages');
  });
  await check('project notes distinct from channel events', async () => {
    await evaluate(`document.getElementById('nav-notes').click()`);
    await waitFor(`!document.getElementById('notes-panel').hidden`);
    assert(await evaluate(`document.getElementById('notes-destination').textContent.includes('Пилот') && document.getElementById('chat-panel').hidden`), 'project note scope absent');
    await evaluate(`document.querySelector('#channel-list button').click()`);
    await waitFor(`!document.getElementById('chat-panel').hidden && document.querySelectorAll('.message').length>=8`);
    await evaluate(`document.getElementById('tab-activity').click()`);
    assert(await evaluate(`!document.getElementById('activity-panel').hidden && document.getElementById('activity-scope').textContent.includes('общий')`), 'event scope absent');
    await evaluate(`document.getElementById('tab-chat').click()`);
  });
  await check('desktop and mobile real-data layout', async () => { await screenshot('desktop', 1440, 1100); await screenshot('mobile', 390, 1000); });
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await check('logout removes all protected DOM and key', async () => {
    await evaluate(`document.getElementById('logout-button').click()`);
    assert(await evaluate(`document.getElementById('connected-workspace').hidden && document.querySelectorAll('.message').length===0 && document.querySelectorAll('.agent-card').length===0 && document.getElementById('api-key').value===''`), 'protected data retained');
  });
  await login('deny-pilot');
  await check('different principal cannot see prior project or messages', async () => {
    assert(await evaluate(`document.getElementById('project-name').textContent.includes('Изолированный') && !document.getElementById('message-list').textContent.includes('PILOT-CLAUDE')`), 'cross-login data leakage');
  });
  const marker = `UI-QA-${Date.now()}`;
  const hostileText = `${marker} <img src=x onerror="window.guiInjected=true">`;
  await check('writer saves literal text to server without HTML execution', async () => {
    await waitFor(`!document.getElementById('composer-form').hidden && !document.getElementById('send-button').disabled`);
    await evaluate(`document.getElementById('message-input').value=${JSON.stringify(hostileText)};document.getElementById('composer-form').requestSubmit()`);
    await waitFor(`document.getElementById('message-list').textContent.includes(${JSON.stringify(marker)})`);
    assert(await evaluate(`!window.guiInjected && !document.querySelector('#message-list img')`), 'user content executed');
  });
  await check('published note has explicit project destination and persists', async () => {
    await evaluate(`document.getElementById('nav-notes').click()`);
    await waitFor(`!document.getElementById('new-note-button').hidden`);
    await evaluate(`document.getElementById('new-note-button').click()`);
    assert(await evaluate(`document.getElementById('note-dialog').open && document.getElementById('note-publish-target').textContent.includes('Изолированный')`), 'missing publication scope');
    await evaluate(`document.getElementById('note-title').value=${JSON.stringify(marker)};document.getElementById('note-body').value=${JSON.stringify(hostileText)};document.getElementById('note-form').requestSubmit()`);
    await waitFor(`!document.getElementById('note-dialog').open && document.getElementById('memory-list').textContent.includes(${JSON.stringify(marker)})`);
    assert(await evaluate(`!window.guiInjected && !document.querySelector('#memory-list img')`), 'note content executed');
  });
  await check('reload forgets credentials, server records remain after login', async () => {
    await call('Page.reload');
    await waitFor(`document.readyState==='complete' && document.getElementById('transport-note')?.textContent.length>0`);
    assert(await evaluate(`!document.getElementById('login-panel').hidden && document.getElementById('api-key').value===''`), 'reload retained auth');
    await login('deny-pilot');
    await waitFor(`document.getElementById('message-list').textContent.includes(${JSON.stringify(marker)})`);
  });
  await evaluate(`document.getElementById('logout-button').click()`);
} catch (error) { report.cases.push({ name: 'suite execution', passed: false, error: error.message }); }
finally {
  report.requestURLs = [...urls];
  report.cases.push({ name: 'no runtime exceptions', passed: report.runtimeErrors.length === 0 });
  report.cases.push({ name: 'no external requests or query credentials', passed: [...urls].every(url => url.startsWith(base) && !/[?&](key|token|authorization)=/i.test(url)) });
  report.passed = report.cases.every(item => item.passed);
  report.finished_at = new Date().toISOString();
  await writeFile(`${evidence}/gui-live-report.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  ws.close();
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, errors: report.runtimeErrors }));
  if (!report.passed) process.exitCode = 1;
}
