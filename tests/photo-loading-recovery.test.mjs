import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderComponent, flatten } from './support/render-component.mjs';
import { runtime, photo } from './support/media-runtime.mjs';
import * as mediaPage from '../src/mediaPage.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const swift = read('modules/maoqiu-photo-preview/ios/PhotoResources.swift');
const view = read('modules/maoqiu-photo-preview/ios/MaoqiuPhotoPreviewModule.swift');

function card(native = true) {
  const events = [];
  const props = { item: photo('a', 10000), items: [], active: true, preload: true, height: 800, purpose: 'feed' };
  const c = renderComponent('components/MemoryCard.js', props, {
    '../nativePhotoPreview': { supportsNativePhotoPreview: native },
    '../mediaPage.mjs': mediaPage,
    '../media': {
      isVideoAsset: item => item.mediaType === 'video', isItemFavorite: () => false,
      reportMediaDisplayFailure: item => events.push(['failed', item.id]),
      reportMediaDisplaySuccess: item => events.push(['ready', item.id]),
    },
  });
  const render = () => c.render();
  const surface = () => flatten(render()).find(node => node.props.assetId === props.item.id && node.props.onProgress);
  const texts = () => flatten(render()).flatMap(node => node.children.filter(child => typeof child === 'string'));
  const retry = () => flatten(render()).find(node => node.props.onPress && node.props.accessibilityRole === 'button');
  return { c, props, events, render, surface, texts, retry };
}

test('failed native photo offers a real retry, then recovers without replacing its view', () => {
  const s = card();
  const key = s.surface().props.key;
  s.surface().props.onError({ nativeEvent: { assetId: 'a', reason: 'offline', hasImage: false } });
  assert.ok(s.texts().includes('home.mediaOffline'));
  assert.ok(s.texts().includes('home.mediaSkipHint'));
  assert.deepEqual(s.events, [['failed', 'a']]);
  s.retry().props.onPress();
  assert.equal(s.surface().props.retryVersion, 1);
  assert.equal(s.surface().props.key, key, 'same native view retains any preview during retry');
  assert.ok(!s.texts().includes('home.mediaOffline'));
  s.surface().props.onLoad({ nativeEvent: { assetId: 'a', degraded: true } });
  assert.deepEqual(s.events.at(-1), ['ready', 'a']);
  assert.equal(s.retry(), undefined);
});

test('a retained preview cannot be replaced by a quality-upgrade error', () => {
  const s = card();
  s.surface().props.onLoad({ nativeEvent: { assetId: 'a', degraded: true } });
  s.surface().props.onError({ nativeEvent: { assetId: 'a', hasImage: true, reason: 'cloud-timeout' } });
  assert.deepEqual(s.events, [['ready', 'a']]);
  assert.equal(s.retry(), undefined);
});

test('network recovery clears the terminal error and stale photo receipts cannot win', () => {
  const s = card(), oldSurface = s.surface();
  oldSurface.props.onError({ nativeEvent: { assetId: 'a', reason: 'cloud-timeout' } });
  s.surface().props.onProgress({ nativeEvent: { assetId: 'a', phase: 'local', progress: 0 } });
  assert.equal(s.retry(), undefined);
  s.props.item = photo('b', 20000); s.render();
  oldSurface.props.onLoad({ nativeEvent: { assetId: 'a' } });
  oldSurface.props.onError({ nativeEvent: { assetId: 'a', reason: 'offline' } });
  assert.deepEqual(s.events, [['failed', 'a']]);
});

test('video failure stays on its card and retry creates a fresh player', () => {
  const s = card(); s.props.item = photo('v', 30000, { mediaType: 'video', displayUri: 'ph://v' });
  const player = () => flatten(s.render()).find(node => node.props.onFailure);
  const key = player().props.key;
  player().props.onFailure();
  assert.equal(player(), undefined);
  assert.ok(s.texts().includes('home.videoLoadFailed'));
  s.retry().props.onPress();
  assert.notEqual(player().props.key, key);
  assert.deepEqual(s.events, [['failed', 'v']]);
});

test('file fallback stays visible after a broken primary source fails', () => {
  const s = card(false);
  s.props.item = photo('file', 10000, { imageUri: 'file:///broken.jpg', localUri: 'file:///fallback.jpg' });
  const image = () => flatten(s.render()).find(node => node.props.source?.uri && node.props.onLoad);
  assert.equal(image().props.source.uri, 'file:///broken.jpg');
  image().props.onError();
  assert.equal(image().props.source.uri, 'file:///fallback.jpg');
  image().props.onLoad();
  assert.equal(image().props.source.uri, 'file:///fallback.jpg');
  assert.deepEqual(s.events, [['ready', 'file']]);
});

test('failed media remains unreviewed and recovery clears the unresolved count', async () => {
  const r = runtime([photo('a', 10000), photo('b', 20000)]), m = r.media;
  await m.openBrowseSession(); await m.fetchMemoryPage();
  const item = photo('a', 10000);
  m.reportMediaDisplayFailure(item);
  assert.equal(m.getUnresolvedMediaCount(), 1);
  assert.equal((await r.store.reviewed(['a'])).size, 0);
  m.reportMediaDisplaySuccess(item);
  assert.equal(m.getUnresolvedMediaCount(), 0);
  assert.ok(r.events.every(event => event[0] !== 'review'));
});

test('native requests use bounded local/cloud phases and release cancelled subscriptions', () => {
  assert.match(swift, /options\(network: cloud\)/);
  assert.match(swift, /!\$0\.cloud \|\| !running\.contains\(where: \{ \$0\.cloud \}\)/);
  assert.match(swift, /cloud-timeout/);
  assert.match(swift, /task\.epoch == epoch/);
  assert.match(swift, /current\.epoch == epoch/);
  assert.match(swift, /task\.deadline\?\.cancel\(\)/);
  assert.match(swift, /manager\.cancelImageRequest\(task\.request\)/);
  assert.match(view, /if !degraded \{ token = nil \}/);
  assert.match(view, /guard window != nil, !loadBlocked/);
  assert.match(view, /PhotoResources\.availabilityChanged/);
});
