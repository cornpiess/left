import { Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  APP_STORE_WRITE_REVIEW_URL,
  APP_STORE_WRITE_REVIEW_WEB_URL,
} from './ratingPrompt.mjs';

const RATING_PROMPT_STORAGE_KEY = 'appRatingPrompt';

/** Load the persisted rating prompt state ({lastAction, lastActionAt}) or null. */
export async function loadRatingPromptState() {
  try {
    const raw = await AsyncStorage.getItem(RATING_PROMPT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return { lastAction: parsed.lastAction, lastActionAt: parsed.lastActionAt };
  } catch {
    return null;
  }
}

/** Persist the rating prompt state after a user action ('rated' | 'later'). */
export async function saveRatingPromptState(state) {
  if (!state || typeof state !== 'object') return;
  try {
    await AsyncStorage.setItem(RATING_PROMPT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Persistence failures must never surface to the user.
  }
}

/**
 * Open the App Store write-review page. Tries the native itms-apps scheme
 * first (jumps straight into the review sheet) and falls back to the public
 * https page. Resolves false when both routes fail.
 */
export async function openAppStoreReview() {
  for (const url of [APP_STORE_WRITE_REVIEW_URL, APP_STORE_WRITE_REVIEW_WEB_URL]) {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      // Try the next route.
    }
  }
  return false;
}
