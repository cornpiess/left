import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent, flatten } from './support/render-component.mjs';
import * as core from '../src/membershipCore.mjs';

function setup({ visible = true, status = 'error', settingsFail = false } = {}) {
  let reads = 0, settings = 0;
  const listeners = new Set(), messages = [];
  const props = { visible, reason: 'quota', onToast: message => messages.push(message) };
  const native = {
    StyleSheet: { create: value => value },
    AppState: { currentState: 'active', addEventListener: (_, fn) => { listeners.add(fn); return { remove: () => listeners.delete(fn) }; } },
    Linking: { openSettings: async () => { settings++; if (settingsFail) throw Error('cannot open'); } },
  };
  const c = renderComponent('components/PaywallModal.js', props, {
    'react-native': native,
    '../membership': {
      getMembershipState: () => ({ isPro: false }),
      getIapCatalogState: () => ({ products: {}, status }),
      subscribeIapProducts: () => () => {}, refreshIapCatalog: async () => { reads++; },
      IAP_SKUS: core.IAP_SKUS, PRICING_PLANS: { YEARLY: { title: '¥28' }, LIFETIME: { title: '¥98' } },
    },
  }, { effects: true });
  const render = () => { const tree = c.render(); c.flushEffects(); return tree; };
  const button = key => flatten(render()).find(node => node.props.onPress && flatten(node).some(child => child.children.includes(key)));
  const emit = state => { native.AppState.currentState = state; listeners.forEach(fn => fn(state)); };
  render();
  return { c, props, render, button, emit, messages, listeners, get reads() { return reads; }, get settings() { return settings; } };
}

test('catalog failure has retry and settings recovery; an idle catalog does not pretend permission was denied', () => {
  const error = setup();
  assert.ok(error.button('paywall.retryCatalog'));
  assert.ok(error.button('paywall.openNetworkSettings'));
  error.button('paywall.retryCatalog').props.onPress();
  assert.equal(error.reads, 1);
  error.c.unmount();
  const idle = setup({ status: 'idle' });
  assert.ok(idle.button('paywall.loadPrices'));
  assert.equal(idle.button('paywall.openNetworkSettings'), undefined);
  idle.c.unmount();
});

test('ordinary foreground changes never fetch prices; an explicit Settings return refreshes exactly once', async () => {
  const s = setup();
  s.emit('inactive'); s.emit('active'); assert.equal(s.reads, 0);
  const button = s.button('paywall.openNetworkSettings');
  await button.props.onPress(); await button.props.onPress();
  assert.equal(s.settings, 1, 'double taps share the settings visit');
  s.emit('inactive'); s.emit('background'); s.emit('active'); s.emit('active');
  assert.equal(s.reads, 1);
  s.emit('background'); s.emit('active'); assert.equal(s.reads, 1);
  await button.props.onPress(); s.emit('inactive'); s.emit('active'); assert.equal(s.reads, 2);
  s.c.unmount();
});

test('closing the paywall discards a pending Settings return and removes its subscription', async () => {
  const s = setup();
  await s.button('paywall.openNetworkSettings').props.onPress();
  s.props.visible = false; s.render(); assert.equal(s.listeners.size, 0);
  s.emit('inactive'); s.emit('active'); assert.equal(s.reads, 0);
  s.props.visible = true; s.render(); s.emit('inactive'); s.emit('active'); assert.equal(s.reads, 0);
  s.c.unmount(); assert.equal(s.listeners.size, 0);
});

test('a failed Settings handoff explains manual recovery, does not refetch on foreground, and remains retryable', async () => {
  const s = setup({ settingsFail: true });
  const button = s.button('paywall.openNetworkSettings');
  await button.props.onPress();
  assert.deepEqual(s.messages, ['paywall.networkSettingsFailed']);
  s.emit('inactive'); s.emit('active'); assert.equal(s.reads, 0);
  await button.props.onPress(); assert.equal(s.settings, 2);
  s.button('paywall.retryCatalog').props.onPress(); assert.equal(s.reads, 1);
  s.c.unmount();
});
