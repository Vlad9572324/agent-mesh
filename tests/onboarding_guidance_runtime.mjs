// Actual onboarding presentation functions. No HTTP, DB, clipboard or provider.
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const boundary = source.indexOf('  // Keys, data, cursors');
assert.ok(boundary > 0);
const names = ['clearOnboardingGuidance', 'onboardingGuidanceFiles', 'onboardingGuidanceCurrent', 'loadOnboardingGuidance',
  'renderOnboardingGuidance', 'copyOnboardingDocument', 'downloadOnboardingDocument', 'renderOnboardingScope',
  'clearOnboardingResult', 'showOnboardingResult', 'digest'];
const functions = names.map(name => {
  const start = source.indexOf(`  function ${name}(`) >= 0 ? source.indexOf(`  function ${name}(`) : source.indexOf(`  async function ${name}(`);
  assert.ok(start >= 0, name);
  const lineEnd = source.indexOf('\n', start);
  return source.slice(start, source.slice(start, lineEnd).endsWith(' }') ? lineEnd : source.indexOf('\n  }', lineEnd) + 4);
}).join('\n');
const constants = source.match(/^  const ONBOARDING_DOCUMENTS = .+;$/m)[0];
const hash = text => createHash('sha256').update(text).digest('hex');
const files = ['PROMPT.md', 'SKILL.md', 'HOOKS-AND-TOOLS.md'];
const guidance = () => ({version: 1, files: files.map(name => {
  const content = `# ${name}\nCanonical English <img src=x onerror=alert(1)> text.\n`;
  return {name, content, sha256: hash(content)};
})});
const result = value => ({public_url: 'https://mesh.example', repository: 'https://example.com/repo', spki_pin: 'sha256//' + 'A'.repeat(43) + '=',
  token: 'b'.repeat(64), invitation: {agent_id: 'new-agent', agent_name: '<img src=x onerror=alert(2)>', project_id: 'target-project',
    channel_ids: ['alpha', 'beta'], runtime: 'auto', expires_at: '2026-10-04T00:00:00Z'}, ...(value === undefined ? {} : {guidance: value})});
class FakeNode {
  parentNode = null; attached = false;
  get isConnected() { return this.attached || Boolean(this.parentNode?.isConnected); }
}
class FakeText extends FakeNode {
  constructor(value) { super(); this.data = String(value); }
  get textContent() { return this.data; }
}
class FakeElement extends FakeNode {
  childNodes = []; dataset = {}; value = ''; open = false; attrs = {}; events = {}; clicks = 0;
  get children() { return this.childNodes.filter(child => child instanceof FakeElement); }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  append(...items) { for (let item of items) { if (!(item instanceof FakeNode)) item = new FakeText(item); item.parentNode = this; this.childNodes.push(item); } }
  replaceChildren(...items) { this.childNodes.forEach(child => { child.parentNode = null; }); this.childNodes = []; this.append(...items); }
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  click() { this.clicks++; }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(child => child !== this); this.parentNode = null; }
}

function fixture() {
  const nodes = new Map(), copied = [], created = [], revoked = [], timers = [];
  const state = {key: 'owner-fixture', me: {kind: 'owner'}, view: 'admin', context: 1, authVersion: 1,
    onboardingCommand: '', onboardingVersion: 0, onboardingDownload: '', onboardingGuidance: {guide: null, result: null},
    onboardingGuideSeq: 0, onboardingGuideURLs: new Map()};
  const $ = id => {
    if (!nodes.has(id)) { const element = new FakeElement(); element.attached = true; nodes.set(id, element); }
    return nodes.get(id);
  };
  let context, clipboard = async text => { copied.push(text); }, digest = (...args) => webcrypto.subtle.digest(...args);
  const node = (tag, className, text) => {
    const element = new FakeElement(); element.tag = tag;
    Object.defineProperty(element, 'id', {set(value) { nodes.set(value, element); }, configurable: true});
    if (text !== undefined) element.append(context.h.ownedText(text));
    return element;
  };
  class FixtureURL extends URL {
    static createObjectURL(blob) { const url = 'blob:fixture-' + created.length; created.push({url, blob}); return url; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  context = vm.createContext({state, $, Node: FakeNode, node, queueMicrotask, URLSearchParams, URL: FixtureURL, Blob, Uint8Array,
    utf8: new TextEncoder(), crypto: {subtle: {digest: (...args) => digest(...args)}},
    document: {documentElement: {lang: 'en'}, createTextNode: value => new FakeText(value), getElementById: $, querySelectorAll: () => [], body: $('body')},
    location: {search: '?lang=en', pathname: '/workspace'}, history: {replaceState() {}},
    replaceContent: (id, ...items) => $(id).replaceChildren(...items), dateText: String,
    isOwner: () => state.me?.kind === 'owner', current: value => Boolean(state.key) && value === state.context,
    navigator: {clipboard: {writeText: text => clipboard(text)}}, setTimeout: fn => timers.push(fn),
  });
  vm.runInContext(source.slice(0, boundary) + constants + '\n' + functions + `\n globalThis.h = {${names.join(',')}, ownedText, applyLanguage}; })();`, context);
  return {state, $, copied, created, revoked, timers, h: context.h,
    clipboard: fn => { clipboard = fn; }, digest: fn => { digest = fn; }};
}

test('canonical English files render literally; labels localize without changing bytes or open sections', async () => {
  const f = fixture(), docs = guidance(); await f.h.loadOnboardingGuidance('guide', docs);
  const card = f.$('admin-onboarding-guide-files').children[0]; card.open = true;
  const preview = f.$('onboarding-guide-document-0');
  assert.equal(preview.value, docs.files[0].content); assert.equal(preview.children.length, 0);
  assert.equal(preview.readOnly, true); assert.equal(preview.lang, 'en');
  f.h.applyLanguage('ru'); assert.match(card.textContent, /Стартовый промпт/); assert.equal(preview.value, docs.files[0].content);
  const skill = f.$('admin-onboarding-guide-files').children[1];
  assert.match(skill.textContent, /Необязательный навык/); assert.match(skill.textContent, /Устанавливайте вручную/);
  assert.match(skill.textContent, /HOOKS-AND-TOOLS.md/);
  f.h.applyLanguage('en'); assert.match(skill.textContent, /Optional skill/); assert.match(skill.textContent, /Install manually/);
  await f.h.loadOnboardingGuidance('guide', JSON.parse(JSON.stringify(docs)));
  assert.equal(f.$('admin-onboarding-guide-files').children[0], card); assert.equal(card.open, true);
});

test('strict version, names, object fields and UTF-8 bounds fail closed', async () => {
  const mutations = [value => { value.version = 2; }, value => { value.files.pop(); }, value => { value.extra = true; },
    value => { value.files[0].name = '../SKILL.md'; }, value => { value.files[1].name = 'PROMPT.md'; },
    value => { value.files[0].extra = true; }, value => { value.files[0].content = 'я'.repeat(16385); },
    value => { value.files[0].content = 'bad\0text'; }, value => { value.files[0].sha256 = 'not-a-hash'; }];
  for (const mutate of mutations) {
    const f = fixture(), docs = guidance(); mutate(docs); await f.h.loadOnboardingGuidance('guide', docs);
    assert.equal(f.$('admin-onboarding-guide-files').children.length, 0); assert.match(f.$('admin-onboarding-guide-status').textContent, /failed validation/);
    f.h.downloadOnboardingDocument('guide', 'SKILL.md'); await f.h.copyOnboardingDocument('guide', 'SKILL.md');
    assert.equal(f.created.length, 0); assert.equal(f.copied.length, 0);
  }
});

test('a single mismatched hash prevents the entire file set being offered', async () => {
  const f = fixture(), docs = guidance(); docs.files[2].content += 'changed';
  await f.h.loadOnboardingGuidance('guide', docs);
  assert.equal(f.$('admin-onboarding-guide-files').children.length, 0); assert.equal(f.state.onboardingGuidance.guide.files.length, 0);
});

test('old backend without guidance keeps the pinned one-time command usable', async () => {
  const f = fixture(); f.h.showOnboardingResult(result());
  assert.match(f.state.onboardingCommand, /--pinnedpubkey/); assert.ok(f.state.onboardingCommand.includes('b'.repeat(64)));
  assert.equal(f.$('admin-onboarding-dialog').open, true);
  assert.match(f.$('admin-onboarding-result-status').textContent, /unavailable from this server/);
  assert.equal(f.$('admin-onboarding-result-files').children.length, 0);
});

test('scope comes from the invitation, with literal identity and requested runtime rather than inferred installation', () => {
  const f = fixture(); f.$('admin-onboarding-project').value = 'different-current-project'; f.h.showOnboardingResult(result());
  const scope = f.$('admin-onboarding-scope');
  assert.match(scope.textContent, /target-project/); assert.doesNotMatch(scope.textContent, /different-current-project/);
  assert.match(scope.textContent, /<img src=x onerror=alert\(2\)> \(new-agent\)/);
  assert.match(scope.textContent, /Auto · chosen locally on first run/);
  assert.equal(scope.children.some(child => child.tag === 'img'), false);
  f.h.applyLanguage('ru'); assert.match(scope.textContent, /при первом запуске/);
  for (const runtime of ['codex', 'claude']) { f.h.renderOnboardingScope({...result().invitation, runtime}); assert.doesNotMatch(scope.textContent, /Автоматически/); }
});

test('copy and download contain exactly one verified document, never the invitation command', async () => {
  const f = fixture(), docs = guidance(); f.h.showOnboardingResult(result());
  await f.h.loadOnboardingGuidance('result', docs);
  for (const file of docs.files) {
    await f.h.copyOnboardingDocument('result', file.name); f.h.downloadOnboardingDocument('result', file.name);
    assert.equal(f.copied.at(-1), file.content); assert.equal(await f.created.at(-1).blob.text(), file.content);
    assert.equal(f.copied.at(-1).includes('b'.repeat(64)), false);
  }
  f.h.clearOnboardingResult();
  assert.equal(f.state.onboardingCommand, ''); assert.equal(f.$('admin-onboarding-scope').textContent, '');
  assert.equal(f.$('admin-onboarding-result-files').children.length, 0); assert.equal(f.state.onboardingGuideURLs.size, 0);
  assert.deepEqual(new Set(f.revoked), new Set(f.created.map(item => item.url)));
});

test('persistent guide survives closing result but purge clears it and revokes its downloads', async () => {
  const f = fixture(); await f.h.loadOnboardingGuidance('guide', guidance()); f.h.showOnboardingResult(result());
  f.h.downloadOnboardingDocument('guide', 'SKILL.md'); f.h.clearOnboardingResult();
  assert.equal(f.$('admin-onboarding-guide-files').children.length, 3); assert.equal(f.state.onboardingGuideURLs.size, 1);
  f.h.clearOnboardingGuidance('guide'); assert.equal(f.$('admin-onboarding-guide-files').textContent, '');
  assert.equal(f.state.onboardingGuideURLs.size, 0); assert.equal(f.revoked.length, 1);
});

test('late clipboard success or failure cannot restore cleared result state', async () => {
  for (const reject of [false, true]) {
    const f = fixture(); f.h.showOnboardingResult(result()); await f.h.loadOnboardingGuidance('result', guidance());
    let done; f.clipboard(() => new Promise((resolve, fail) => { done = reject ? fail : resolve; }));
    const pending = f.h.copyOnboardingDocument('result', 'PROMPT.md'); f.h.clearOnboardingResult();
    done(); await pending; assert.equal(f.$('admin-onboarding-result-status').textContent, '');
    assert.equal(f.$('admin-onboarding-command').value, '');
  }
});

test('clipboard fallback selects only the verified document', async () => {
  const f = fixture(); await f.h.loadOnboardingGuidance('guide', guidance());
  f.clipboard(async () => { throw new Error('unavailable'); }); await f.h.copyOnboardingDocument('guide', 'SKILL.md');
  assert.equal(f.$('onboarding-guide-document-1').selected, true); assert.equal(f.$('admin-onboarding-command').selected, undefined);
});

test('late hash verification is fenced by logout and does not populate protected UI', async () => {
  const f = fixture(); let complete;
  f.digest((...args) => new Promise(resolve => { complete = async () => resolve(await webcrypto.subtle.digest(...args)); }));
  const pending = f.h.loadOnboardingGuidance('guide', guidance());
  f.state.key = ''; f.state.authVersion++; f.h.clearOnboardingGuidance('guide');
  f.digest((...args) => webcrypto.subtle.digest(...args)); await complete(); await pending;
  assert.equal(f.state.onboardingGuidance.guide, null); assert.equal(f.$('admin-onboarding-guide-files').children.length, 0);
});

test('navigation during hashing does not leave a permanently cached loading state', async () => {
  const f = fixture(); let complete;
  f.digest((...args) => new Promise(resolve => { complete = async () => resolve(await webcrypto.subtle.digest(...args)); }));
  const pending = f.h.loadOnboardingGuidance('guide', guidance()); f.state.context++;
  f.digest((...args) => webcrypto.subtle.digest(...args)); await complete(); await pending;
  await f.h.loadOnboardingGuidance('guide', guidance()); assert.equal(f.$('admin-onboarding-guide-files').children.length, 3);
});

test('owner, authentication and active-view guards apply to copy and download even with a cached file', async () => {
  for (const revoke of [f => { f.state.me.kind = 'viewer'; }, f => { f.state.key = ''; }, f => { f.state.view = 'chat'; }]) {
    const f = fixture(); await f.h.loadOnboardingGuidance('guide', guidance()); revoke(f);
    await f.h.copyOnboardingDocument('guide', 'SKILL.md'); f.h.downloadOnboardingDocument('guide', 'SKILL.md');
    assert.equal(f.copied.length, 0); assert.equal(f.created.length, 0);
  }
});

test('document object URLs are also revoked after the bounded download window', async () => {
  const f = fixture(); await f.h.loadOnboardingGuidance('guide', guidance()); f.h.downloadOnboardingDocument('guide', 'SKILL.md');
  f.timers.forEach(fn => fn()); assert.equal(f.state.onboardingGuideURLs.size, 0); assert.deepEqual(f.revoked, [f.created[0].url]);
});
