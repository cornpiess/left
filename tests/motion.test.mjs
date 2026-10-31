import test from 'node:test';
import assert from 'node:assert/strict';
import { MOTION, planExit } from '../src/motionCore.mjs';
import { loadMotionRuntime } from './support/motion-runtime.mjs';
import { renderComponent, flatten } from './support/render-component.mjs';

function nativeDriver({ delayedStop = false } = {}) {
  const records = [], stops = [];
  const interpolate = (read, config) => ({ config, read: () => {
    const { inputRange: x, outputRange: y } = config;
    const value = Math.max(x[0], Math.min(x.at(-1), read()));
    let i = 0; while (i < x.length - 2 && value > x[i + 1]) i++;
    const ratio = (value - x[i]) / (x[i + 1] - x[i]);
    return parseFloat(y[i]) + (parseFloat(y[i + 1]) - parseFloat(y[i])) * ratio;
  } });
  class Value {
    constructor(position) { this.position = position; this.animation = null; this.writes = []; this.stopCalls = 0; this.trackers = new Set(); }
    setValue(position) {
      this.animation?.stop(); this.position = position; this.writes.push(position);
      this.trackers.forEach(record => record.retarget(position));
    }
    stopAnimation(callback) {
      this.stopCalls++;
      this.animation?.stop();
      if (!callback) return;
      const position = this.position;
      if (delayedStop) stops.push(() => callback(position));
      else callback(position);
    }
    interpolate(config) { return interpolate(() => this.position, config); }
  }
  const animation = kind => (value, config) => {
    const tracking = config.toValue instanceof Value;
    const record = {
      kind, value, config, callback: null, ended: false, stopped: false,
      destination: tracking ? config.toValue.position : config.toValue, targets: [],
      start(callback) {
        value.animation?.stop(); value.animation = record; record.callback = callback;
        if (tracking) config.toValue.trackers.add(record);
        records.push(record);
      },
      retarget(destination) { if (!record.stopped) { record.destination = destination; record.targets.push(destination); record.ended = false; } },
      stop() {
        if (tracking) {
          config.toValue.trackers.delete(record); record.stopped = true; record.ended = true;
          if (value.animation === record) value.animation = null;
        } else record.finish(false);
      },
      finish(finished = true) {
        if (record.ended || record.stopped) return;
        record.ended = true;
        if (finished) value.position = record.destination;
        if (!tracking && value.animation === record) value.animation = null;
        record.callback?.({ finished });
      },
    };
    return record;
  };
  const native = {
    StyleSheet: { create: x => x }, Platform: { OS: 'ios' },
    useWindowDimensions: () => ({ width: 393, height: 852 }),
    PanResponder: { create: handlers => ({ panHandlers: handlers }) },
    Easing: { out: x => x, quad: x => x * x, bezier: (...points) => points },
    Animated: {
      Value, spring: animation('spring'), timing: animation('timing'),
      subtract: (a, b) => ({ interpolate: config => interpolate(() => a.position - b.position, config) }),
      parallel: animations => ({ start: () => animations.forEach(a => a.start()), stop: () => animations.forEach(a => a.stop()) }),
      sequence: animations => {
        let current = 0;
        const next = () => animations[current]?.start(({ finished }) => { if (finished) { current++; next(); } });
        return { start: next, stop: () => animations[current]?.stop() };
      },
    },
  };
  return { native, records, stops, flushStops: () => { while (stops.length) stops.shift()(); } };
}

test('exit timing responds to speed and distance and preserves a normal release tangent', () => {
  const slow = planExit(-60, -393, -0.1), fast = planExit(-60, -393, -2);
  const near = planExit(-300, -393, -0.1);
  assert.ok(fast.duration < slow.duration);
  assert.ok(near.duration < slow.duration);
  for (const plan of [slow, fast, near]) assert.ok(plan.duration >= 120 && plan.duration <= 220);
  // derivative at t=0 = (y1/x1) * distance / duration
  const speed = fast.bezier[1] / fast.bezier[0] * (-393 + 60) / fast.duration;
  assert.ok(Math.abs(speed + 2) < 1e-9);
  assert.equal(planExit(-393, -393, -1).duration, 0);
  assert.ok(planExit(100, 852, 0, true).duration < near.duration);
});

test('exit plans remain finite under noisy velocities and allow a small direction reversal', () => {
  for (const velocity of [NaN, Infinity, -Infinity, 0, -100, 100]) {
    const plan = planExit(-100, -393, velocity);
    assert.ok(Number.isFinite(plan.duration));
    assert.ok(plan.bezier.every(Number.isFinite));
  }
  assert.ok(planExit(-100, -393, 0.2).bezier[1] < 0);
});

test('return uses native near-critical damping and converts gesture velocity to points/second', () => {
  const driver = nativeDriver(), motion = loadMotionRuntime(driver.native);
  const value = new driver.native.Animated.Value(40);
  motion.settleMotion(value, 0, { velocity: 0.2 }).start();
  const { config } = driver.records[0];
  const ratio = config.damping / (2 * Math.sqrt(config.mass * config.stiffness));
  assert.ok(ratio >= 0.98 && ratio <= 1.1);
  assert.equal(config.velocity, 200);
  assert.equal(config.useNativeDriver, true);
  assert.equal(config.isInteraction, false);
  motion.settleMotion(value, 0, { reduced: true }).start();
  assert.equal(driver.records[1].kind, 'timing');
  assert.ok(driver.records[1].config.duration <= 100);
});

test('a card caught mid-return follows from its current position without a jump', () => {
  const driver = nativeDriver(), motion = loadMotionRuntime(driver.native);
  const value = new driver.native.Animated.Value(28), state = { version: 0 };
  motion.beginMotionDrag(value, state, 12);
  assert.equal(value.position, 28);
  motion.moveMotionDrag(value, state, 17);
  assert.equal(value.position, 33);
  assert.equal(state.position, 33);
});

test('late native handoff retains intervening moves and cannot overwrite a newer gesture', () => {
  const driver = nativeDriver({ delayedStop: true }), motion = loadMotionRuntime(driver.native);
  const value = new driver.native.Animated.Value(28), state = { version: 0 };
  motion.beginMotionDrag(value, state, 12);
  motion.moveMotionDrag(value, state, 20);
  driver.flushStops();
  assert.equal(value.position, 36);
  motion.beginMotionDrag(value, state, 12);
  state.dragging = false;
  value.position = 0;
  driver.flushStops();
  assert.equal(value.position, 0);
});

test('a re-grabbed downward panel stays inside its top boundary', () => {
  const driver = nativeDriver(), motion = loadMotionRuntime(driver.native);
  const value = new driver.native.Animated.Value(2), state = { version: 0, min: 0 };
  motion.beginMotionDrag(value, state, 12);
  motion.moveMotionDrag(value, state, 0);
  assert.equal(value.position, 0);
});

const touch = { nativeEvent: { touches: [{ pageX: 100, pageY: 100 }] } };
const gesture = (dx, vx = 0) => ({ dx, dy: 0, vx, vy: 0, numberActiveTouches: 1 });
function card({ prepare = async () => true, delayedStop = false, favorite, memoized = false } = {}) {
  const driver = nativeDriver({ delayedStop });
  const removed = [], favorites = [], haptics = [];
  const props = {
    item: { id: 'a', width: 3000, height: 4000, mediaType: 'photo' },
    items: [], active: true, preload: false, height: 800,
    onPrepareTrash: prepare, onTrash: item => removed.push(item.id),
    onFavoriteChange: value => favorites.push(value),
  };
  const runtime = renderComponent('components/MemoryCard.js', props, {
    'react-native': driver.native,
    'expo-haptics': { ImpactFeedbackStyle: { Light: 'light' }, impactAsync: type => { haptics.push(type); return Promise.resolve(); } },
    ...(favorite ? { '../media': { isVideoAsset: () => false, isItemFavorite: () => false, toggleFavorite: favorite } } : {}),
  }, { memoized });
  const render = () => flatten(runtime.render()).find(node => node.props.onPanResponderRelease).props;
  const handlers = render();
  return { ...driver, runtime, props, handlers, render, removed, favorites, haptics };
}

const pinchTouch = distance => ({ nativeEvent: {
  pageX: 100, pageY: 100,
  touches: [{ identifier: 0, pageX: 100, pageY: 100 }, { identifier: 1, pageX: 100 + distance, pageY: 100 }],
} });
const lifted = { nativeEvent: { touches: [] } };

for (const kind of ['photo', 'live', 'video', 'burst']) {
  test(`${kind}: inward pinch enters the day exactly once and does not become a tap or delete`, () => {
    const c = card({ memoized: true }), entered = [], locks = [], taps = [];
    Object.assign(c.props, {
      item: { ...c.props.item, mediaType: kind === 'video' ? 'video' : 'photo', isLive: kind === 'live' },
      groupCount: kind === 'burst' ? 3 : 1,
      onPinchIn: item => entered.push(item.id), onHorizontalGestureChange: value => locks.push(value),
      onGroupNext: () => taps.push('next'),
    });
    const h = c.render();
    h.onTouchStart(pinchTouch(100));
    h.onPanResponderGrant(pinchTouch(100), gesture(0));
    h.onPanResponderMove(pinchTouch(90), gesture(-70));
    h.onPanResponderMove(pinchTouch(70), gesture(-100));
    h.onTouchEnd(lifted);
    h.onPanResponderRelease(lifted, gesture(-100, -1));
    assert.deepEqual(entered, ['a']);
    assert.deepEqual(locks, [true, false]);
    assert.deepEqual(taps, []);
    assert.deepEqual(c.removed, []);
  });
}

test('a late responder grant preserves the distance from second-finger touchdown', () => {
  const c = card(), entered = [];
  c.props.onPinchIn = item => entered.push(item.id);
  const h = c.render();
  assert.equal(h.onStartShouldSetPanResponderCapture(pinchTouch(100), gesture(0)), true);
  h.onPanResponderGrant(pinchTouch(94), gesture(0));
  h.onPanResponderMove(pinchTouch(90), gesture(0));
  assert.deepEqual(entered, ['a']);
  h.onTouchEnd(lifted);
});

test('adding a second finger upgrades an owned swipe before its first pinch move', () => {
  const c = card(), entered = [];
  c.props.onPinchIn = item => entered.push(item.id);
  const h = c.render();
  h.onPanResponderGrant(touch, gesture(-20));
  h.onPanResponderStart(pinchTouch(100));
  h.onPanResponderMove(pinchTouch(90), gesture(-80));
  h.onPanResponderRelease(lifted, gesture(-80, -1));
  assert.deepEqual(entered, ['a']);
  assert.deepEqual(c.removed, []);
});

test('raw touch delivery shares recognition when a native child delays responder ownership', () => {
  const c = card(), entered = [], locks = [];
  c.props.onPinchIn = item => entered.push(item.id);
  c.props.onHorizontalGestureChange = value => locks.push(value);
  const h = c.render();
  h.onTouchStart(pinchTouch(100));
  h.onTouchMove(pinchTouch(90));
  h.onTouchEnd(lifted);
  assert.deepEqual(entered, ['a']);
  assert.deepEqual(locks, [true, false]);
});

test('an uncommitted/cancelled pinch unlocks and a subsequent pinch works', () => {
  for (const end of ['onPanResponderRelease', 'onPanResponderTerminate', 'onTouchCancel']) {
    const c = card(), entered = [], locks = [];
    c.props.onPinchIn = item => entered.push(item.id);
    c.props.onHorizontalGestureChange = value => locks.push(value);
    const h = c.render();
    h.onTouchStart(pinchTouch(100));
    h.onPanResponderGrant(pinchTouch(100), gesture(0));
    h.onPanResponderMove(pinchTouch(96), gesture(0));
    h[end](lifted, gesture(0));
    assert.deepEqual(entered, []);
    assert.equal(locks.at(-1), false, end);
    h.onTouchStart(pinchTouch(100));
    h.onPanResponderMove(pinchTouch(90), gesture(0));
    h.onTouchEnd(lifted);
    assert.deepEqual(entered, ['a'], end);
  }
});

test('a memoized responder uses the current burst frame and latest day-entry callback', () => {
  const c = card({ memoized: true }), entered = [];
  c.props.onPinchIn = () => entered.push('old callback');
  c.props.groupCount = 3;
  const old = c.render();
  c.props.item = { ...c.props.item, id: 'burst-frame-2' };
  c.props.onPinchIn = item => entered.push(item.id);
  const current = c.render();
  assert.equal(old.onPanResponderMove, current.onPanResponderMove, 'exercise retained responder closure');
  current.onPanResponderGrant(pinchTouch(100), gesture(0));
  current.onPanResponderMove(pinchTouch(90), gesture(0));
  current.onPanResponderRelease(lifted, gesture(0));
  assert.deepEqual(entered, ['burst-frame-2']);
});

test('shrinking a magnified photo reduces zoom before entering its day', () => {
  const c = card(), entered = [];
  c.props.onPinchIn = item => entered.push(item.id);
  const h = c.render();
  h.onPanResponderGrant(pinchTouch(100), gesture(0));
  h.onPanResponderMove(pinchTouch(200), gesture(0));
  h.onPanResponderRelease(lifted, gesture(0));
  h.onPanResponderGrant(pinchTouch(100), gesture(0));
  h.onPanResponderMove(pinchTouch(80), gesture(0));
  assert.deepEqual(entered, []);
  h.onPanResponderMove(pinchTouch(45), gesture(0));
  h.onPanResponderRelease(lifted, gesture(0));
  assert.deepEqual(entered, ['a']);
});

test('cancelled video pinches resume audio, while committed day entry keeps it silent', () => {
  const c = card(); let plays = 0;
  c.props.item = { ...c.props.item, mediaType: 'video', displayUri: 'file://video.mov' };
  c.props.onPinchIn = () => {};
  const player = { muted: true, volume: 0, playing: false,
    play() { plays++; this.playing = true; }, pause() { this.playing = false; } };
  flatten(c.runtime.render()).find(n => n.type?.name === 'MemoryVideo').props.onPlayerChange(player);
  const h = c.render();
  h.onPanResponderGrant(pinchTouch(100), gesture(0));
  h.onPanResponderMove(pinchTouch(96), gesture(0));
  h.onPanResponderRelease(lifted, gesture(0));
  assert.equal(plays, 1);
  h.onPanResponderGrant(pinchTouch(100), gesture(0));
  h.onPanResponderMove(pinchTouch(90), gesture(0));
  h.onPanResponderRelease(lifted, gesture(0));
  assert.equal(plays, 1);
  assert.equal(player.muted, true);
  assert.equal(player.playing, false);
});

test('a cancelled pinch does not swallow the next one-finger burst tap', () => {
  const c = card(); let turns = 0;
  c.props.groupCount = 3;
  c.props.onGroupNext = () => turns++;
  const h = c.render();
  h.onTouchStart(pinchTouch(100));
  h.onTouchCancel();
  h.onTouchStart(touch);
  h.onTouchEnd(lifted);
  assert.equal(turns, 1);
});

test('trash preview sizes and centres every media page in its measured content viewport', async () => {
  const driver = nativeDriver();
  let dimensions = { width: 393, height: 852 };
  const items = ['photo', 'video'].map((mediaType, index) => ({ id: `asset-${index}`, mediaType, displayUri: `ph://asset-${index}` }));
  const c = renderComponent('components/TrashGallery.js', { visible: true }, {
    'react-native': { ...driver.native, useWindowDimensions: () => dimensions },
    '../media': { fetchTrashSummary: async () => ({ items, count: 2, sizeBytes: 100, unknownCount: 0 }), isVideoAsset: item => item.mediaType === 'video' },
    '../nativePhotoPreview': { supportsNativePhotoPreview: true },
  }, { effects: true });
  let tree = flatten(c.render());
  tree.find(n => n.props.onLayout).props.onLayout({ nativeEvent: { layout: { width: 393, height: 724 } } });
  c.flushEffects();
  await tick();
  tree = flatten(c.render());
  const grid = tree.find(n => n.props.numColumns === 3);
  flatten(grid.props.renderItem({ item: items[0], index: 0 })).find(n => n.props.onPress).props.onPress();
  let preview = flatten(c.render()).find(n => n.props.horizontal);
  for (const [index, item] of items.entries()) {
    const slide = preview.props.renderItem({ item, index });
    assert.equal(slide.props.style.at(-1).height, 724);
    assert.equal(slide.props.style[0].justifyContent, 'center');
  }
  dimensions = { width: 852, height: 393 };
  tree = flatten(c.render());
  tree.find(n => n.props.onLayout).props.onLayout({ nativeEvent: { layout: { width: 852, height: 320 } } });
  preview = flatten(c.render()).find(n => n.props.horizontal);
  const layout = preview.props.getItemLayout(null, 1);
  assert.equal(layout.length, 852);
  assert.equal(layout.offset, 852);
  assert.equal(preview.props.renderItem({ item: items[0], index: 0 }).props.style.at(-1).height, 320);
  c.unmount();
});

const tick = () => new Promise(resolve => setImmediate(resolve));
test('actual swipe keeps short-drag cancellation and lets the next drag catch its return', () => {
  const c = card();
  c.handlers.onPanResponderGrant(touch, gesture(12));
  c.handlers.onPanResponderMove(touch, gesture(25));
  c.handlers.onPanResponderRelease(touch, gesture(25, 0.1));
  assert.deepEqual(c.removed, []);
  assert.equal(c.records[0].config.toValue, 0);
  const value = c.records[0].value;
  value.position = 8;
  c.handlers.onPanResponderGrant(touch, gesture(12));
  assert.equal(value.position, 8);
  c.handlers.onPanResponderMove(touch, gesture(17));
  assert.equal(value.position, 13);
  c.handlers.onPanResponderRelease(touch, gesture(17));
  assert.deepEqual(c.haptics, []);
});

test('a very quick release waits for the native position without losing the release decision', async () => {
  const c = card({ delayedStop: true });
  c.handlers.onPanResponderGrant(touch, gesture(-12));
  c.handlers.onPanResponderMove(touch, gesture(-80));
  const released = gesture(-80, -1);
  c.handlers.onPanResponderRelease(touch, released);
  released.dx = 0; released.vx = 0; // PanResponder resets its mutable state.
  c.flushStops(); await tick();
  assert.equal(c.records.length, 1);
  assert.equal(c.records[0].config.toValue, -393);
  c.records[0].finish();
  assert.deepEqual(c.removed, ['a']);
  assert.deepEqual(c.haptics, ['light']);
});

test('an interrupted exit never invokes the card-removal callback', async () => {
  const c = card();
  c.handlers.onPanResponderGrant(touch, gesture(-12));
  c.handlers.onPanResponderMove(touch, gesture(-80));
  c.handlers.onPanResponderRelease(touch, gesture(-80, -1));
  await tick();
  c.records[0].finish(false);
  assert.deepEqual(c.removed, []);
});

test('an old selection result cannot animate or remove a recycled card', async () => {
  let resolve;
  const c = card({ prepare: () => new Promise(r => { resolve = r; }) });
  c.handlers.onPanResponderGrant(touch, gesture(-12));
  c.handlers.onPanResponderMove(touch, gesture(-80));
  c.handlers.onPanResponderRelease(touch, gesture(-80, -1));
  c.props.item = { ...c.props.item, id: 'b' }; c.render();
  resolve(true); await tick();
  assert.equal(c.records.length, 0);
  assert.deepEqual(c.removed, []);
});

test('favorite feedback confirms success once and rejects a late result for another photo', async () => {
  let resolve;
  const c = card({ favorite: () => new Promise(r => { resolve = r; }) });
  c.handlers.onPanResponderGrant(touch, gesture(12));
  c.handlers.onPanResponderMove(touch, gesture(80));
  c.handlers.onPanResponderRelease(touch, gesture(80, 0.4));
  assert.deepEqual(c.haptics, []);
  resolve({ favorite: true, changed: true }); await tick();
  assert.deepEqual(c.haptics, ['light']);
  assert.deepEqual(c.favorites, [true]);
  assert.equal(c.records.find(r => r.config.toValue === 0 && r.kind === 'timing').config.duration, MOTION.feedbackMs);

  c.handlers.onPanResponderGrant(touch, gesture(12));
  c.handlers.onPanResponderMove(touch, gesture(80));
  c.handlers.onPanResponderRelease(touch, gesture(80, 0.4));
  c.props.item = { ...c.props.item, id: 'b' }; c.render();
  resolve({ favorite: false, changed: true }); await tick();
  assert.deepEqual(c.favorites, [true]);
  assert.deepEqual(c.haptics, ['light']);
});

test('same-day cleanup advances as soon as the card exits, even while the decorative pulse is running', async () => {
  const driver = nativeDriver(), removed = [];
  const c = renderComponent('components/DayMemoryCarousel.js', {
    items: [{ id: 'a', width: 3000, height: 4000, mediaType: 'photo' }],
    onPrepareTrash: async () => true, onTrash: item => removed.push(item.id),
  }, {
    'react-native': driver.native,
    '../useScrollLiveness': { __esModule: true, default: () => [false, () => {}] },
    '../i18n': { useI18n: () => ({ t: x => x, formatLocalizedDate: () => '' }) },
  });
  const button = flatten(c.render()).find(n => n.props.onPress && flatten(n).some(child => child.children.includes('dayCarousel.moveToMaoqiuBtn')));
  assert.equal(button.props.haptic, false);
  await button.props.onPress();
  const exit = driver.records.find(r => r.config.toValue === 1);
  assert.ok(exit);
  assert.equal(driver.records[0].ended, false);
  exit.finish();
  assert.deepEqual(removed, ['a']);
  assert.equal(driver.records[0].ended, false, 'cleanup must not wait for the decorative pulse');
});

test('actual gallery dismissal preserves cancellation and ignores an interrupted close callback', () => {
  const driver = nativeDriver(); let closed = 0;
  const c = renderComponent('components/TrashGallery.js', { visible: true, onClose: () => closed++ }, { 'react-native': driver.native });
  const handlers = flatten(c.render()).find(n => n.props.onPanResponderGrant).props;
  const down = (dy, vy = 0) => ({ dx: 0, dy, vx: 0, vy });
  handlers.onPanResponderGrant(null, down(0));
  handlers.onPanResponderMove(null, down(30));
  handlers.onPanResponderRelease(null, down(30));
  assert.equal(driver.records[0].config.toValue, 0);
  driver.records[0].value.position = 8;
  handlers.onPanResponderGrant(null, down(0));
  handlers.onPanResponderMove(null, down(120));
  handlers.onPanResponderRelease(null, down(120, 0.7));
  assert.equal(driver.records[1].config.toValue, 852);
  driver.records[1].finish(false);
  assert.equal(closed, 0);
});

test('all cards share one Reduce Motion subscription and a late query cannot overwrite an event', async () => {
  let onChange, resolve, queries = 0, removed = 0;
  const native = { AccessibilityInfo: {
    addEventListener: (_, listener) => { onChange = listener; return { remove: () => removed++ }; },
    isReduceMotionEnabled: () => { queries++; return new Promise(r => { resolve = r; }); },
  } };
  const stores = [];
  const motion = loadMotionRuntime(native, { useSyncExternalStore: (subscribe, snapshot) => {
    stores.push({ subscribe, snapshot }); return snapshot();
  } });
  assert.equal(motion.useReducedMotion(), true);
  motion.useReducedMotion();
  const unsubscribeA = stores[0].subscribe(() => {}), unsubscribeB = stores[1].subscribe(() => {});
  assert.equal(queries, 1);
  onChange(true); resolve(false); await tick();
  assert.equal(stores[0].snapshot(), true);
  onChange(false); assert.equal(stores[0].snapshot(), false);
  unsubscribeA(); assert.equal(removed, 0);
  unsubscribeB(); assert.equal(removed, 1);
});

function burst() {
  const driver = nativeDriver();
  const props = { itemId: 'a', enabled: true, reduced: false, directionRef: { current: 0 } };
  const c = renderComponent('useBurstMotion.js', props, { 'react-native': driver.native }, { effects: true });
  const render = () => { const poses = c.render(); c.flushEffects(); return poses; };
  render();
  return { ...driver, c, props, render, turn: (itemId, direction) => {
    props.itemId = itemId; props.directionRef.current = direction; return render();
  } };
}
const pose = transforms => Object.fromEntries(transforms.map(transform => {
  const [key, value] = Object.entries(transform)[0];
  return [key, typeof value === 'object' ? value.read() : parseFloat(value)];
}));
const nearPose = (a, b) => { for (const key of Object.keys(a)) assert.ok(Math.abs(a[key] - b[key]) < 1e-9, `${key}: ${a[key]} vs ${b[key]}`); };

test('burst front and back cards share one native spring and keep their exact settled geometry', () => {
  const b = burst();
  const initial = b.render();
  nearPose(pose(initial[0]), { translateY: 0, rotate: 0, scale: 1 });
  nearPose(pose(initial[1]), { translateY: 26, rotate: -2.5, scale: 0.97 });
  const previousBack = pose(initial[1]);
  const moving = b.turn('b', 1);
  assert.equal(b.records.length, 1);
  nearPose(pose(moving[0]), previousBack);
  b.records[0].finish();
  nearPose(pose(moving[0]), { translateY: 0, rotate: 0, scale: 1 });
  nearPose(pose(moving[1]), { translateY: 26, rotate: -2.5, scale: 0.97 });
});

test('rapid burst taps preserve the incoming photo position and retarget rather than reset or queue', () => {
  const b = burst();
  const first = b.turn('b', 1);
  const driver = b.records[0].value;
  driver.position = 0.4;
  const oldBack = pose(first[1]);
  const second = b.turn('c', 1);
  nearPose(pose(second[0]), oldBack);
  assert.equal(b.records.length, 1, 'native tracking must reuse one spring, including its velocity');
  assert.equal(b.records[0].destination, 2);
  assert.equal(driver.stopCalls, 0);
  assert.deepEqual(driver.writes, []);
  const oldFront = pose(second[0]);
  const previous = b.turn('b', -1);
  nearPose(pose(previous[1]), oldFront);
  assert.equal(b.records[0].destination, 1);
  assert.deepEqual(b.records[0].targets, [1, 2, 1]);
  assert.equal(driver.stopCalls, 0);
});

test('burst animation waits for a real frame identity change, and reduced motion/leave cancel without replay', () => {
  const b = burst();
  b.props.directionRef.current = 1;
  b.render();
  assert.equal(b.records.length, 0, 'a native-group paging wait must not animate the old frame');
  b.props.itemId = 'b'; b.render();
  assert.equal(b.records.length, 1);
  b.props.reduced = true;
  nearPose(pose(b.render()[0]), { translateY: 0, rotate: 0, scale: 1 });
  assert.equal(b.records[0].ended, true);
  b.props.reduced = false; b.props.enabled = false; b.render();
  b.props.enabled = true; b.render();
  assert.equal(b.records.length, 1, 'returning to a card must not replay an old tap');
  b.turn('c', 1);
  b.c.unmount();
  assert.equal(b.records.at(-1).ended, true);
});

test('rapid burst input remains visually bounded and an external frame change resets only its presentation', () => {
  const b = burst(); let poses;
  for (let i = 0; i < 20; i++) poses = b.turn(`photo-${i}`, 1);
  assert.equal(b.records.length, 1);
  assert.equal(b.records[0].destination, 20);
  const front = pose(poses[0]);
  assert.ok(front.translateY <= 52 && front.scale >= 0.94);
  b.props.directionRef.current = 0; b.props.itemId = 'restored-photo';
  nearPose(pose(b.render()[0]), { translateY: 0, rotate: 0, scale: 1 });
});

test('actual burst deck reuses back-card asset keys and retains the existing four media surfaces', () => {
  const driver = nativeDriver();
  const items = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, width: 3000, height: 4000, mediaType: 'photo' }));
  const props = { item: items[0], items, groupCount: items.length, groupIndex: 0, active: true, preload: true, height: 800 };
  const c = renderComponent('components/MemoryCard.js', props, {
    'react-native': driver.native, '../nativePhotoPreview': { supportsNativePhotoPreview: true },
  });
  flatten(c.render()).find(n => n.props.assetId === 'a' && n.props.onLoad).props.onLoad();
  const first = flatten(c.render());
  assert.equal(first.filter(n => n.props.assetId).length, 4);
  assert.deepEqual(first.filter(n => n.props.key?.startsWith('stack-')).map(n => n.props.key), ['stack-b', 'stack-c', 'stack-d']);
  props.item = items[1]; props.groupIndex = 1;
  const second = flatten(c.render());
  assert.equal(second.filter(n => n.props.assetId).length, 4);
  assert.deepEqual(second.filter(n => n.props.key?.startsWith('stack-')).map(n => n.props.key), ['stack-c', 'stack-d', 'stack-e']);
  for (const back of second.filter(n => n.props.purpose === 'burst')) {
    assert.equal(back.props.maxPixelSize, 512);
    assert.equal(back.props.priority, 1);
  }
});
