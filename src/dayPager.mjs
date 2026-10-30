// A day is two native cursor streams around the selected photo, not a full scan.
export function createDayPager({ anchor, fetchPage, pageSize = 80, eligible = () => true }) {
  const date = new Date(anchor.creationTime);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  const sides = { before: { cursor: null, more: true, bound: anchor.creationTime }, after: { cursor: null, more: true, bound: anchor.creationTime } };
  const seen = new Set([anchor.id]);
  const inFlight = new Map();
  return {
    more: side => sides[side].more,
    reset(side, edge) { sides[side] = { cursor: null, more: true, bound: edge.creationTime }; },
    forget(ids) { ids.forEach(id => seen.delete(id)); },
    next(side) {
      if (inFlight.has(side)) return inFlight.get(side);
      const state = sides[side];
      if (!state.more) return Promise.resolve([]);
      const task = (async () => {
        while (state.more) {
          const page = await fetchPage({ first: pageSize, ...(state.cursor ? { after: state.cursor } : {}),
          createdAfter: side === 'before' ? start - 1 : state.bound - 1,
          createdBefore: side === 'before' ? state.bound + 1 : end,
          ascending: side === 'after',
        });
        if (page.hasNextPage && (!page.endCursor || page.endCursor === state.cursor)) throw Error('PhotoKit day cursor did not advance');
        state.cursor = page.endCursor;
        state.more = Boolean(page.hasNextPage);
        const fresh = (page.assets || []).filter(item => !seen.has(item.id) && eligible(item) && item.creationTime >= start && item.creationTime < end);
        fresh.forEach(item => seen.add(item.id));
        if (fresh.length || !state.more) return fresh.sort((a,b) => a.creationTime - b.creationTime);
        }
        return [];
      })().finally(() => inFlight.delete(side));
      inFlight.set(side,task);return task;
    },
  };
}
