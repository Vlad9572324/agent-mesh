// Actual composer functions with a small DOM fixture. No server, DB or provider.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const boundary = source.indexOf('  // Keys, data, cursors');
assert.ok(boundary > 0);
const names = ['availableRecipients', 'recipientScope', 'selectedRecipients', 'syncComposerAddressing',
  'selectReply', 'renderRecipients', 'updatePermissions', 'clearDrafts', 'selectChannel', 'clientId', 'pendingPayload', 'sendMessage'];
const functions = names.map(name => {
  const start = source.indexOf(`  function ${name}(`) >= 0 ? source.indexOf(`  function ${name}(`) : source.indexOf(`  async function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}).join('\n');

class FakeNode {
  parentNode = null; attached = false;
  get isConnected() { return this.attached || Boolean(this.parentNode?.isConnected); }
}
class FakeText extends FakeNode {
  constructor(data) { super(); this.data = String(data); }
  get textContent() { return this.data; }
}
class FakeElement extends FakeNode {
  constructor(tag = 'div') { super(); this.tag = tag; }
  childNodes = []; dataset = {}; value = ''; checked = false; disabled = false; hidden = false; valid = true; open = false;
  get children() { return this.childNodes.filter(child => child instanceof FakeElement); }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  append(...items) {
    for (let item of items) {
      if (!(item instanceof FakeNode)) item = new FakeText(item);
      item.parentNode = this; this.childNodes.push(item);
    }
  }
  replaceChildren(...items) { this.childNodes.forEach(child => { child.parentNode = null; }); this.childNodes = []; this.append(...items); }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    return descendants.filter(child => selector === '*' || selector.split(',').some(part => part === child.tag || part === 'input:checked' && child.tag === 'input' && child.checked));
  }
  setAttribute() {}
  reportValidity() { return this.valid; }
  reset() {
    for (const item of this.querySelectorAll('input,textarea,select')) {
      item.checked = false;
      if (item.type !== 'checkbox') item.value = '';
    }
  }
  close() { this.open = false; }
}

function fixture() {
  const nodes = new Map(), calls = [], errors = [];
  const state = {key: 'synthetic', me: {id: 'writer', name: 'Writer', kind: 'agent'}, authVersion: 1, context: 1,
    project: {id: 'p'}, channel: {id: 'c', can_write: true, member_ids: ['writer', 'alpha', 'beta']},
    agents: [{id: 'writer', name: 'Writer', kind: 'agent'}, {id: 'alpha', name: 'Alpha', kind: 'agent'},
      {id: 'beta', name: 'Beta', kind: 'agent'}, {id: 'outsider', name: 'Hidden', kind: 'agent'}, {id: 'viewer', kind: 'viewer'}],
    messages: new Map(), events: new Map(), sending: false, publishing: false, dataReady: true, pendingMessage: null,
    pendingNote: null, replyRecipient: '', view: 'chat', messageSeq: 1};
  const $ = id => {
    if (!nodes.has(id)) { const element = new FakeElement(); element.attached = true; nodes.set(id, element); }
    return nodes.get(id);
  };
  for (const [id, tag] of [['recipient-fieldset', 'fieldset'], ['channel-only', 'input'], ['reply-to', 'select'],
    ['message-input', 'textarea'], ['send-button', 'button']]) { $(id).tag = tag; }
  $('channel-only').type = 'checkbox';
  $('recipient-fieldset').append($('recipient-list'));
  $('composer-form').append($('channel-only'), $('recipient-fieldset'), $('reply-to'), $('message-input'), $('send-button'));
  let context, apiHandler = async (_route, options) => ({message: {id: 'saved', channel_id: 'c', ...options.body}});
  const node = (tag, className, text) => {
    const element = new FakeElement(tag);
    if (text !== undefined) element.append(context.h.ownedText(text));
    return element;
  };
  context = vm.createContext({state, $, Node: FakeNode, node, queueMicrotask, URLSearchParams, Uint8Array, crypto: webcrypto,
    document: {documentElement: {lang: 'en'}, createTextNode: value => new FakeText(value), getElementById: $, querySelectorAll: () => []},
    location: {search: '?lang=en', pathname: '/workspace'}, history: {replaceState() {}},
    list: value => Array.isArray(value) ? value : [],
    displayName: id => state.agents.find(agent => agent.id === id)?.name || id,
    replaceContent: (id, ...items) => $(id).replaceChildren(...items),
    canMessage: () => Boolean(state.key) && state.me?.kind === 'agent' && !state.project?.archived_at && state.channel?.can_write === true && state.dataReady,
    canNote: () => false, isOwner: () => false, isWriter: () => state.me?.kind === 'agent', isCoordination: () => false,
    current: value => Boolean(state.key) && value === state.context, pathId: encodeURIComponent,
    ApiError: class extends Error { constructor(status, text) { super(text); this.status = status; } }, errorText: error => error.message,
    api: async (route, options) => { calls.push({route, ...JSON.parse(JSON.stringify(options))}); return apiHandler(route, options); },
    validateFields() {}, renderMessages() {}, renderEvents() {}, clearNativeActivity() {}, clearError() {}, scheduleRefresh() {}, connection() {},
    stopNetwork() { state.context++; state.sending = false; }, setView(value) { state.view = value; }, refresh: async () => {},
    showError: error => errors.push(error.message),
  });
  vm.runInContext(source.slice(0, boundary) + functions + `\n globalThis.h = {${names.join(',')}, ownedText, applyLanguage}; })();`, context);
  context.h.renderRecipients(); $('message-input').value = 'Message body';
  const select = (...ids) => { for (const input of $('recipient-list').querySelectorAll('input')) input.checked = ids.includes(input.value); state.replyRecipient = ''; context.h.syncComposerAddressing(); };
  const parent = (id = 'parent', author = 'alpha', channel = 'c') => state.messages.set(id, {id, author_id: author, channel_id: channel, body: 'Original'});
  return {state, $, calls, errors, h: context.h, select, parent, setAPI: handler => { apiHandler = handler; }, send: () => context.h.sendMessage({preventDefault() {}})};
}

test('an empty default selection cannot publish a new message', async () => {
  const f = fixture(); await f.send();
  assert.equal(f.calls.length, 0); assert.equal(f.state.pendingMessage, null);
  assert.match(f.$('send-status').textContent, /Choose a recipient/);
  f.h.applyLanguage('ru'); assert.match(f.$('send-status').textContent, /Выберите получателя/);
  assert.equal(f.$('message-input').value, 'Message body');
  assert.doesNotMatch(html.match(/<input id="channel-only"[^>]*>/)[0], /\schecked(?:\s|>)/);
  assert.match(html, /id="channel-only-warning"[^>]*hidden/);
});

test('explicit channel publication sends only [] and channel_only:true, then resets its mode', async () => {
  const f = fixture(); f.select('alpha'); f.$('channel-only').checked = true; f.h.updatePermissions();
  assert.equal(f.$('recipient-fieldset').disabled, true); assert.equal(f.$('channel-only').disabled, false);
  assert.equal(f.$('channel-only-warning').hidden, false);
  assert.match(f.$('send-button').textContent, /Publish to channel/);
  await f.send(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body.recipient_ids, []); assert.equal(f.calls[0].body.channel_only, true);
  assert.equal(f.$('channel-only').checked, false); assert.equal(f.$('channel-only-warning').hidden, true);
  assert.deepEqual([...f.h.selectedRecipients()], []);
  assert.match(f.$('send-status').textContent, /Published to the channel only/);
  f.h.applyLanguage('ru'); assert.match(f.$('send-status').textContent, /не попадёт во входящие/);
  f.$('message-input').value = 'Next'; await f.send(); assert.equal(f.calls.length, 1, 'mode is never sticky after sending');
});

test('directed storage preserves exact recipients without broadcast intent or delivery claims', async () => {
  const f = fixture(); f.select('beta', 'alpha'); await f.send();
  assert.deepEqual(f.calls[0].body.recipient_ids, ['alpha', 'beta']); assert.equal('channel_only' in f.calls[0].body, false);
  assert.match(f.$('send-status').textContent, /does not confirm viewing or acceptance/);
  assert.equal(f.state.messageSeq, 1, 'optimistic own message does not skip history replay');
});

test('reply suggests its visible author and sends a directed reply, not a channel publication', async () => {
  const f = fixture(); f.parent(); f.h.selectReply('parent');
  assert.deepEqual([...f.h.selectedRecipients()], ['alpha']); assert.equal(f.$('reply-to').value, 'parent');
  assert.match(f.$('recipient-summary').textContent, /Alpha \(alpha\)/);
  await f.send(); assert.deepEqual(f.calls[0].body.recipient_ids, ['alpha']); assert.equal(f.calls[0].body.reply_to, 'parent');
  assert.equal('channel_only' in f.calls[0].body, false);
});

test('reply preserves manually chosen recipients and an explicit channel-only mode', async () => {
  const f = fixture(); f.parent(); f.select('beta'); f.h.selectReply('parent');
  assert.deepEqual([...f.h.selectedRecipients()], ['beta']);
  f.$('channel-only').checked = true; f.h.selectReply('parent');
  assert.equal(f.$('channel-only').checked, true); assert.deepEqual([...f.h.selectedRecipients()], ['beta']);
  await f.send(); assert.deepEqual(f.calls[0].body.recipient_ids, []); assert.equal(f.calls[0].body.channel_only, true);
  assert.equal(f.calls[0].body.reply_to, 'parent');
});

test('changing reply updates only the automatic suggestion, while New message clears it', () => {
  const f = fixture(); f.parent(); f.parent('second', 'beta');
  f.h.selectReply('parent'); f.h.renderRecipients(); f.h.selectReply('second');
  assert.deepEqual([...f.h.selectedRecipients()], ['beta']);
  f.h.selectReply(''); assert.deepEqual([...f.h.selectedRecipients()], []);
  f.select('alpha'); f.h.selectReply('second'); f.h.selectReply('');
  assert.deepEqual([...f.h.selectedRecipients()], ['alpha'], 'manual recipient survives reply changes');
});

test('reply never targets self, an inaccessible author or an author from another channel', async () => {
  for (const [author, channel] of [['writer', 'c'], ['outsider', 'c'], ['viewer', 'c'], ['alpha', 'other']]) {
    const f = fixture(); f.parent('parent', author, channel); f.h.selectReply('parent'); await f.send();
    assert.deepEqual([...f.h.selectedRecipients()], []); assert.equal(f.calls.length, 0);
  }
});

test('a mode toggle preserves the addressed draft without using its recipients in channel mode', () => {
  const f = fixture(); f.select('beta'); f.$('channel-only').checked = true; f.h.updatePermissions();
  assert.match(f.$('recipient-summary').textContent, /no native inbox recipients/);
  f.$('channel-only').checked = false; f.h.updatePermissions();
  assert.deepEqual([...f.h.selectedRecipients()], ['beta']); assert.equal(f.$('recipient-fieldset').disabled, false);
  assert.match(f.$('recipient-summary').textContent, /Beta \(beta\)/);
});

test('fresh channel ACL rejects a stale checked recipient before any request', async () => {
  const f = fixture(); f.select('alpha'); f.state.channel.member_ids = ['writer', 'beta']; await f.send();
  assert.equal(f.calls.length, 0); assert.match(f.$('send-status').textContent, /access changed/);
  f.h.renderRecipients(); assert.deepEqual([...f.h.selectedRecipients()], []);
  assert.equal(f.$('message-input').value, 'Message body', 'ACL reconciliation preserves body for review');
});

test('background refresh cannot silently send only the remaining subset after recipient revocation', async () => {
  const f = fixture(); f.select('alpha', 'beta'); f.state.channel.member_ids = ['writer', 'beta']; f.h.renderRecipients();
  assert.deepEqual([...f.h.selectedRecipients()], []); await f.send(); assert.equal(f.calls.length, 0);
});

test('cross-channel or cross-auth stale controls cannot send even with channel-only checked', async () => {
  for (const channelOnly of [false, true]) for (const change of ['channel', 'auth']) {
    const f = fixture(); f.select('alpha'); f.$('channel-only').checked = channelOnly;
    if (change === 'channel') f.state.channel = {...f.state.channel, id: 'other'};
    else f.state.authVersion++;
    await f.send(); assert.equal(f.calls.length, 0); assert.match(f.$('send-status').textContent, /access changed/);
  }
});

test('real channel selection clears mode, recipients, reply suggestion and pending request', async () => {
  const f = fixture(); f.parent(); f.h.selectReply('parent'); f.$('channel-only').checked = true;
  f.state.pendingMessage = {signature: 'unknown'};
  await f.h.selectChannel({id: 'other', can_write: true, member_ids: ['writer', 'beta']});
  assert.equal(f.$('channel-only').checked, false); assert.equal(f.$('reply-to').value, '');
  assert.deepEqual([...f.h.selectedRecipients()], []); assert.equal(f.state.replyRecipient, '');
  assert.equal(f.state.pendingMessage, null); assert.equal(f.$('message-input').value, '');
  assert.equal(f.$('recipient-list').dataset.scope, f.h.recipientScope());
});

test('write access and reply scope are rechecked before submission', async () => {
  for (const failure of ['readonly', 'unloaded', 'archived', 'stale-reply']) {
    const f = fixture(); f.select('alpha');
    if (failure === 'readonly') f.state.channel.can_write = false;
    if (failure === 'unloaded') f.state.dataReady = false;
    if (failure === 'archived') f.state.project.archived_at = '2026-01-01T00:00:00Z';
    if (failure === 'stale-reply') { f.parent('parent', 'beta', 'other'); f.$('reply-to').value = 'parent'; }
    await f.send(); assert.equal(f.calls.length, 0);
  }
});

test('unknown storage outcome retries the identical intent and client_id without silently converting modes', async () => {
  const f = fixture(); f.$('channel-only').checked = true;
  f.setAPI(async () => { throw new Error('synthetic disconnect'); }); await f.send();
  const first = f.calls[0].body; assert.equal(f.state.pendingMessage.body.client_id, first.client_id);
  f.setAPI(async (_route, options) => ({replayed: true, message: {id: 'saved', channel_id: 'c', ...options.body}}));
  await f.send(); assert.deepEqual(f.calls[1].body, first);
  assert.match(f.$('send-status').textContent, /No new copy was created/);
  assert.match(f.$('send-status').textContent, /will not enter any agent’s native inbox/);
});

test('recipient refresh cannot discard an ambiguous channel publication idempotency key', async () => {
  const f = fixture(); f.select('alpha'); f.$('channel-only').checked = true;
  f.setAPI(async () => { throw new Error('synthetic disconnect'); }); await f.send();
  f.state.channel.member_ids = ['writer', 'beta']; f.h.renderRecipients();
  assert.deepEqual([...f.h.selectedRecipients()], []);
  await f.send(); assert.deepEqual(f.calls[1].body, f.calls[0].body);
});

test('late success after context switch or logout cannot clear a new draft or report storage there', async () => {
  for (const logout of [false, true]) {
    const f = fixture(); f.select('alpha'); let resolve;
    f.setAPI(() => new Promise(done => { resolve = done; })); const pending = f.send();
    f.state.context++; if (logout) { f.state.key = ''; f.state.authVersion++; }
    f.h.clearDrafts(); f.$('message-input').value = 'New context draft';
    resolve({message: {id: 'late', channel_id: 'c'}}); await pending;
    assert.equal(f.$('message-input').value, 'New context draft'); assert.equal(f.state.messages.has('late'), false);
    assert.equal(f.$('send-status').textContent, '');
  }
});

test('both reply entry points and recipient changes wire to the reviewed addressing functions', () => {
  assert.match(source, /reply\.addEventListener\("click", \(\) => \{ selectReply\(message\.id\)/);
  assert.match(source, /\$\("reply-to"\)\.addEventListener\("change", \(\) => selectReply/);
  assert.match(source, /\$\("recipient-list"\)\.addEventListener\("change", \(\) => \{ state\.replyRecipient = ""; syncComposerAddressing/);
});
