// Offline configuration tests; no browser, API, credential file or database.
import assert from 'node:assert/strict';
import test from 'node:test';
import {liveSettings, testIdentifier} from './live-operator-config.mjs';

const settings = {
  AGENT_LINK_RUNTIME_DIR: '/var/tmp/agent-mesh-config-fixture',
  AGENT_LINK_ORIGIN: 'https://198.51.100.20:8766',
  AGENT_LINK_CA_FILE: '/workspace-fixture/ca.crt', AGENT_LINK_CHROME: '/workspace-fixture/chromium',
  AGENT_LINK_TEST_PROJECT_ID: 'example-project', AGENT_LINK_TEST_OWNER_ID: 'example-owner',
  AGENT_LINK_TEST_KEY_FILE: '/workspace-fixture/owner.key', AGENT_LINK_TEST_CHANNEL_ID: 'example-channel',
  AGENT_LINK_TEST_CODEX_ACTOR_ID: 'example-writer', AGENT_LINK_TEST_CLAUDE_ACTOR_ID: 'example-reviewer',
  AGENT_LINK_TEST_BASELINE_EVENT_ID: 'example-event', AGENT_LINK_TEST_DEPLOYMENT_FILE: '/workspace-fixture/deployment.json',
  AGENT_LINK_TEST_WEB_DIR: '/workspace-fixture/web',
};
const all = {channel: true, actors: ['codex', 'claude'], baseline: true, deployment: true, web: true};

test('explicit settings preserve exact configured identities and targets', () => {
  const value = liveSettings(all, settings);
  assert.equal(value.origin, settings.AGENT_LINK_ORIGIN);
  assert.equal(value.channelId, settings.AGENT_LINK_TEST_CHANNEL_ID);
  assert.equal(value.actors.codex, settings.AGENT_LINK_TEST_CODEX_ACTOR_ID);
  assert.equal(value.baselineId, settings.AGENT_LINK_TEST_BASELINE_EVENT_ID);
  assert.equal(value.deploymentPath, settings.AGENT_LINK_TEST_DEPLOYMENT_FILE);
  assert.equal(value.webPath, settings.AGENT_LINK_TEST_WEB_DIR);
});

test('every requested setting is mandatory, without fallback', () => {
  for (const name of Object.keys(settings)) {
    const env = {...settings}; delete env[name];
    assert.throws(() => liveSettings(all, env), new RegExp(name));
  }
});

test('identifiers reject traversal and DOM/URL expression injection', () => {
  for (const value of ['../project', '.', '..', '/project', 'project?other', "x');throw 1;//", 'x" ]', 'x\\y', 'x y', 'x\n', '-x']) {
    assert.throws(() => testIdentifier('TARGET', {TARGET: value}));
  }
  assert.equal(testIdentifier('TARGET', {TARGET: 'example-id_2.3'}), 'example-id_2.3');
});

test('paths and service origin remain fail-closed', () => {
  for (const [name, value] of [
    ['AGENT_LINK_TEST_KEY_FILE', 'relative.key'], ['AGENT_LINK_TEST_DEPLOYMENT_FILE', 'relative.json'],
    ['AGENT_LINK_TEST_WEB_DIR', 'relative-web'], ['AGENT_LINK_ORIGIN', 'http://198.51.100.20'],
    ['AGENT_LINK_ORIGIN', 'https://198.51.100.20/project'], ['AGENT_LINK_ORIGIN', 'https://user@198.51.100.20'],
  ]) assert.throws(() => liveSettings(all, {...settings, [name]: value}));
});
