import { describe, it, expect } from 'vitest';
import {
  formatStat,
  formatCount,
  histogramBars,
  histogramTicks,
  outsideCaption,
  nonFiniteCaption,
  type ScalarHistogramData,
  type ScalarStats,
} from './scalarFieldStats';

function hist(partial: Partial<ScalarHistogramData> = {}): ScalarHistogramData {
  return {
    bin_edges: [0, 1, 2, 3],
    counts: [1, 4, 2],
    below_count: 0,
    above_count: 0,
    degenerate: false,
    ...partial,
  };
}

describe('formatStat', () => {
  it('adapts the decimal places to the magnitude', () => {
    // A fixed 2-decimal rendering would print "0.00" for this, which is the
    // whole reason curvature needed its own treatment.
    expect(formatStat(0.00031)).toBe('0.00031');
    expect(formatStat(1234.5678)).toBe('1235');
  });

  it('keeps every integer digit of a large coordinate', () => {
    // A UTM easting is the value class most at risk here. Rounding it to 4
    // significant figures would print "601200" and silently throw away 35 m of
    // position; `toPrecision(4)` additionally renders it as "6.012e+5", which
    // is unreadable in a stats table. Neither is acceptable for a coordinate,
    // so above 1 the fractional digits shrink but the integer part is kept
    // whole.
    expect(formatStat(601234.567)).toBe('601235');
  });

  it('trims trailing zeros a fixed conversion leaves behind', () => {
    expect(formatStat(2.5)).toBe('2.5');
    expect(formatStat(3)).toBe('3');
  });

  it('switches to exponential outside the readable fixed range', () => {
    expect(formatStat(1e-9)).toContain('e');
    expect(formatStat(5e12)).toContain('e');
  });

  it('prints integer fields bare — a class id is not 3.00', () => {
    expect(formatStat(3, true)).toBe('3');
    // float32 round-trip noise must not surface as "2.9999998".
    expect(formatStat(2.9999998, true)).toBe('3');
  });

  it('renders zero and non-finite values without NaN leaking to the UI', () => {
    expect(formatStat(0)).toBe('0');
    expect(formatStat(undefined)).toBe('—');
    expect(formatStat(NaN)).toBe('—');
    expect(formatStat(Infinity)).toBe('—');
  });
});

describe('formatCount', () => {
  it('groups thousands', () => {
    expect(formatCount(1234567)).toBe((1234567).toLocaleString());
  });

  it('handles absent counts', () => {
    expect(formatCount(undefined)).toBe('—');
  });
});

describe('histogramBars', () => {
  it('scales heights to the tallest bin, not the total', () => {
    // The shape is the point: scaling to the total would make a long tail
    // invisible next to a dominant mode.
    const bars = histogramBars(hist({ counts: [1, 4, 2] }));
    expect(bars.map(b => b.height)).toEqual([0.25, 1, 0.5]);
  });

  it('tiles the unit box with no gaps', () => {
    const bars = histogramBars(hist({ counts: [1, 2, 3, 4] }));
    expect(bars).toHaveLength(4);
    expect(bars[0].x).toBe(0);
    bars.forEach((b, i) => {
      if (i > 0) expect(b.x).toBeCloseTo(bars[i - 1].x + bars[i - 1].width, 12);
    });
    const last = bars[bars.length - 1];
    expect(last.x + last.width).toBeCloseTo(1, 12);
  });

  it('derives x from the bin index so float wobble cannot open a hairline gap', () => {
    // Edges that do not divide evenly would leave sub-pixel seams if x came
    // from the edge values.
    const bars = histogramBars(hist({
      bin_edges: [0, 0.1, 0.20000000000000004, 0.3],
      counts: [1, 1, 1],
    }));
    expect(bars[1].x).toBeCloseTo(1 / 3, 12);
    expect(bars[2].x).toBeCloseTo(2 / 3, 12);
  });

  it('carries each bin range for the tooltip', () => {
    const bars = histogramBars(hist());
    expect(bars[0].from).toBe(0);
    expect(bars[0].to).toBe(1);
    expect(bars[2].to).toBe(3);
  });

  it('returns nothing to draw for absent, empty or degenerate histograms', () => {
    expect(histogramBars(undefined)).toEqual([]);
    expect(histogramBars(hist({ degenerate: true }))).toEqual([]);
    expect(histogramBars(hist({ counts: [] }))).toEqual([]);
    // All-zero counts have no peak to scale against.
    expect(histogramBars(hist({ counts: [0, 0, 0] }))).toEqual([]);
  });
});

describe('histogramTicks', () => {
  it('returns both ends and the midpoint', () => {
    expect(histogramTicks(hist({ bin_edges: [0, 1, 2, 10] }))).toEqual([0, 5, 10]);
  });

  it('collapses to one tick when the domain is a point', () => {
    expect(histogramTicks(hist({ bin_edges: [7, 7] }))).toEqual([7]);
  });

  it('handles an absent histogram', () => {
    expect(histogramTicks(undefined)).toEqual([]);
  });
});

describe('outsideCaption', () => {
  it('says so when points fall outside the plotted range', () => {
    // The histogram bins over p1-p99 so one spike cannot flatten it; a chart
    // that quietly omitted those points would be worse than one that says so.
    expect(outsideCaption(hist({ below_count: 12, above_count: 3 })))
      .toBe('12 below, 3 above the plotted range');
    expect(outsideCaption(hist({ above_count: 5 }))).toBe('5 above the plotted range');
  });

  it('is silent when every point is plotted', () => {
    expect(outsideCaption(hist())).toBeNull();
    expect(outsideCaption(undefined)).toBeNull();
    expect(outsideCaption(hist({ degenerate: true, below_count: 9 }))).toBeNull();
  });
});

describe('nonFiniteCaption', () => {
  const base: ScalarStats = {
    count: 10, finite_count: 10, nan_count: 0, inf_count: 0,
  };

  it('reports NaN and infinite values, which the statistics exclude', () => {
    expect(nonFiniteCaption({ ...base, nan_count: 2 }))
      .toBe('2 NaN — excluded from these statistics');
    expect(nonFiniteCaption({ ...base, nan_count: 2, inf_count: 1 }))
      .toBe('2 NaN and 1 infinite — excluded from these statistics');
  });

  it('is silent for a clean field', () => {
    expect(nonFiniteCaption(base)).toBeNull();
    expect(nonFiniteCaption(undefined)).toBeNull();
  });
});
