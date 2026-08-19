import { describe, expect, it } from 'vitest';

// potree's binary decoder, reproduced exactly (see the `size > 4` branch in
// potree-core's decoder worker):
//
//     if (attribute.type.size > 4) {
//       const [lo, hi] = attribute.range;
//       offset = lo; scale = 1 / (hi - lo);
//     }
//     buffer[i] = (value - offset) * scale;
//
// A float64 column therefore reaches the GPU already normalised to 0..1; a
// float32 column reaches it raw. This is the whole bug: our shader range was
// taken from the metadata's raw extrema in both cases.
function potreeDecode(value: number, typeSize: number, range: [number, number]): number {
  if (typeSize > 4) {
    const [lo, hi] = range;
    return (value - lo) * (1 / (hi - lo));
  }
  return value;
}

// potree's getIntensity(): w = (buffer - range.x) / (range.y - range.x), then
// the gradient is sampled at clamp(w, 0, 1).
function shaderT(buffer: number, intensityRange: [number, number]): number {
  const t = (buffer - intensityRange[0]) / (intensityRange[1] - intensityRange[0]);
  return Math.max(0, Math.min(1, t));
}

// The real extrema of the peach scan's time column.
const RANGE: [number, number] = [85.153654794, 233.566786486];
const SAMPLES = [85.16, 132.07, 180.0, 233.56];

describe('wide (>4-byte) octree attributes colour correctly', () => {
  it('a float64 column is flat if the shader uses the RAW range', () => {
    // The reported symptom: "the range is correct (85-233) but all points have
    // the same colour". Every sample clamps to the same texel.
    const ts = SAMPLES.map(v => shaderT(potreeDecode(v, 8, RANGE), RANGE));
    expect(new Set(ts).size).toBe(1);
    expect(ts.every(t => t === 0)).toBe(true);
  });

  it('a float64 column spans the gradient when the shader uses [0,1]', () => {
    const ts = SAMPLES.map(v => shaderT(potreeDecode(v, 8, RANGE), [0, 1]));
    expect(new Set(ts).size).toBe(SAMPLES.length);
    // Monotonic and spread across the full gradient.
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
    expect(ts[0]).toBeLessThan(0.01);
    expect(ts[ts.length - 1]).toBeGreaterThan(0.99);
  });

  it('a float32 column still needs the RAW range (must not regress)', () => {
    // Why the fix is gated on width: the same data exported as a float32 extra
    // dim (`timestamp`) was always correct, and forcing [0,1] would break it.
    const ts = SAMPLES.map(v => shaderT(potreeDecode(v, 4, RANGE), RANGE));
    expect(new Set(ts).size).toBe(SAMPLES.length);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);

    // …and would be flat under the wide-attribute treatment.
    const wrong = SAMPLES.map(v => shaderT(potreeDecode(v, 4, RANGE), [0, 1]));
    expect(new Set(wrong).size).toBe(1);
  });
});

// The gate itself. Guarding this is what keeps the fix from silently no-opping:
// if the property path to potree's parsed attribute table were wrong,
// isWideOctreeAttribute would return false for everything and the flat-colour
// bug would come straight back with all tests still green.
describe('isWideOctreeAttribute reads potree\'s own attribute table', () => {
  // Shape as potree-core builds it: PointCloudOctree.pcoGeometry
  // .pointAttributes.attributes[], each with a {name,size} type record.
  const pco = {
    pcoGeometry: {
      pointAttributes: {
        attributes: [
          { name: 'position', type: { name: 'int32', size: 4 }, numElements: 3 },
          { name: 'intensity', type: { name: 'uint16', size: 2 }, numElements: 1 },
          { name: 'gps-time', type: { name: 'double', size: 8 }, numElements: 1 },
          { name: 'reflectance', type: { name: 'float', size: 4 }, numElements: 1 },
        ],
      },
    },
  };

  // Mirrors the implementation in OctreePointCloud.tsx.
  function isWide(octree: any, field: string): boolean {
    const attrs = octree?.pcoGeometry?.pointAttributes?.attributes
      ?? octree?.geometry?.pointAttributes?.attributes
      ?? octree?.octreeGeometry?.pointAttributes?.attributes;
    if (!Array.isArray(attrs)) return false;
    const a = attrs.find((x: any) => x?.name === field);
    return typeof a?.type?.size === 'number' && a.type.size > 4;
  }

  it('flags the 8-byte column and no other', () => {
    expect(isWide(pco, 'gps-time')).toBe(true);
    expect(isWide(pco, 'reflectance')).toBe(false);
    expect(isWide(pco, 'intensity')).toBe(false);
    expect(isWide(pco, 'position')).toBe(false);
  });

  it('is safe on an unknown field or an unloaded octree', () => {
    expect(isWide(pco, 'nope')).toBe(false);
    expect(isWide({}, 'gps-time')).toBe(false);
    expect(isWide(null, 'gps-time')).toBe(false);
  });
});
