/**
 * App Store rating prompt — pure decision logic.
 *
 * Design rules (keep in sync with AGENTS.md v273 entry):
 * - The prompt may only surface at natural pauses (feed completion page); it
 *   never interrupts the swiping flow.
 * - Milestone gate: the user must have actually cleaned a meaningful amount
 *   of space (>= RATING_MIN_CLEANED_BYTES) before the app ever asks.
 * - Neutral wording only: no "do you like us?" sentiment branching — Apple
 *   review guidelines forbid review gating.
 * - After a completed rating the automatic prompt never fires again; "later"
 *   starts a cooldown. The permanent more-menu entry is always available.
 */

export const APP_STORE_ID = '6804368763';
export const APP_STORE_WRITE_REVIEW_URL = `itms-apps://itunes.apple.com/app/id${APP_STORE_ID}?action=write-review`;
export const APP_STORE_WRITE_REVIEW_WEB_URL = `https://apps.apple.com/app/id${APP_STORE_ID}?action=write-review`;

/** Minimum cumulative cleaned bytes before the automatic prompt may appear. */
export const RATING_MIN_CLEANED_BYTES = 100 * 1024 * 1024;
/** Cooldown applied after the user taps "next time". */
export const RATING_LATER_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Decide whether the automatic rating invitation should be shown.
 *
 * @param {object} input
 * @param {number} input.cleanedBytes Cumulative cleaned bytes (getTotalCleanedBytes()).
 * @param {{lastAction?: string, lastActionAt?: number}|null} [input.promptState]
 * @param {number} [input.now] Epoch ms (defaults to Date.now()).
 * @returns {boolean}
 */
export function shouldOfferRatingPrompt({ cleanedBytes, promptState, now = Date.now() }) {
  if (!(cleanedBytes >= RATING_MIN_CLEANED_BYTES)) return false;
  if (!promptState || typeof promptState !== 'object') return true;

  const { lastAction, lastActionAt } = promptState;
  if (lastAction === 'rated') return false;
  if (lastAction === 'later') {
    if (typeof lastActionAt !== 'number') return true;
    return now - lastActionAt >= RATING_LATER_COOLDOWN_MS;
  }
  return true;
}

/**
 * Pure reducer for prompt state after a user action. Returns a new state object.
 *
 * @param {{lastAction?: string, lastActionAt?: number}|null} prevState
 * @param {'rated'|'later'} action
 * @param {number} [now] Epoch ms.
 */
export function buildRatingPromptStateAfterAction(prevState, action, now = Date.now()) {
  if (action !== 'rated' && action !== 'later') return prevState || null;
  return { lastAction: action, lastActionAt: now };
}
