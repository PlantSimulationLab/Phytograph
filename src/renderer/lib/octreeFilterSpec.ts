// Resolving a cloud's `CloudFilters` into something an octree TILE can be
// tested against, once per filter change rather than once per point.
//
// The flat path tests `pointPassesFilters(data, filters, i)` against
// `PointCloudData`. Octree clouds have no such object — their values live in
// per-tile `geometry.attributes[slug]` Float32 buffers that stream in and out
// with the LOD. So the preview needs a different *lookup*, but it must not
// have a different *rule*: `filterValueKeeps` (pointCloudHelpers) stays the one
// definition of what a FilterRange means, and this module only decides which
// buffer to read and in what units.
//
// Two things make that decision non-obvious, and both produce silently wrong
// pixels rather than an error:
//
// 1. **Wide attributes are pre-normalised.** potree's decoder rescales any
//    attribute wider than a float32 (a `double` gps_time, an int64) into 0..1
//    before upload — see lib/octreeWideAttributes.ts. But the Filter panel's
//    bounds come from `data.octree.attributeRanges`, which are in FILE units.
//    Testing `[105.2, 105.8]` against a buffer holding 0.034 hides the whole
//    cloud. We convert the BOUNDS into buffer space once here, rather than
//    denormalising every point: it is cheaper, and it avoids
//    `denormalizeWideValue`'s display rounding, which has no business deciding
//    whether a point survives a filter.
//
// 2. **The `intensity` slot may be aliased away.** In scalar colour mode
//    `swapScalarIntoIntensity` points `geometry.attributes.intensity` at a
//    DIFFERENT field's buffer and stashes the real one under
//    ORIG_INTENSITY_ATTRIBUTE. A filter on intensity that reads the live slot
//    would silently filter by whatever the user happens to be colouring by.
//    This is the same trap the point picker fell into once already.
//
// Pure + stateless — no THREE, no React, no potree types. Unit-testable
// directly against a plain `{attributes: {...}}` stand-in.
import type { CloudFilters, FilterRange } from './pointCloudTypes';
import { isWideOctreeAttribute, wideOctreeAttributeRange } from './octreeWideAttributes';
import { ORIG_INTENSITY_ATTRIBUTE } from './pointPick';

// Where one clause reads its value from.
//   'position' — the tile's `position` attribute, on axis `axis`.
//   'attribute' — a named attribute buffer (`slug`).
export type FilterClauseSource =
  | { kind: 'position'; axis: 0 | 1 | 2 }
  | { kind: 'attribute'; slug: string; fallbackSlug?: string };

export interface FilterClause {
  source: FilterClauseSource;
  // The range to test with, ALREADY in the units the tile buffer holds. For a
  // wide attribute that means 0..1 buffer space, not file units.
  range: FilterRange;
}

export interface OctreeFilterSpec {
  clauses: FilterClause[];
  // Changes whenever any clause would test differently. Drives the per-frame
  // re-mask skip, exactly as `cropMaskRulesKey` does for crop rules.
  key: string;
}

export const EMPTY_FILTER_SPEC: OctreeFilterSpec = Object.freeze({
  clauses: Object.freeze([]) as unknown as FilterClause[],
  key: '',
});

// Map a range in FILE units onto potree's 0..1 buffer space for a wide
// attribute. Infinities are preserved (an unbounded side stays unbounded) so a
// half-open filter keeps working.
function toBufferSpace(range: FilterRange, lo: number, hi: number): FilterRange {
  const span = hi - lo;
  // Round each bound to FLOAT32, because that is the precision the value it
  // will be compared against was stored at. potree normalises in float64 and
  // then writes the result into a Float32Array, so a point sitting exactly ON
  // the bound can round UP past a float64 bound and be dropped — measured on
  // the gps_time fixture, where t=150.0 over [100, 247.5] normalises to
  // 0.33898305084745762 but reads back as 0.33898305892944336, losing the
  // boundary point. Widening the bound to the same float32 grid makes the
  // comparison exact at the edges, which is where a range filter is most often
  // aimed (a user typing the max they can see in the panel).
  const f32 = (v: number) => Math.fround(v);
  const map = (v: number) => (Number.isFinite(v) ? f32((v - lo) / span) : v);
  return { ...range, min: map(range.min), max: map(range.max) };
}

/**
 * Resolve `filters` against `octree` (potree's own parsed attribute table) into
 * the clauses a tile can be tested with.
 *
 * Disabled filters are dropped. A categorical filter keeps its
 * `selectedClasses` untouched — class ids are small integers that are never
 * wide, and `filterValueKeeps` rounds them itself.
 *
 * `octree` may be null/undefined (a cloud whose octree has not loaded yet), in
 * which case nothing is treated as wide — the clauses are still correct for
 * every normal-width attribute, which is all of them in the common case.
 */
export function resolveOctreeFilterSpec(
  filters: CloudFilters | undefined | null,
  octree: unknown,
): OctreeFilterSpec {
  if (!filters) return EMPTY_FILTER_SPEC;
  const clauses: FilterClause[] = [];

  const axes: [FilterRange, 0 | 1 | 2][] = [
    [filters.x, 0], [filters.y, 1], [filters.z, 2],
  ];
  for (const [range, axis] of axes) {
    if (range?.enabled) clauses.push({ source: { kind: 'position', axis }, range });
  }

  if (filters.intensity?.enabled) {
    clauses.push({
      source: {
        // Read the ORIGINAL intensity when the scalar colour mode has aliased
        // the live slot away; fall back to the live slot when it has not (the
        // stash only exists after the first swap).
        kind: 'attribute',
        slug: ORIG_INTENSITY_ATTRIBUTE,
        fallbackSlug: 'intensity',
      },
      range: filters.intensity,
    });
  }

  for (const slug of Object.keys(filters.scalarFields)) {
    const range = filters.scalarFields[slug];
    if (!range?.enabled) continue;
    // A categorical filter is matched by rounded class id, which potree never
    // normalises (class columns are narrow), so only continuous ranges need
    // the buffer-space conversion.
    const wideRange = range.selectedClasses
      ? null
      : (isWideOctreeAttribute(octree, slug) ? wideOctreeAttributeRange(octree, slug) : null);
    clauses.push({
      source: { kind: 'attribute', slug },
      range: wideRange ? toBufferSpace(range, wideRange[0], wideRange[1]) : range,
    });
  }

  return { clauses, key: filterSpecKey(clauses) };
}

// A stable string identifying what these clauses will do. Two specs with the
// same key mask identically, so a tile already masked under it can be skipped.
function filterSpecKey(clauses: readonly FilterClause[]): string {
  return clauses
    .map(c => {
      const src = c.source.kind === 'position'
        ? `p${c.source.axis}`
        : `a:${c.source.slug}`;
      const r = c.range;
      const sel = r.selectedClasses ? `c[${[...r.selectedClasses].sort((a, b) => a - b).join(',')}]` : `${r.min}:${r.max}`;
      return `${src}|${sel}`;
    })
    .join('&');
}
