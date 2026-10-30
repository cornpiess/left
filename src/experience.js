import { createExposureController, createCleanupController } from './experienceCore.mjs';
import { markAssetViewed, selectForCleanup } from './media';
import { getMembershipState, initMembership, applyDailyUsage, DAILY_FREE_LIMIT } from './membership';
export const experience = createExposureController({ review: markAssetViewed });
export const cleanup = createCleanupController({
  select: selectForCleanup,
  getMembership: async () => { await initMembership(); return getMembershipState(); },
  applyUsage: applyDailyUsage,
  limit: DAILY_FREE_LIMIT,
});
