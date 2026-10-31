// Fetch one native page at a time. Keep a boundary group until the next page
// arrives so a continuous sequence cannot be split solely by pagination.
export function createCandidatePager({ fetchPage, eligible, group, order, pageSize = 240 }) {
  let scanned = 0;
  let cursor, hasMore = true, tail = [], units = [], pending;
  async function refill() {
    const page = await fetchPage({ first: pageSize, ...(cursor ? { after: cursor } : {}) });
    if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) throw Error('PhotoKit pagination did not advance');
    const candidates = [...tail, ...(page.assets || [])];
    let nextTail = [];
    const grouped = group(candidates);
    // Native pages are newest-first; hold the oldest group as boundary lookahead.
    grouped.sort((a,b) => (b.items[0]?.creationTime || 0) - (a.items[0]?.creationTime || 0));
    if (page.hasNextPage && grouped.length) nextTail = grouped.pop().items;
    const allowed = new Set((await eligible(grouped.flatMap(unit => unit.items))).map(item => item.id));
    const ready = grouped.map(unit => ({ ...unit, items: unit.items.filter(item => allowed.has(item.id)) })).filter(unit => unit.items.length);
    const ordered = order(ready);
    // Commit the cursor only after grouping, durable eligibility and ordering
    // succeed. Retrying a failed read must retry the same page and boundary.
    scanned += page.assets?.length || 0;
    cursor = page.endCursor;
    hasMore = Boolean(page.hasNextPage);
    tail = nextTail;
    units.push(...ordered);
  }
  return {
    get scanned() { return scanned; },
    get hasMore() { return hasMore || units.length > 0 || tail.length > 0; },
    next(limit, maxPages = 2) {
      if (pending) return pending;
      pending = (async () => {
        let budget = Math.max(1, Math.min(2, maxPages));
        while (!units.length && hasMore && budget-- > 0) await refill();
        const selected = []; let count = 0;
        while (units.length && count < limit) { const unit = units.shift(); selected.push(unit); count += unit.items.length; }
        return selected;
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}

