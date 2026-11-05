import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
function extract(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `missing source boundary: ${start}`);
  return source.slice(first, last);
}

function command(invitationRuntime, selectedRuntime, checked) {
  const elements = new Map([
    ['admin-onboarding-runtime', {value: selectedRuntime}],
    ['admin-onboarding-yolo', {checked}],
    ['admin-onboarding-attended', {checked: true}],
  ]);
  const context = {
    URL, state: {},
    $: id => {
      if (!elements.has(id)) elements.set(id, {showModal() {}, focus() {}});
      return elements.get(id);
    },
    renderOnboardingScope() {}, setText() {}, tr() {}, dateText() {},
    loadOnboardingGuidance() {},
  };
  vm.createContext(context);
  vm.runInContext(extract('  function showOnboardingResult(result) {', '  async function onboardingAction('), context);
  context.showOnboardingResult({
    public_url: 'https://example.test:8766', repository: 'https://example.test/repo',
    spki_pin: 'sha256//' + 'A'.repeat(43) + '=', token: 'a'.repeat(64),
    invitation: {agent_id: 'agent-1', expires_at: '2030-01-01T00:00:00Z', runtime: invitationRuntime},
  });
  assert.equal(elements.get('admin-onboarding-yolo-notice').hidden,
    !(checked && selectedRuntime === invitationRuntime && invitationRuntime !== 'auto'));
  return context.state.onboardingCommand;
}

assert(!command('auto', 'auto', false).includes('--yolo'));
assert(!command('codex', 'codex', false).includes('--yolo'));
assert.match(command('codex', 'codex', true), / --runtime 'codex' --attended -- --yolo$/);
assert.match(command('claude', 'claude', true), / --runtime 'claude' --attended -- --dangerously-skip-permissions$/);
assert(!command('auto', 'codex', true).includes('--yolo'));
assert(!command('claude', 'codex', true).includes('--dangerously-skip-permissions'));

const elements = new Map([
  ['admin-onboarding-runtime', {value: 'auto', disabled: false}],
  ['admin-onboarding-yolo', {checked: true, disabled: false}],
  ['admin-onboarding-form', {querySelectorAll: () => [elements.get('admin-onboarding-runtime'), elements.get('admin-onboarding-yolo')]}],
  ['admin-onboarding-channels', {querySelectorAll: () => []}],
  ['admin-onboarding-list', {querySelectorAll: () => []}],
  ['admin-onboarding-submit', {disabled: false}],
  ['admin-onboarding-project', {value: 'project'}],
]);
const context = {
  state: {onboarding: {enabled: true}},
  $: id => elements.get(id), selectedOnboardingChannels: () => [], setText() {}, tr() {},
};
vm.createContext(context);
vm.runInContext(extract('  function updateOnboardingControls(unavailable) {', '  function renderOnboarding() {'), context);
context.updateOnboardingControls(false);
assert.equal(elements.get('admin-onboarding-yolo').checked, false);
assert.equal(elements.get('admin-onboarding-yolo').disabled, true);
elements.get('admin-onboarding-runtime').value = 'codex';
context.updateOnboardingControls(false);
assert.equal(elements.get('admin-onboarding-yolo').disabled, false);
console.log('onboarding YOLO command and opt-in controls: PASS');
