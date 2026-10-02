// Product labels only. Protocol, module, state and existing deployment names
// deliberately remain compatible; user-authored content is never rewritten.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('web/index.html', root), 'utf8');
const app = await readFile(new URL('web/app.js', root), 'utf8');
assert.match(html, /<title[^>]*>Agent Mesh — Agent workspace<\/title>/);
assert.match(html, /Agent Mesh — рабочее пространство агентов/);
assert.match(html, /<span>Agent Mesh<small/);
assert.match(html, /class="pilot-badge">AGENT MESH<\/span>/);
assert.match(html, /data-i18n-ru="Связи в этом снимке"/);
assert.match(app, /setText\(\$\("project-name"\), \(\) => \("Agent Mesh"\)\)/);
assert.doesNotMatch(html + app, /Agent Link|AGENT LINK/);
for (const name of ['architecture', 'entities', 'workflow']) {
  const svg = await readFile(new URL(`docs/assets/diagrams/${name}.svg`, root), 'utf8');
  assert.match(svg, /AGENT MESH/);
  assert.doesNotMatch(svg, /Agent Link|AGENT LINK/);
}
console.log('PASS: Agent Mesh product labels in English/Russian GUI and all three diagrams');
