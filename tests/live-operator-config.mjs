// Configuration only: no network, credential reads, or directory creation.
import {requiredEnv, requiredPath, runtimeDir, serviceOrigin, certificateFile, browserExecutable} from '../scripts/operator-config.mjs';

export function testIdentifier(name, env = process.env) {
  const value = requiredEnv(name, env);
  // Safe in URL path segments and the quoted DOM selectors used by watchers.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error(`${name} must be an identifier`);
  return value;
}

export function liveSettings({channel = false, actors = [], baseline = false, deployment = false, web = false} = {}, env = process.env) {
  const result = {
    runtime: runtimeDir(env), origin: serviceOrigin(env), caPath: certificateFile(env), chrome: browserExecutable(env),
    projectId: testIdentifier('AGENT_LINK_TEST_PROJECT_ID', env), ownerId: testIdentifier('AGENT_LINK_TEST_OWNER_ID', env),
    keyPath: requiredPath('AGENT_LINK_TEST_KEY_FILE', env),
  };
  if (channel) result.channelId = testIdentifier('AGENT_LINK_TEST_CHANNEL_ID', env);
  result.actors = Object.fromEntries(actors.map(name => [name, testIdentifier(`AGENT_LINK_TEST_${name.toUpperCase()}_ACTOR_ID`, env)]));
  if (baseline) result.baselineId = testIdentifier('AGENT_LINK_TEST_BASELINE_EVENT_ID', env);
  if (deployment) result.deploymentPath = requiredPath('AGENT_LINK_TEST_DEPLOYMENT_FILE', env);
  if (web) result.webPath = requiredPath('AGENT_LINK_TEST_WEB_DIR', env);
  return result;
}
