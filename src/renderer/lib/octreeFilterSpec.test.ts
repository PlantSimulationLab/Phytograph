import { describe, it, expect } from 'vitest';
import { resolveOctreeFilterSpec, EMPTY_FILTER_SPEC } from './octreeFilterSpec';
import { filterValueKeeps } from './pointCloudHelpers';
import { ORIG_INTENSITY_ATTRIBUTE } from './pointPick';
import type { CloudFilters } from './pointCloudTypes';

// A stand-in for potree's parsed attribute table — the same shape
// octreeWideAttributes.ts reads (`pcoGeometry.pointAttributes.attributes`).
// `size > 4` is what marks an attribute as pre-normalised into 0..1.
const octreeWith = (attrs: { name: string; size: number; range?: [number, number] }[]) => ({
  pcoGeometry: {
    pointAttributes: {
      attributes: attrs.map(a => ({ name: a.name, type: { size: a.size }, range: a.range })),
    },
  },
});

const off = { min: 0, max: 0, enabled: false };
const filters = (over: Partial<CloudFilters>): CloudFilters => ({
  x: { ...off }, y: { ...off }, z: { ...off }, scalarFields: {}, ...over,
});

describe('resolveOctreeFilterSpec', () => {
  it('is empty for no filters and for an all-disabled set', () => {
    expect(resolveOctreeFilterSpec(undefined, null)).toBe(EMPTY_FILTER_SPEC);
    expect(resolveOctreeFilterSpec(null, null)).toBe(EMPTY_FILTER_SPEC);
    expect(resolveOctreeFilterSpec(filters({}), null).clauses).toEqual([]);
  });

  it('drops disabled clauses and keeps enabled ones', () => {
    const spec = resolveOctreeFilterSpec(
      filters({
        x: { min: 1, max: 2, enabled: true },
        y: { min: 5, max: 6, enabled: false },
        scalarFields: { dev: { min: 0, max: 2, enabled: true } },
      }),
      null,
    );
    expect(spec.clauses).toHaveLength(2);
    expect(spec.clauses[0].source).toEqual({ kind: 'position', axis: 0 });
    expect(spec.clauses[1].source).toMatchObject({ kind: 'attribute', slug: 'dev' });
  });

  it('maps an axis filter to the right position component', () => {
    const spec = resolveOctreeFilterSpec(
      filters({ z: { min: 1, max: 2, enabled: true } }),
      null,
    );
    expect(spec.clauses[0].source).toEqual({ kind: 'position', axis: 2 });
  });

  // TRAP 1 --------------------------------------------------------------
  // potree normalises a >4-byte attribute into 0..1, but the panel's bounds
  // are in FILE units. Testing file units against that buffer hides the cloud.
  describe('wide attributes', () => {
    const octree = octreeWith([{ name: 'gps_time', size: 8, range: [100, 200] }]);

    it('converts a continuous range into 0..1 buffer space', () => {
      const spec = resolveOctreeFilterSpec(
        filters({ scalarFields: { gps_time: { min: 125, max: 150, enabled: true } } }),
        octree,
      );
      expect(spec.clauses[0].range.min).toBeCloseTo(0.25, 10);
      expect(spec.clauses[0].range.max).toBeCloseTo(0.5, 10);
    });

    it('makes the converted range accept exactly the right buffer values', () => {
      // The whole point: a buffer value is what filterValueKeeps sees.
      const spec = resolveOctreeFilterSpec(
        filters({ scalarFields: { gps_time: { min: 125, max: 150, enabled: true } } }),
        octree,
      );
      const r = spec.clauses[0].range;
      // file 120 -> 0.20 (out), 130 -> 0.30 (in), 160 -> 0.60 (out)
      expect([0.20, 0.30, 0.60].map(v => filterValueKeeps(r, v)))
        .toEqual([false, true, false]);
    });

    it('keeps a point sitting exactly ON the bound', () => {
      // potree normalises in float64 then stores into a Float32Array, so the
      // value read back can round UP past a float64 bound. Measured on the
      // gps_time fixture: t=150 over [100, 247.5] is 0.33898305084745762 exact
      // but 0.33898305892944336 as stored, so the 21st point vanished from a
      // [100, 150] filter — an off-by-one at precisely the bound a user is most
      // likely to type, because it is the number the panel shows them.
      const ts = octreeWith([{ name: 't', size: 8, range: [100, 247.5] }]);
      const spec = resolveOctreeFilterSpec(
        filters({ scalarFields: { t: { min: 100, max: 150, enabled: true } } }),
        ts,
      );
      const stored = Math.fround((150 - 100) / (247.5 - 100));
      expect(filterValueKeeps(spec.clauses[0].range, stored)).toBe(true);
    });

    it('keeps boundary points at BOTH ends of the range', () => {
      const ts = octreeWith([{ name: 't', size: 8, range: [100, 247.5] }]);
      const spec = resolveOctreeFilterSpec(
        filters({ scalarFields: { t: { min: 102.5, max: 150, enabled: true } } }),
        ts,
      );
      const stored = (v: number) => Math.fround((v - 100) / (247.5 - 100));
      const r = spec.clauses[0].range;
      expect(filterValueKeeps(r, stored(102.5))).toBe(true);   // low bound
      expect(filterValueKeeps(r, stored(150))).toBe(true);     // high bound
      expect(filterValueKeeps(r, stored(100))).toBe(false);    // just outside
      expect(filterValueKeeps(r, stored(152.5))).toBe(false);  // just outside
    });

    it('leaves a NARROW attribute in file units', () => {
      const narrow = octreeWith([{ name: 'dev', size: 4, range: [0, 100] }]);
      const spec = resolveOctreeFilterSpec(
        filters({ scalarFields: { dev: { min: 25, max: 50, enabled: true } } }),
        narrow,
      );
      expect(spec.clauses[0].range.min).toBe(25);
      expect(spec.clauses[0].range.max).toBe(50);
    });

    it('leaves the range alone when the wide attribute has no usable range', () => {
      // hi <= lo: potree's scale would be infinite and no inverse exists.
      const degenerate = octreeWith([{ name: 'gps_time', size: 8, range: [5, 5] }]);
      const spec = resolveOctreeFilterSpec(
        filters({ scalarFields: { gps_time: { min: 1, max: 2, enabled: true } } }),
        degenerate,
      );
      expect(spec.clauses[0].range.min).toBe(1);
      expect(spec.clauses[0].range.max).toBe(2);
    });

    it('does not rescale a categorical filter', () => {
      // Class ids are matched by rounded value; rescaling them would be wrong
      // even if the column were somehow wide.
      const spec = resolveOctreeFilterSpec(
        filters({
          scalarFields: {
            gps_time: { min: 100, max: 200, enabled: true, selectedClasses: [1, 2] },
          },
        }),
        octree,
      );
      expect(spec.clauses[0].range.selectedClasses).toEqual([1, 2]);
      expect(spec.clauses[0].range.min).toBe(100);
    });

    it('preserves an unbounded side', () => {
      const spec = resolveOctreeFilterSpec(
        filters({ scalarFields: { gps_time: { min: -Infinity, max: 150, enabled: true } } }),
        octree,
      );
      expect(spec.clauses[0].range.min).toBe(-Infinity);
      expect(spec.clauses[0].range.max).toBeCloseTo(0.5, 10);
    });

    it('treats nothing as wide when the octree is unavailable', () => {
      const spec = resolveOctreeFilterSpec(
        filters({ scalarFields: { gps_time: { min: 125, max: 150, enabled: true } } }),
        null,
      );
      expect(spec.clauses[0].range.min).toBe(125);
    });
  });

  // TRAP 2 --------------------------------------------------------------
  // In scalar colour mode `intensity` is aliased to another field's buffer and
  // the real one is stashed under ORIG_INTENSITY_ATTRIBUTE. Reading the live
  // slot would filter by whatever the user is colouring by.
  it('reads intensity from the stashed original, falling back to the live slot', () => {
    const spec = resolveOctreeFilterSpec(
      filters({ intensity: { min: 0.2, max: 0.8, enabled: true } }),
      null,
    );
    expect(spec.clauses[0].source).toEqual({
      kind: 'attribute',
      slug: ORIG_INTENSITY_ATTRIBUTE,
      fallbackSlug: 'intensity',
    });
  });

  describe('key', () => {
    const specKey = (f: Partial<CloudFilters>, o: unknown = null) =>
      resolveOctreeFilterSpec(filters(f), o).key;

    it('is stable for the same filter', () => {
      const f = { x: { min: 1, max: 2, enabled: true } };
      expect(specKey(f)).toBe(specKey(f));
    });

    it('changes when a bound changes', () => {
      expect(specKey({ x: { min: 1, max: 2, enabled: true } }))
        .not.toBe(specKey({ x: { min: 1, max: 3, enabled: true } }));
    });

    it('changes when a filter is disabled', () => {
      expect(specKey({ x: { min: 1, max: 2, enabled: true } }))
        .not.toBe(specKey({ x: { min: 1, max: 2, enabled: false } }));
    });

    it('changes when a class is unticked', () => {
      const withClasses = (cs: number[]) =>
        specKey({ scalarFields: { c: { min: 0, max: 3, enabled: true, selectedClasses: cs } } });
      expect(withClasses([1, 2])).not.toBe(withClasses([1]));
    });

    it('ignores the order classes were ticked in', () => {
      const withClasses = (cs: number[]) =>
        specKey({ scalarFields: { c: { min: 0, max: 3, enabled: true, selectedClasses: cs } } });
      expect(withClasses([2, 1])).toBe(withClasses([1, 2]));
    });

    it('distinguishes the same range on different fields', () => {
      expect(specKey({ x: { min: 1, max: 2, enabled: true } }))
        .not.toBe(specKey({ y: { min: 1, max: 2, enabled: true } }));
    });
  });
});
