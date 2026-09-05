import { describe, it, expect } from 'vitest';
import {
  denormalizeWideAttributes,
  isWideOctreeAttribute,
  wideOctreeAttributeRange,
} from './octreeWideAttributes';

// A potree octree as far as these helpers care: the parsed attribute table the
// binary decoder branched on. `gps-time` is a double (size 8), the rest float32
// extra dims / uint8 builtins.
const octree = {
  pcoGeometry: {
    pointAttributes: {
      attributes: [
        { name: 'position', type: { size: 4 }, range: [[0, 0, 0], [1, 1, 1]] },
        { name: 'gps-time', type: { size: 8 }, range: [100, 247.5] },
        { name: 'Deviation', type: { size: 4 }, range: [0, 5] },
        { name: 'classification', type: { size: 1 }, range: [0, 0] },
        { name: 'flat-double', type: { size: 8 }, range: [7, 7] },
      ],
    },
  },
};

// What potree's decoder actually stores for a wide value: (v - lo) / (hi - lo),
// then rounded to float32 on the way into the GPU buffer.
const normalised = (v: number, lo: number, hi: number) => Math.fround((v - lo) / (hi - lo));

describe('isWideOctreeAttribute', () => {
  it('is true only for attributes wider than a float32', () => {
    expect(isWideOctreeAttribute(octree, 'gps-time')).toBe(true);
    expect(isWideOctreeAttribute(octree, 'Deviation')).toBe(false);
    expect(isWideOctreeAttribute(octree, 'classification')).toBe(false);
    expect(isWideOctreeAttribute(octree, 'nope')).toBe(false);
    expect(isWideOctreeAttribute(null, 'gps-time')).toBe(false);
  });

  it('reads whichever of potree\'s geometry handles is populated', () => {
    const table = octree.pcoGeometry.pointAttributes;
    expect(isWideOctreeAttribute({ geometry: { pointAttributes: table } }, 'gps-time')).toBe(true);
    expect(isWideOctreeAttribute({ octreeGeometry: { pointAttributes: table } }, 'gps-time')).toBe(true);
  });
});

describe('wideOctreeAttributeRange', () => {
  it('returns the normalisation range for a wide attribute and null otherwise', () => {
    expect(wideOctreeAttributeRange(octree, 'gps-time')).toEqual([100, 247.5]);
    expect(wideOctreeAttributeRange(octree, 'Deviation')).toBeNull();
  });

  it('refuses a degenerate range, where potree\'s scale is infinite', () => {
    expect(wideOctreeAttributeRange(octree, 'flat-double')).toBeNull();
  });
});

describe('denormalizeWideAttributes', () => {
  it('recovers the file value of a wide attribute from its 0..1 buffer value', () => {
    // Row 2 of tests/e2e/fixtures/scalars.xyz: Timestamp 105 over [100, 247.5].
    // This is the bubble that read "0.033898" before the fix.
    const values: Record<string, unknown> = {
      'gps-time': normalised(105, 100, 247.5),
      Deviation: 2,
      classification: 0,
      rgba: [0, 0, 0, 255],
    };
    denormalizeWideAttributes(octree, values);
    // Exactly 105, not 105.00000009: the float32 round trip is rounded away so
    // the bubble prints what the source column says ("105", not "105.0000").
    expect(values['gps-time']).toBe(105);
    // Narrow attributes hold raw values already and must not be rescaled.
    expect(values.Deviation).toBe(2);
    expect(values.classification).toBe(0);
    expect(values.rgba).toEqual([0, 0, 0, 255]);
  });

  it('is exact at both ends of the range', () => {
    const values: Record<string, unknown> = { 'gps-time': 0 };
    denormalizeWideAttributes(octree, values);
    expect(values['gps-time']).toBe(100);
    const top: Record<string, unknown> = { 'gps-time': 1 };
    denormalizeWideAttributes(octree, top);
    expect(top['gps-time']).toBe(247.5);
  });

  it('keeps sub-second GPS-magnitude times while discarding only float32 noise', () => {
    // A 120 s scan at adjusted-standard GPS time (~3.5e8): the float32 buffer
    // resolves (hi - lo) * 2^-24 ≈ 7 µs, so 0.1 ms must survive the round trip
    // and the absolute magnitude must not be squashed (the bug that moved the
    // column off float32 extras in the first place).
    const lo = 351_234_500;
    const hi = lo + 120;
    const truth = lo + 67.1234;
    const wide = { pcoGeometry: { pointAttributes: { attributes: [
      { name: 'gps-time', type: { size: 8 }, range: [lo, hi] },
    ] } } };
    const values: Record<string, unknown> = { 'gps-time': normalised(truth, lo, hi) };
    denormalizeWideAttributes(wide, values);
    expect(values['gps-time'] as number).toBeCloseTo(truth, 4);
  });

  it('leaves a degenerate wide attribute alone rather than inventing a value', () => {
    const values: Record<string, unknown> = { 'flat-double': 0.5 };
    denormalizeWideAttributes(octree, values);
    expect(values['flat-double']).toBe(0.5);
  });
});
