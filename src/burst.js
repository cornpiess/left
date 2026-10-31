import { getAlgorithmConfig } from './algorithmConfig.mjs';

const EXCLUDED = new Set(['screenshot', 'panorama', 'spatialMedia']);
export function isBurstPhoto(asset) {
  return Boolean(asset?.id && !asset.suppressBurstRegroup
    && asset.mediaType !== 'video' && !(asset.duration > 0)
    && !(asset.mediaSubtypes || []).some(type => EXCLUDED.has(type)));
}
function validMetadata(asset) {
  return Number.isFinite(asset.creationTime) && asset.creationTime > 0
    && Number.isFinite(asset.width) && asset.width > 0
    && Number.isFinite(asset.height) && asset.height > 0;
}
function matchingShape(a, b, tolerance) {
  const x = a.width / a.height, y = b.width / b.height;
  return (a.width >= a.height) === (b.width >= b.height)
    && Math.abs(x - y) / Math.max(x, y) <= tolerance;
}
export function compareCaptureOrder(a, b) {
  return (a.creationTime || 0) - (b.creationTime || 0) || String(a.id).localeCompare(String(b.id));
}
export function assignBursts(assets, config = getAlgorithmConfig()) {
  if (!Array.isArray(assets)) return assets;
  const native = new Map();
  for (const asset of assets) {
    delete asset.burstId; delete asset.burstIndex; delete asset.burstCount;
    if (isBurstPhoto(asset) && asset.nativeBurstId) {
      if (!native.has(asset.nativeBurstId)) native.set(asset.nativeBurstId, []);
      native.get(asset.nativeBurstId).push(asset);
    }
  }
  function mark(group, id) {
    if (group.length < config.minBurstSize) return;
    group.sort(compareCaptureOrder).forEach((item, index) => {
      item.burstId = id; item.burstIndex = index; item.burstCount = group.length;
    });
  }
  for (const [id, group] of native) mark(group, 'native-' + id);
  let group = [];
  function finish() {
    if (group.length) mark(group, 'capture-' + group[0].id);
    group = [];
  }
  // Excluded media remain in the ordered stream as boundaries.
  for (const asset of [...assets].sort(compareCaptureOrder)) {
    if (!isBurstPhoto(asset) || asset.nativeBurstId || !validMetadata(asset)) { finish(); continue; }
    const first = group[0], previous = group.at(-1);
    if (previous && (group.length >= config.maxGroupMetadata || asset.creationTime - previous.creationTime > config.burstGapMs
      || asset.creationTime - first.creationTime > config.burstWindowMs
      || !matchingShape(first, asset, config.aspectTolerance))) finish();
    group.push(asset);
  }
  finish();
  return assets;
}
export function buildBurstUnits(assets) {
  if (!Array.isArray(assets)) return [];
  const groups = new Map(), emitted = new Set(), result = [];
  for (const item of assets) if (item.burstId && item.burstCount > 1) {
    if (!groups.has(item.burstId)) groups.set(item.burstId, []);
    groups.get(item.burstId).push(item);
  }
  for (const item of assets) {
    const id = item.burstCount > 1 && item.burstId;
    if (!id) { result.push({ items: [item] }); continue; }
    if (emitted.has(id)) continue;
    emitted.add(id);
    const members = groups.get(id).sort(compareCaptureOrder);
    const limit = item.nativeBurstId ? getAlgorithmConfig().maxGroupMetadata : members.length;
    result.push({ burstId: id, groupSource: item.nativeBurstId ? 'native' : 'time', items: members.slice(0, limit) });
    // The metadata cap bounds a deck, not library coverage. Overflow members
    // retain native identity but enter the regular single-card schedule.
    for (const member of members.slice(limit)) result.push({ items: [{ ...member, suppressBurstRegroup: true }] });
  }
  return result;
}
export function filterEligibleBurstUnit(unit, { viewedIds, attemptedIds, trashIds } = {}) {
  const items = (unit?.items || []).filter(item => item?.id && !viewedIds?.has(item.id)
    && !attemptedIds?.has(item.id) && !trashIds?.has(item.id) && !item.isTrash);
  return items.length ? { ...unit, items } : null;
}
