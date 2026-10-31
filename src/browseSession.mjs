import { DEFAULT_ALGORITHM_CONFIG } from './algorithmConfig.mjs';

const VERSION = 1;
const KEYS = ['id', 'filename', 'mediaType', 'width', 'height', 'creationTime',
  'modificationTime', 'duration', 'mediaSubtypes', 'isLive', 'nativeBurstId',
  'nativeBurstCount', 'nativeBurstOffset', 'suppressBurstRegroup', 'burstId', 'burstIndex', 'burstCount'];
function metadata(item) {
  return Object.fromEntries(KEYS.filter(key => item[key] !== undefined).map(key => [key, item[key]]));
}
function restoreItem(item) {
  return { ...item, uri: 'ph://' + item.id, previewUri: 'ph://' + item.id,
    ...(item.mediaType === 'video' ? { displayUri: 'ph://' + item.id } : {}) };
}
function isDeck(entry) {
  const item = entry.unit.items[0];
  return entry.unit.items.length > 1 || Boolean(item?.nativeBurstId && !item.suppressBurstRegroup && item.nativeBurstCount !== 1);
}
function copyUnit(unit) {
  return { ...unit, items: unit.items.map(metadata) };
}
function snapshotEntry(entry) {
  return { key: entry.key, ordinal: entry.ordinal, replay: Boolean(entry.replay),
    nextGap: entry.nextGap, unit: copyUnit(entry.unit) };
}
export function isBrowseSnapshot(value) {
  if (!value || value.version !== VERSION || !Number.isSafeInteger(value.epoch) || value.epoch < 0
    || typeof value.sessionId !== 'string' || !Number.isSafeInteger(value.revision)
    || !Number.isSafeInteger(value.sequence) || !Number.isSafeInteger(value.frontier)
    || value.frontier > value.sequence || !value.positions || typeof value.positions !== 'object'
    || !value.rhythm || typeof value.rhythm.hasBurst !== 'boolean'
    || !Number.isFinite(value.rhythm.singles) || !Number.isFinite(value.rhythm.nextGap)
    || !Array.isArray(value.entries) || !Array.isArray(value.candidates)
    || value.entries.length > 100 || value.candidates.length > 600) return false;
  if (value.continuations && (!Array.isArray(value.continuations) || value.continuations.length > 128
    || !value.continuations.every(c => typeof c?.nativeId === 'string' && Number.isInteger(c.nativeOffset)
      && c.nativeOffset >= 0 && Number.isInteger(c.nativeCount) && c.nativeCount >= c.nativeOffset))) return false;
  const p = value.policy;
  if (p && (p.schedulerVersion !== DEFAULT_ALGORITHM_CONFIG.schedulerVersion
    || p.groupingVersion !== DEFAULT_ALGORITHM_CONFIG.groupingVersion
    || !Number.isInteger(p.minSinglesBetweenBursts) || p.minSinglesBetweenBursts < 1
    || !Number.isInteger(p.maxSinglesBetweenBursts) || p.maxSinglesBetweenBursts < p.minSinglesBetweenBursts
    || p.maxSinglesBetweenBursts > 50 || !Number.isInteger(p.candidateLimit) || p.candidateLimit > 1000
    || p.candidateLimit < 1)) return false;
  const validItem = item => item && typeof item.id === 'string' && item.id.length > 0;
  const validUnit = unit => unit && Array.isArray(unit.items) && unit.items.length > 0
    && unit.items.length <= 400 && unit.items.every(validItem);
  if (![...value.entries, ...value.candidates].every(e => e && typeof e.key === 'string' && validUnit(e.unit))
    || (value.overflow && (!Array.isArray(value.overflow) || value.overflow.length > 600 || !value.overflow.every(validUnit)))
    || (value.deferred && (!Array.isArray(value.deferred) || value.deferred.length > 800 || !value.deferred.every(validItem)))
    || (value.day && (!Array.isArray(value.day.items) || value.day.items.length > 320 || !value.day.items.every(validItem)))) return false;
  try { return JSON.stringify(value).length < 512 * 1024; } catch { return false; }
}

// One bounded session owns grouping identities, scheduling, exposure and resumption.
// UI arrays are projections of these entries, never a second grouping algorithm.
export function createBrowseSession({ snapshot, epoch = 0, random = Math.random, config = DEFAULT_ALGORITHM_CONFIG } = {}) {
  const saved = isBrowseSnapshot(snapshot) ? snapshot : null;
  const policy = { ...config, ...(saved?.policy || {}) };
  const state = saved ? JSON.parse(JSON.stringify(saved)) : {
    version: VERSION, epoch, sessionId: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
    revision: 0, sequence: 0, frontier: 0, anchorId: null, positions: {},
    rhythm: { hasBurst: false, singles: 0, nextGap: policy.openingSingles },
    entries: [], candidates: [], overflow: [], deferred: [], continuations: [], day: null,
  };
  state.continuations = state.continuations || [];
  state.overflow = state.overflow || [];
  state.deferred = state.deferred || [];
  state.entries.forEach(e => { e.unit.items = e.unit.items.map(restoreItem); });
  state.candidates.forEach(e => { e.unit.items = e.unit.items.map(restoreItem); });
  state.deferred = state.deferred.map(restoreItem);
  state.overflow.forEach(unit => { unit.items = unit.items.map(restoreItem); });
  if (state.day?.items) state.day.items = state.day.items.map(restoreItem);
  // Repair overlapping reservations in snapshots written by older native
  // expansion code. Main history wins; day browsing is a separate context.
  const restoredIds = new Set();
  const uniqueItems = items => items.filter(item => {
    if (restoredIds.has(item.id)) return false;
    restoredIds.add(item.id); return true;
  });
  for (const field of ['entries', 'candidates']) state[field] = state[field]
    .map(entry => ({ ...entry, unit: { ...entry.unit, items: uniqueItems(entry.unit.items) } }))
    .filter(entry => entry.unit.items.length);
  state.overflow = state.overflow.map(unit => ({ ...unit, items: uniqueItems(unit.items) })).filter(unit => unit.items.length);
  state.deferred = uniqueItems(state.deferred);
  state.serial = state.serial || state.sequence;
  function ids() {
    return new Set([...state.entries, ...state.candidates].flatMap(e => e.unit.items.map(item => item.id))
      .concat(state.deferred.map(item => item.id), state.overflow.flatMap(unit => unit.items.map(item => item.id))));
  }
  function advance(rhythm, entry, prospective = false) {
    if (prospective ? isDeck(entry) : entry.unit.items.length > 1) {
      rhythm.hasBurst = true; rhythm.singles = 0; rhythm.nextGap = entry.nextGap;
    } else {
      rhythm.singles = Math.min(policy.maxSinglesBetweenBursts, rhythm.singles + 1);
    }
  }
  function plannedRhythm() {
    const rhythm = { ...state.rhythm };
    for (const e of state.entries) if (e.ordinal > state.frontier && !e.replay) advance(rhythm, e);
    return rhythm;
  }
  function findItem(id) {
    for (const e of state.entries) {
      const item = e.unit.items.find(item => item.id === id);
      if (item) return { entry: e, item };
    }
    return null;
  }
  const api = {
    state,
    get policy() { return policy; },
    get candidateCount() { return state.candidates.reduce((n, e) => n + e.unit.items.length, 0); },
    get hasCandidates() { return state.candidates.length > 0; },
    get needsBurst() { return !state.candidates.some(isDeck); },
    get reservedIds() { return ids(); },
    ingest(units) {
      const known = ids(), overflow = [];
      let count = api.candidateCount;
      function enqueue(unit, items) {
        if (count >= policy.candidateLimit) { overflow.push({ ...unit, items }); return; }
        count += items.length;
        state.candidates.push({ key: 'entry-' + state.sessionId + '-' + (++state.serial),
          unit: { ...unit, items } });
      }
      for (const unit of units || []) {
        const items = (unit.items || []).filter(item => {
          if (!item?.id || known.has(item.id)) return false;
          known.add(item.id); return true;
        });
        if (!items.length) continue;
        const native = !items[0].suppressBurstRegroup && items[0].nativeBurstId;
        const existing = native && [...state.entries, ...state.candidates].find(e =>
          (e.unit.nativeId || (!e.unit.items[0]?.suppressBurstRegroup && e.unit.items[0]?.nativeBurstId)) === native);
        if (existing) {
          if (state.candidates.includes(existing)) {
            const nativeCount = existing.unit.items.find(i => i.nativeBurstCount)?.nativeBurstCount;
            if (nativeCount) items.forEach(i => { i.nativeBurstCount = nativeCount; });
            existing.unit.items.push(...items); count += items.length;
            existing.unit.items.sort((a,b) => a.creationTime-b.creationTime || a.id.localeCompare(b.id));
          } else {
            // A committed deck is immutable. Late unseen members still need
            // a turn; dropping them here silently exhausts an incomplete library.
            for (const item of items) enqueue({}, [{ ...item, suppressBurstRegroup: true }]);
          }
          continue;
        }
        enqueue(unit, items);
      }
      return overflow;
    },
    claimEntryItems(entry, items) {
      // Native expansion shares the same ownership rule as ingestion. It may
      // absorb queued candidates, but never steal another committed card.
      const known = new Set(state.entries.filter(e => e !== entry).flatMap(e => e.unit.items.map(i => i.id)));
      const accepted = items.filter(item => {
        if (!item?.id || known.has(item.id)) return false;
        known.add(item.id); return true;
      });
      const claimed = new Set(accepted.map(i => i.id));
      api.pruneCandidates(claimed);
      state.overflow = state.overflow.map(unit => ({ ...unit,
        items: unit.items.filter(i => !claimed.has(i.id)) })).filter(unit => unit.items.length);
      // memorySession holds this array by reference.
      const deferred = state.deferred.filter(i => !claimed.has(i.id));
      state.deferred.splice(0, state.deferred.length, ...deferred);
      return accepted;
    },
    trimBefore(key) {
      const index = state.entries.findIndex(e => e.key === key);
      if (index <= 0) return;
      const removed = state.entries.splice(0, index);
      for (const entry of removed) delete state.positions[entry.key];
    },
    pruneCandidates(blocked) {
      state.candidates = state.candidates.map(e => ({ ...e, unit: { ...e.unit,
        items: e.unit.items.filter(item => !blocked.has(item.id)) } })).filter(e => e.unit.items.length);
    },
    pruneReviewedAhead(reviewed) {
      let removed = 0;
      state.entries = state.entries.map(entry => {
        if (entry.replay || entry.ordinal <= state.frontier || entry.unit.items.some(i => i.id === state.anchorId)) return entry;
        const items = entry.unit.items.filter(i => !reviewed.has(i.id));
        removed += entry.unit.items.length - items.length;
        return { ...entry, unit: { ...entry.unit, items } };
      }).filter(entry => entry.unit.items.length);
      return removed;
    },
    take(limit = policy.lookAheadEntries, { allowSinglesFallback = true } = {}) {
      const added = [], rhythm = plannedRhythm();
      while (added.length < limit && state.candidates.length) {
        let single = state.candidates.findIndex(e => !isDeck(e));
        const burst = state.candidates.findIndex(e => isDeck(e));
        const due = rhythm.singles >= rhythm.nextGap;
        let index;
        if (burst >= 0 && (due || (!rhythm.hasBurst && single < 0))) index = burst;
        else if (single >= 0) index = single;
        else if (burst >= 0 && allowSinglesFallback) {
          // Scarcity changes presentation, never capture relations or review facts.
          const [deck] = state.candidates.splice(burst, 1);
          state.candidates.splice(burst, 0, ...deck.unit.items.map((item, n) => ({
            key: deck.key + '-single-' + n, unit: { groupSource: deck.unit.groupSource,
              items: [{ ...item, suppressBurstRegroup: true }] },
          })));
          index = burst;
        } else break;
        const [entry] = state.candidates.splice(index, 1);
        entry.ordinal = ++state.sequence;
        if (isDeck(entry)) entry.nextGap = policy.minSinglesBetweenBursts
          + Math.floor(Math.min(0.999999, Math.max(0, random())) * (policy.maxSinglesBetweenBursts - policy.minSinglesBetweenBursts + 1));
        state.entries.push(entry); added.push(entry); advance(rhythm, entry, true);
      }
      return added;
    },
    feed(blocked = new Set()) {
      return state.entries.map(e => ({ ...e, unit: { ...e.unit,
        items: e.unit.items.filter(item => !blocked.has(item.id)) } })).filter(e => e.unit.items.length);
    },
    reconcile(assets) {
      const map = new Map(assets.map(item => [item.id, item]));
      if (state.anchorId && !map.has(state.anchorId)) api.restoreAnchor(new Set(
        state.entries.flatMap(e => e.unit.items).filter(item => !map.has(item.id)).map(item => item.id)));
      state.entries = state.entries.flatMap(e => {
        const items = e.unit.items.filter(item => map.has(item.id)).map(item => map.get(item.id));
        const restored = items.length > 1 ? items.filter(item => item.suppressBurstRegroup && !item.isTrash) : [];
        const remaining = items.filter(item => !restored.includes(item));
        return [...(remaining.length ? [{ ...e, unit: { ...e.unit, items: remaining } }] : []),
          ...restored.map(item => ({ key: 'restored-' + item.id + '-' + (++state.serial),
            replay: true, ordinal: ++state.sequence, unit: { items: [item] } }))];
      });
      const known = ids();
      for (const item of assets) if (!known.has(item.id)) {
        state.entries.push({ key: 'restored-' + item.id + '-' + (++state.serial), replay: true,
          ordinal: ++state.sequence, unit: { items: [item] } });
      }
    },
    refresh(asset) {
      for (const e of [...state.entries, ...state.candidates]) {
        const i = e.unit.items.findIndex(item => item.id === asset.id);
        if (i >= 0) e.unit.items[i] = asset;
      }
    },
    anchor(id, source = 'feed') {
      if (source === 'day') { if (state.day) state.day.anchorId = id; return; }
      const found = findItem(id);
      if (found) { state.anchorId = id; state.positions[found.entry.key] = id; }
    },
    settle(id) {
      const found = findItem(id);
      if (!found || found.entry.ordinal <= state.frontier || !state.rhythm.hasBurst
        || state.rhythm.singles >= policy.minSinglesBetweenBursts || found.entry.unit.items.length < 2) return false;
      const entry = found.entry;
      const remaining = entry.unit.items.filter(item => item.id !== id);
      api.queueContinuation(entry.unit);
      entry.unit = { items: [{ ...found.item, suppressBurstRegroup: true }] };
      state.overflow.push(...api.ingest(remaining.map(item => ({ items: [{ ...item, suppressBurstRegroup: true }] }))));
      return true;
    },
    expose(id, { source = 'feed' } = {}) {
      if (source !== 'feed' || state.day) return false;
      const found = findItem(id);
      if (!found || found.entry.ordinal <= state.frontier || found.entry.replay) return false;
      api.anchor(id);
      state.frontier = found.entry.ordinal;
      advance(state.rhythm, found.entry);
      return true;
    },
    enterDay(items, id, mainId) {
      state.day = { anchorId: id, mainId, items };
    },
    leaveDay() { state.day = null; },
    restoreAnchor(blocked = new Set()) {
      const visible = api.feed(blocked), current = visible.find(e => e.unit.items.some(i => i.id === state.anchorId));
      if (current) return state.anchorId;
      const oldId = state.anchorId;
      const ordered = state.entries.flatMap(e => e.unit.items);
      const index = ordered.findIndex(item => item.id === state.anchorId);
      const neighbours = [...ordered.slice(Math.max(0, index + 1)), ...ordered.slice(0, Math.max(0, index)).reverse()];
      state.anchorId = neighbours.find(item => !blocked.has(item.id))?.id || visible[0]?.unit.items[0]?.id || null;
      if (state.day?.mainId === oldId) state.day.mainId = state.anchorId;
      return state.anchorId;
    },
    snapshot({ blocked = new Set(), removeId = null } = {}) {
      const anchor = state.anchorId;
      const currentIndex = Math.max(0, state.entries.findIndex(e => e.unit.items.some(i => i.id === anchor)));
      const entries = state.entries.slice(Math.max(0, currentIndex - 40), currentIndex + 8);
      const out = { ...state, policy, revision: ++state.revision,
        entries: entries.map(snapshotEntry),
        candidates: state.candidates.map(snapshotEntry),
        overflow: state.overflow.map(copyUnit), deferred: state.deferred.map(metadata),
        positions: Object.fromEntries(entries.filter(e => state.positions[e.key]).map(e => [e.key, state.positions[e.key]])),
        day: state.day ? { ...state.day, items: state.day.items.map(metadata) } : null };
      const exclude = new Set(blocked);
      if (removeId) exclude.add(removeId);
      if (removeId === out.anchorId || (out.anchorId && exclude.has(out.anchorId))) {
        const ordered = entries.flatMap(e => e.unit.items);
        const index = ordered.findIndex(item => item.id === out.anchorId);
        const neighbours = [...ordered.slice(Math.max(0, index + 1)), ...ordered.slice(0, Math.max(0, index)).reverse()];
        out.anchorId = neighbours.find(item => !exclude.has(item.id))?.id || null;
      }
      if (out.day?.mainId === anchor && out.anchorId !== anchor) out.day.mainId = out.anchorId;
      if (out.day && exclude.has(out.day.anchorId)) {
        const i = out.day.items.findIndex(item => item.id === out.day.anchorId);
        const ordered = [...out.day.items.slice(i + 1), ...out.day.items.slice(0, i).reverse()];
        out.day.anchorId = ordered.find(item => !exclude.has(item.id))?.id || null;
      }
      if (!isBrowseSnapshot(out)) throw Error('Browse snapshot exceeds its metadata budget');
      return out;
    },
    queueContinuation(unit) {
      if (!unit?.nativeId || !(unit.nativeOffset < unit.nativeCount)) return;
      if (!state.continuations.some(c => c.nativeId === unit.nativeId && c.nativeOffset === unit.nativeOffset))
        state.continuations.push({ nativeId: unit.nativeId, nativeOffset: unit.nativeOffset, nativeCount: unit.nativeCount });
    },
    getItem: id => findItem(id)?.item,
    remove(idsToRemove) {
      if (idsToRemove.has(state.anchorId)) api.restoreAnchor(idsToRemove);
      state.entries = state.entries.map(e => ({ ...e, unit: { ...e.unit,
        items: e.unit.items.filter(i => !idsToRemove.has(i.id)) } })).filter(e => e.unit.items.length);
    },
  };
  return api;
}
