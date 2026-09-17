// Presentation helpers for the Scalar Fields panel: formatting a statistic for
// a 260 px-wide readout, and turning histogram bins into SVG geometry.
//
// Pure + stateless — no React, no fetch. The numbers themselves all come from
// the backend (`scalar_fields.describe`), which measures them over the points
// that are alive AND real returns; nothing here re-derives a statistic, so the
// panel can never disagree with the legend beside it.

/** One field's statistics, as `GET .../scalar_fields/{slug}/stats` returns them. */
export interface ScalarStats {
  count: number;
  finite_count: number;
  nan_count: number;
  inf_count: number;
  // Absent when the column holds no finite values at all — the backend omits
  // them rather than emitting NaNs every caller would have to guard.
  min?: number;
  max?: number;
  mean?: number;
  std?: number;
  median?: number;
  p1?: number;
  p5?: number;
  p25?: number;
  p75?: number;
  p95?: number;
  p99?: number;
  histogram?: ScalarHistogramData;
}

export interface ScalarHistogramData {
  /** `counts.length + 1` edges, spanning the p1–p99 domain the bars cover. */
  bin_edges: number[];
  counts: number[];
  /** Points below/above the binned domain. Counted, never silently dropped. */
  below_count: number;
  above_count: number;
  /** A constant column: there is no span to bin. */
  degenerate: boolean;
}

/**
 * Format a scalar for display.
 *
 * LiDAR scalar fields span an absurd dynamic range — a `tree_instance` id of 7,
 * a reflectance of -12.4 dB, a UTM easting of 601234.567, a curvature of
 * 0.00031. A single `toFixed(n)` is wrong for at least two of those: it prints
 * `0.00` for the curvature and eleven characters of noise for the easting.
 *
 * So the rule is ~4 significant figures' worth of DECIMAL PLACES, chosen from
 * the magnitude, with three carve-outs: an integer-valued field prints bare (a
 * class id is not `3.00`); anything outside the readable range of a fixed
 * notation switches to exponential; and the integer part is never rounded away,
 * because for a coordinate those digits are the measurement (`601234.567` must
 * not become `601200`, losing 35 m of position, nor `6.012e+5`).
 */
export function formatStat(value: number | undefined, integer = false): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (integer) return String(Math.round(value));
  if (value === 0) return '0';
  const mag = Math.abs(value);
  // Below this a fixed rendering is all leading zeros; above it, all digits.
  if (mag < 1e-4 || mag >= 1e7) return value.toExponential(3);
  // 4 significant figures. `toPrecision` is the right rounding but the wrong
  // NOTATION above 1e6 — it returns "6.012e+5" for a UTM easting, which is
  // exactly the value class that most needs to stay readable. So round to 4
  // significant figures and render the result fixed.
  const digits = Math.max(0, 4 - Math.floor(Math.log10(mag)) - 1);
  const fixed = value.toFixed(digits);
  // Trim the trailing zeros a fixed conversion leaves behind (`2.500` → `2.5`)
  // so the column stays narrow.
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/**
 * Format a point count with thousands separators.
 *
 * Separate from `formatStat` because a count is never a measurement: it is
 * always a whole number and always wants grouping, where a scalar never does.
 */
export function formatCount(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

/** A bar, in the 0..1 unit box the histogram component scales into place. */
export interface HistogramBar {
  /** Left edge, 0..1 across the binned domain. */
  x: number;
  /** Width, 0..1. */
  width: number;
  /** Height, 0..1 of the tallest bar. */
  height: number;
  count: number;
  /** The bin's value range, for the hover tooltip. */
  from: number;
  to: number;
}

/**
 * Turn histogram bins into unit-box bars.
 *
 * Returns [] for an absent, empty or degenerate histogram, so the caller
 * renders its empty state rather than an axis with nothing on it.
 *
 * Heights are scaled to the TALLEST BIN rather than to the total, because the
 * shape is the point: a field where 95% of points share one value would
 * otherwise draw one full-height bar and 60 invisible ones, hiding exactly the
 * tail the user opened the panel to look at.
 */
export function histogramBars(h: ScalarHistogramData | undefined): HistogramBar[] {
  if (!h || h.degenerate || !h.counts?.length || !h.bin_edges?.length) return [];
  const peak = Math.max(...h.counts);
  if (!(peak > 0)) return [];
  const n = h.counts.length;
  const lo = h.bin_edges[0];
  const hi = h.bin_edges[h.bin_edges.length - 1];
  const span = hi - lo;
  return h.counts.map((count, i) => {
    const from = h.bin_edges[i];
    const to = h.bin_edges[i + 1] ?? hi;
    return {
      // Derive x from the bin INDEX, not from the edge value, so a
      // floating-point wobble in the edges can't leave a hairline gap between
      // adjacent bars.
      x: i / n,
      width: 1 / n,
      height: count / peak,
      count,
      from,
      to: span === 0 ? from : to,
    };
  });
}

/**
 * Tick values for the histogram's x axis: the two ends and the midpoint.
 *
 * Three is what fits under a 260 px panel without the labels colliding once
 * they are 4 significant figures wide.
 */
export function histogramTicks(h: ScalarHistogramData | undefined): number[] {
  if (!h || !h.bin_edges?.length) return [];
  const lo = h.bin_edges[0];
  const hi = h.bin_edges[h.bin_edges.length - 1];
  if (!(hi > lo)) return [lo];
  return [lo, (lo + hi) / 2, hi];
}

/**
 * The caption for points outside the binned domain, or null when there are none.
 *
 * The histogram is binned over p1–p99 (see `scalar_fields.HIST_LOW_PERCENTILE`)
 * so one spike cannot flatten it. That is the right default, but it means the
 * bars do not account for every point — and a chart that quietly omits data is
 * worse than one that says so. This is the saying-so.
 */
export function outsideCaption(h: ScalarHistogramData | undefined): string | null {
  if (!h || h.degenerate) return null;
  const below = h.below_count ?? 0;
  const above = h.above_count ?? 0;
  if (below + above === 0) return null;
  const parts: string[] = [];
  if (below > 0) parts.push(`${formatCount(below)} below`);
  if (above > 0) parts.push(`${formatCount(above)} above`);
  return `${parts.join(', ')} the plotted range`;
}

/** The rows of the statistics table, in display order. */
export const STAT_ROWS: ReadonlyArray<{ key: keyof ScalarStats; label: string }> = [
  { key: 'count', label: 'Points' },
  { key: 'mean', label: 'Mean' },
  { key: 'std', label: 'Std dev' },
  { key: 'min', label: 'Min' },
  { key: 'max', label: 'Max' },
  { key: 'median', label: 'Median' },
  { key: 'p5', label: '5th pct' },
  { key: 'p25', label: '25th pct' },
  { key: 'p75', label: '75th pct' },
  { key: 'p95', label: '95th pct' },
];

/**
 * The advisory about non-finite values, or null when the field is clean.
 *
 * Worth surfacing because NaN and infinity are a normal outcome of the
 * calculator (`log` of a negative, a division by zero) rather than an error,
 * and they are excluded from every statistic above — so a user comparing
 * `Points` against the cloud's own count needs to know where the difference
 * went.
 */
export function nonFiniteCaption(stats: ScalarStats | undefined): string | null {
  if (!stats) return null;
  const nan = stats.nan_count ?? 0;
  const inf = stats.inf_count ?? 0;
  if (nan + inf === 0) return null;
  const parts: string[] = [];
  if (nan > 0) parts.push(`${formatCount(nan)} NaN`);
  if (inf > 0) parts.push(`${formatCount(inf)} infinite`);
  return `${parts.join(' and ')} — excluded from these statistics`;
}
