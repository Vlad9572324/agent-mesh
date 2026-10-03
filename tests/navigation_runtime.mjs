// Deterministic checks of the actual browser navigation functions. No browser,
// network, database, credentials or provider process is used. An optional app.js
// path allows an isolated test worktree to review an integration worktree.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(process.argv[2] || new URL('../web/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = source.match(new RegExp(`^  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'));
  assert.ok(match, `${name} production function exists`);
  return match[0];
}
const functions = ['loadNavigation', 'markVisibleChannelRead'].map(functionSource).join('\n');
const snapshot = (unread, read) => ({
  projects: [{id: 'fixture-project', unread_messages: unread}],
  channels: [{id: 'fixture-channel', project_id: 'fixture-project', unread_messages: unread, last_read_seq: read, latest_message_seq: 3}],
});
function fixture() {
  const state = {key: 'fixture-only', context: 1, navigationSeq: 0, navigationRead: null,
    navigation: snapshot(1, 1), channel: {id: 'fixture-channel'}, messageSeq: 1,
    messages: new Map([['first', {id: 'first', seq: 1}]]), dataReady: true, loading: false, view: 'chat'};
  const ui = {dialog: null, navOpen: false, hidden: false, query: '', renders: 0, refreshes: 0};
  const scroller = {clientHeight: 400, scrollHeight: 400, scrollTop: 0,
    // Match renderMessages: each rendered message article gets its actual seq.
    querySelectorAll(selector) {
      assert.equal(selector, '[data-message-seq]');
      return [...state.messages.values()].map(message => ({dataset: {messageSeq: String(message.seq)}}));
    }};
  const requests = [];
  const context = vm.createContext({state,
    $: id => {
      if (id === 'message-list') return scroller;
      if (id === 'search-input') return {value: ui.query};
      throw new Error(`Unexpected fixture element ${id}`);
    },
    document: {get hidden() { return ui.hidden; },
      querySelector(selector) { assert.equal(selector, 'dialog[open]'); return ui.dialog; },
      body: {classList: {contains(name) { assert.equal(name, 'nav-open'); return ui.navOpen; }}}},
    list: value => Array.isArray(value) ? value : [],
    number: value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0,
    pathId: encodeURIComponent,
    current: context => Boolean(state.key) && context === state.context,
    renderNavigation: () => { ui.renders += 1; },
    scheduleRefresh: () => { ui.refreshes += 1; },
    api: (path, options = {}) => new Promise((resolve, reject) => requests.push({path, options, resolve, reject})),
  });
  vm.runInContext(functions, context, {filename: 'production-navigation.js'});
  return {state, ui, scroller, requests, load: () => context.loadNavigation(state.context), read: () => context.markVisibleChannelRead()};
}
async function finishRead(f, pending, unread = 0, read = f.state.messageSeq) {
  const write = f.requests.at(-1);
  assert.equal(write.options.method, 'PUT');
  write.resolve({last_read_seq: read});
  await new Promise(resolve => setImmediate(resolve));
  const get = f.requests.at(-1);
  assert.equal(get.path, '/v1/navigation');
  assert.notEqual(get, write, 'confirmed writes reload the authoritative snapshot');
  get.resolve(snapshot(unread, read));
  await pending;
}

test('late navigation response cannot restore cleared unread badges', async () => {
  const f = fixture(), old = f.load(), fresh = f.load(), confirmed = snapshot(0, 3);
  f.requests[1].resolve(confirmed); await fresh;
  f.requests[0].resolve(snapshot(1, 1)); await old;
  assert.equal(f.state.navigation, confirmed);
});

for (const status of [404, 503]) {
  test(`late navigation error ${status} cannot clear a newer confirmed snapshot`, async () => {
    const f = fixture(), old = f.load(), fresh = f.load(), confirmed = snapshot(0, 3);
    f.requests[1].resolve(confirmed); await fresh;
    f.requests[0].reject(Object.assign(new Error('Fixture response failure'), {status}));
    await assert.doesNotReject(old);
    assert.equal(f.state.navigation, confirmed);
  });
}

test('starting a read write invalidates snapshots from before the write', async () => {
  const f = fixture(), original = f.state.navigation, old = f.load();
  f.state.messages.set('second', {id: 'second', seq: 2}); f.state.messageSeq = 2;
  const pending = f.read();
  assert.equal(f.requests[1].options.method, 'PUT');
  f.requests[0].resolve(snapshot(5, 0)); await old;
  assert.equal(f.state.navigation, original, 'pre-write data must not overwrite current state while PUT is pending');
  await finishRead(f, pending);
  assert.equal(f.state.navigation.channels[0].last_read_seq, 2);
  assert.equal(f.state.navigationRead, null);
});

test('navigation replies from an ended authentication context are ignored', async () => {
  const f = fixture(), pending = f.load();
  f.state.key = ''; f.state.context += 1; f.state.navigationSeq += 1; f.state.navigation = null;
  f.requests[0].resolve(snapshot(9, 0)); await pending;
  assert.equal(f.state.navigation, null);
});

for (const overlay of ['dialog', 'navigation']) {
  test(`${overlay} covering the discussion prevents a read acknowledgement`, async () => {
    const f = fixture();
    f.state.messages.set('second', {id: 'second', seq: 2}); f.state.messageSeq = 2;
    if (overlay === 'dialog') f.ui.dialog = {open: true}; else f.ui.navOpen = true;
    await f.read();
    assert.equal(f.requests.length, 0, 'covered discussion must not consume unread messages');
    f.ui.dialog = null; f.ui.navOpen = false;
    const pending = f.read();
    assert.equal(f.requests[0].options.body.through_seq, 2, 'uncovered discussion can acknowledge the replayed message');
    await finishRead(f, pending);
  });
}

test('an own POST response ahead of replay cannot acknowledge an unseen gap', async () => {
  const f = fixture();
  // The REST history contains seq 1. A peer writes seq 2, then our POST response
  // inserts seq 3 into state.messages/rendered DOM, preserving messageSeq at 1.
  f.state.messages.set('own', {id: 'own', seq: 3, author_id: 'self'});
  assert.deepEqual([...f.state.messages.values()].map(message => message.seq), [1, 3]);
  assert.equal(f.state.messageSeq, 1);
  await f.read();
  assert.equal(f.requests.length, 0, 'seq 2 was not fetched/rendered and must remain unread');
  // REST replay then fills the gap and reaches seq 3. Only now may the GUI
  // acknowledge through 3, while still using an actual rendered message seq.
  f.state.messages.set('peer', {id: 'peer', seq: 2, author_id: 'peer'});
  f.state.messageSeq = 3;
  const pending = f.read();
  assert.equal(f.requests[0].options.body.through_seq, 3);
  await finishRead(f, pending);
});

test('background, search and scrolled-away views retain unread messages', async () => {
  for (const mode of ['background', 'search', 'scrolled']) {
    const f = fixture();
    f.state.messages.set('second', {id: 'second', seq: 2}); f.state.messageSeq = 2;
    if (mode === 'background') f.ui.hidden = true;
    if (mode === 'search') f.ui.query = 'filtered message';
    if (mode === 'scrolled') f.scroller.scrollHeight = 1000;
    await f.read();
    assert.equal(f.requests.length, 0, `${mode} must not acknowledge the discussion`);
  }
});
