/**
 * Bounded-concurrency mapper. PhotoKit enrichment storms (e.g. trash list
 * enrichment firing one getAssetInfoAsync per id inside Promise.all) saturate
 * the bridge and the XPC channel on huge libraries — this keeps at most
 * `limit` requests in flight while preserving result order.
 *
 * The mapper is expected to handle its own errors; a rejection here rejects
 * the whole batch (same semantics as Promise.all).
 */
export async function mapLimit(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  if (!list.length) return results;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  let next = 0;
  const workers = Array.from({ length: width }, async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Coalescer for library-reload storms. An iCloud-syncing 100k-photo library
 * fires non-incremental PhotoKit change events in bursts; each one used to
 * discard the whole feed and re-run discovery. Semantics:
 *  - accept(now) → 'emit' when the cooldown since the last emit has fully
 *    elapsed, otherwise 'suppress' (and the suppressed event is remembered).
 *  - takeTrailing(now) turns one remembered suppressed event into an emit as
 *    soon as the cooldown window has passed, so a settling storm still ends
 *    with exactly one fresh reload — never zero.
 *  - accept(now, true) forces an emit (used after intentional batch deletions).
 */
export function createReloadCoalescer({ cooldownMs = 8000 } = {}) {
  let lastEmitAt = -Infinity;
  let pendingTrailing = false;
  return {
    accept(now, force = false) {
      if (force || now - lastEmitAt >= cooldownMs) {
        lastEmitAt = now;
        pendingTrailing = false;
        return 'emit';
      }
      pendingTrailing = true;
      return 'suppress';
    },
    takeTrailing(now) {
      if (!pendingTrailing || now - lastEmitAt < cooldownMs) return false;
      lastEmitAt = now;
      pendingTrailing = false;
      return true;
    },
    reset() {
      lastEmitAt = -Infinity;
      pendingTrailing = false;
    },
  };
}
