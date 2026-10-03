// Actual production alert functions, deferred HTTP boundaries and a minimal DOM.
// No credentials, network, timers advancing real time or model execution.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = readFileSync(process.argv[2] || new URL('../web/app.js', import.meta.url), 'utf8');
const boundary = source.indexOf('  // Keys, data, cursors');
const names = ['nativeReceiptTime', 'deliveryOwner', 'invalidateDeliveryAlerts', 'validateDeliveryPolicy', 'validateDeliveryAlertPage',
  'setDeliveryPolicy', 'loadDeliveryAlerts', 'scheduleDeliveryPoll', 'captureDeliveryDraft', 'deliveryPolicyPayload',
  'deliveryConnectivityChanged', 'reloadDeliveryPolicy', 'saveDeliveryPolicy', 'renderDeliveryAlerts', 'openDeliveryMessage'];
const functions = names.map(name => {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'));
  assert.ok(match, `Production function ${name}`); return match[0];
}).join('\n');
class Node { parentNode = null; get isConnected() { return true; } }
class Text extends Node { constructor(value) { super(); this.data = String(value); } get textContent() { return this.data; } }
class Element extends Node {
  childNodes = []; dataset = {}; value = ''; checked = false; disabled = false; className = '';
  get children() { return this.childNodes.filter(item => item instanceof Element); }
  get textContent() { return this.childNodes.map(item => item.textContent).join(''); }
  append(...values) { for (let value of values) { if (!(value instanceof Node)) value = new Text(value); value.parentNode = this; this.childNodes.push(value); } }
  replaceChildren(...values) { this.childNodes.forEach(item => { item.parentNode = null; }); this.childNodes = []; this.append(...values); }
  contains(value) { return this === value || this.children.some(item => item.contains(value)); }
  reset() {} setAttribute() {} addEventListener() {} querySelectorAll() { return []; }
}
const time = '2026-10-03T10:00:00.123456789Z';
const policy = (extra = {}) => ({enabled: true, ack_timeout_seconds: 300, reply_timeout_seconds: 1800, enabled_at: time, updated_at: time, version: 1, ...extra});
const row = (id = 'm1', extra = {}) => ({message_id: id, message_seq: 40, project_id: 'p1', channel_id: 'c1', author_id: 'sender', recipient_id: 'receiver', created_at: time, due_at: time,
  reason: 'unacknowledged', offered_at: null, seen_at: null, accepted_at: null, delivered_at: null, legacy_accepted_at: null, answered_at: null, ...extra});
const page = (rows = [row()], extra = {}) => ({policy: policy(), alerts: rows, total: rows.length, truncated: false, next_cursor: null, generated_at: time, as_of: time, ...extra});
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(role = 'owner') {
  const state = {key: 'fixture', authVersion: 1, context: 1, role, view: 'admin', adminSection: 'delivery-alerts',
    deliveryAlerts: null, deliveryDraft: null, deliveryDirty: false, deliveryConflict: false, deliverySeq: 0, deliveryWriteSeq: 0,
    deliveryLoading: false, deliverySaving: false, deliveryPolicyLoading: false, deliveryDraftSeq: 0, deliveryDenied: false,
    deliveryTimer: null, deliveryLastAttempt: 0, deliveryNotice: '', deliveryError: '', deliveryPolicyError: '', deliveryLinkSeq: 0,
    messages: new Map(), messageSeq: 4};
  const nodes = new Map(), requests = [], timers = new Map(); let serial = 0, context;
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const navigator = {onLine: true};
  const document = {hidden: false, activeElement: null, documentElement: {lang: 'en'}, createTextNode: value => new Text(value), getElementById: $, querySelectorAll: () => []};
  const node = (_tag, className = '', value) => { const el = new Element(); el.className = className; if (value !== undefined) el.append(context.h.ownedText(value)); return el; };
  context = vm.createContext({state, $, document, navigator, Node, URLSearchParams, queueMicrotask, location: {search: '?lang=en', pathname: '/'}, history: {replaceState() {}},
    node, list: value => Array.isArray(value) ? value : [], dateText: value => value, pathId: encodeURIComponent,
    isOwner: () => state.role === 'owner', currentAuth: auth => Boolean(state.key) && state.authVersion === auth,
    current: scope => Boolean(state.key) && scope === state.context, replaceContent: (id, ...items) => $(id).replaceChildren(...items),
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, {fn, delay}); return id; }, clearTimeout: id => timers.delete(id),
    api: (path, options) => new Promise((resolve, reject) => requests.push({path, options, resolve, reject})),
    selectProject: async project => { state.project = project; state.channels = [{id: 'c1', project_id: 'p1'}]; state.context++; context.h.invalidateDeliveryAlerts(); },
    selectChannel: async channel => { state.channel = channel; state.context++; context.h.invalidateDeliveryAlerts(); }, renderMessages() {}});
  vm.runInContext(source.slice(0, boundary) + functions + `\n globalThis.h={${names.join(',')},ownedText,applyLanguage}; })();`, context);
  return {state, $, document, navigator, requests, timers, h: context.h};
}
async function load(f, payload = page(), options) { const pending = f.h.loadDeliveryAlerts(options); f.requests.at(-1).resolve(payload); await pending; }
function draft(f, ack = '1') { f.$('delivery-policy-enabled').checked = true; f.$('delivery-policy-ack').value = ack; f.h.captureDeliveryDraft(); }

for (const role of ['agent', 'viewer']) test(`${role} has no alerts, settings requests or polling`, async () => {
  const f = fixture(role); f.h.renderDeliveryAlerts(); f.h.scheduleDeliveryPoll(0);
  await f.h.loadDeliveryAlerts(); await f.h.saveDeliveryPolicy(); await f.h.reloadDeliveryPolicy();
  assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.$('delivery-alert-banner').hidden, true);
});
test('initial disabled state is explicit and cannot auto-enable through GET or poll', async () => {
  const f = fixture(); await load(f, page([], {policy: policy({enabled: false, version: 0, enabled_at: null})}));
  assert.equal(f.$('delivery-alert-banner').dataset.state, 'off'); assert.equal(f.$('delivery-policy-enabled').checked, false);
  assert.equal(f.requests.length, 1); assert.ok(f.requests.every(item => !item.options));
  f.h.applyLanguage('ru', false); assert.match(f.$('delivery-alert-banner').textContent + f.$('delivery-alert-banner-title').textContent, /выключена/);
});
for (const change of ['logout', 'account', 'context', 'role']) test(`late response after ${change} cannot repopulate the UI`, async () => {
  const f = fixture(), pending = f.h.loadDeliveryAlerts();
  if (change === 'logout') { f.state.key = ''; f.h.invalidateDeliveryAlerts(true); }
  if (change === 'account') f.state.authVersion++;
  if (change === 'context') f.state.context++;
  if (change === 'role') f.state.role = 'viewer';
  f.requests[0].resolve(page()); await pending; assert.equal(f.state.deliveryAlerts, null);
});
test('newer first page wins over both older data and a late authorization error', async () => {
  for (const error of [false, true]) {
    const f = fixture(), old = f.h.loadDeliveryAlerts(), fresh = f.h.loadDeliveryAlerts();
    f.requests[1].resolve(page([row('new')])); await fresh;
    if (error) f.requests[0].reject(Object.assign(new Error('late'), {status: 403})); else f.requests[0].resolve(page([row('old')]));
    await old; assert.equal(f.state.deliveryAlerts.rows[0].message_id, 'new'); assert.equal(f.state.deliveryDenied, false);
  }
});
test('pending page is fenced by an explicit first-page refresh', async () => {
  const f = fixture(); await load(f, page([row()], {total: 3, truncated: true, next_cursor: 'opaque'}));
  const more = f.h.loadDeliveryAlerts({more: true}), request = f.requests.at(-1);
  await load(f, page([row('fresh')])); request.resolve(page([row('old-page')])); await more;
  assert.deepEqual(Array.from(f.state.deliveryAlerts.rows, item => item.message_id), ['fresh']);
});
test('expanded list and focused nodes survive periodic summary refresh and policy change', async () => {
  const f = fixture(); await load(f, page([row()], {total: 3, truncated: true, next_cursor: 'opaque'}));
  await load(f, page([row('m2')], {total: 3, truncated: true, next_cursor: 'next'}), {more: true});
  const rows = f.state.deliveryAlerts.rows, node = f.$('delivery-alert-list').children[0]; f.document.activeElement = node;
  draft(f, '7'); await load(f, page([row('new')], {total: 8, policy: policy({version: 2})}), {preserveList: true});
  assert.equal(f.state.deliveryAlerts.rows, rows); assert.equal(f.$('delivery-alert-list').children[0], node);
  assert.equal(f.state.deliveryAlerts.total, 8); assert.equal(f.state.deliveryAlerts.updates, true);
  assert.equal(f.$('delivery-alert-more').disabled, true); assert.equal(f.state.deliveryDraft.ack, '7'); assert.equal(f.state.deliveryConflict, true);
  assert.match(f.$('delivery-alert-status').textContent, /previous check/);
  await load(f, page([row('new')])); assert.notEqual(f.state.deliveryAlerts.rows, rows);
});
test('cursor window mismatch rejects the entire page without merging', async () => {
  const f = fixture(); await load(f, page([row()], {total: 2, truncated: true, next_cursor: 'opaque'}));
  await load(f, page([row('m2')], {as_of: '2026-10-03T11:00:00Z'}), {more: true});
  assert.equal(f.state.deliveryAlerts.rows.length, 1); assert.equal(f.state.deliveryAlerts.status, 'unavailable');
});
test('save carries expected version; stale read cannot overwrite the successful policy', async () => {
  const f = fixture(); await load(f); draft(f, '1');
  const old = f.h.loadDeliveryAlerts(), oldRequest = f.requests.at(-1);
  const write = f.h.saveDeliveryPolicy(), req = f.requests.at(-1);
  assert.equal(req.options.method, 'PUT'); assert.equal(req.options.body.expected_version, 1); assert.equal(req.options.body.ack_timeout_seconds, 60);
  req.resolve({policy: policy({version: 2, ack_timeout_seconds: 60})}); await write;
  oldRequest.resolve(page()); await old;
  assert.equal(f.state.deliveryDraft.version, 2); assert.equal(f.state.deliveryDraft.ack, '1'); assert.equal(f.state.deliveryAlerts, null);
});
test('CAS conflict preserves draft, blocks retry and requires explicit server reload', async () => {
  const f = fixture(); await load(f); draft(f, '9');
  const write = f.h.saveDeliveryPolicy(); f.requests.at(-1).reject(Object.assign(new Error('changed'), {status: 409})); await write;
  assert.equal(f.state.deliveryDraft.ack, '9'); assert.equal(f.$('delivery-policy-save').disabled, true);
  await load(f, page([], {policy: policy({version: 2})})); assert.equal(f.state.deliveryDraft.ack, '9');
  const count = f.requests.length; await f.h.saveDeliveryPolicy(); assert.equal(f.requests.length, count);
  const reload = f.h.reloadDeliveryPolicy(); f.requests.at(-1).resolve({policy: policy({version: 2})}); await reload;
  assert.equal(f.state.deliveryDraft.ack, '5'); assert.equal(f.state.deliveryConflict, false); assert.equal(f.state.deliveryDraft.version, 2);
});
test('navigation during write keeps uncertain draft and ignores delayed write success', async () => {
  const f = fixture(); await load(f); draft(f, '3');
  const write = f.h.saveDeliveryPolicy(); f.state.context++; f.h.invalidateDeliveryAlerts();
  f.requests.at(-1).resolve({policy: policy({version: 2, ack_timeout_seconds: 180})}); await write;
  assert.equal(f.state.deliveryConflict, true); assert.equal(f.state.deliveryDraft.ack, '3'); assert.match(f.$('delivery-policy-error').textContent, /not confirmed/);
});
test('minute boundaries enforce whole seconds and explicit reply-off sends zero', () => {
  const f = fixture(), base = {enabled: true, ack: '1', replyEnabled: false, reply: '', version: 2};
  assert.equal(f.h.deliveryPolicyPayload(base).reply_timeout_seconds, 0);
  for (const ack of ['', '0', '1441', 'NaN', '1.001']) assert.equal(f.h.deliveryPolicyPayload({...base, ack}), null);
  assert.equal(f.h.deliveryPolicyPayload({...base, ack: '1.5'}).ack_timeout_seconds, 90);
  assert.equal(f.h.deliveryPolicyPayload({...base, replyEnabled: true, reply: '0.5'}), null);
});
for (const malformed of [page([row('m1', {reason: 'completed'})]), page([row('m1', {offered_at: undefined})]), page([row(), row()]), page([], {total: -1}), page([], {as_of: 'invalid'})]) {
  test('malformed server result cannot create a clear/green state', async () => {
    const f = fixture(); await load(f, malformed); assert.equal(f.state.deliveryAlerts, null); assert.equal(f.$('delivery-alert-banner').dataset.state, 'unavailable');
  });
}
test('network failure exposes unknown state and retains old rows as stale', async () => {
  const f = fixture(); await load(f); const old = f.state.deliveryAlerts.rows;
  const pending = f.h.loadDeliveryAlerts(); f.requests.at(-1).reject(new Error('offline')); await pending;
  assert.equal(f.$('delivery-alert-banner').dataset.state, 'unavailable'); assert.equal(f.state.deliveryAlerts.rows, old); assert.match(f.$('delivery-alert-status').textContent, /not current/);
});
test('25s polling runs without SSE, pauses hidden and is cleared on logout or denied access', async () => {
  const f = fixture(); f.h.scheduleDeliveryPoll(); const timer = [...f.timers.values()][0]; assert.equal(timer.delay, 25000);
  f.timers.delete(f.state.deliveryTimer); const pending = timer.fn(); f.requests[0].resolve(page()); await pending; assert.equal(f.state.deliveryAlerts.total, 1);
  f.document.hidden = true; f.h.scheduleDeliveryPoll(); assert.equal(f.timers.size, 0);
  f.document.hidden = false; f.h.scheduleDeliveryPoll(0); assert.equal([...f.timers.values()][0].delay, 0);
  const denied = f.h.loadDeliveryAlerts(); f.requests.at(-1).reject(Object.assign(new Error('denied'), {status: 403})); await denied;
  assert.equal(f.timers.size, 0); assert.equal(f.state.deliveryAlerts, null); f.h.scheduleDeliveryPoll(); assert.equal(f.timers.size, 0);
  f.state.key = ''; f.h.invalidateDeliveryAlerts(true); assert.equal(f.timers.size, 0); assert.equal(f.$('delivery-alert-list').textContent, '');
});
test('message jump checks current identity and never skips the REST replay cursor', async () => {
  const f = fixture(), target = row(), pending = f.h.openDeliveryMessage(target);
  f.requests[0].resolve({message: {id: target.message_id, channel_id: target.channel_id, seq: 40, author_id: target.author_id, recipient_ids: [target.recipient_id]}}); await tick();
  f.requests[1].resolve({projects: [{id: target.project_id}]}); await pending;
  assert.equal(f.state.messageSeq, 4); assert.equal(f.state.messages.get('m1').seq, 40); assert.equal(f.state.highlightMessage, 'm1');
  const bad = f.h.openDeliveryMessage(target); f.requests.at(-1).resolve({message: {id: 'other'}}); await bad;
  assert.match(f.$('delivery-alert-error').textContent, /identity changed/);
});

test('background polling cannot cancel an in-flight Show more request', async () => {
  const f = fixture(); await load(f, page([row()], {total: 3, truncated: true, next_cursor: 'cursor1'}));
  const pending = f.h.loadDeliveryAlerts({more: true}), request = f.requests.at(-1), count = f.requests.length;
  await f.h.loadDeliveryAlerts({preserveList: true}); assert.equal(f.requests.length, count);
  request.resolve(page([row('m2')], {total: 3, truncated: true, next_cursor: 'cursor2'})); await pending;
  assert.equal(f.state.deliveryAlerts.rows.length, 2);
  await load(f, page([row('new')], {total: 4}), {preserveList: true});
  assert.equal(f.$('delivery-alert-more').disabled, false, 'same-policy frozen cursor remains usable after summary polling');
  await load(f, page([row('m3')], {total: 3}), {more: true});
  assert.deepEqual(Array.from(f.state.deliveryAlerts.rows, item => item.message_id), ['m1', 'm2', 'm3']);
});

test('offline immediately invalidates a clear result and reconnect schedules a fresh check', async () => {
  const f = fixture(); await load(f, page([])); assert.equal(f.$('delivery-alert-banner').dataset.state, 'clear');
  f.h.scheduleDeliveryPoll(); const timer = f.timers.get(f.state.deliveryTimer); f.timers.delete(f.state.deliveryTimer);
  const pending = timer.fn(), request = f.requests.at(-1);
  f.navigator.onLine = false; f.h.deliveryConnectivityChanged();
  assert.equal(f.$('delivery-alert-banner').dataset.state, 'unavailable'); assert.equal(f.timers.size, 0);
  const count = f.requests.length; await f.h.loadDeliveryAlerts(); assert.equal(f.requests.length, count);
  f.navigator.onLine = true; f.h.deliveryConnectivityChanged();
  request.resolve(page([])); await pending; assert.equal(f.$('delivery-alert-banner').dataset.state, 'unavailable');
  assert.equal([...f.timers.values()][0].delay, 0, 'old callback must not delay the immediate reconnect check');
});
