// Mapping one step of a sequential multi-scan run onto a single 0..1 bar.
//
// WHY THIS EXISTS — the mapping itself is three lines of arithmetic, but every
// loop that inlined it got the CAPTURE wrong at least once. A per-scan reporter
// outlives the statement that created it: it is stashed in a ref (or passed to a
// streaming fetch) and invoked later, while the backend call for that scan is
// still running. If it reads the loop counter through a closure over a MUTABLE
// binding, and the loop advances that binding before awaiting, the reporter
// reports the NEXT scan's index.
//
// That is not hypothetical. The crop apply loop incremented `i` immediately
// before `await processOne(cloudId)`, so every bake progress marker for scan k
// was labelled k+2 and scaled into k+1's slice: a 4-scan crop displayed
// "Cropping plot_d.laz (5 of 4)…", overshot 100%, and then SNAPPED BACKWARDS
// when the next scan set the bar to its own start.
//
// Taking `index` as a parameter is what fixes it — the value is copied into the
// closure at construction, so the reporter cannot see a later step. Call sites
// build one reporter per step and never mutate a shared counter.
//
// Deliberately dependency-free and pure so the behaviour is unit-testable
// without mounting the 20k-line viewer component (same reasoning as
// sequentialApply.test.tsx).

/** One rendered state of a StatusPill: its text and its bar (null = indeterminate). */
export interface StepBar {
  label: string;
  value: number | null;
}

export interface StepReporterOptions {
  /**
   * What an indeterminate stage (a null fraction from the backend) does to the bar.
   *
   *   'hold' — freeze at this step's slice start. The bar stays where it is and
   *            keeps its earlier steps' progress visible. Default, and what a
   *            multi-scan run wants: snapping to indeterminate mid-run reads as
   *            the run having restarted.
   *   'null' — report indeterminate upward, so the pill drops the bar entirely.
   */
  indeterminate?: 'hold' | 'null';
}

/** `n` clamped into [0, 1]; NaN and ±Infinity land on 0 and 1 rather than escaping. */
export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return n > 0 ? 1 : 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * `" (3 of 8)"` for a multi-step run, `""` for a single-step one — so a lone scan
 * reads as a plain "Cropping…" rather than a pointless "(1 of 1)".
 *
 * `index` is ZERO-based; the rendered counter is one-based.
 */
export function stepCounter(index: number, total: number): string {
  if (total <= 1) return '';
  return ` (${index + 1} of ${total})`;
}

/**
 * Build the progress reporter for ONE step of a `total`-step run.
 *
 * The returned function maps a per-step fraction into this step's slice of the
 * overall bar — `[index/total, (index+1)/total]` — so a multi-scan run reads as
 * one monotonic 0→1 rather than N sawteeth. It is safe to hold past the step:
 * `index` was copied in here, so a stale reporter reports stale-but-correct
 * numbers instead of the next step's.
 *
 * `stageLabel`, when given, replaces the label — that is how a backend stage name
 * ("Building octree…") reaches the pill without the caller re-deriving the counter.
 */
export function stepReporter(
  index: number,
  total: number,
  label: string,
  opts: StepReporterOptions = {},
): (fraction: number | null, stageLabel?: string) => StepBar {
  const steps = Math.max(1, total);
  const base = Math.min(index, steps) / steps;
  const span = 1 / steps;
  const indeterminate = opts.indeterminate ?? 'hold';
  return (fraction, stageLabel) => ({
    label: stageLabel || label,
    value: fraction == null
      ? (indeterminate === 'null' ? null : base)
      : base + span * clamp01(fraction),
  });
}
