import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent, flatten } from './support/render-component.mjs';
import * as mediaPage from '../src/mediaPage.mjs';
import { onboardingSceneLayout } from '../src/onboardingMotion.mjs';

const i18n = { useI18n: () => ({ t: key => key, formatLocalizedDate: () => 'today' }) };
const texts = tree => flatten(tree).flatMap(node => node.children.filter(child => typeof child === 'string'));
const tick = () => new Promise(resolve => setImmediate(resolve));

test('GPS-only photos show coordinates in the upper-left panel, including zero coordinates', () => {
  const props = { item: { id: 'a', location: { latitude: 0, longitude: 0 } }, top: 62 };
  const c = renderComponent('components/MemoryInfoPanel.js', props, {
    '../i18n': i18n, '../mediaPage.mjs': mediaPage,
  });
  const tree = c.render();
  assert.equal(tree.props.style.at(-1).top, 62);
  assert.ok(texts(tree).includes('0.0000° N, 0.0000° E'));
});

test('location hydration cannot leak an old location onto the next photo', async () => {
  let finishFirst;
  const props = { item: { id: 'a' }, top: 62 };
  const c = renderComponent('components/MemoryInfoPanel.js', props, {
    '../i18n': i18n, '../mediaPage.mjs': mediaPage,
    '../media': {
      isVideoAsset: () => false, isItemFavorite: () => false,
      loadItemBasics: item => item.id === 'a' ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve(),
      getPlaceName: async item => item.id === 'a' ? 'old place' : '',
    },
  }, { effects: true });
  c.render(); c.flushEffects();
  props.item = { id: 'b', placeName: 'New full address', placeShortName: 'New city' };
  assert.ok(texts(c.render()).includes('New city'));
  c.flushEffects(); await tick();
  finishFirst(); await tick();
  assert.ok(!texts(c.render()).includes('old place'));
  flatten(c.render()).find(node => node.props.onPress).props.onPress();
  assert.ok(texts(c.render()).includes('New full address'));
  props.item = { id: 'no-gps' };
  const nextText = texts(c.render());
  assert.ok(!nextText.includes('New city') && !nextText.includes('New full address'));
  c.unmount();
});

test('the shared primary button gives its touch target width and its label internal padding', () => {
  const primary = renderComponent('components/Glass.js', { label: '我知道了', onPress() {} }, {}, { exportName: 'PrimaryButton' });
  const button = primary.render();
  assert.equal(button.props.containerStyle.width, '100%');
  assert.ok(button.props.style.paddingHorizontal >= 24);
  assert.ok(button.props.style.minHeight >= 54);
  const jelly = renderComponent('components/Glass.js', button.props, {}, { exportName: 'JellyPressable' });
  const native = jelly.render();
  assert.equal(native.props.style.at(-1).width, '100%');
  assert.equal(native.props.accessibilityRole, 'button');
  assert.equal(native.props.accessibilityLabel, '我知道了');
});

test('busy primary buttons expose a disabled touch target and loading state', () => {
  const c = renderComponent('components/Glass.js', { label: 'Continue', loading: true }, {}, { exportName: 'PrimaryButton' });
  const button = c.render();
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.accessibilityState.busy, true);
});

test('the teaching scene grows with available space and never exceeds its measured viewport', () => {
  const small = onboardingSceneLayout(272, 226);
  const normal = onboardingSceneLayout(345, 450);
  const large = onboardingSceneLayout(382, 520);
  const tablet = onboardingSceneLayout(520, 760);
  assert.ok(small.scale < normal.scale && normal.scale < large.scale && large.scale < tablet.scale);
  assert.ok(normal.scale > 1.2);
  for (const [width, height] of [[272, 226], [345, 450], [382, 520], [520, 760]]) {
    const scene = onboardingSceneLayout(width, height);
    assert.ok(scene.width <= width && scene.height <= height);
    assert.ok(scene.scale <= 1.8);
  }
});

test('the shared teaching section centres its content and accounts for actual multiline text height', () => {
  const props = { viewportHeight: 600 };
  const c = renderComponent('components/OnboardingExperience.js', props, { '../i18n': i18n });
  let tree = c.render();
  assert.equal(tree.props.style[0].justifyContent, 'center');
  assert.equal(tree.props.style[1].minHeight, 600);
  tree.props.onLayout({ nativeEvent: { layout: { width: 345 } } });
  const textNodes = flatten(tree).filter(node => node.props.onLayout && node !== tree);
  textNodes[0].props.onLayout({ nativeEvent: { layout: { height: 130 } } });
  textNodes[1].props.onLayout({ nativeEvent: { layout: { height: 70 } } });
  tree = c.render();
  const scene = flatten(tree).find(node => node.props.availableHeight !== undefined);
  assert.equal(scene.props.availableWidth, 345);
  assert.equal(scene.props.availableHeight, 340);
});

test('PhotoKit and file fallback renderers are display-only, preserving parent gestures', () => {
  for (const native of [true, false]) {
    const c = renderComponent('components/PhotoKitPreview.js', { assetId: native ? 'a' : undefined, uri: 'file://photo.jpg' }, {
      '../nativePhotoPreview': { NativePhotoPreview: native ? 'NativePhotoPreview' : null },
    });
    assert.equal(c.render().props.pointerEvents, 'none');
  }
});

test('the real feed locks/unlocks the native pager immediately and ignores queued drag events during pinch', () => {
  const entry = { key: 'photo', unit: { items: [{ id: 'a', mediaType: 'photo' }] } };
  const c = renderComponent('screens/HomeScreen.js', { accessPrivileges: 'all' });
  c.render();
  c.slots[0] = [entry]; c.slots[1] = false; c.slots[6] = 800;
  // Seed the raw-assets ref as well as the loaded-feed state, bypassing the
  // unrelated library/permission startup while exercising the real handlers.
  c.slots.find(slot => Array.isArray(slot?.current)).current = entry.unit.items;
  const pager = flatten(c.render()).find(node => node.props.pagingEnabled && node.props.renderItem);
  assert.ok(pager);
  assert.equal(pager.props.pinchGestureEnabled, false);
  const nativeUpdates = [];
  pager.props.ref.current = { getNativeScrollRef: () => ({ setNativeProps: props => nativeUpdates.push(props.scrollEnabled) }) };
  const card = pager.props.renderItem({ item: entry, index: 0 });
  card.props.onHorizontalGestureChange(true);
  pager.props.onScrollBeginDrag();
  const locked = flatten(c.render()).find(node => node.props.pagingEnabled && node.props.renderItem);
  assert.equal(locked.props.scrollEnabled, false);
  card.props.onHorizontalGestureChange(false);
  assert.deepEqual(nativeUpdates, [false, true]);
  const unlocked = flatten(c.render()).find(node => node.props.pagingEnabled && node.props.renderItem);
  assert.equal(unlocked.props.scrollEnabled, true);
});
