// The renderer's point budget — how many octree points potree keeps resident
// and draws per frame across the whole scene — is the one number that decides
// both how detailed a large cloud looks and how much GPU/RAM the view costs.
// 2 M (24 MB of positions on the GPU) is right for a laptop; a workstation
// with a discrete GPU draws 10 M without dropping frames, and a machine that
// struggles wants 1 M. The setting is stored in MILLIONS of points (what a
// person types), blank meaning the default.

export const DEFAULT_DISPLAY_POINT_BUDGET = 2_000_000;
// Below this the coarsest LOD alone exceeds the budget on a large cloud and
// the view degrades to scattered dots; above it a single frame's position
// upload exceeds what integrated GPUs sustain at 60 fps.
export const MIN_DISPLAY_POINT_BUDGET = 250_000;
export const MAX_DISPLAY_POINT_BUDGET = 30_000_000;

/** Points to draw for a persisted "million points" setting: blank/invalid →
 * the default, otherwise clamped to the sane range. */
export function resolveDisplayPointBudget(
  millions: number | null | undefined,
  fallback: number = DEFAULT_DISPLAY_POINT_BUDGET,
): number {
  if (millions == null || !Number.isFinite(millions) || millions <= 0) return fallback;
  const pts = Math.round(millions * 1_000_000);
  return Math.min(MAX_DISPLAY_POINT_BUDGET, Math.max(MIN_DISPLAY_POINT_BUDGET, pts));
}

/** What the Settings field's text means: blank is "default", junk is rejected
 * (stored as default rather than clobbering the field with 0). */
export function parseDisplayPointBudgetDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (trimmed === '') return null;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}
