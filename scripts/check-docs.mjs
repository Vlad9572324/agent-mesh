#!/usr/bin/env node
// Offline documentation checks. No credentials, servers or external requests.
import {readFile, lstat, realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname, extname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean))];
const errors = [], cache = new Map();
let links = 0, images = 0;
const fail = (file, message) => errors.push(`${file}: ${message}`);
const text = async file => {
  if (!cache.has(file)) cache.set(file, await readFile(resolve(root, file), 'utf8'));
  return cache.get(file);
};
const withoutFences = value => {
  let marker = '';
  return value.split('\n').filter(line => {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (!marker) marker = fence[1][0]; else if (marker === fence[1][0]) marker = ''; return false; }
    return !marker;
  }).join('\n');
};
const anchors = value => {
  const ids = new Set(), counts = new Map();
  for (const match of withoutFences(value).matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = match[1].replace(/<[^>]*>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').trim().replace(/\s/g, '-');
    const count = counts.get(base) || 0; counts.set(base, count + 1);
    ids.add(base + (count ? `-${count}` : ''));
  }
  for (const match of value.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(match[1]);
  return ids;
};
async function checkLink(source, raw, image = false) {
  links++; if (image) images++;
  const target = raw.replace(/^<|>$/g, '');
  if (/^(https?:|mailto:)/i.test(target)) return;
  if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) { fail(source, `unsupported URL ${target}`); return; }
  const split = target.indexOf('#'), pathPart = (split < 0 ? target : target.slice(0, split)).split('?')[0];
  let path, anchor;
  try { path = decodeURIComponent(pathPart); anchor = split < 0 ? '' : decodeURIComponent(target.slice(split + 1)); }
  catch { fail(source, `invalid URL encoding ${target}`); return; }
  if (isAbsolute(path)) { fail(source, `absolute local link ${target}`); return; }
  const full = path ? resolve(root, dirname(source), path) : resolve(root, source);
  const local = relative(root, full);
  if (local === '..' || local.startsWith(`..${sep}`)) { fail(source, `link leaves repository ${target}`); return; }
  try {
    const info = await lstat(full);
    if (info.isSymbolicLink()) { fail(source, `linked symlink ${target}`); return; }
    const resolved = relative(root, await realpath(full));
    if (resolved === '..' || resolved.startsWith(`..${sep}`)) { fail(source, `resolved link leaves repository ${target}`); return; }
    if (image && !info.isFile()) fail(source, `image is not a file ${target}`);
    if (anchor && extname(local) === '.md' && !anchors(await text(local)).has(anchor)) fail(source, `missing anchor ${target}`);
  } catch { fail(source, `missing local target ${target}`); }
}

const markdown = paths.filter(path => path.endsWith('.md'));
for (const file of markdown) {
  let content;
  try { content = withoutFences(await text(file)); } catch { continue; } // A staged rename may still list its removed path.
  for (const match of content.matchAll(/(!?)\[([^\]\n]*)\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    if (match[1] && !match[2].trim()) fail(file, 'image needs nonempty alternative text');
    await checkLink(file, match[3], Boolean(match[1]));
  }
  for (const match of content.matchAll(/<(img|a)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
    if (match[1].toLowerCase() === 'img' && !/\balt=["'][^"']+["']/.test(match[0])) fail(file, 'image needs nonempty alternative text');
    await checkLink(file, match[2], match[1].toLowerCase() === 'img');
  }
  if (/(?:^|\n)(?:<{7}|={7}|>{7})(?:\s|$)/m.test(content)) fail(file, 'merge-conflict marker');
}
const svgs = paths.filter(path => path.startsWith('docs/assets/') && path.endsWith('.svg'));
for (const file of svgs) {
  const body = await text(file);
  if (!/<svg\b/.test(body) || !/\bviewBox=/.test(body) || !/<title\b/.test(body) || !/<desc\b/.test(body)) fail(file, 'SVG needs viewBox, title and description');
  if (/<(?:script|foreignObject|image)\b|\bon\w+\s*=|(?:href|url)\s*[=(]\s*["']?(?:https?:|\/\/|data:)/i.test(body)) fail(file, 'SVG must be self-contained and script-free');
}
const pngs = paths.filter(path => path.startsWith('docs/assets/screenshots/') && path.endsWith('.png'));
for (const file of pngs) {
  const bytes = await readFile(resolve(root, file));
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.length < 33) { fail(file, 'invalid PNG signature'); continue; }
  if (bytes.length > 2 * 1024 * 1024) fail(file, 'screenshot exceeds 2 MiB; optimize without losing readable text');
  if (bytes.readUInt32BE(16) < 320 || bytes.readUInt32BE(20) < 400) fail(file, 'screenshot is too small for the documented UI');
}
if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; }
console.log(JSON.stringify({passed: errors.length === 0, markdown_files: markdown.length, local_and_external_links: links,
  image_embeds: images, svg_diagrams: svgs.length, png_screenshots: pngs.length, external_requests: 0, errors: errors.length}));
