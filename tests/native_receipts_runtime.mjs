// Exercise the production receipt loader, chat renderer, localization, REST
// replay and SSE invalidation together. No network, credentials or provider.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(process.argv[2] || new URL('../web/app.js', import.meta.url), 'utf8');
const boundary = source.indexOf('  // Keys, data, cursors');
assert.ok(boundary > 0);
const names = ['clearNativeReceipts', 'nativeReceiptTime', 'validateNativeReceipts', 'loadNativeReceipts',
  'nativeReceiptFor', 'messageReceiptSummary', 'renderNativeReceipt', 'renderMessages', 'channelSnapshot', 'onSseBlock',
  'clearChannelContent', 'forgetProjectContent', 'reconcileWorkspace'];
const functions = names.map(name => {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'));
  assert.ok(match, `${name} is an actual production function`);
  return match[0];
}).join('\n');

class FakeNode {
  parentNode = null;
  attached = false;
  get isConnected() { return this.attached || Boolean(this.parentNode?.isConnected); }
}
class FakeText extends FakeNode {
  constructor(value) { super(); this.data = String(value); }
  get textContent() { return this.data; }
}
class FakeElement extends FakeNode {
  childNodes = []; dataset = {}; attributes = new Map(); value = ''; className = '';
  scrollHeight = 200; clientHeight = 200; scrollTop = 0;
  get children() { return this.childNodes.filter(item => item instanceof FakeElement); }
  get textContent() { return this.childNodes.map(item => item.textContent).join(''); }
  append(...items) {
    for (let item of items) {
      if (!(item instanceof FakeNode)) item = new FakeText(item);
      item.parentNode = this; this.childNodes.push(item);
    }
  }
  replaceChildren(...items) {
    this.childNodes.forEach(item => { item.parentNode = null; });
    this.childNodes = []; this.append(...items);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  reset() { this.value = ''; }
  querySelectorAll(selector) {
    assert.equal(selector, '.message-details[open]');
    return descendants(this).filter(item => item.className === 'message-details' && item.open);
  }
}
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
const time = '2026-10-03T00:00:00.123456789Z';
const message = (id = 'm1', extra = {}) => ({id, channel_id: 'alpha', seq: 1, author_id: 'sender',
  recipient_ids: ['receiver'], receipts: null, created_at: time, body: 'Fixture message', ...extra});
const row = (stage = 'seen', extra = {}) => ({message_id: 'm1', agent_id: 'receiver', offered_at: null,
  seen_at: null, accepted_at: null, [`${stage}_at`]: time, provenance: 'client_reported', server_verified: false, ...extra});
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(messages = [message()]) {
  const state = {key: 'fixture-only', authVersion: 1, context: 1, channel: {id: 'alpha'}, view: 'chat',
    project: {id: 'project'}, projects: [{id: 'project'}], channels: [{id: 'alpha', project_id: 'project'}],
    channelUpdates: new Set(), channelSeen: new Map(),
    messages: new Map(messages.map(item => [item.id, item])), events: new Map(), cursors: new Map(), messageSeq: 0,
    nativeReceipts: new Map(), nativeReceiptIDs: new Set(), nativeReceiptsChannel: '', nativeReceiptsStatus: 'pending', nativeReceiptsSeq: 0};
  const nodes = new Map(), requests = [], ui = {reads: 0, refreshes: 0};
  const $ = id => {
    if (!nodes.has(id)) { const element = new FakeElement(); element.attached = true; nodes.set(id, element); }
    return nodes.get(id);
  };
  let context;
  const node = (_tag, className = '', text) => {
    const element = new FakeElement(); element.className = className;
    if (text !== undefined) element.append(context.h.ownedText(text));
    return element;
  };
  context = vm.createContext({state, $, Node: FakeNode, URLSearchParams, queueMicrotask,
    document: {documentElement: {lang: 'en'}, createTextNode: value => new FakeText(value),
      getElementById: $, querySelectorAll: () => []},
    location: {search: '?lang=en', pathname: '/workspace'}, history: {replaceState() {}},
    list: value => Array.isArray(value) ? value : [], number: value => Number(value) || 0,
    current: scope => Boolean(state.key) && scope === state.context,
    currentAuth: version => Boolean(state.key) && version === state.authVersion,
    pathId: encodeURIComponent, node, displayName: id => id, dateText: value => value,
    replaceContent: (id, ...items) => $(id).replaceChildren(...items),
    canMessage: () => false, avatar: () => node('div'), scheduleChannelRead: () => { ui.reads += 1; },
    MESSAGES_PAGE: 100, EVENTS_PAGE: 25, renderEvents() {}, nativeActivitySnapshot: async () => false,
    clearNativeActivity() {}, renderRecipients() {}, validateFields() {}, clearOverview() {}, clearProjectNative() {},
    clearProjectMap() {}, clearDrafts() {}, clearCoordination() {}, renderNotes() {}, renderAgents() {}, updatePermissions() {},
    renderNavigation() {}, loadNavigation: async () => {}, isOwner: () => false, setView() {}, syncProjectNativeScope() {},
    syncProjectMapScope() {}, isCoordination: () => false, channelMessageSeq: channel => channel.latest_message_seq || 0,
    api: (path, options) => new Promise((resolve, reject) => requests.push({path, options, resolve, reject})),
    scheduleRefresh: () => { ui.refreshes += 1; ui.pending = context.h.channelSnapshot(state.context); },
  });
  vm.runInContext(source.slice(0, boundary) + functions + `\n globalThis.h = {${names.join(',')}, ownedText, applyLanguage}; })();`, context);
  const h = context.h;
  return {state, requests, ui, $, h, load: () => h.loadNativeReceipts(state.context, state.channel.id),
    render: () => { h.renderMessages(); return $('message-list'); },
    elements: className => descendants($('message-list')).filter(item => item.className === className),
    summary: () => descendants($('message-list')).find(item => item.className === 'receipt-summary')};
}

async function load(f, receipts) {
  const pending = f.load(); f.requests.at(-1).resolve({receipts}); await pending; f.render();
}

test('seen with null legacy receipts updates primary summary and translates in place', async () => {
  const f = fixture(); await load(f, [row()]);
  const summary = f.summary();
  assert.match(summary.textContent, /viewed · connector report/);
  assert.doesNotMatch(summary.textContent, /unconfirmed/);
  const stages = descendants(f.$('message-list')).filter(item => item.dataset.nativeStage);
  assert.deepEqual(stages.map(item => [item.dataset.nativeStage, item.dataset.confirmed]), [['offered', 'false'], ['seen', 'true'], ['accepted', 'false']]);
  assert.equal(f.state.messages.get('m1').receipts, null, 'native evidence never overwrites legacy fields');
  assert.match(f.$('message-list').textContent, /first server record/);
  f.h.applyLanguage('ru', false);
  assert.match(summary.textContent, /просмотрено · по отчёту коннектора/);
  assert.match(f.$('message-list').textContent, /первую запись каждого отчёта сервером/);
  f.h.applyLanguage('en', false);
  assert.match(summary.textContent, /viewed · connector report/);
});

test('acceptance is not completion and does not synthesize offered or seen', async () => {
  const f = fixture(); await load(f, [row('accepted')]);
  assert.match(f.summary().textContent, /accepted, not necessarily completed · connector report/);
  const confirmed = descendants(f.$('message-list')).filter(item => item.dataset.nativeStage && item.dataset.confirmed === 'true');
  assert.deepEqual(confirmed.map(item => item.dataset.nativeStage), ['accepted']);
  assert.match(f.$('message-list').textContent, /none proves completion/);
});

test('offered does not imply viewed; legacy uncertainty remains visible', async () => {
  const legacy = [{agent_id: 'receiver', uncertain_at: time, session_id: 'legacy-session'}];
  const f = fixture([message('m1', {receipts: legacy})]); await load(f, [row('offered')]);
  assert.match(f.summary().textContent, /offered to the CLI · connector report.*Legacy: ⚠ uncertain/);
  assert.doesNotMatch(f.summary().textContent, /viewed|completed/);
  assert.equal(f.summary().dataset.uncertain, 'true');
  assert.match(f.$('message-list').textContent, /Operator review is required/);
  assert.match(f.$('message-list').textContent, /legacy-session/);
  assert.equal(f.state.messages.get('m1').receipts, legacy);
});

test('no reports is distinct from pending and failed snapshots', async () => {
  const f = fixture(); f.render();
  assert.equal(f.elements('native-receipt')[0].dataset.nativeReceipt, 'pending');
  await load(f, []);
  assert.match(f.summary().textContent, /stored, delivery unconfirmed/);
  assert.equal(f.elements('native-receipt')[0].dataset.nativeReceipt, 'none');
  const pending = f.load(); f.requests.at(-1).reject(new Error('Fixture transport failure')); await pending; f.render();
  assert.equal(f.elements('native-receipt')[0].dataset.nativeReceipt, 'unavailable');
  assert.match(f.$('message-list').textContent, /unavailable; native status is unknown/);
  assert.doesNotMatch(f.$('message-list').textContent, /No connector report/);
  assert.match(f.summary().textContent, /connector status unavailable/);
  assert.doesNotMatch(f.summary().textContent, /delivery unconfirmed/);
  f.h.applyLanguage('ru', false);
  assert.match(f.summary().textContent, /статус коннектора недоступен/);
});

test('unavailable connector status keeps legacy uncertainty visible in primary summary', async () => {
  const f = fixture([message('m1', {receipts: [{agent_id: 'receiver', uncertain_at: time}]})]);
  const pending = f.load(); f.requests[0].reject(new Error('Fixture transport failure')); await pending; f.render();
  assert.match(f.summary().textContent, /⚠ uncertain.*connector status unavailable/);
  assert.equal(f.summary().dataset.uncertain, 'true');
});

for (const [name, receipt] of [
  ['unknown recipient', row('seen', {agent_id: 'stranger'})],
  ['unknown message', row('seen', {message_id: 'foreign'})],
  ['wrong provenance', row('seen', {provenance: 'server_verified'})],
  ['false server verification claim', row('seen', {server_verified: true})],
  ['invalid date', row('seen', {seen_at: '2026-02-31T00:00:00Z'})],
  ['missing null stage', {...row(), offered_at: undefined}],
  ['all null stages', row('seen', {seen_at: null})],
]) {
  test(`${name} rejects the entire batch without partial trusted display`, async () => {
    const f = fixture([message(), message('m2')]); await load(f, [row('seen', {message_id: 'm2'}), receipt]);
    assert.equal(f.state.nativeReceipts.size, 0);
    assert.equal(f.state.nativeReceiptsStatus, 'unavailable');
    assert.doesNotMatch(f.summary().textContent, /viewed/);
  });
}

test('duplicate pairs and cross-channel loaded messages are rejected', async () => {
  const f = fixture([message(), message('foreign', {channel_id: 'beta'})]);
  await load(f, [row(), row()]);
  assert.equal(f.state.nativeReceiptsStatus, 'unavailable');
  const pending = f.load();
  assert.deepEqual(new URL(f.requests.at(-1).path, 'https://fixture.invalid').searchParams.getAll('message_id'), ['m1']);
  f.requests.at(-1).resolve({receipts: [row('seen', {message_id: 'foreign'})]}); await pending;
  assert.equal(f.state.nativeReceipts.size, 0);
});

for (const change of ['auth', 'context', 'channel', 'logout']) {
  test(`${change} fences a late valid response`, async () => {
    const f = fixture(), pending = f.load();
    if (change === 'auth') f.state.authVersion += 1;
    if (change === 'context') f.state.context += 1;
    if (change === 'channel') f.state.channel = {id: 'beta'};
    if (change === 'logout') f.state.key = '';
    f.requests[0].resolve({receipts: [row()]}); await pending;
    assert.equal(f.state.nativeReceipts.size, 0);
  });
}

test('newer request wins over both late valid data and errors', async () => {
  for (const failure of [false, true]) {
    const f = fixture(), old = f.load(), fresh = f.load();
    f.requests[1].resolve({receipts: [row('accepted')]}); await fresh;
    if (failure) f.requests[0].reject(Object.assign(new Error('Late denied'), {status: 403}));
    else f.requests[0].resolve({receipts: [row('offered')]});
    await old; f.render();
    assert.match(f.summary().textContent, /accepted, not necessarily completed/);
    assert.equal(f.state.nativeReceiptsStatus, 'ready');
  }
});

test('denied aggregate retains the existing ACL-clearing error path', async () => {
  for (const status of [401, 403, 404]) {
    const f = fixture(), pending = f.load();
    f.requests[0].reject(Object.assign(new Error('Access denied'), {status}));
    await assert.rejects(pending, error => error.status === status);
    assert.equal(f.state.nativeReceipts.size, 0);
  }
});

test('201 loaded messages use bounded batches and publish only a complete snapshot', async () => {
  const f = fixture(Array.from({length: 201}, (_, index) => message(`m${index}`, {seq: index + 1})));
  const pending = f.load();
  for (const [index, count] of [100, 100, 1].entries()) {
    const request = f.requests[index], ids = new URL(request.path, 'https://fixture.invalid').searchParams.getAll('message_id');
    assert.equal(ids.length, count);
    assert.equal(f.state.nativeReceipts.size, 0, 'earlier batches are not exposed while a later batch is pending');
    request.resolve({receipts: ids.map(id => row('seen', {message_id: id}))}); await tick();
  }
  await pending;
  assert.equal(f.state.nativeReceipts.size, 201); assert.equal(f.state.nativeReceiptIDs.size, 201);
});

test('a response cannot smuggle an ID from another batch of loaded messages', async () => {
  const f = fixture(Array.from({length: 101}, (_, index) => message(`m${index}`)));
  const pending = f.load(); f.requests[0].resolve({receipts: [row('seen', {message_id: 'm100'})]}); await pending;
  assert.equal(f.state.nativeReceiptsStatus, 'unavailable'); assert.equal(f.requests.length, 1);
});

test('scope removal during a request and context reset prevent stale display', async () => {
  const f = fixture(), pending = f.load();
  f.state.messages.set('m1', message('m1', {recipient_ids: []}));
  f.requests[0].resolve({receipts: [row()]}); await pending;
  assert.equal(f.state.nativeReceipts.size, 0);
  f.state.messages.set('m1', message()); await load(f, [row()]);
  const old = f.load(); f.h.clearNativeReceipts(); f.requests.at(-1).resolve({receipts: [row()]}); await old;
  assert.equal(f.state.nativeReceipts.size, 0); assert.equal(f.state.nativeReceiptsStatus, 'pending');
});

for (const scope of ['channel', 'project']) {
  test(`real workspace reconciliation clears ${scope} receipts and invalidates pending aggregate`, async () => {
    const f = fixture(); await load(f, [row()]);
    assert.equal(f.state.nativeReceipts.size, 1);
    const pending = f.load(), old = f.requests.at(-1), generation = f.state.nativeReceiptsSeq;
    const reconcile = f.h.reconcileWorkspace(f.state.context);
    assert.equal(f.requests.at(-1).path, '/v1/projects');
    f.requests.at(-1).resolve({projects: scope === 'project' ? [] : [{id: 'project'}]}); await tick();
    if (scope === 'channel') {
      assert.equal(f.requests.at(-1).path, '/v1/projects/project/channels');
      f.requests.at(-1).resolve({channels: [{id: 'beta', project_id: 'project'}]});
    }
    await reconcile;
    assert.equal(f.state.nativeReceipts.size, 0);
    assert.equal(f.state.nativeReceiptIDs.size, 0);
    assert.equal(f.state.nativeReceiptsChannel, '');
    assert.ok(f.state.nativeReceiptsSeq > generation, 'scope loss must invalidate already pending generations');
    assert.doesNotMatch(f.$('message-list').textContent, /viewed · connector report/);
    // Re-entering the same ID cannot make an old, pre-revocation response valid.
    f.state.channel = {id: 'alpha'}; f.state.messages.set('m1', message());
    old.resolve({receipts: [row()]}); await pending;
    assert.equal(f.state.nativeReceipts.size, 0);
    assert.equal(f.state.nativeReceiptsStatus, 'pending');
  });
}

test('REST replay then an SSE native-activity invalidation updates the chat without a new message', async () => {
  const f = fixture([]);
  let pending = f.h.channelSnapshot(f.state.context);
  f.requests[0].resolve({messages: [message()]}); f.requests[1].resolve({events: []}); await tick();
  assert.match(f.requests[2].path, /native-receipts\?message_id=m1$/);
  f.requests[2].resolve({receipts: []}); await pending;
  assert.match(f.summary().textContent, /delivery unconfirmed/);
  // SSE carries only an invalidation pointer. All receipt evidence must come
  // from authorized REST, even when the CLI feed has hidden technical events.
  f.h.onSseBlock(`event: workspace\ndata: {"revision":"${'a'.repeat(64)}"}\n`, f.state.authVersion);
  assert.equal(f.ui.refreshes, 1); pending = f.ui.pending;
  assert.match(f.requests[3].path, /messages\?after_seq=1/);
  f.requests[3].resolve({messages: []});
  f.requests[4].resolve({events: [{seq: 2, channel_id: 'alpha', kind: 'native.activity', entity_id: 'native-event'}]}); await tick();
  assert.equal(f.requests[5].path, f.requests[2].path);
  f.requests[5].resolve({receipts: [row()]}); await pending;
  assert.match(f.summary().textContent, /viewed · connector report/);
  assert.equal(f.state.messageSeq, 1); assert.equal(f.state.cursors.get('alpha'), 2);
  f.h.onSseBlock(`event: workspace\ndata: {"revision":"${'a'.repeat(64)}"}\n`, f.state.authVersion);
  assert.equal(f.ui.refreshes, 1, 'same invalidation revision is deduplicated');
});
