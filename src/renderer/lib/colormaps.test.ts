import { describe, it, expect } from 'vitest';
import {
  COLORMAP_NAMES,
  COLORMAP_LABELS,
  sampleColormap,
  colormapToCssGradient,
  ColormapName,
} from './colormaps';

describe('colormaps', () => {
  it('exposes a stable set of named colormaps with labels', () => {
    expect(COLORMAP_NAMES.length).toBeGreaterThanOrEqual(6);
    for (const name of COLORMAP_NAMES) {
      expect(typeof COLORMAP_LABELS[name]).toBe('string');
      expect(COLORMAP_LABELS[name].length).toBeGreaterThan(0);
    }
  });

  describe('sampleColormap', () => {
    it('returns RGB tuples in [0,1] for the full t range across every colormap', () => {
      for (const name of COLORMAP_NAMES) {
        for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
          const c = sampleColormap(name, t);
          expect(c).toHaveLength(3);
          for (const channel of c) {
            expect(channel).toBeGreaterThanOrEqual(0);
            expect(channel).toBeLessThanOrEqual(1);
            expect(Number.isFinite(channel)).toBe(true);
          }
        }
      }
    });

    it('clamps out-of-range t values to the endpoint colors', () => {
      const below = sampleColormap('viridis', -5);
      const atZero = sampleColormap('viridis', 0);
      const above = sampleColormap('viridis', 10);
      const atOne = sampleColormap('viridis', 1);
      expect(below).toEqual(atZero);
      expect(above).toEqual(atOne);
    });

    it('falls back to viridis on an unknown colormap name', () => {
      const unknown = sampleColormap('not-a-map' as ColormapName, 0.5);
      const viridis = sampleColormap('viridis', 0.5);
      expect(unknown).toEqual(viridis);
    });

    it('returns the first stop when t is NaN', () => {
      const nanSample = sampleColormap('plasma', Number.NaN);
      const firstStop = sampleColormap('plasma', 0);
      expect(nanSample).toEqual(firstStop);
    });

    it('interpolates linearly between adjacent stops for grayscale', () => {
      // grayscale has exactly two stops [0,0,0] → [1,1,1]
      const mid = sampleColormap('grayscale', 0.5);
      expect(mid[0]).toBeCloseTo(0.5, 6);
      expect(mid[1]).toBeCloseTo(0.5, 6);
      expect(mid[2]).toBeCloseTo(0.5, 6);

      const quarter = sampleColormap('grayscale', 0.25);
      expect(quarter[0]).toBeCloseTo(0.25, 6);
    });

    it('produces monotonic luminance for grayscale', () => {
      let prev = -1;
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const [r, g, b] = sampleColormap('grayscale', t);
        // grayscale: r === g === b
        expect(r).toBeCloseTo(g, 6);
        expect(g).toBeCloseTo(b, 6);
        expect(r).toBeGreaterThanOrEqual(prev);
        prev = r;
      }
    });

    it('starts and ends every colormap at distinct colors', () => {
      for (const name of COLORMAP_NAMES) {
        const start = sampleColormap(name, 0);
        const end = sampleColormap(name, 1);
        const dist =
          Math.abs(start[0] - end[0]) +
          Math.abs(start[1] - end[1]) +
          Math.abs(start[2] - end[2]);
        expect(dist).toBeGreaterThan(0.1);
      }
    });
  });

  describe('colormapToCssGradient', () => {
    it('emits a linear-gradient string with the requested direction and stop count', () => {
      const css = colormapToCssGradient('viridis', 5, 'to right');
      expect(css.startsWith('linear-gradient(to right, ')).toBe(true);
      const rgbStops = (css.match(/rgb\(/g) ?? []).length;
      expect(rgbStops).toBe(5);
    });

    it('defaults to "to top" direction and renders RGB tuples with percent stops', () => {
      const css = colormapToCssGradient('plasma');
      expect(css.startsWith('linear-gradient(to top,')).toBe(true);
      expect(css).toMatch(/rgb\(\d+, \d+, \d+\) 0\.00%/);
      expect(css).toMatch(/rgb\(\d+, \d+, \d+\) 100\.00%/);
    });

    it('produces a single solid stop when samples=1', () => {
      const css = colormapToCssGradient('jet', 1);
      const stopMatches = css.match(/rgb\(/g) ?? [];
      expect(stopMatches.length).toBe(1);
    });
  });
});
