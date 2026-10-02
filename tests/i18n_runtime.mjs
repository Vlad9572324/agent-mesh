// Pure Node checks for the actual browser localization helpers. No API, browser,
// database, credentials, provider process or production endpoint is used.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const helperEnd = source.indexOf('  // Keys, data, cursors');
assert.ok(helperEnd > 0, 'localization helper boundary exists');

class FakeNode {
  parentNode = null;
  attached = false;
  get isConnected() { return this.attached || Boolean(this.parentNode?.isConnected); }
}
class FakeText extends FakeNode {
  constructor(value) { super(); this.data = String(value); }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}
class FakeElement extends FakeNode {
  childNodes = [];
  attributes = new Map();
  dataset = {};
  value = '';
  validationMessage = '';
  get children() { return this.childNodes.filter(child => child instanceof FakeElement); }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(new FakeText(value)); }
  append(...children) {
    for (let child of children) {
      if (!(child instanceof FakeNode)) child = new FakeText(child);
      child.parentNode = this; this.childNodes.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = []; this.append(...children);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'data-i18n-ru') this.dataset.i18nRu = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setCustomValidity(value) { this.validationMessage = String(value); }
}

const nodes = new Map(), statics = [], urls = [];
const $ = id => {
  if (!nodes.has(id)) { const node = new FakeElement(); node.attached = true; nodes.set(id, node); }
  return nodes.get(id);
};
const document = {
  documentElement: {lang: 'en'},
  createTextNode: value => new FakeText(value),
  createElement: () => new FakeElement(),
  getElementById: $,
  querySelectorAll: selector => statics.filter(node => node.attributes.has(selector.slice(1, -1))),
};
const context = vm.createContext({document, Node: FakeNode, URLSearchParams, queueMicrotask,
  location: {search: '?discarded=not-a-key', pathname: '/workspace'},
  history: {replaceState: (_state, _title, url) => urls.push(url)},
});
vm.runInContext(source.slice(0, helperEnd) + `
  globalThis.helpers = {tr, formatText, resolveText, ownedText, setText, appendOwned,
    setOwnedAttribute, setOwnedValidity, captureStaticTranslations, applyLanguage,
    textBindings, attributeBindings, validityBindings};
})();`, context);
const h = context.helpers;
const state = {project: {id: 'project-id', name: 'Untranslated <project> title'}, projectMap: {}, projectMapEpoch: 0};
Object.assign(context, h, {$, state, clearError: id => h.setText($(id), '')});

// Interpolation is literal data, including data identical to another UI message.
const userText = 'Чтение <img src=x onerror=alert(1)> {0}';
h.setText($('data'), () => h.tr('Author: {0} · permissions checked by the server', () => userText));
assert.equal($('data').textContent, `Author: ${userText} · permissions checked by the server`);
h.applyLanguage('ru');
assert.equal($('data').textContent, `Автор: ${userText} · права проверяет сервер`);
assert.equal($('data').children.length, 0, 'user data is never parsed as HTML');
assert.equal(String(h.tr('Show').trim()), 'Показать');
assert.equal([h.tr('Show'), h.tr('Hide')].join('/'), 'Показать/Скрыть');
assert.equal(JSON.stringify({message: String(h.tr('Show'))}), '{"message":"Показать"}');
assert.equal(h.resolveText(h.formatText(['[', ']'], () => userText)), `[${userText}]`);

// A language switch translates the rendered snapshot, not subsequently mutated
// authentication state or a newly selected project.
const snapshot = {name: 'Captured project', id: 'captured-id'};
h.setText($('snapshot'), () => h.tr('Project: {0} ({1}).', () => snapshot.name, () => snapshot.id));
snapshot.name = 'Different project'; snapshot.id = 'different-id';
h.applyLanguage('en');
assert.equal($('snapshot').textContent, 'Project: Captured project (captured-id).');

// Static labels, dynamic option labels and validation are rewritten in place;
// form values, draft identity and selected protocol enums remain unchanged.
const label = $('static-label'); label.textContent = 'Language'; label.setAttribute('data-i18n-ru', 'Язык'); statics.push(label);
const parent = $('mixed-parent'), child = new FakeElement(); child.textContent = 'Keep child'; parent.append(child);
parent.setAttribute('data-i18n-ru', 'Must not overwrite mixed content'); statics.push(parent);
const input = $('draft'), option = $('task-event-option'); input.value = userText; option.value = 'review_requested';
h.setText(option, () => h.tr('Request review of the set'));
h.setOwnedAttribute(input, 'aria-label', () => h.tr('Public summary'));
h.setOwnedValidity(input, () => h.tr('Null characters are not allowed.'));
h.captureStaticTranslations();
for (const language of ['en', 'ru', 'en', 'ru', 'en']) {
  h.applyLanguage(language, true);
  assert.equal(document.documentElement.lang, language);
  assert.equal($('language-select').value, language);
  assert.equal(input.value, userText);
  assert.equal(option.value, 'review_requested');
  assert.equal(parent.children[0], child);
  assert.equal(label.textContent, language === 'ru' ? 'Язык' : 'Language');
}
assert.ok(urls.every(url => /^\/workspace\?lang=(en|ru)$/.test(url)), 'only locale is retained in URL');

// Replaced or detached records must release bindings at the next microtask.
const detached = new FakeElement();
h.setText(detached, () => userText);
h.setOwnedAttribute(detached, 'title', () => userText);
h.setOwnedValidity(detached, () => userText);
const detachedText = detached.childNodes[0];
h.setText($('replace'), 'first'); const first = $('replace').childNodes[0]; h.setText($('replace'), 'second');
await new Promise(resolve => queueMicrotask(resolve));
assert.equal(h.textBindings.has(detachedText), false);
assert.equal(h.attributeBindings.has(detached), false);
assert.equal(h.validityBindings.has(detached), false);
assert.equal(h.textBindings.has(first), false);

// Exercise the production map-title binding and its production cleanup. Hidden
// headers remain connected after logout, unlike removed entity cards.
function functionSource(name) {
  const match = source.match(new RegExp(`^  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'));
  assert.ok(match, `${name} exists`); return match[0];
}
const mapRender = functionSource('renderProjectMap');
const titleBinding = mapRender.split('\n').find(line => line.includes('setText($("project-map-live-title")'));
assert.ok(titleBinding, 'production map title has a text binding');
vm.runInContext(titleBinding, context);
assert.ok($('project-map-live-title').textContent.includes(state.project.name));
vm.runInContext(functionSource('clearProjectMap') + '\nclearProjectMap();', context);
state.project = null;
assert.doesNotThrow(() => h.applyLanguage('ru', true), 'locale switch after map logout must not dereference a cleared project');
assert.ok(!$('project-map-live-title').textContent.includes('Untranslated'), 'map cleanup removes the previous project title');

console.log('PASS: i18n runtime interpolation, form preservation, detached cleanup and map logout');
