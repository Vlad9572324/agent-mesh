// Production artifact GUI functions, isolated in Node. No HTTP, DB or provider.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const boundary = source.indexOf('  // Keys, data, cursors');
assert.ok(boundary > 0);
const names = ['artifactTitle', 'renderArtifacts', 'record', 'boundedText', 'uploadArtifact', 'digest'];
const functions = names.map(name => {
  const start = source.indexOf(`  function ${name}(`) >= 0 ? source.indexOf(`  function ${name}(`) : source.indexOf(`  async function ${name}(`);
  assert.ok(start >= 0, name);
  const lineEnd = source.indexOf('\n', start);
  return source.slice(start, source.slice(start, lineEnd).endsWith(' }') ? lineEnd : source.indexOf('\n  }', lineEnd) + 4);
}).join('\n');
const roles = source.match(/^  const ARTIFACT_ROLES = .+;$/m)[0];

class FakeNode {
  parentNode = null; attached = false;
  get isConnected() { return this.attached || Boolean(this.parentNode?.isConnected); }
}
class FakeText extends FakeNode {
  constructor(data) { super(); this.data = String(data); }
  get textContent() { return this.data; }
}
class FakeElement extends FakeNode {
  childNodes = []; dataset = {}; value = ''; files = []; resets = 0;
  get children() { return this.childNodes.filter(child => child instanceof FakeElement); }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  append(...items) {
    for (let item of items) {
      if (!(item instanceof FakeNode)) item = new FakeText(item);
      item.parentNode = this; this.childNodes.push(item);
    }
  }
  replaceChildren(...items) { this.childNodes.forEach(child => { child.parentNode = null; }); this.childNodes = []; this.append(...items); }
  addEventListener() {}
  setAttribute() {}
  reportValidity() { return true; }
  reset() { this.resets++; }
}

function fixture() {
  const nodes = new Map(), calls = [], errors = [];
  const state = {key: 'fixture', context: 1, project: {id: 'p'}, coordinationEpoch: 1, coordinationBusy: false};
  const $ = id => {
    if (!nodes.has(id)) { const value = new FakeElement(); value.attached = true; nodes.set(id, value); }
    return nodes.get(id);
  };
  let context;
  const node = (tag, className, text) => {
    const result = new FakeElement(); result.tag = tag;
    if (text !== undefined) result.append(context.h.ownedText(text));
    return result;
  };
  context = vm.createContext({state, $, Node: FakeNode, node, queueMicrotask, URLSearchParams,
    Uint8Array, TextEncoder, crypto: webcrypto, utf8: new TextEncoder(),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    document: {documentElement: {lang: 'en'}, createTextNode: value => new FakeText(value), getElementById: $,
      querySelectorAll: () => [], querySelector: () => ({textContent: 'Title'})},
    location: {search: '?lang=en', pathname: '/workspace'}, history: {replaceState() {}},
    replaceContent: (id, ...items) => $(id).replaceChildren(...items), number: Number, numberText: String, dateText: String,
    ApiError: class extends Error { constructor(status, text) { super(String(text)); this.status = status; } },
    coordinationWritable: () => true, coordinationRoute: () => '/v1/projects/p/artifacts',
    scopeMatches: (context, project, epoch) => Boolean(state.key) && state.context === context && state.project?.id === project && state.coordinationEpoch === epoch,
    coordinationMutation: async (...args) => { calls.push(args); args[4](); },
    downloadArtifact() {}, showError: error => errors.push(String(error)),
  });
  vm.runInContext(source.slice(0, boundary) + roles + '\n' + functions + `\n globalThis.h = {${names.join(',')}, ownedText, applyLanguage}; })();`, context);
  $('artifact-role').value = 'document'; $('artifact-base').value = 'requirements-v1';
  const bytes = new TextEncoder().encode('Exact requirements text');
  $('artifact-file').files = [{size: bytes.byteLength, name: 'private-local-name.txt', arrayBuffer: async () => bytes.buffer}];
  return {state, $, calls, errors, h: context.h, upload: () => context.h.uploadArtifact({preventDefault() {}})};
}

const artifact = (title, id = 'doc-1') => ({id, title, role: 'document', project_id: 'p', base_revision: 'requirements-v1',
  sha256: '1'.repeat(64), author_id: 'author', size_bytes: 4, created_at: '2026-01-01T00:00:00Z'});

test('artifact title is literal in both locales, with role and immutable pins visible', () => {
  const f = fixture();
  f.h.renderArtifacts({artifacts: [artifact('Document'), artifact('<img src=x onerror=alert(1)>', 'doc-2')], ready: new Set(['artifacts']), artifactsMore: false});
  const cards = f.$('artifact-list').children;
  assert.equal(cards[0].children[0].textContent, 'Document');
  assert.match(cards[0].textContent, /document.*ID doc-1/s);
  f.h.applyLanguage('ru');
  assert.equal(cards[0].children[0].textContent, 'Document', 'user title is not translated');
  assert.match(cards[0].textContent, /Документ/);
  assert.equal(cards[1].children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(cards[1].children[0].children.length, 0, 'title never becomes markup');
});

test('old untitled metadata uses the exact artifact ID', () => {
  const f = fixture();
  for (const title of [undefined, '', null]) assert.equal(f.h.artifactTitle(artifact(title)), 'doc-1');
  assert.match(html, /id="artifact-title"[^>]*maxlength="200"/);
  assert.match(html, /option value="document"/);
  assert.match(html, /requirements-v1/);
});

test('document upload sends explicit title and revision; hashes only selected bytes', async () => {
  const f = fixture(); f.$('artifact-title').value = 'Требования';
  await f.upload(); assert.deepEqual(f.errors, []); assert.equal(f.calls.length, 1);
  const payload = f.calls[0][3];
  assert.equal(payload.title, 'Требования'); assert.equal(payload.role, 'document');
  assert.equal(payload.base_revision, 'requirements-v1');
  assert.equal(Buffer.from(payload.content_base64, 'base64').toString(), 'Exact requirements text');
  assert.match(payload.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(payload).includes('private-local-name'), false);
});

test('optional title preserves legacy request shape and is never taken from filename', async () => {
  const f = fixture(); f.$('artifact-role').value = 'test';
  await f.upload(); assert.equal(f.calls.length, 1); assert.equal('title' in f.calls[0][3], false);
});

test('UTF-8 byte bound and control characters fail before publication', async () => {
  for (const title of ['я'.repeat(101), 'line\nbreak', 'line\u2028break', 'bad\u007f']) {
    const f = fixture(); f.$('artifact-title').value = title; await f.upload();
    assert.equal(f.calls.length, 0); assert.equal(f.errors.length, 1);
  }
  const f = fixture(); f.$('artifact-title').value = 'я'.repeat(100); await f.upload(); assert.equal(f.calls.length, 1);
});

test('logout while selected file is loading cannot publish into a later session', async () => {
  const f = fixture(); let resolve;
  f.$('artifact-file').files = [{size: 4, arrayBuffer: () => new Promise(r => { resolve = r; })}];
  const pending = f.upload(); f.state.key = ''; f.state.context++;
  resolve(new Uint8Array([116, 101, 120, 116]).buffer); await pending;
  assert.equal(f.calls.length, 0); assert.deepEqual(f.errors, []);
});
