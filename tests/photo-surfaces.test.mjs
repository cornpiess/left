import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent, flatten } from './support/render-component.mjs';
import { runtime, photo } from './support/media-runtime.mjs';

const Native = function NativePreview() {};
const modules = { '../nativePhotoPreview': { supportsNativePhotoPreview: true },
  './PhotoKitPreview': { __esModule: true, default: Native } };

test('visible feed, neighbour and fanned burst cards request the correct asset at visible priority', () => {
  const items = [photo('a', 1000), photo('b', 1100), photo('c', 1200)];
  const props = { item: items[0], items, groupCount: 3, height: 800, active: true, preload: true };
  const view = renderComponent('components/MemoryCard.js', props, modules);
  let surfaces = flatten(view.render()).filter(node => node.type === Native);
  const current = surfaces.find(node => node.props.assetId === 'a');
  assert.equal(current.props.priority, 0);
  current.props.onLoad(); // the deck opens after the first decoded image
  surfaces = flatten(view.render()).filter(node => node.type === Native);
  assert.equal(surfaces.find(node => node.props.assetId === 'b').props.priority, 1);
  assert.equal(surfaces.find(node => node.props.assetId === 'c').props.priority, 1);
  props.active = false; // the same visible card during scroll
  assert.equal(flatten(view.render()).find(node => node.type === Native && node.props.assetId === 'a').props.priority, 1);
});

test('ambient double buffer asks for a visible, blurred, size-bounded preview', () => {
  const c = renderComponent('components/AmbientBackdrop.js', { source: 'ph://a' }, modules);
  c.render(); c.slots[1] = 'ph://a';
  const pending = flatten(c.render()).find(node => node.type?.name === 'BackdropImage');
  assert.ok(pending);
  const native = pending.type(pending.props);
  assert.equal(native.type, Native); assert.equal(native.props.priority, 1);
  assert.equal(native.props.blurred, true); assert.equal(native.props.maxPixelSize, 512);
  pending.props.onLoad();
  assert.equal(c.slots[0], 'ph://a');
  const front = flatten(c.render()).find(node => node.type?.name === 'BackdropImage');
  assert.equal(front.props.key, pending.props.key, 'promotion keeps the same native layer');
});

test('pending-bin metadata updates tell the live grid that a default photo is actually a video', async () => {
  const item = photo('video', 10000, { mediaType: 'video', duration: 10 });
  const r = runtime([item]); await r.store.setPending('video', true);
  const event = new Promise(resolve => { const stop = r.media.subscribeTrashMetadata(value => { stop(); resolve(value); }); });
  const list = await r.media.fetchTrashItems();
  assert.equal(list.length, 1);
  const updated = await event;
  assert.equal(updated.id, 'video'); assert.equal(updated.mediaType, 'video');
});
