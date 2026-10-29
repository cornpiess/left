// Shared geometry and bounded look-ahead. Preheat exactly the sizes the view uses.
export function photoCardSize(item, width, height) {
  const w = item?.width || 3, h = item?.height || 4;
  const fit = Math.min(width / w, Math.round(height * 0.96) / h);
  return { width: Math.max(Math.round(w * fit), 60), height: Math.max(Math.round(h * fit), 60) };
}
export function planPhotoWindow(items, width, height) {
  return items.filter(item => item?.id).slice(0, 2).map(item => ({ id: item.id, ...photoCardSize(item, width, height) }));
}
export function mergeDayWindow(items, additions, side, limit = 320) {
  const known = new Set(items.map(item => item.id));
  const fresh = additions.filter(item => !known.has(item.id));
  const merged = side === 'before' ? [...fresh, ...items] : [...items, ...fresh];
  const cut = Math.max(0, merged.length - limit);
  const kept = side === 'before' ? merged.slice(0, limit) : merged.slice(cut);
  const dropped = side === 'before' ? merged.slice(limit) : merged.slice(0, cut);
  return { items: kept, dropped, resetSide: dropped.length ? (side === 'before' ? 'after' : 'before') : null };
}

