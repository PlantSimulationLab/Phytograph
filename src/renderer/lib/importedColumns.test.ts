import { describe, expect, it } from 'vitest';
import { importedColumnsFor } from './pointCloudHelpers';
import { octreeScalarFieldOptions } from './pointCloudHelpers';

// The exact attribute set a real RIEGL import produces, from a live extract.
const RIEGL_RANGES = {
  position: { min: [0, 0, 0], max: [1, 1, 1] },
  intensity: { min: [0], max: [65535] },
  'return number': { min: [0], max: [3] },
  'number of returns': { min: [0], max: [3] },
  classification: { min: [0], max: [0] },
  'scan angle rank': { min: [0], max: [0] },
  'user data': { min: [0], max: [0] },
  'point source id': { min: [0], max: [0] },
  'gps-time': { min: [85.1], max: [233.5] },
  rgb: { min: [0, 0, 0], max: [0, 0, 0] },
  reflectance: { min: [-40.4], max: [28.4] },
  amplitude: { min: [0], max: [59.8] },
  deviation: { min: [0], max: [65535] },
  target_index: { min: [0], max: [3] },
  target_count: { min: [0], max: [3] },
  is_miss: { min: [0], max: [1] },
  echo_type: { min: [0], max: [3] },
  facet: { min: [0], max: [2] },
};

describe('importedColumnsFor', () => {
  it('lists every scalar column, including ones Color-by hides', () => {
    // THE GAP THIS CLOSES: the Color-by dropdown was the only way to check an
    // import, and it hides `intensity` (own colour mode) and every LAS schema
    // builtin — so a silently-dropped column was indistinguishable from a kept
    // one. This must show them.
    const cols = importedColumnsFor({ data: { octree: { attributeRanges: RIEGL_RANGES } } } as never);
    expect(cols).toContain('intensity');
    expect(cols).toContain('gps-time');
    expect(cols).toContain('reflectance');
    expect(cols).toContain('is_miss');
    expect(cols).toContain('echo_type');
    // Geometry and colour are not scalar fields.
    expect(cols).not.toContain('position');
    expect(cols).not.toContain('rgb');
  });

  it('is strictly broader than the Color-by options', () => {
    const cols = new Set(importedColumnsFor({ data: { octree: { attributeRanges: RIEGL_RANGES } } } as never));
    for (const o of octreeScalarFieldOptions(RIEGL_RANGES as never, {})) {
      expect(cols.has(o.value)).toBe(true);
    }
    // …and shows things the picker deliberately omits.
    expect(cols.size).toBeGreaterThan(octreeScalarFieldOptions(RIEGL_RANGES as never, {}).length);
  });

  it('works for a flat (non-octree) cloud too', () => {
    const cols = importedColumnsFor({
      data: { scalarFields: { reflectance: {}, timestamp: {} } },
    } as never);
    expect(cols).toEqual(['reflectance', 'timestamp']);
  });

  it('returns nothing for a cloud with no scalars', () => {
    expect(importedColumnsFor({ data: {} } as never)).toEqual([]);
    expect(importedColumnsFor({} as never)).toEqual([]);
  });
});
