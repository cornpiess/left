import { DAILY_FREE_LIMIT } from './membershipCore.mjs';

// Display receipts and cleaning decisions are independent product events.
export function createExposureController({ review }) {
  let generation = 0;
  let queue = Promise.resolve();
  return {
    reset() { generation++; },
    expose(item, { ready = false, stable = false } = {}) {
      if (!item?.id || !ready || !stable) return Promise.resolve(false);
      const token = generation;
      const task = queue.catch(() => {}).then(async () => {
        if (token !== generation) return false;
        await review(item);
        return token === generation;
      });
      queue = task;
      return task;
    },
  };
}

// Every cleanup entry point shares this serialized, durable decision boundary.
// No UI pre-check: an already charged asset may be reselected at the limit.
export function createCleanupController({ select, getMembership, applyUsage, limit = DAILY_FREE_LIMIT }) {
  let queue = Promise.resolve();
  return {
    select(item) {
      if (!item?.id) return Promise.resolve({ allowed: false, reason: 'invalid' });
      const task = queue.catch(() => {}).then(async () => {
        const state = await getMembership();
        const result = await select(item, { date: state.date, charge: !state.isPro, limit });
        applyUsage?.(result.used, state.date);
        return { ...result, reason: result.allowed ? null : 'quota' };
      });
      queue = task;
      return task;
    },
  };
}
