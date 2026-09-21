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

// How much of the display budget a CLIP-VOLUME crop preview (Box mode) keeps.
//
// potree clips an AABB with a fragment-shader `discard`, which disables
// early-Z: occluded points still run the shader, so overdraw scales with depth
// complexity and spikes exactly when the box is concentrated on a dense region.
// Fewer resident points ⇒ proportionally fewer fragment invocations. The
// screen-space shapes (Rect/Polygon) reject points with an index buffer and
// never submit them, so they pay no such cost and keep the full budget.
export const CROP_PREVIEW_BUDGET_FRACTION = 1 / 4;

/**
 * Points to draw while a crop CLIP VOLUME is previewed.
 *
 * Derived from the user's own display budget rather than being a constant.
 * This was a flat 150_000, which is wrong in two compounding ways:
 *
 *   • It sits BELOW `MIN_DISPLAY_POINT_BUDGET` (250k) — the threshold this
 *     module documents as the point where "the coarsest LOD alone exceeds the
 *     budget on a large cloud and the view degrades to scattered dots". The
 *     crop preview was the one place in the app that went there on purpose,
 *     and the reported symptom ("almost non-viewable") is exactly that.
 *   • It ignored the setting entirely, so a workstation configured for 10M
 *     still dropped to 150k on entering Box mode — a 67x cut instead of 13x.
 *
 * Scaling keeps the overdraw guard proportional (a real cut at any setting)
 * while the floor keeps it above the app's own viewability threshold. Clamped
 * to the budget itself so a user who has deliberately set a LOW budget is
 * never handed MORE points during a preview than in normal viewing.
 */
export function resolveCropPreviewPointBudget(displayBudget: number): number {
  if (!Number.isFinite(displayBudget) || displayBudget <= 0) {
    return MIN_DISPLAY_POINT_BUDGET;
  }
  const scaled = Math.round(displayBudget * CROP_PREVIEW_BUDGET_FRACTION);
  return Math.min(displayBudget, Math.max(MIN_DISPLAY_POINT_BUDGET, scaled));
}

/** What the Settings field's text means: blank is "default", junk is rejected
 * (stored as default rather than clobbering the field with 0). */
export function parseDisplayPointBudgetDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (trimmed === '') return null;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}
