import { describe, it, expect } from 'vitest';
import { categoricalTexels, CATEGORICAL_TEXTURE_MIN, discreteColormapScheme } from './categoricalTexture';
import { discreteColor } from './colormaps';
import type { CategoricalScheme } from './classification';
import type { RGB } from './colormaps';

const GRAY: RGB = [0.5, 0.5, 0.5];

/** n classes 0..n-1, each a distinct color encoded in its red/green bytes. */
function scheme(values: number[]): CategoricalScheme {
  return {
    attribute: 'tree_instance',
    classes: values.map((v) => ({
      value: v, label: `c${v}`, color: [(v % 256) / 255, Math.floor(v / 256) / 255, 1] as RGB,
    })),
  };
}

/** What the shader reads for class value v (nearest filter, clamp to edge). */
function sample(tex: { width: number; data: Uint8Array }, v: number, lo: number, hi: number) {
  const t = (v - lo) / (hi - lo || 1);
  const i = Math.min(tex.width - 1, Math.max(0, Math.floor(t * tex.width)));
  return [tex.data[4 * i], tex.data[4 * i + 1]];
}

describe('categoricalTexels', () => {
  it('gives every one of 300 classes its own color (the 64-pixel bake merged them)', () => {
    const values = Array.from({ length: 300 }, (_, i) => i);
    const tex = categoricalTexels(scheme(values), [0, 299], GRAY);
    expect(tex.width).toBeGreaterThanOrEqual(600);
    for (const v of values) {
      expect(sample(tex, v, 0, 299), `class ${v}`).toEqual([v % 256, Math.floor(v / 256)]);
    }
  });

  it('keeps gapped classes apart, including both ends of the range', () => {
    const tex = categoricalTexels(scheme([0, 64, 65]), [0, 65], GRAY);
    expect(sample(tex, 0, 0, 65)).toEqual([0, 0]);
    expect(sample(tex, 64, 0, 65)).toEqual([64, 0]);
    expect(sample(tex, 65, 0, 65)).toEqual([65, 0]);
  });

  it('stays at the minimum width when classes are few', () => {
    expect(categoricalTexels(scheme([1, 2]), [1, 2], GRAY).width).toBe(CATEGORICAL_TEXTURE_MIN);
  });

  it('never exceeds the GPU limit it is given', () => {
    const values = Array.from({ length: 5000 }, (_, i) => i);
    expect(categoricalTexels(scheme(values), [0, 4999], GRAY, 2048).width).toBe(2048);
  });

  it('fills an empty range with the unknown color', () => {
    const tex = categoricalTexels(scheme([500]), [0, 10], GRAY);
    expect(Array.from(tex.data.slice(0, 4))).toEqual([128, 128, 128, 255]);
  });
});

// The octree shader only has t = (v - lo) / span, so a discrete (label)
// colormap is drawn as a class texture with one class per integer. What has to
// hold: sampling the texture where the shader would, for value v, returns the
// map's color for v — and v+1 a different one.
describe('discreteColormapScheme', () => {
  const texelAt = (tex: { width: number; data: Uint8Array }, t: number) => {
    const i = Math.min(tex.width - 1, Math.max(0, Math.floor(t * tex.width)));
    return [tex.data[4 * i], tex.data[4 * i + 1], tex.data[4 * i + 2]];
  };
  const bytes = (c: number[]) => c.map((x) => Math.round(x * 255));

  for (const name of ['tab20', 'glasbey', 'golden'] as const) {
    it(`${name}: each integer in range samples its own value-keyed color`, () => {
      const range: [number, number] = [0, 300];
      const scheme = discreteColormapScheme(name, range);
      expect(scheme.classes.length).toBe(301);
      const tex = categoricalTexels(scheme, range, [0.6, 0.6, 0.6]);
      for (let v = 0; v <= 300; v++) {
        expect(texelAt(tex, (v - range[0]) / 300)).toEqual(bytes(discreteColor(name, v)));
      }
    });
  }

  it('lays out a negative / offset range correctly', () => {
    const range: [number, number] = [-7, 12];
    const tex = categoricalTexels(discreteColormapScheme('tab20', range), range, [0.6, 0.6, 0.6]);
    for (let v = -7; v <= 12; v++) {
      expect(texelAt(tex, (v + 7) / 19)).toEqual(bytes(discreteColor('tab20', v)));
    }
  });

  it('strides past the texture width instead of allocating unbounded classes', () => {
    const scheme = discreteColormapScheme('tab20', [0, 65535], 16384);
    expect(scheme.classes.length).toBeLessThanOrEqual(8192);
    expect(scheme.classes.length).toBeGreaterThan(4000);
  });
});
