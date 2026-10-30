import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const swiftView = read('modules/maoqiu-photo-preview/ios/MaoqiuPhotoPreviewModule.swift');
const swiftContent = read('modules/maoqiu-photo-preview/ios/PhotoContentView.swift');
const swiftResources = read('modules/maoqiu-photo-preview/ios/PhotoResources.swift');

// ---- Step 1: view hierarchy isolates the image view from direct-child masking ----
test('image view is never a direct child of the Expo view', () => {
  assert.match(swiftView, /addSubview\(contentView\)/);
  assert.doesNotMatch(swiftView, /addSubview\(imageView\)/);
});
test('PhotoContentView is plain UIKit with no React layout logic', () => {
  assert.match(swiftContent, /final class PhotoContentView: UIView/);
  assert.doesNotMatch(swiftContent, /import Expo/, 'the file must stay free of Expo imports for the test host');
  assert.match(swiftContent, /layoutSubviews\(\)[\s\S]{0,400}imageView\.frame = bounds/);
});
test('view keeps its frame contract: contentView follows bounds, imageView follows contentView', () => {
  assert.match(swiftView, /layoutSubviews\(\)[\s\S]{0,200}contentView\.frame = bounds/);
});

// ---- Step 2: retention rules ----
test('leaving the window must not clear the displayed image', () => {
  const block = swiftView.match(/didMoveToWindow\(\)[\s\S]{0,400}/)[0];
  assert.doesNotMatch(block, /image = nil/, 'didMoveToWindow must retain the image');
  assert.match(block, /invalidatePending/, 'late callbacks must be invalidated instead');
});
test('switching photos resets load state by identity and clears the old photo', () => {
  assert.match(swiftView, /coordinator\.switchPhoto\(id\)/);
  assert.match(swiftView, /switchPhoto[\s\S]{0,400}imageView\.image = nil/);
});
test('degraded deliveries never downgrade a shown final image', () => {
  assert.match(swiftContent, /if !isFinal && hasFinalImage \{ return false \}/);
});

// ---- Step 3: Core Image blur replaces the system material blur ----
test('the UIVisualEffectView backdrop is fully removed', () => {
  assert.doesNotMatch(swiftView, /UIVisualEffectView/);
  assert.doesNotMatch(swiftView, /Prop\("blurred"\)/);
  assert.match(swiftView, /Prop\("blurRadius"\)/);
});
test('blur clamps before filtering and crops back to the input extent', () => {
  assert.match(swiftContent, /clampedToExtent\(\)/);
  assert.match(swiftContent, /cropped\(to: extent\)/);
  assert.match(swiftContent, /CIGaussianBlur/);
});
test('one shared CIContext on a serial background queue, results on main', () => {
  assert.match(swiftContent, /private let context = CIContext\(\)/);
  assert.match(swiftContent, /DispatchQueue\(label: "maoqiu\.photo\.blur\.render"/);
  assert.match(swiftContent, /DispatchQueue\.main\.async \{ completion/);
});
test('blur respects the 512px bitmap cap', () => {
  assert.match(swiftContent, /pixelCap: CGFloat = 512/);
});
test('blur keeps at most one in-flight job plus one newest pending job', () => {
  assert.match(swiftContent, /final class BlurPipeline/);
  assert.match(swiftContent, /private var pending: Job\?/);
});

// ---- Step 4: diagnostics ----
test('purpose prop reaches native and is diagnostic-only', () => {
  assert.match(swiftView, /Prop\("purpose"\)/);
});
test('performance snapshot stays numeric-compatible and carries display counters', () => {
  assert.match(swiftView, /\(\) -> \[String: Any\]/);
  for (const key of ['assignedImages', 'droppedCallbacks', 'clearedImages', 'layoutAnomalies', 'events', 'readyImages']) {
    assert.match(swiftResources, new RegExp(key));
  }
});
test('diagnostics record is bounded and one line per event', () => {
  assert.match(swiftResources, /private let cap = 64/);
  assert.match(swiftResources, /prefix\(160\)/);
});
test('JS wires blurRadius and purpose through both render branches', () => {
  const code = read('src/components/PhotoKitPreview.js');
  assert.match(code, /blurRadius=\{blurRadius \|\| 0\}/);
  assert.match(code, /purpose=\{purpose \|\| 'feed'\}/);
  assert.match(code, /<Image[^>]*blurRadius=\{blurRadius\}/s);
});
test('ambient backdrop dropped the blurred prop and tags itself ambient', () => {
  const code = read('src/components/AmbientBackdrop.js');
  assert.doesNotMatch(code, /<PhotoKitPreview[^>]*blurred/s);
  assert.match(code, /purpose="ambient"/);
  assert.match(code, /blurRadius=\{BLUR_RADIUS\}/, 'existing radius value is preserved');
});
test('every PhotoKitPreview call site carries a purpose tag', () => {
  const card = read('src/components/MemoryCard.js');
  const day = read('src/components/DayMemoryCarousel.js');
  const trash = read('src/components/TrashGallery.js');
  assert.match(card, /purpose="burst"/);
  assert.match(card, /purpose=\{purpose\}/, 'main surface forwards the incoming purpose');
  assert.match(day, /purpose="day"/);
  const gridCount = (trash.match(/purpose="trashGrid"/g) || []).length;
  const previewCount = (trash.match(/purpose="trashPreview"/g) || []).length;
  assert.equal(gridCount, 2, 'both trash grid branches tagged');
  assert.equal(previewCount, 2, 'both trash preview branches tagged');
});
test('useMediaWindow consumes the five display counters and each event line', () => {
  const code = read('src/useMediaWindow.js');
  for (const key of ['rdy: snapshot.readyImages', 'asg: snapshot.assignedImages', 'drp: snapshot.droppedCallbacks', 'clr: snapshot.clearedImages', 'ano: snapshot.layoutAnomalies']) {
    assert.match(code, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(code, /for \(const line of snapshot\.events\) flightEvent\('media-event', line\)/);
});
