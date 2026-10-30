import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

// Onboarding must stay fully decoupled from quota / membership / paywall logic.
// It persists exactly one boolean and never reads or writes any business state.
const KEY = 'hasCompletedOnboarding';

// Markers that prove an install predates onboarding. If any exists, treat the
// upgrade user as having already completed onboarding so they never see it.
const LEGACY_USER_KEYS = [
  'viewedHistory',
  'maoqiuTrash',
  'cleanedStorageBytes',
  'usedTodayDate',
  'usedTodayCount',
  '@maoqiu_language',
  'vibe-swipe-coach-done',
];

export async function readOnboardingCompleted() {
  try {
    const saved = await AsyncStorage.getItem(KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
    const checks = await Promise.all(
      LEGACY_USER_KEYS.map((k) => AsyncStorage.getItem(k).catch(() => null))
    );
    const files = await Promise.all(['vibe-viewed-assets.json', 'vibe-trash-assets.json', 'vibe-membership.json', 'SQLite/maoqiu-review.db'].map(name =>
      FileSystem.getInfoAsync(`${FileSystem.documentDirectory}${name}`).then(info => info.exists).catch(() => false)));
    const isExistingUser = checks.some((v) => v !== null) || files.some(Boolean);
    await AsyncStorage.setItem(KEY, isExistingUser ? '1' : '0');
    return isExistingUser;
  } catch {
    // Storage failure must never block launching into the app.
    return true;
  }
}

export async function completeOnboarding() {
  try {
    await AsyncStorage.setItem(KEY, '1');
  } catch {}
}
