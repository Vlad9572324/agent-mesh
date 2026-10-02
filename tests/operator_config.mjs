import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, symlinkSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join, dirname} from 'node:path';
import {repositoryRoot, requiredEnv, requiredPath, runtimeDir, serviceOrigin, certificateFile, browserExecutable} from '../scripts/operator-config.mjs';

for (const value of [undefined, '', ' padded', 'padded ', 'bad\nvalue', 'bad\0value']) {
  assert.throws(() => requiredEnv('SETTING', {SETTING: value}));
}
for (const value of ['relative', '~/private', 'https://example.test']) {
  assert.throws(() => requiredPath('SETTING', {SETTING: value}));
}
for (const path of ['/', homedir(), repositoryRoot, join(repositoryRoot, 'state'), dirname(repositoryRoot)]) {
  assert.throws(() => runtimeDir({AGENT_LINK_RUNTIME_DIR: path}));
}
const directory = mkdtempSync(join(tmpdir(), 'agent-mesh-config-'));
try {
  const selected = join(directory, 'not-created');
  assert.equal(runtimeDir({AGENT_LINK_RUNTIME_DIR: selected}), selected);
  assert.equal(existsSync(selected), false);
  symlinkSync(repositoryRoot, join(directory, 'link'), 'dir');
  assert.throws(() => runtimeDir({AGENT_LINK_RUNTIME_DIR: join(directory, 'link', 'state')}));
  writeFileSync(join(directory, 'file'), 'fixture');
  assert.throws(() => runtimeDir({AGENT_LINK_RUNTIME_DIR: join(directory, 'file')}));
} finally { rmSync(directory, {recursive: true}); }
for (const value of ['http://127.0.0.1:8766', 'https://user:pass@example.test', 'https://example.test/path',
  'https://@example.test', 'https://:@example.test',
  'https://example.test/?q=x', 'https://example.test/#x', 'https://example.test/..', 'https://example.test\\path',
  'https://example.test:99999', 'https://exa mple.test']) {
  assert.throws(() => serviceOrigin({AGENT_LINK_ORIGIN: value}));
}
assert.equal(serviceOrigin({AGENT_LINK_ORIGIN: 'https://example.test:8766/'}), 'https://example.test:8766');
assert.throws(() => certificateFile({}));
assert.throws(() => browserExecutable({}));
assert.equal(certificateFile({AGENT_LINK_CA_FILE: '/tmp/fixture/ca.crt'}), '/tmp/fixture/ca.crt');
assert.equal(browserExecutable({AGENT_LINK_CHROME: '/usr/bin/chromium'}), '/usr/bin/chromium');
console.log('PASS: explicit operator paths, runtime isolation, HTTPS origins and missing settings');
