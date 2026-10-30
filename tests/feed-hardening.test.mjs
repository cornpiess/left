import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');




test('memory card is memoized off-screen and always re-renders when active', async () => {
  const card = await readSource('../src/components/MemoryCard.js');
  assert.match(card, /function memoryCardPropsEqual\(prev, next\)/);
  assert.match(card, /if \(prev\.active \|\| next\.active\) return false;/);
  assert.match(card, /export default memo\(MemoryCard, memoryCardPropsEqual\)/);
});

test('favorite commits carry an identity guard and settle-based re-entry lock (ISSUE-004)', async () => {
  const card = await readSource('../src/components/MemoryCard.js');
  assert.match(card, /favOpVersionRef/);
  const commitFav = card.match(/const commitFav = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[/)?.[0] || '';
  assert.match(commitFav, /const committedItemId = item\?\.id/);
  assert.match(commitFav, /isStale/);
  assert.doesNotMatch(commitFav, /snapBack\(\(\) => \{ trashingRef\.current = false; \}\)/);
});

test('sandbox prune keeps the in-memory cache coherent with disk (ISSUE-006)', async () => {
  const media = await readSource('../src/media.js');
  const prune = media.match(/export async function pruneSandboxDirectory\(maxFiles = 50\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(prune, /deletedPaths/);
  assert.match(prune, /sandboxMediaCache\.entries\(\)/);
  assert.match(prune, /sandboxMediaCache\.delete\(cachedId\)/);

  // Interrupted exports must not be mistaken for valid files forever.
  const getSandbox = media.match(/export async function getSandboxMediaUri\(item\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(getSandbox, /size === 0/);
  assert.match(getSandbox, /deleteAsync\(target/);
});

test('purchase and restore results resolve through i18n message keys', async () => {
  const membership = await readSource('../src/membership.js');
  const paywall = await readSource('../src/components/PaywallModal.js');
  const home = await readSource('../src/screens/HomeScreen.js');

  assert.doesNotMatch(membership, /message: '[^m]/, 'no raw hardcoded message strings may remain');
  assert.match(membership, /messageKey: 'paywall\.buyCancelled'/);
  assert.match(membership, /messageKey: 'menu\.noOrdersFound'/);
  assert.match(paywall, /t\(res\.messageKey \|\| 'paywall\.restoreFailed'\)/);
  assert.doesNotMatch(home, /restoreIapPurchases\(/, 'Restore lives in the shared purchase component');

  const locales = ['zh-Hans', 'zh-Hant', 'en', 'es', 'ja', 'ko'];
  for (const locale of locales) {
    const src = await readSource(`../src/i18n/locales/${locale}.js`);
    assert.match(src, /buyCancelled:/, `${locale} must define paywall.buyCancelled`);
    assert.match(src, /restoreUnavailable:/, `${locale} must define paywall.restoreUnavailable`);
  }
});
