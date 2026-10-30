// Hints teach one action at a time and never block real photos.
export function nextExperienceHint(state, { ready, browsingCount }) {
  if (!state || !ready || state.dismissed) return null;
  if (!state.browsed) return 'browse';
  if (!state.selected && browsingCount >= 3) return 'cleanup';
  return null;
}
export function learnExperience(state = {}, event) {
  if (event === 'browse') return { ...state, browsed: true };
  if (event === 'select') return { ...state, browsed: true, selected: true };
  if (event === 'dismiss') return { ...state, dismissed: true };
  return state;
}
