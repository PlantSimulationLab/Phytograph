import { describe, it, expect } from 'vitest';
import {
  COLORMAP_NAMES,
  COLORMAP_LABELS,
  COLORMAP_GROUPS,
  sampleColormap,
  colormapToCssGradient,
  colormapColorForValue,
  colormapColorForValueInto,
  discreteColor,
  discretePeriod,
  isDiscreteColormap,
  ColormapName,
  type DiscreteColormapName,
} from './colormaps';
import { treeInstanceColor } from './classification';

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

// ── Discrete (label) colormaps ───────────────────────────────────────────────
// The point of these maps: an integer label column (instance / segment ids)
// where a gradient paints neighbors nearly the same color. They color by
// VALUE, cycling — palette[round(v) mod K] — independent of the mapped range.
describe('discrete label colormaps', () => {
  const DISCRETE: DiscreteColormapName[] = ['tab20', 'glasbey', 'golden'];
  const same = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  // Euclidean distance in sRGB 0..1 — crude, but enough to say "clearly not
  // the same color", which is the whole requirement.
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  it('are exactly the three label maps, grouped apart from the gradients', () => {
    expect(COLORMAP_NAMES.filter(isDiscreteColormap)).toEqual(DISCRETE);
    const [gradients, labels] = COLORMAP_GROUPS;
    expect(labels.names).toEqual(DISCRETE);
    expect(gradients.names).toContain('viridis');
    expect(gradients.names.some(isDiscreteColormap)).toBe(false);
  });

  for (const name of DISCRETE) {
    it(`${name}: adjacent labels get clearly different colors, across a full cycle and its wrap`, () => {
      const span = name === 'glasbey' ? 300 : 60;
      // Golden keeps the tree_instance convention: every id <= 0 is the one
      // "unassigned" gray, so adjacency is a promise from id 1 up.
      const start = name === 'golden' ? 1 : -5;
      for (let v = start; v < span; v++) {
        // 0.08 in raw sRGB: Glasbey is spaced perceptually (CAM02-UCS), so its
        // closest neighbors are a little under 0.1 by this crude metric.
        expect(dist(discreteColor(name, v), discreteColor(name, v + 1))).toBeGreaterThan(0.08);
      }
    });

    it(`${name}: the color depends on the value, not on the mapped range`, () => {
      // Label 7 under a range of [0,10] and [0,10000] — a gradient would put
      // it at opposite ends; a label map must not care.
      const a = colormapColorForValue(name, 7, 0, 10);
      const b = colormapColorForValue(name, 7, 0, 10000);
      const c = colormapColorForValue(name, 7, 5, 9);
      expect(same(a, b) && same(a, c)).toBe(true);
      // And Into agrees with the allocating form.
      const out = new Float32Array(3);
      colormapColorForValueInto(name, 7, 0, 10, out, 0);
      expect(dist(Array.from(out), a)).toBeLessThan(1e-6);
    });
  }

  it('tab20 is matplotlib tab20 and repeats every 20', () => {
    expect(discretePeriod('tab20')).toBe(20);
    const hex = (c: number[]) => c.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
    expect(hex(discreteColor('tab20', 0))).toBe('1f77b4');
    expect(hex(discreteColor('tab20', 19))).toBe('9edae5');
    expect(same(discreteColor('tab20', 3), discreteColor('tab20', 23))).toBe(true);
    // Negative labels wrap rather than indexing off the table.
    expect(same(discreteColor('tab20', -1), discreteColor('tab20', 19))).toBe(true);
  });

  it('glasbey has 256 distinct colors and repeats every 256', () => {
    expect(discretePeriod('glasbey')).toBe(256);
    const keys = new Set<string>();
    for (let v = 0; v < 256; v++) keys.add(discreteColor('glasbey', v).map((x) => Math.round(x * 255)).join(','));
    expect(keys.size).toBe(256);
    expect(same(discreteColor('glasbey', 5), discreteColor('glasbey', 261))).toBe(true);
  });

  it('golden paints every id <= 0 the same unassigned gray', () => {
    expect(same(discreteColor('golden', -3), discreteColor('golden', 0))).toBe(true);
    expect(dist(discreteColor('golden', 0), discreteColor('golden', 1))).toBeGreaterThan(0.2);
  });

  it('golden is the tree_instance palette, so a column can match TreeIso coloring', () => {
    expect(discretePeriod('golden')).toBe(Infinity);
    for (let id = 0; id <= 50; id++) {
      expect(same(discreteColor('golden', id), treeInstanceColor(id))).toBe(true);
    }
  });

  it('rounds float-stored labels (a float32 round-trip) to their integer', () => {
    expect(same(discreteColor('tab20', 6.9999), discreteColor('tab20', 7))).toBe(true);
    expect(same(discreteColor('tab20', 7.0001), discreteColor('tab20', 7))).toBe(true);
  });

  it('non-finite values take the first color without throwing', () => {
    expect(same(discreteColor('tab20', NaN), discreteColor('tab20', 0))).toBe(true);
    expect(discreteColor('glasbey', Infinity).every(Number.isFinite)).toBe(true);
  });

  it('a gradient map through the value chokepoint is unchanged from sampleColormap', () => {
    for (const name of COLORMAP_NAMES.filter((n) => !isDiscreteColormap(n))) {
      for (const v of [-3, 0, 2.5, 7, 10, 14]) {
        expect(same(colormapColorForValue(name, v, 0, 10), sampleColormap(name, v / 10))).toBe(true);
      }
      // Zero-width range: same divisor guard as the renderers used.
      expect(same(colormapColorForValue(name, 4, 4, 4), sampleColormap(name, 0))).toBe(true);
    }
  });

  it('t-only sampling of a discrete map is flat steps, never a blend', () => {
    // Every sampled color must be one of the palette's own colors.
    const palette = Array.from({ length: 20 }, (_, i) => discreteColor('tab20', i));
    for (let k = 0; k <= 100; k++) {
      const c = sampleColormap('tab20', k / 100);
      expect(palette.some((p) => same(p, c))).toBe(true);
    }
  });

  it('the CSS swatch uses hard stops (each color starts where the last ends)', () => {
    const css = colormapToCssGradient('tab20', 0, 'to bottom');
    const stops = [...css.matchAll(/rgb\((\d+), (\d+), (\d+)\) ([\d.]+)%/g)];
    expect(stops.length).toBe(40); // 20 colors × (start, end)
    for (let i = 0; i < stops.length; i += 2) {
      expect(stops[i].slice(1, 4)).toEqual(stops[i + 1].slice(1, 4)); // same color both ends
      if (i > 0) expect(stops[i][4]).toBe(stops[i - 1][4]);          // no gap, no blend
    }
  });
});
