import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as core from '../src/membershipCore.mjs';
import { renderComponent, flatten } from './support/render-component.mjs';
const require = createRequire(import.meta.url), babel = require('@babel/core');
const code = babel.transformSync(readFileSync(new URL('../src/membership.js', import.meta.url), 'utf8'), {
  configFile: false, babelrc: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
}).code;

function membershipRuntime() {
  const calls = { require: 0, connect: 0, products: 0, purchases: 0, updateListeners: 0, errorListeners: 0, reads: 0, restores: 0 };
  const native = {
    initConnection: async () => { calls.connect++; return true; },
    fetchProducts: async () => { calls.products++; return [{ id: core.IAP_SKUS.YEARLY, displayPrice: '¥28' }, { id: core.IAP_SKUS.LIFETIME, displayPrice: '¥98' }]; },
    getAvailablePurchases: async () => { calls.purchases++; return [{ productId: core.IAP_SKUS.LIFETIME }]; },
    purchaseUpdatedListener: () => { calls.updateListeners++; return { remove() {} }; },
    purchaseErrorListener: () => { calls.errorListeners++; return { remove() {} }; },
    restorePurchases: async () => { calls.restores++; },
  };
  const modules = {
    'react-native': { Platform: { OS: 'ios' } },
    './reviewStore.js': { reviewStore: { dailyUsage: async () => 7 } },
    'expo-file-system/legacy': { documentDirectory: 'file:///local/', getInfoAsync: async () => ({ exists: true }),
      readAsStringAsync: async () => { calls.reads++; return JSON.stringify({ isPro: true, planType: 'lifetime', entitlementSource: 'storekit' }); }, writeAsStringAsync: async () => {} },
    'expo-crypto': {}, './promoHashes.json': [], './membershipCore.mjs': core,
    'expo-constants': { __esModule: true, default: { executionEnvironment: 'standalone' }, ExecutionEnvironment: { StoreClient: 'storeClient' } },
  };
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => {
    if (name === 'react-native-iap') { calls.require++; return native; }
    if (!(name in modules)) throw Error(`unexpected import ${name}`);
    return modules[name];
  }, console, Set, Map, Date, Promise, setTimeout, clearTimeout });
  return { membership: exports, calls };
}

test('startup and concurrent quota checks load cached Pro/usage once without even loading StoreKit', async () => {
  const { membership, calls } = membershipRuntime();
  await Promise.all([membership.initMembership(), membership.initMembership(), membership.initMembership()]);
  await membership.initMembership();
  assert.equal(calls.reads, 1);
  assert.equal(calls.require, 0);
  assert.equal(calls.connect, 0);
  assert.equal(calls.products, 0);
  assert.equal(calls.purchases, 0);
  assert.equal(membership.getMembershipState().isPro, true);
  assert.equal(membership.getMembershipState().usedToday, 7);
});

test('explicit concurrent price loads share one StoreKit connection, listener pair and catalog read', async () => {
  const { membership, calls } = membershipRuntime();
  await Promise.all([membership.refreshIapCatalog(), membership.refreshIapCatalog()]);
  assert.equal(calls.connect, 1);
  assert.equal(calls.products, 1);
  assert.equal(calls.updateListeners, 1);
  assert.equal(calls.errorListeners, 1);
  assert.equal(membership.getIapCatalogState().status, 'ready');
});

test('an explicit restore works from a cold local session without fetching price products', async () => {
  const { membership, calls } = membershipRuntime();
  const result = await membership.restoreIapPurchases();
  assert.equal(result.restored, true);
  assert.equal(calls.connect, 1);
  assert.equal(calls.restores, 1);
  assert.equal(calls.products, 0);
});

test('hidden and automatic quota paywalls do not request network prices; manual Pro does', () => {
  const prices = { products: {}, status: 'idle' }; let reads = 0;
  const props = { visible: false, reason: 'menu' };
  const c = renderComponent('components/PaywallModal.js', props, { '../membership': {
    getMembershipState: () => ({ isPro: false }), getIapCatalogState: () => prices,
    subscribeIapProducts: () => () => {}, refreshIapCatalog: async () => { reads++; },
    IAP_SKUS: core.IAP_SKUS, PRICING_PLANS: { YEARLY: { title: '¥28' }, LIFETIME: { title: '¥98' } },
  } }, { effects: true });
  c.render(); c.flushEffects(); assert.equal(reads, 0);
  props.visible = true; props.reason = 'quota';
  const nodes = flatten(c.render()); c.flushEffects(); assert.equal(reads, 0);
  const load = nodes.find(node => node.props.onPress && flatten(node).some(child => child.children.includes('paywall.loadPrices')));
  assert.ok(load); load.props.onPress(); assert.equal(reads, 1);
  props.reason = 'menu'; c.render(); c.flushEffects(); assert.equal(reads, 2);
  c.unmount();
});
