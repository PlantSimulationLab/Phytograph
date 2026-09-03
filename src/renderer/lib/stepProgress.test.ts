// Pins the capture-and-mapping contract behind the multi-scan progress pill.
//
// The defect this replaces: the crop apply loop advanced a shared `let i` before
// awaiting the scan's backend call, and the bake's progress callback read `i`
// through a closure. A 4-scan crop rendered "Cropping plot_d.laz (5 of 4)…",
// pushed the bar past 100%, and then jumped BACKWARDS at the next scan.
import { describe, expect, it } from 'vitest';
import { clamp01, stepCounter, stepReporter } from './stepProgress';

describe('stepCounter', () => {
  it('is one-based and omitted for a single-step run', () => {
    expect(stepCounter(0, 1)).toBe('');
    expect(stepCounter(0, 4)).toBe(' (1 of 4)');
    expect(stepCounter(3, 4)).toBe(' (4 of 4)');
  });

  it('never exceeds the total for any in-range index', () => {
    const total = 4;
    for (let i = 0; i < total; i++) {
      const shown = Number(stepCounter(i, total).match(/\((\d+) of/)![1]);
      expect(shown).toBeLessThanOrEqual(total);
      expect(shown).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('stepReporter', () => {
  it('maps a per-step fraction into that step SLICE of the overall bar', () => {
    const r = stepReporter(1, 4, 'Cropping b…');
    expect(r(0).value).toBeCloseTo(0.25);
    expect(r(0.5).value).toBeCloseTo(0.375);
    expect(r(1).value).toBeCloseTo(0.5);
  });

  it('clamps a fraction outside 0..1 instead of overshooting the slice', () => {
    const r = stepReporter(3, 4, 'Cropping d…');
    // The old inline mapping produced (i+frac)/total with an already-incremented
    // i, i.e. 1.25 on the last scan.
    expect(r(1.4).value).toBeCloseTo(1);
    expect(r(-2).value).toBeCloseTo(0.75);
  });

  it('holds the bar at the slice start for an indeterminate stage', () => {
    const r = stepReporter(2, 4, 'Cropping c…');
    expect(r(null).value).toBeCloseTo(0.5);
  });

  it('can report indeterminate upward when the pill should drop its bar', () => {
    const r = stepReporter(2, 4, 'Building QSM…', { indeterminate: 'null' });
    expect(r(null).value).toBeNull();
    expect(r(0.5).value).toBeCloseTo(0.625);
  });

  it('lets a backend stage name replace the label without losing the mapping', () => {
    const r = stepReporter(1, 2, 'Cropping b…');
    expect(r(0.5, 'Building octree…')).toEqual({ label: 'Building octree…', value: 0.75 });
    // An empty stage label falls back rather than blanking the pill.
    expect(r(0.5, '').label).toBe('Cropping b…');
  });

  it('a single-step run spans the whole bar', () => {
    const r = stepReporter(0, 1, 'Cropping…');
    expect(r(0).value).toBe(0);
    expect(r(0.42).value).toBeCloseTo(0.42);
    expect(r(1).value).toBe(1);
  });

  // THE REGRESSION. A reporter built for step k must keep reporting k even
  // though the loop has moved on — that is the whole reason `index` is a
  // parameter rather than a closed-over counter.
  it('keeps reporting its OWN step after the loop advances', () => {
    const total = 4;
    const reporters: ReturnType<typeof stepReporter>[] = [];
    // Mirrors the apply loop: build the step's reporter, advance, then let the
    // in-flight backend call fire the reporter later.
    for (let i = 0; i < total; i++) {
      reporters.push(stepReporter(i, total, `Cropping scan${i}${stepCounter(i, total)}…`));
    }
    expect(reporters[3](0.5).label).toBe('Cropping scan3 (4 of 4)…');
    // Fired late, after every step was constructed — still its own slice.
    expect(reporters[0](0.5).value).toBeCloseTo(0.125);
    expect(reporters[3](0.5).value).toBeCloseTo(0.875);
    // And nothing can report a counter past the total.
    for (const [i, r] of reporters.entries()) {
      expect(r(1).value!).toBeLessThanOrEqual(1);
      expect(r(1).value!).toBeCloseTo((i + 1) / total);
    }
  });

  it('is monotonic across a whole sequential run', () => {
    const total = 3;
    const seen: number[] = [];
    for (let i = 0; i < total; i++) {
      const r = stepReporter(i, total, 'x');
      for (const f of [null, 0, 0.3, 0.9, 1]) seen.push(r(f as number | null).value!);
    }
    for (let k = 1; k < seen.length; k++) {
      expect(seen[k], `sample ${k} moved backwards`).toBeGreaterThanOrEqual(seen[k - 1]);
    }
    expect(seen[seen.length - 1]).toBeCloseTo(1);
  });
});

describe('clamp01', () => {
  it('clamps, and pins non-finite input rather than letting it escape', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Infinity)).toBe(1);
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(NaN)).toBe(0);
  });
});
