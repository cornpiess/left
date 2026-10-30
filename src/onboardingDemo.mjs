// The tutorial owns only these synthetic IDs; no media, quota or history APIs.
export function initialDemo() { return { current: 0, pending: [], favorites: [], lastRemoved: null }; }
export function demoAction(state, action) {
  if (action === 'cleanup' && state.pending.length >= 2) return state;
  if (action === 'undo') {
    if (state.lastRemoved === null) return state;
    return { ...state, current: state.lastRemoved, pending: state.pending.filter(id => id !== state.lastRemoved), lastRemoved: null };
  }
  if (action === 'favorite') return { ...state, favorites: state.favorites.includes(state.current) ? state.favorites.filter(id => id !== state.current) : [...state.favorites, state.current] };
  const direction = action === 'previous' ? -1 : 1;
  const pending = action === 'cleanup' ? [...new Set([...state.pending, state.current])] : state.pending;
  let next = state.current;
  for (let i = 1; i <= 3; i++) {
    const candidate = (state.current + direction * i + 3) % 3;
    if (!pending.includes(candidate)) { next = candidate; break; }
  }
  return { ...state, current: next, pending, lastRemoved: action === 'cleanup' ? state.current : state.lastRemoved };
}
