import { describe, it, expect } from 'vitest';
import {
  NOISE_METHOD_OPTIONS,
  NOISE_PARAM_FIELDS,
  buildNoiseParams,
  formatFlaggedSummary,
  formatMultiScanSummary,
  formatResolvedParams,
  noiseRemovalNeedsConfirmation,
  noiseRemovalConfirmMessage,
} from './noiseFilter';

describe('noise method catalogue', () => {
  it('offers the safe local method first and labels SOR as advanced', () => {
    // Order is the dropdown order and the default is the first entry, so this
    // pins the deliberate choice NOT to default to the conventional method.
    expect(NOISE_METHOD_OPTIONS.map(o => o.value)).toEqual(['ror', 'voxel_count', 'sor']);
    expect(NOISE_METHOD_OPTIONS[2].label).toContain('advanced');
    expect(NOISE_METHOD_OPTIONS[2].blurb).toMatch(/aggressive/i);
  });

  it('gives every method a parameter set', () => {
    for (const { value } of NOISE_METHOD_OPTIONS) {
      expect(NOISE_PARAM_FIELDS[value].length).toBeGreaterThan(0);
    }
  });
});

describe('buildNoiseParams', () => {
  it('sends no parameters at all in auto mode', () => {
    // Auto must mean "derive from this cloud", not "resend what the last run
    // resolved" — otherwise the parameters silently pin to a stale cloud after a
    // crop or merge.
    expect(buildNoiseParams('ror', true, { radius: 0.5, nb_points: 9 }))
      .toEqual({ method: 'ror' });
  });

  it('sends only the selected method’s own keys', () => {
    const params = buildNoiseParams('ror', false, {
      radius: 0.15, nb_points: 3, std_ratio: 2.0, voxel: 0.4,
    });
    expect(params).toEqual({ method: 'ror', radius: 0.15, nb_points: 3 });
  });

  it('falls back to auto for a blank, non-finite or out-of-range value', () => {
    expect(buildNoiseParams('sor', false, { nb_neighbors: undefined, std_ratio: 4 }))
      .toEqual({ method: 'sor', std_ratio: 4 });
    expect(buildNoiseParams('sor', false, { nb_neighbors: NaN, std_ratio: 4 }))
      .toEqual({ method: 'sor', std_ratio: 4 });
    // nb_neighbors has min 2; 1 is not a usable neighbour count.
    expect(buildNoiseParams('sor', false, { nb_neighbors: 1 })).toEqual({ method: 'sor' });
  });

  it('keeps a zero that is legal for its field', () => {
    expect(buildNoiseParams('ror', false, { radius: 0 })).toEqual({ method: 'ror', radius: 0 });
  });
});

describe('formatFlaggedSummary', () => {
  it('reads as a headline count plus a share', () => {
    expect(formatFlaggedSummary({ flagged: 24318, fraction: 0.0042 }))
      .toBe('24,318 points (0.42%) flagged');
  });

  it('singularises one point', () => {
    expect(formatFlaggedSummary({ flagged: 1, fraction: 0.001 })).toContain('1 point (');
  });

  it('never renders a non-zero count as 0.00%', () => {
    // "5 points (0.00%) flagged" reads as "nothing happened".
    expect(formatFlaggedSummary({ flagged: 5, fraction: 0.00001 }))
      .toBe('5 points (<0.01%) flagged');
    expect(formatFlaggedSummary({ flagged: 0, fraction: 0 })).toBe('0 points (0.00%) flagged');
  });
});

describe('formatMultiScanSummary', () => {
  it('pools the counts and says how many scans they came from', () => {
    expect(formatMultiScanSummary([
      { flagged: 25, kept: 3518 },
      { flagged: 9, kept: 3518 },
    ])).toBe('34 points (0.48%) flagged across 2 scans');
  });

  it('weighs the pooled total, not the mean of the per-scan shares', () => {
    // A tiny scan that was half noise must not drag a huge clean scan's
    // headline up to ~25% (the mean of 50% and 0%): pooled, it is 50 of
    // 1,000,100 points.
    const summary = formatMultiScanSummary([
      { flagged: 50, kept: 50 },
      { flagged: 0, kept: 1_000_000 },
    ]);
    expect(summary).toBe('50 points (<0.01%) flagged across 2 scans');
  });

  it('singularises a one-scan run', () => {
    expect(formatMultiScanSummary([{ flagged: 1, kept: 99 }]))
      .toBe('1 point (1.00%) flagged across 1 scan');
  });
});

describe('formatResolvedParams', () => {
  it('shows what auto resolved, with units and timing', () => {
    expect(formatResolvedParams({
      params_used: { radius: 0.048, nb_points: 2 }, elapsed_s: 3.14,
    })).toBe('radius 0.048 m · min neighbours 2 · 3.1 s');
  });

  it('omits the timing when the backend did not report one', () => {
    expect(formatResolvedParams({ params_used: { voxel: 0.25 }, elapsed_s: null }))
      .toBe('voxel size 0.250 m');
  });

  it('survives an unknown parameter key', () => {
    expect(formatResolvedParams({ params_used: { mystery: 7 }, elapsed_s: null }))
      .toBe('mystery 7.000');
  });
});

describe('noise removal confirmation', () => {
  it('does not gate a plausible result with no other filters', () => {
    expect(noiseRemovalNeedsConfirmation(
      { over_removal: false }, [])).toBe(false);
  });

  it('gates an implausible flagged fraction', () => {
    expect(noiseRemovalNeedsConfirmation({ over_removal: true }, [])).toBe(true);
    expect(noiseRemovalConfirmMessage(
      { flagged: 500000, fraction: 0.42, over_removal: true }, []))
      .toContain('0.1–3%');
  });

  it('gates when another filter would also be applied', () => {
    // Remove applies EVERY active filter at once, so "I only wanted the noise
    // gone" is a real way to lose half a cloud.
    expect(noiseRemovalNeedsConfirmation({ over_removal: false }, ['Z'])).toBe(true);
    const msg = noiseRemovalConfirmMessage(
      { flagged: 25, fraction: 0.001, over_removal: false }, ['Z', 'Intensity']);
    expect(msg).toContain('2 other active filters');
    expect(msg).toContain('Z, Intensity');
  });

  it('reports both reasons together', () => {
    const msg = noiseRemovalConfirmMessage(
      { flagged: 9, fraction: 0.5, over_removal: true }, ['Z']);
    expect(msg).toContain('0.1–3%');
    expect(msg).toContain('1 other active filter');
  });

  it('handles a null result (nothing detected yet)', () => {
    expect(noiseRemovalNeedsConfirmation(null, [])).toBe(false);
    expect(noiseRemovalConfirmMessage(null, [])).toBe('');
  });
});
