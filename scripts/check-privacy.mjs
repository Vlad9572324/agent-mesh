#!/usr/bin/env node
// Offline current-tree regression gate, not a Git-history or secret audit.
// Prints locations/categories only, never matching values. No network calls.
import {readFileSync, lstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve, relative, sep, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rules = [
  ['private_ipv4', /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
  ['personal_email', /[A-Z0-9._%+-]+@(?:gmail|yahoo|hotmail|outlook|mail|yandex)\.[A-Z]{2,}/gi],
  ['operator_home_path', /\/home\/(?!example(?:\/|\b)|runner(?:\/|\b))[^/\s"'`<>]+\//g],
  ['operator_ddns_domain', /\b(?:[a-z0-9-]+\.)+(?:ddns\.net|duckdns\.org|no-ip\.org)\b/gi],
  ['private_key_literal', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
  ['provider_token_candidate', /(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{25,}|glpat-[A-Za-z0-9_.-]{20,}|sk-ant-api\d+-[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})/g],
];

export function privacyIssues(text) {
  const findings = [];
  for (const [category, pattern] of rules) {
    pattern.lastIndex = 0; let match;
    while ((match = pattern.exec(text))) findings.push({category, line: text.slice(0, match.index).split('\n').length});
  }
  return findings;
}

function main() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean))];
  const findings = []; let checked = 0;
  for (const path of files) {
    const target = resolve(root, path), rel = relative(root, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Repository path escaped root');
    let info;
    try { info = lstatSync(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) { findings.push({path, category: 'review_symlink', line: 1}); continue; }
    if (!info.isFile()) continue;
    const bytes = readFileSync(target);
    if (bytes.includes(0)) continue; // Images/binaries need their own artifact review.
    checked++;
    for (const finding of privacyIssues(bytes.toString('utf8'))) findings.push({path, ...finding});
  }
  const identity = execFileSync('git', ['log', '-1', '--format=%an <%ae>%n%cn <%ce>'], {cwd: root, encoding: 'utf8'});
  for (const finding of privacyIssues(identity)) findings.push({path: '(HEAD authorship)', ...finding});
  for (const item of findings) console.error(`${item.path}:${item.line}: ${item.category} (value withheld)`);
  console.log(JSON.stringify({passed: !findings.length, scope: 'current text tree and HEAD authorship; earlier history and binary artifacts not cleared',
    text_files: checked, findings: findings.length, external_requests: 0}));
  if (findings.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
