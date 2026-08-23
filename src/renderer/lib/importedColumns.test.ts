import { describe, expect, it } from 'vitest';
import { importedColumnsFor, partitionImportedColumns } from './pointCloudHelpers';
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

  it('lists a column once when two buffer keys share a display label', () => {
    // An ASCII import whose time column round-tripped through the LAS gps_time
    // dimension carries BOTH `gps-time` (PotreeConverter's builtin spelling)
    // and its own `timestamp` attribute. Both label as "Timestamp", so keying
    // the dedupe on the raw buffer name printed it twice and read as two
    // separate fields in the expanded scan row.
    const cols = importedColumnsFor({
      data: {
        octree: {
          attributeRanges: {
            position: { min: [0, 0, 0], max: [1, 1, 1] },
            'gps-time': { min: [0], max: [1] },
            timestamp: { min: [0], max: [1] },
          },
          attributeLabels: { 'gps-time': 'Timestamp', timestamp: 'Timestamp' },
        },
      },
    } as never);
    expect(cols.filter((c) => c === 'Timestamp')).toHaveLength(1);
    expect(cols).toEqual(['Timestamp']);
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

describe('partitionImportedColumns', () => {
  it('separates real columns from the all-zero LAS schema padding', () => {
    // A three-column ASCII import: PotreeConverter still writes the full LAS
    // point schema, so the cloud reports `classification`, `user data`,
    // `point source id`, `scan angle rank`, `return number` and
    // `number of returns` — all identically zero, none of them in the file.
    // Listed in one flat run they buried the three columns the user imported.
    const { present, padding } = partitionImportedColumns({
      data: {
        octree: {
          attributeRanges: {
            position: { min: [0, 0, 0], max: [1, 1, 1] },
            intensity: { min: [0], max: [0] },
            classification: { min: [0], max: [0] },
            'user data': { min: [0], max: [0] },
            'point source id': { min: [0], max: [0] },
            'scan angle rank': { min: [0], max: [0] },
            'return number': { min: [0], max: [0] },
            'number of returns': { min: [0], max: [0] },
            timestamp: { min: [100], max: [160] },
            deviation: { min: [0], max: [3] },
            target_index: { min: [1], max: [3] },
          },
        },
      },
    } as never);
    // `classification` stays in the primary list even when empty: it is where
    // segmentation results land, so "you can colour/label by this" is true of it
    // in a way it is not of `user data`. This matches the same deliberate
    // exception in octreeScalarFieldOptions.
    expect(present).toEqual(['classification', 'deviation', 'target_index', 'timestamp']);
    expect(padding).toContain('user data');
    expect(padding).toContain('point source id');
    expect(padding).toContain('intensity');
    expect(padding).not.toContain('classification');
    // Nothing is lost — every column lands in exactly one of the two groups.
    expect([...present, ...padding].sort()).toEqual(
      importedColumnsFor({
        data: {
          octree: {
            attributeRanges: {
              position: { min: [0, 0, 0], max: [1, 1, 1] },
              intensity: { min: [0], max: [0] },
              classification: { min: [0], max: [0] },
              'user data': { min: [0], max: [0] },
              'point source id': { min: [0], max: [0] },
              'scan angle rank': { min: [0], max: [0] },
              'return number': { min: [0], max: [0] },
              'number of returns': { min: [0], max: [0] },
              timestamp: { min: [100], max: [160] },
              deviation: { min: [0], max: [3] },
              target_index: { min: [1], max: [3] },
            },
          },
        },
      } as never).sort(),
    );
  });

  it('keeps a POPULATED builtin in the primary list', () => {
    // The split must be by observed range, not by name. A `classification` the
    // user segmented into, and a real LAS file's populated `point source id`,
    // are data — a name-based filter would have hidden both.
    const { present, padding } = partitionImportedColumns({
      data: {
        octree: {
          attributeRanges: {
            classification: { min: [0], max: [5] },
            'point source id': { min: [1], max: [4] },
            'user data': { min: [0], max: [0] },
          },
        },
      },
    } as never);
    expect(present).toEqual(['classification', 'point source id']);
    expect(padding).toEqual(['user data']);
  });

  it('does not call a real RIEGL import empty', () => {
    const { present, padding } = partitionImportedColumns({
      data: { octree: { attributeRanges: RIEGL_RANGES } },
    } as never);
    // The scanner's own measurements survive the split.
    expect(present).toContain('reflectance');
    expect(present).toContain('amplitude');
    expect(present).toContain('is_miss');
    expect(present).toContain('gps-time');
    // A real RIEGL import's populated `classification` is data, empty or not.
    expect(present).toContain('classification');
    // …while the zero-filled LAS dimensions are set aside.
    expect(padding).toContain('scan angle rank');
    expect(padding).toContain('user data');
  });

  it('never puts a label in both groups', () => {
    // A real `timestamp` alongside the all-zero `gps-time` that shares its
    // label: the populated key wins, and the label appears exactly once.
    const { present, padding } = partitionImportedColumns({
      data: {
        octree: {
          attributeRanges: {
            'gps-time': { min: [0], max: [0] },
            timestamp: { min: [1], max: [9] },
          },
          attributeLabels: { 'gps-time': 'Timestamp', timestamp: 'Timestamp' },
        },
      },
    } as never);
    expect(present).toEqual(['Timestamp']);
    expect(padding).toEqual([]);
  });

  it("treats a flat cloud's own scalarFields as data even when named like a builtin", () => {
    const { present, padding } = partitionImportedColumns({
      data: { scalarFields: { classification: {}, reflectance: {} } },
    } as never);
    expect(present).toEqual(['classification', 'reflectance']);
    expect(padding).toEqual([]);
  });
});
