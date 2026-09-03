// Pure logic for the Filter panel's Noise section. No React, no backend calls —
// unit-tested directly in noiseFilter.test.ts.
//
// The Noise section does not remove anything itself: it classifies points into a
// `noise_class` column (1 = clean, 2 = noise) and then arms the Filter tool's
// EXISTING "Filter (remove points)" / "Segment (split into two clouds)" buttons.
// That is why there is no commit logic here.
import type { NoiseMethod, NoiseParams, DenoiseStats } from '../utils/backendApi';

export interface NoiseMethodOption {
  value: NoiseMethod;
  label: string;
  // One or two lines shown under the dropdown. These carry the actual guidance —
  // the choice between these three is the whole risk surface of the feature.
  blurb: string;
}

// Order is the dropdown order, and it is deliberate: the safe local method
// first, the fast one for big clouds second, and the conventional-but-dangerous
// statistical method last and labelled.
export const NOISE_METHOD_OPTIONS: NoiseMethodOption[] = [
  {
    value: 'ror',
    label: 'Isolated points (recommended)',
    blurb: 'Flags points with too few neighbours nearby. Safe on fine twigs, and '
      + 'gives the same answer however often you run it.',
  },
  {
    value: 'voxel_count',
    label: 'Sparse voxels (fast)',
    blurb: 'Bins the cloud and flags near-empty bins. Much faster on very large '
      + 'clouds, but coarser — it can clip the last point of a thin branch.',
  },
  {
    value: 'sor',
    label: 'Statistical (SOR) — advanced',
    blurb: 'The conventional method. Catches tight noise clumps the others miss, '
      + 'but gets MORE aggressive each time you run it, so it can eat fine '
      + 'structure on a second pass. Review before removing.',
  },
];

// Every NoiseParams key EXCEPT `method` — i.e. exactly the numeric ones that get
// an input. Keeps `method` out of the numeric-field machinery by construction.
export type NoiseParamKey = Exclude<keyof NoiseParams, 'method'>;

export interface NoiseParamField {
  key: NoiseParamKey;
  label: string;
  integer: boolean;
  min: number;
  step?: number;
}

// Which numeric inputs each method shows. Only these keys are ever sent for that
// method: shipping another method's parameter would make the backend echo a
// `params_used` the panel then displays as though it had been applied.
export const NOISE_PARAM_FIELDS: Record<NoiseMethod, NoiseParamField[]> = {
  ror: [
    { key: 'radius', label: 'Radius (m)', integer: false, min: 0, step: 0.01 },
    { key: 'nb_points', label: 'Min neighbours', integer: true, min: 1 },
  ],
  voxel_count: [
    { key: 'voxel', label: 'Voxel size (m)', integer: false, min: 0, step: 0.01 },
    { key: 'min_points', label: 'Min points per voxel', integer: true, min: 1 },
  ],
  sor: [
    { key: 'nb_neighbors', label: 'Neighbours (k)', integer: true, min: 2 },
    { key: 'std_ratio', label: 'Std ratio', integer: false, min: 0, step: 0.5 },
  ],
};

/** The request body for a Detect run.
 *
 * `auto` sends NO parameters at all, so the backend derives every one from the
 * cloud's own point spacing. That is a different thing from sending the values
 * currently displayed: those are whatever the LAST run resolved, and re-sending
 * them would pin the parameters to a stale cloud after a crop or a merge. */
export function buildNoiseParams(
  method: NoiseMethod,
  auto: boolean,
  draft: NoiseParams,
): NoiseParams {
  const params: NoiseParams = { method };
  if (auto) return params;
  for (const field of NOISE_PARAM_FIELDS[method]) {
    const value = draft[field.key];
    // Only finite, in-range values are sent; anything else falls back to auto
    // for that one parameter rather than failing the whole run.
    if (typeof value === 'number' && Number.isFinite(value) && value >= field.min) {
      (params as Record<string, number>)[field.key] = value;
    }
  }
  return params;
}

/** "24,318 points (0.42%) flagged" — the headline number the user judges. */
export function formatFlaggedSummary(stats: Pick<DenoiseStats, 'flagged' | 'fraction'>): string {
  const pct = stats.fraction * 100;
  // Below 0.01% "0.00%" reads as "nothing happened" when points were in fact
  // flagged, so switch to a coarser-but-honest form.
  const pctText = pct > 0 && pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`;
  return `${stats.flagged.toLocaleString()} point${stats.flagged === 1 ? '' : 's'} `
    + `(${pctText}) flagged`;
}

/** "1,204 points (0.85%) flagged across 4 scans" — the run-level headline for a
 * multi-scan detection. The panel's result box only ever shows the PRIMARY
 * scan's numbers (it edits one cloud's criteria), so without this the user gets
 * no evidence that the other selected scans were touched at all.
 *
 * The percentage is over the pooled point total, not the mean of the per-scan
 * percentages: a 200-point scan and a 20 M-point scan must not weigh the same. */
export function formatMultiScanSummary(
  perScan: Pick<DenoiseStats, 'flagged' | 'kept'>[],
): string {
  const flagged = perScan.reduce((sum, s) => sum + s.flagged, 0);
  const total = perScan.reduce((sum, s) => sum + s.flagged + s.kept, 0);
  const summary = formatFlaggedSummary({ flagged, fraction: total > 0 ? flagged / total : 0 });
  return `${summary} across ${perScan.length} scan${perScan.length === 1 ? '' : 's'}`;
}

/** "radius 0.048 m · 3.1 s" — what auto actually resolved, so the run is
 * reproducible and the user can see whether the number is sane for their scan. */
export function formatResolvedParams(stats: Pick<DenoiseStats, 'params_used' | 'elapsed_s'>): string {
  const parts = Object.entries(stats.params_used ?? {}).map(([key, value]) => {
    const field = Object.values(NOISE_PARAM_FIELDS).flat().find(f => f.key === key);
    const label = (field?.label ?? key).replace(/ \(m\)$/, '').toLowerCase();
    const num = field?.integer ? String(value) : value.toFixed(3);
    const unit = field?.label.endsWith('(m)') ? ' m' : '';
    return `${label} ${num}${unit}`;
  });
  if (stats.elapsed_s != null) parts.push(`${stats.elapsed_s.toFixed(1)} s`);
  return parts.join(' · ');
}

/** Should the destructive "remove" be gated behind a confirmation?
 *
 * Two independent reasons, both about a removal the user did not intend:
 *  - the run flagged an implausible share of the cloud (`over_removal`), or
 *  - another filter is also active, and Remove applies ALL of them at once —
 *    "I only wanted the noise gone" is the failure that guards against. */
export function noiseRemovalNeedsConfirmation(
  stats: Pick<DenoiseStats, 'over_removal'> | null,
  otherActiveFilterLabels: string[],
): boolean {
  return !!stats?.over_removal || otherActiveFilterLabels.length > 0;
}

export function noiseRemovalConfirmMessage(
  stats: Pick<DenoiseStats, 'flagged' | 'fraction' | 'over_removal'> | null,
  otherActiveFilterLabels: string[],
): string {
  const lines: string[] = [];
  if (stats?.over_removal) {
    lines.push(
      `This flagged ${formatFlaggedSummary(stats)} — far more than the 0.1–3% `
      + 'typical of scanner noise. Check the red points before removing them.');
  }
  if (otherActiveFilterLabels.length > 0) {
    lines.push(
      `Removing also applies ${otherActiveFilterLabels.length} other active `
      + `filter${otherActiveFilterLabels.length === 1 ? '' : 's'} `
      + `(${otherActiveFilterLabels.join(', ')}).`);
  }
  return lines.join('\n\n');
}
