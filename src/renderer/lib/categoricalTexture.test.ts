import { describe, it, expect } from 'vitest';
import { categoricalTexels, CATEGORICAL_TEXTURE_MIN } from './categoricalTexture';
import type { CategoricalScheme } from './classification';
import type { RGB } from './colormaps';

const GREY: RGB = [0.5, 0.5, 0.5];

/** n classes 0..n-1, each a distinct colour encoded in its red/green bytes. */
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
  it('gives every one of 300 classes its own colour (the 64-pixel bake merged them)', () => {
    const values = Array.from({ length: 300 }, (_, i) => i);
    const tex = categoricalTexels(scheme(values), [0, 299], GREY);
    expect(tex.width).toBeGreaterThanOrEqual(600);
    for (const v of values) {
      expect(sample(tex, v, 0, 299), `class ${v}`).toEqual([v % 256, Math.floor(v / 256)]);
    }
  });

  it('keeps gapped classes apart, including both ends of the range', () => {
    const tex = categoricalTexels(scheme([0, 64, 65]), [0, 65], GREY);
    expect(sample(tex, 0, 0, 65)).toEqual([0, 0]);
    expect(sample(tex, 64, 0, 65)).toEqual([64, 0]);
    expect(sample(tex, 65, 0, 65)).toEqual([65, 0]);
  });

  it('stays at the minimum width when classes are few', () => {
    expect(categoricalTexels(scheme([1, 2]), [1, 2], GREY).width).toBe(CATEGORICAL_TEXTURE_MIN);
  });

  it('never exceeds the GPU limit it is given', () => {
    const values = Array.from({ length: 5000 }, (_, i) => i);
    expect(categoricalTexels(scheme(values), [0, 4999], GREY, 2048).width).toBe(2048);
  });

  it('fills an empty range with the unknown colour', () => {
    const tex = categoricalTexels(scheme([500]), [0, 10], GREY);
    expect(Array.from(tex.data.slice(0, 4))).toEqual([128, 128, 128, 255]);
  });
});
