import * as FileSystem from 'expo-file-system/legacy';
import { createReviewStore } from './reviewStore.mjs';

async function readLegacyJson(filename, fallback) {
  const path = `${FileSystem.documentDirectory}${filename}`;
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return fallback;
  return JSON.parse(await FileSystem.readAsStringAsync(path));
}
export const reviewStore = createReviewStore({
  open: async () => {
    const SQLite = require('expo-sqlite');
    return SQLite.openDatabaseAsync('maoqiu-review.db');
  },
  readLegacy: async () => {
    const [viewed, trash, bytes, quota] = await Promise.all([
      readLegacyJson('vibe-viewed-assets.json', []),
      readLegacyJson('vibe-trash-assets.json', []),
      readLegacyJson('vibe-cleaned-history.json', 0),
      readLegacyJson('vibe-membership.json', {}),
    ]);
    if (!Array.isArray(viewed) || !Array.isArray(trash) || !Number.isFinite(bytes)) throw Error('Invalid legacy review data');
    return { viewed: viewed.filter(id => typeof id === 'string'), trash: trash.filter(id => typeof id === 'string'), bytes: Math.max(0, bytes), quota: typeof quota?.date === 'string' && Number.isFinite(quota.usedToday) ? quota : {} };
  },
});
