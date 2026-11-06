import test from 'node:test';
import assert from 'node:assert/strict';
import { FEEDBACK, feedbackPosition } from '../src/feedbackPolicy.mjs';
import { renderComponent, flatten } from './support/render-component.mjs';
import * as mediaPage from '../src/mediaPage.mjs';
import { MOTION } from '../src/motionCore.mjs';
import { readFileSync } from 'node:fs';

const texts = tree => flatten(tree).flatMap(n => n.children.filter(x => typeof x === 'string'));
function fakeClock() {
  let now = 0, sequence = 0; const tasks = new Map();
  return { setTimeout(fn, delay) { const id = ++sequence; tasks.set(id, { fn, at: now + delay }); return id; }, clearTimeout(id) { tasks.delete(id); },
    advance(ms) { const end = now + ms; while (true) { const next = [...tasks].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0]; if (!next) break; now = next[1].at; tasks.delete(next[0]); next[1].fn(); } now = end; }, get pending() { return tasks.size; } };
}
function feedback(props = {}) {
  const clock = fakeClock();
  const values = { state: 'loading', identity: 'a', title: 'Loading from iCloud', ...props };
  const c = renderComponent('components/Feedback.js', values, { '../motion': { useReducedMotion: () => true } }, { effects: true, clock });
  const render = () => { const tree = c.render(); c.flushEffects(); return c.render(); };
  return { c, props: values, clock, render };
}

test('loading has one 350ms grace period and adds explanation only after 1500ms', () => {
  const s = feedback({ progress: .42 });
  assert.equal(s.render(), null);
  s.clock.advance(349); assert.equal(s.render(), null);
  s.clock.advance(1);
  let nodes = flatten(s.render());
  assert.equal(nodes.filter(n => n.props.size === 'small').length, 1);
  assert.ok(!texts(s.render()).includes('Loading from iCloud'));
  s.clock.advance(1150);
  assert.ok(texts(s.render()).join('').includes('Loading from iCloud 42%'));
  s.props.state = 'ready'; assert.equal(s.render(), null);
  s.c.unmount(); assert.equal(s.clock.pending, 0);
});

test('new assets cannot inherit a previous spinner, and errors replace loading immediately', () => {
  const s = feedback({ actionLabel: 'Retry', onAction() {}, hint: 'Keep browsing' });
  s.render(); s.clock.advance(1600); s.render();
  s.props.identity = 'b'; assert.equal(s.render(), null);
  s.props.state = 'error'; s.props.title = 'Offline';
  const tree = s.render();
  assert.equal(flatten(tree).filter(n => n.props.size === 'small').length, 0);
  assert.ok(texts(tree).includes('Offline')); assert.ok(texts(tree).includes('Retry'));
  assert.equal(s.clock.pending, 0); s.c.unmount();
});

test('grid loading is silent and does not schedule spinner timers', () => {
  const s = feedback({ variant: 'tile', title: 'Unavailable' });
  assert.equal(s.render(), null); assert.equal(s.clock.pending, 0);
  s.props.state = 'error'; const tree = s.render();
  assert.deepEqual(texts(tree), ['Unavailable']);
  assert.equal(flatten(tree).filter(n => n.props.onPress).length, 0);
  s.c.unmount();
});

test('feedback centre is stable and measured long text switches to a scrollable safe layout', () => {
  assert.equal(feedbackPosition(600, 24).top + FEEDBACK.slot / 2, 300);
  assert.equal(feedbackPosition(600, 90).top + FEEDBACK.slot / 2, 300);
  for (const viewport of [200, 260, 480, 600]) for (const content of [24, 90, 180, 320, 500]) {
    const p = feedbackPosition(viewport, content);
    assert.ok(p.top >= 12); assert.equal(p.scroll, content > viewport - 24);
    if (!p.scroll) assert.ok(p.top + content <= viewport - 12);
  }
  const s = feedback({ state: 'error', title: 'Long explanation', actionLabel: 'Retry', onAction() {} });
  let tree = s.render(); tree.props.onLayout({ nativeEvent: { layout: { height: 200 } } });
  tree = s.render(); flatten(tree).find(n => n.props.onLayout && n !== tree).props.onLayout({ nativeEvent: { layout: { height: 320 } } });
  assert.ok(flatten(s.render()).some(n => n.props.contentContainerStyle?.flexGrow === 1)); s.c.unmount();
});

test('retry actions have pressed feedback, a 44pt target, and do not trigger the underlying burst tap', () => {
  let calls = 0, stopped = 0;
  const c = renderComponent('components/Feedback.js', { label: 'Retry', onPress: () => calls++ }, {}, { exportName: 'FeedbackAction' });
  const button = c.render();
  button.props.onTouchStart({ stopPropagation() { stopped++; } }); button.props.onTouchEnd({ stopPropagation() { stopped++; } }); button.props.onPress();
  assert.equal(stopped, 2); assert.equal(calls, 1);
  assert.equal(button.props.style({ pressed: false })[0].minHeight, 44);
  assert.equal(button.props.style({ pressed: true })[1].opacity, .65);
});

test('a thumbnail or full preview retains its displayed image through quality errors and rejects stale identities', () => {
  const props = { assetId: 'a', purpose: 'trashPreview' };
  const c = renderComponent('components/MediaPreview.js', props, { '../nativePhotoPreview': { supportsNativePhotoPreview: true } });
  const surface = () => flatten(c.render()).find(n => n.props.onProgress);
  const state = () => flatten(c.render()).find(n => n.props.variant === 'stage').props.state;
  surface().props.onLoad({ nativeEvent: { assetId: 'a', degraded: true } }); assert.equal(state(), 'ready');
  surface().props.onError({ nativeEvent: { assetId: 'a', reason: 'cloud-timeout' } }); assert.equal(state(), 'ready');
  const old = surface(); props.assetId = 'b'; c.render();
  old.props.onLoad({ nativeEvent: { assetId: 'a' } }); assert.equal(state(), 'loading');
  surface().props.onLoad({ nativeEvent: { assetId: 'a' } }); assert.equal(state(), 'loading');
  surface().props.onError({ nativeEvent: { assetId: 'b', reason: 'offline' } }); assert.equal(state(), 'error');
  flatten(c.render()).find(n => n.props.actionLabel && n.props.onAction).props.onAction();
  assert.equal(surface().props.retryVersion, 1); assert.equal(state(), 'loading');
});

test('unseen cards block cleanup and favorites but allow them after a real preview receipt', async () => {
  let cleaned = 0, favorites = 0;
  const item = { id: 'a', width: 3000, height: 4000, mediaType: 'photo' };
  const c = renderComponent('components/MemoryCard.js', { item, active: true, preload: true, height: 800, onPrepareTrash: async () => { cleaned++; return false; } }, {
    '../nativePhotoPreview': { supportsNativePhotoPreview: true }, '../mediaPage.mjs': mediaPage,
    '../motion': { MOTION, useReducedMotion: () => true, settleMotion: () => ({ start: callback => callback?.({ finished: true }) }), fadeMotion: () => ({ start() {} }) },
    '../media': { isVideoAsset: () => false, isItemFavorite: () => false, reportMediaDisplaySuccess() {}, toggleFavorite: async () => { favorites++; return { changed: false }; } },
  });
  c.render(); const handlers = () => c.slots.find(s => s?.current && Object.hasOwn(s.current, 'commitTrash'))?.current;
  await handlers().commitTrash(); handlers().commitFav(); assert.equal(cleaned, 0); assert.equal(favorites, 0);
  flatten(c.render()).find(n => n.props.assetId === 'a' && n.props.onLoad).props.onLoad({ nativeEvent: { assetId: 'a', degraded: true } }); c.render();
  await handlers().commitTrash(); handlers().commitFav(); await Promise.resolve();
  assert.equal(cleaned, 1); assert.equal(favorites, 1);
});

test('busy primary actions retain their label and fixed slots while preventing duplicate taps', () => {
  const c = renderComponent('components/Glass.js', { label: 'Continue', loading: true }, {}, { exportName: 'PrimaryButton' });
  const tree = c.render(); assert.ok(texts(tree).includes('Continue'));
  assert.equal(tree.props.disabled, true); assert.equal(tree.props.accessibilityState.busy, true);
  assert.ok(flatten(tree).some(n => n.props.style?.width === 24));
});

test('every locale has meaningful state copy and component code has one spinner implementation', async () => {
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'es']) {
    const { default: copy } = await import(`../src/i18n/locales/${locale}.js`);
    for (const value of [copy.feedback.unavailable, copy.feedback.listFailed, copy.dayCarousel.loadFailed]) assert.ok(value.length > 2);
  }
  for (const path of ['MemoryCard.js','DayMemoryCarousel.js','TrashGallery.js','Glass.js','PaywallModal.js']) {
    const source = readFileSync(new URL('../src/components/' + path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /ActivityIndicator|image-outline|hourglass-outline|videoLoadingMark/);
  }
});

test('same-day lookup keeps its anchor visible, exposes local retry, and protects its separate cleanup button', () => {
  const item = { id: 'anchor', width: 3000, height: 4000, mediaType: 'photo' };
  let retries = 0;
  const props = { items: [item], loading: true, error: false, onRetry: () => { retries++; props.loading = true; props.error = false; } };
  const c = renderComponent('components/DayMemoryCarousel.js', props, { '../i18n': { useI18n: () => ({ t: x => x, formatLocalizedDate: () => 'today' }) } });
  const list = () => flatten(c.render()).find(n => n.props.renderItem && n.props.horizontal);
  assert.equal(list().props.data[0].id, 'anchor');
  props.loading = false; props.error = true;
  assert.equal(list().props.data[0].id, 'anchor');
  const nodes = flatten(c.render());
  assert.ok(nodes.some(n => n.children.includes('dayCarousel.loadFailed')));
  const cleanup = nodes.find(n => n.props.accessibilityLabel === 'dayCarousel.moveToMaoqiuBtn');
  assert.equal(cleanup.props.disabled, true);
  flatten(list().props.renderItem({ item, index: 0 })).find(n => n.props.onMediaReady).props.onMediaReady(item);
  assert.equal(flatten(c.render()).find(n => n.props.accessibilityLabel === 'dayCarousel.moveToMaoqiuBtn').props.disabled, false);
  nodes.find(n => n.props.onPress === props.onRetry).props.onPress();
  assert.equal(retries, 1);
  assert.ok(!texts(c.render()).includes('dayCarousel.loadFailed'));
});

test('neutral and failed toasts never show success checkmarks', () => {
  const clock = fakeClock();
  const c = renderComponent('screens/HomeScreen.js', {}, { '../motion': { MOTION, useReducedMotion: () => true, fadeMotion: () => ({ start() {} }) } }, { clock });
  const show = flatten(c.render()).find(n => n.props.onToast).props.onToast;
  show('Could not save', 'error');
  let toast = flatten(c.render()).find(n => n.props.accessibilityLiveRegion === 'polite' && n.props.pointerEvents === 'none');
  assert.ok(texts(toast).includes('Could not save'));
  assert.equal(flatten(toast).filter(n => n.props.name).length, 0);
  show('Saved', 'success');
  toast = flatten(c.render()).find(n => n.props.accessibilityLiveRegion === 'polite' && n.props.pointerEvents === 'none');
  assert.equal(flatten(toast).filter(n => n.props.name === 'checkmark').length, 1);
});

test('a player callback from a previous retry cannot fail its replacement', () => {
  const props = { item: { id: 'v', mediaType: 'video', displayUri: 'ph://v', width: 1920, height: 1080 }, active: true, height: 800 };
  const c = renderComponent('components/MemoryCard.js', props, { '../mediaPage.mjs': mediaPage, '../media': { isVideoAsset: () => true, isItemFavorite: () => false, reportMediaDisplayFailure() {}, reportMediaDisplaySuccess() {} } });
  const player = () => flatten(c.render()).find(n => n.props.onFailure);
  const old = player(); old.props.onFailure();
  flatten(c.render()).find(n => n.props.onAction).props.onAction();
  const key = player().props.key;
  old.props.onFailure(); old.props.onFirstFrame();
  assert.equal(player().props.key, key);
  assert.ok(flatten(c.render()).some(n => n.props.state === 'loading'), 'old first frame must not claim readiness');
});
