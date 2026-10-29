import test from 'node:test';
import assert from 'node:assert/strict';
import { collectUsablePage, computeStorageImpactScore, getEmptyPageStatus, getPhotoKitAssetRef, getPhotoKitPreviewUri, getRenderableDisplayUri, getRenderableImageUri, mergeStartupMedia, pruneReleasedBurstFrames } from '../src/mediaPage.mjs';

test('keeps the visible cached prefix stable while fresh PhotoKit items append', () => {
  const cachedItems = [
    { id: 'cached-visible', uri: 'file:///old.jpg' },
    { id: 'cached-second' },
  ];
  const freshItems = [
    { id: 'fresh-first' },
    { id: 'cached-visible', uri: 'file:///refreshed.jpg' },
  ];

  const merged = mergeStartupMedia({ cachedItems, freshItems, viewedIds: new Set(), trashIds: new Set() });

  assert.deepEqual(merged.map((item) => item.id), ['cached-visible', 'cached-second', 'fresh-first']);
  assert.equal(merged[0].uri, 'file:///refreshed.jpg');
});

test('never flashes viewed or trashed cached items during cold start', () => {
  const merged = mergeStartupMedia({
    cachedItems: [{ id: 'viewed' }, { id: 'trash' }, { id: 'safe' }],
    freshItems: [{ id: 'viewed' }, { id: 'fresh' }],
    viewedIds: new Set(['viewed']),
    trashIds: new Set(['trash']),
  });

  assert.deepEqual(merged.map((item) => item.id), ['safe', 'fresh']);
});

test('keeps a cached card visible after the active card is marked viewed during refresh', () => {
  const viewedIds = new Set();
  const startupViewed = new Set(viewedIds);
  const visibleCache = mergeStartupMedia({ cachedItems: [{ id: 'visible' }], viewedIds: startupViewed });
  viewedIds.add('visible');

  const refreshed = mergeStartupMedia({
    cachedItems: visibleCache,
    freshItems: [{ id: 'fresh' }],
    viewedIds: startupViewed,
  });

  assert.deepEqual(refreshed.map((item) => item.id), ['visible', 'fresh']);
});

test('keeps ph:// out of photo rendering while allowing it as a video playback source', () => {
  assert.equal(getRenderableDisplayUri({ isVideo: false, localUri: null, systemUri: 'ph://photo' }), null);
  assert.equal(getRenderableDisplayUri({ isVideo: false, localUri: 'file:///photo.heic', systemUri: 'ph://photo' }), 'file:///photo.heic');
  assert.equal(getRenderableDisplayUri({ isVideo: true, localUri: null, systemUri: 'ph://video' }), 'ph://video');
  assert.equal(getRenderableDisplayUri({ isVideo: true, localUri: 'file:///video.mov', systemUri: 'https://example.com/video.mov' }), 'file:///video.mov');
});

test('requires local image files on iOS image boundaries', () => {
  assert.equal(getRenderableImageUri('ph://photo'), null);
  assert.equal(getRenderableImageUri('https://example.com/photo.jpg'), null);
  assert.equal(getRenderableImageUri('file:///photo.heic'), 'file:///photo.heic');
  assert.equal(getRenderableImageUri('https://example.com/photo.jpg', true), 'https://example.com/photo.jpg');
});

test('keeps an iCloud photo preview clean when systemUri is a ph:// reference', () => {
  assert.equal(getPhotoKitPreviewUri({ isVideo: false, systemUri: 'ph://photo/L0/001' }), null);
  assert.equal(getPhotoKitPreviewUri({ isVideo: true, systemUri: 'ph://video/L0/001' }), null);
  assert.equal(getPhotoKitPreviewUri({ isVideo: false, systemUri: 'file:///photo.heic' }), 'file:///photo.heic');
});

test('normalizes legacy and PhotoKit asset ids for the next media-library API', () => {
  assert.equal(getPhotoKitAssetRef({ id: '79948467-CA60-4094-BC6B-1CF05CEFB307/L0/001' }), 'ph://79948467-CA60-4094-BC6B-1CF05CEFB307/L0/001');
  assert.equal(getPhotoKitAssetRef({ id: 'ph://79948467-CA60-4094-BC6B-1CF05CEFB307/L0/001' }), 'ph://79948467-CA60-4094-BC6B-1CF05CEFB307/L0/001');
});

test('only labels a page all-viewed when the accessible library had candidates', () => {
  assert.equal(getEmptyPageStatus({ pageStatus: 'empty-library', candidates: 0, initialAssets: 240, viewed: 20 }), 'all-viewed');
  assert.equal(getEmptyPageStatus({ pageStatus: 'empty-library', candidates: 0, initialAssets: 240, viewed: 20, discoveryError: true }), 'empty-library');
  assert.equal(getEmptyPageStatus({ pageStatus: 'empty-library', candidates: 0, initialAssets: 0, viewed: 20 }), 'empty-library');
  assert.equal(getEmptyPageStatus({ pageStatus: 'error', candidates: 0, initialAssets: 240, viewed: 20 }), 'error');
});

test('continues past unresolved candidates until the page contains usable media', async () => {
  const candidates = [
    ...Array.from({ length: 50 }, (_, index) => ({ id: `cloud-${index}` })),
    ...Array.from({ length: 10 }, (_, index) => ({ id: `local-${index}` })),
  ];
  let cursor = 0;

  const page = await collectUsablePage({
    limit: 10,
    async nextCandidates() {
      const items = candidates.slice(cursor, cursor + 50);
      cursor += items.length;
      return { items, hasMore: cursor < candidates.length };
    },
    async resolveCandidates(items) {
      const usable = items.filter((item) => item.id.startsWith('local-'));
      return {
        items: usable,
        diagnostics: {
          local: usable.length,
          cloud: items.length - usable.length,
          failed: 0,
        },
      };
    },
  });

  assert.deepEqual(page.items.map((item) => item.id), [
    'local-0',
    'local-1',
    'local-2',
    'local-3',
    'local-4',
    'local-5',
    'local-6',
    'local-7',
    'local-8',
    'local-9',
  ]);
  assert.equal(page.diagnostics.candidates, 60);
  assert.equal(page.status, 'ready');
});

test('reports cloud-only candidates with empty-library status when no usable items are returned', async () => {
  const page = await collectUsablePage({
    limit: 1,
    async nextCandidates() {
      return { items: [{ id: 'cloud-0' }], hasMore: false };
    },
    async resolveCandidates() {
      return {
        items: [],
        diagnostics: { local: 0, cloud: 1, failed: 0 },
      };
    },
  });

  assert.equal(page.items.length, 0);
  assert.equal(page.status, 'empty-library');
  assert.equal(page.diagnostics.cloud, 1);
});

test('serves an iCloud preview immediately while the original keeps downloading', async () => {
  const preview = { id: 'cloud-preview-0', previewUri: 'ph://cloud-preview-0' };
  const page = await collectUsablePage({
    limit: 1,
    async nextCandidates() {
      return { items: [preview], hasMore: true };
    },
    async resolveCandidates() {
      return {
        items: [preview],
        diagnostics: { local: 0, cloud: 1, preview: 1, failed: 0 },
      };
    },
  });

  assert.deepEqual(page.items, [preview]);
  assert.equal(page.status, 'ready');
  assert.equal(page.diagnostics.local, 0);
  assert.equal(page.diagnostics.preview, 1);
});

test('reports resolver failures instead of disguising them as an empty library', async () => {
  const page = await collectUsablePage({
    limit: 1,
    async nextCandidates() {
      return { items: [{ id: 'broken-0' }], hasMore: false };
    },
    async resolveCandidates() {
      return {
        items: [],
        diagnostics: { local: 0, cloud: 0, failed: 1 },
      };
    },
  });

  assert.equal(page.items.length, 0);
  assert.equal(page.status, 'error');
  assert.equal(page.diagnostics.failed, 1);
});

test('returns empty-library status when candidate fetching yields no items', async () => {
  const page = await collectUsablePage({
    limit: 1,
    async nextCandidates() {
      return { items: [], hasMore: true };
    },
    async resolveCandidates() {
      return { items: [], diagnostics: { local: 0, cloud: 0, failed: 0 } };
    },
  });

  assert.equal(page.items.length, 0);
  assert.equal(page.status, 'empty-library');
});

test('continues after an empty candidate batch when the source still has candidates', async () => {
  let calls = 0;
  const page = await collectUsablePage({
    limit: 1,
    async nextCandidates() {
      calls += 1;
      return calls === 1
        ? { items: [], hasMore: true }
        : { items: [{ id: 'local-after-skip' }], hasMore: false };
    },
    async resolveCandidates(items) {
      return { items, diagnostics: { local: items.length, cloud: 0, failed: 0 } };
    },
  });

  assert.deepEqual(page.items.map((item) => item.id), ['local-after-skip']);
  assert.equal(calls, 2);
});

test('never reports no accessible photos while iCloud candidates are still preparing', () => {
  assert.equal(getEmptyPageStatus({
    pageStatus: 'empty-library',
    candidates: 20,
    initialAssets: 20,
    viewed: 0,
    pendingCloud: 20,
  }), 'cloud-pending');
});

test('reports an error instead of completion when iCloud retries are exhausted', () => {
  assert.equal(getEmptyPageStatus({
    pageStatus: 'empty-library',
    candidates: 0,
    initialAssets: 20,
    viewed: 19,
    exhaustedCloud: 1,
  }), 'error');
});

test('removes released burst frames so they can return later as unseen cards', () => {
  const items = [{ id: 'seen-frame' }, { id: 'unseen-1' }, { id: 'unseen-2' }, { id: 'next-card' }];
  assert.deepEqual(
    pruneReleasedBurstFrames(items, new Set(['unseen-1', 'unseen-2'])).map((item) => item.id),
    ['seen-frame', 'next-card']
  );
});

test('storage impact uses legacy video seconds and photo resolution when exact bytes are unknown', () => {
  const longVideo = computeStorageImpactScore({ items: [{ mediaType: 'video', duration: 120 }] });
  const shortVideo = computeStorageImpactScore({ items: [{ mediaType: 'video', duration: 10 }] });
  const largePhoto = computeStorageImpactScore({ items: [{ mediaType: 'photo', width: 12000, height: 9000 }] });
  const smallPhoto = computeStorageImpactScore({ items: [{ mediaType: 'photo', width: 1200, height: 900 }] });
  assert.ok(longVideo > shortVideo);
  assert.ok(largePhoto > smallPhoto);
});

test('preserves resolved overflow for the next page instead of losing feed items', async () => {
  const carryOver = [];
  let fetched = false;
  const nextCandidates = async () => {
    if (fetched) return { items: [], hasMore: false };
    fetched = true;
    return {
      items: Array.from({ length: 6 }, (_, index) => ({ id: `asset-${index + 1}` })),
      hasMore: false,
    };
  };
  const resolveCandidates = async (items) => ({
    items,
    diagnostics: { local: items.length, cloud: 0, preview: 0, failed: 0 },
  });

  const first = await collectUsablePage({ limit: 5, nextCandidates, resolveCandidates, carryOver });
  const second = await collectUsablePage({ limit: 5, nextCandidates, resolveCandidates, carryOver });

  assert.deepEqual(first.items.map((item) => item.id), ['asset-1', 'asset-2', 'asset-3', 'asset-4', 'asset-5']);
  assert.deepEqual(second.items.map((item) => item.id), ['asset-6']);
  assert.equal(first.hasNextPage, true);
  assert.equal(second.hasNextPage, false);
});
