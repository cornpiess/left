import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('PRO and more-menu legal actions open the published pages without nested modals', async () => {
  const [paywall, moreMenu, legalNavigation] = await Promise.all([
    readSource('../src/components/PaywallModal.js'),
    readSource('../src/components/MoreMenuModal.js'),
    readSource('../src/legalNavigation.js'),
  ]);

  for (const source of [paywall, moreMenu]) {
    assert.match(source, /openLegalPage\(tab\)/);
    assert.match(source, /(?:openLegal|handleOpenLegal)\('privacy'\)/);
    assert.match(source, /(?:openLegal|handleOpenLegal)\('terms'\)/);
    assert.doesNotMatch(source, /<LegalModal\b/);
    assert.doesNotMatch(source, /legalModalVisible/);
  }

  assert.match(legalNavigation, /WebBrowser\.openBrowserAsync/);
  assert.match(legalNavigation, /Linking\.openURL/);
  assert.match(legalNavigation, /delete_photo\/privacy\.html/);
  assert.match(legalNavigation, /delete_photo\/terms\.html/);
});

test('the language switcher renders its expandable choices', async () => {
  const moreMenu = await readSource('../src/components/MoreMenuModal.js');

  assert.match(moreMenu, /langExpand\s*\?\s*\(/);
  assert.match(moreMenu, /LANGUAGES\.map/);
  assert.match(moreMenu, /setLanguage\(language\.id\)/);
});

test('StoreKit actions prevent duplicate purchase and restore requests', async () => {
  const paywall = await readSource('../src/components/PaywallModal.js');

  assert.match(paywall, /const \[pendingAction, setPendingAction\] = useState\(null\)/);
  assert.match(paywall, /if \(actionRef\.current\) return/);
  assert.match(paywall, /disabled=\{!yearlyProduct \|\| Boolean\(pendingAction\)\}/);
  assert.match(paywall, /disabled=\{!lifetimeProduct \|\| Boolean\(pendingAction\)\}/);
  assert.match(paywall, /disabled=\{Boolean\(pendingAction\)\}/);
  assert.match(paywall, /<ActivityIndicator/);
});

test('completion restarts viewed history and recommendation modes are selectable', async () => {
  const [home, moreMenu, media] = await Promise.all([
    readSource('../src/screens/HomeScreen.js'),
    readSource('../src/components/MoreMenuModal.js'),
    readSource('../src/media.js'),
  ]);

  assert.match(home, /item\.kind === 'complete'/);
  assert.match(home, /onPress=\{handleResetViewedHistory\}/);
  assert.match(moreMenu, /id: 'default'/);
  assert.match(moreMenu, /id: 'storage'/);
  assert.match(media, /AsyncStorage\.setItem\(RECOMMEND_MODE_STORAGE_KEY, mode\)/);
});

test('burst backdrop remains anchored instead of resetting on every frame', async () => {
  const memoryCard = await readSource('../src/components/MemoryCard.js');

  assert.match(memoryCard, /burstBackdropAnchorRef/);
  assert.match(memoryCard, /setBurstBackdropUri\(\(current\) => current \|\| uri\)/);
  assert.doesNotMatch(memoryCard, /setBurstBackdropUri\(null\)/);
});

test('granted permission never dead-ends on an empty first page', async () => {
  const [home, media] = await Promise.all([
    readSource('../src/screens/HomeScreen.js'),
    readSource('../src/media.js'),
  ]);

  // Numeric/cased mediaType tolerance; startup and retries have behavioral
  // coverage in photo-startup.test.mjs instead of asserting query fallbacks.
  assert.match(media, /mt === 'photo' \|\| mt === 'image' \|\| mt === '1'/);
  assert.match(media, /mt === 'video' \|\| mt === '2'/);

  // media.js: full-catalog scan announces itself so an empty feed can recover
  assert.doesNotMatch(media, /async function loadCatalog/);
  assert.match(media, /createCandidatePager/);

  // HomeScreen: catalog-ready refreshes an empty feed instead of dead-ending
  assert.match(home, /event\?\.type === 'catalog-ready' && !feedRef\.current\.length/);

  // HomeScreen: bounded auto-retry before settling on the empty-library screen
  assert.match(home, /EMPTY_LIBRARY_RETRY_LIMIT/);
  assert.match(home, /emptyRetryCount >= EMPTY_LIBRARY_RETRY_LIMIT/);
  assert.match(home, /if \(loadStatus !== 'empty-library'\) return undefined/);

  // Loading/preparing states are rendered distinctly from the empty verdict
  assert.match(home, /t\('home\.loadingHint'\)/);
  assert.match(home, /t\('home\.preparingHint'\)/);
  assert.match(home, /loadStatus === 'empty-library' && emptyRetryCount < EMPTY_LIBRARY_RETRY_LIMIT/);

  // Reset enters the loading UI synchronously (no empty-verdict flash window)
  assert.match(home, /setLoadStatus\('loading'\);/);
  assert.ok(
    home.indexOf("setLoadStatus('loading');") < home.indexOf('burstDiscoveryStartedRef.current = false;')
  );
});

test('bulk empty uses the system confirmation and resyncs after any outcome', async () => {
  const trashGallery = await readSource('../src/components/TrashGallery.js');
  assert.doesNotMatch(trashGallery, /Alert\.alert/);
  assert.match(trashGallery, /deletingRef.current/);
  assert.match(trashGallery, /finally[\s\S]*await refresh\(\)/);
  assert.match(trashGallery, /disabled=\{deleting\}/);
});

