import assert from 'node:assert/strict';
import {privacyIssues} from '../scripts/check-privacy.mjs';

const blocked = [
  ['private_ipv4', ['192', '168', '2', '3'].join('.')],
  ['private_ipv4', ['10', '2', '3', '4'].join('.')],
  ['private_ipv4', ['172', '20', '3', '4'].join('.')],
  ['personal_email', 'fictional-person' + '@' + 'gmail.com'],
  ['operator_home_path', '/home/' + 'operator-name' + '/state'],
  ['operator_ddns_domain', 'fixture-host' + '.' + 'ddns.net'],
  ['private_key_literal', '-----BEGIN ' + 'PRIVATE KEY-----'],
  ['provider_token_candidate', 'github_pat_' + 'x'.repeat(40)],
  ['provider_token_candidate', 'glpat-' + 'x'.repeat(20)],
];
for (const [category, text] of blocked) {
  assert(privacyIssues(text).some(item => item.category === category), category);
  const report = JSON.stringify(privacyIssues(text));
  assert(!report.includes(text), 'Report must not echo detected values');
}
for (const text of ['127.0.0.1', '192.0.2.10', '198.51.100.10', '203.0.113.10',
  '/home/example/workspace', '/home/runner/work/project', 'agent@example.test',
  '101418967+Vlad9572324@users.noreply.github.com', 'https://agent-mesh.example']) {
  assert.deepEqual(privacyIssues(text), [], text);
}
assert.equal(privacyIssues('safe\n' + blocked[0][1])[0].line, 2);
console.log('PASS: current-tree privacy rules, synthetic fixtures and redacted findings');
