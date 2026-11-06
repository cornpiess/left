export const FEEDBACK = Object.freeze({ graceMs: 350, detailMs: 1500, fadeMs: 120, indicator: 20, slot: 24 });

export function feedbackPosition(viewport, contentHeight) {
  const height = Math.max(0, Number(viewport) || 0);
  const content = Math.max(0, Number(contentHeight) || 0);
  return { top: Math.max(12, Math.min((height - FEEDBACK.slot) / 2, height - content - 12)), scroll: height > 0 && content > height - 24 };
}
