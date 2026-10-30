import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('an ErrorBoundary wraps the navigation tree and a global handler is installed (stability #1)', async () => {
  const [boundary, app, entry] = await Promise.all([
    readSource('../src/components/ErrorBoundary.js'),
    readSource('../App.js'),
    readSource('../index.js'),
  ]);

  assert.match(boundary, /static getDerivedStateFromError/);
  assert.match(boundary, /componentDidCatch/);
  assert.match(app, /<ErrorBoundary>/, 'App must wrap the navigation tree in ErrorBoundary');
  assert.match(entry, /ErrorUtils\.setGlobalHandler/, 'entry point must install a global JS error handler');
});

test('degenerate feed units can no longer crash MemoryCard render (stability #2)', async () => {
  const [home, card] = await Promise.all([
    readSource('../src/screens/HomeScreen.js'),
    readSource('../src/components/MemoryCard.js'),
  ]);
  assert.match(home, /if \(!cur\) return null;/, 'renderItem must drop units without a current item');
  assert.match(card, /item\?\.isLive/);
  assert.match(card, /item\?\.placeName/);
  const geometry = await readSource('../src/mediaWindow.mjs');
  assert.match(geometry, /item\?\.width \|\| 3/);
});




test('small hardening items (stability #6)', async () => {
  const [home, gallery, media] = await Promise.all([
    readSource('../src/screens/HomeScreen.js'),
    readSource('../src/components/TrashGallery.js'),
    readSource('../src/media.js'),
  ]);
  const loadNextPage = home.match(/const loadNextPage = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[makeFeed\]\);/)?.[0] || '';
  assert.match(loadNextPage, /catch \(err\)/, 'loadNextPage must not float rejections');

  const preview = gallery.match(/function TrashVideoPreview\(\{ uri \}\) \{[\s\S]*?\n\}\);/)?.[0] || '';
  assert.match(preview, /try \{/);

  const emptyTrash = media.slice(media.indexOf('const deletePendingTrash'), media.indexOf('/** Extract the paired video'));
  assert.match(emptyTrash, /deletedIds/);
  assert.match(emptyTrash, /deletedIds\.has\(/);
  assert.doesNotMatch(emptyTrash, /deletedIds\.includes/);
});

test('error boundary copy exists in every locale', async () => {
  const locales = ['zh-Hans', 'zh-Hant', 'en', 'es', 'ja', 'ko'];
  for (const locale of locales) {
    const src = await readSource(`../src/i18n/locales/${locale}.js`);
    assert.match(src, /boundaryTitle:/, `${locale} must define error.boundaryTitle`);
    assert.match(src, /boundaryRetry:/, `${locale} must define error.boundaryRetry`);
  }
});
