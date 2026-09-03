// Filter-field semantics: which fields hold integers, and whether a committed
// filter actually narrows anything.
//
// Both exist to make the Filter Points panel honest about what it will do.
//
// **Narrowing.** `CloudFilters` carries one `FilterRange` per field with an
// `enabled` flag, and the panel used to set `enabled: true` on any keystroke —
// including a keystroke that left the range at the field's full extent. Since
// the panel's commit buttons were gated on "any field enabled", typing in one
// field revealed the buttons for every field, and the Active Filters list named
// full-range fields that would remove exactly zero points. A user reading that
// list had every reason to believe a filter was being applied when none was.
// `isNarrowing` is the real predicate: a range filter narrows only when it
// excludes part of the field's extent, and a class filter narrows only when it
// drops at least one class.
//
// **Integers.** Several imported columns are conceptually integer counters —
// `target_index` is the n-th return of a pulse, so a fractional value is
// meaningless — but they arrive as float32 (the RIEGL stream spells every
// scalar `<f4`; PotreeConverter's extra dims are floats) and nothing downstream
// records that they were whole numbers. The panel therefore offered
// `Range: 1.00 to 3.00` with a free-decimal input. That is only a display
// problem, so it is fixed at the display boundary: the storage dtype and the
// wire contract stay exactly as they are, and this module says which slugs to
// present as integers.
//
// Pure + stateless — safe to unit-test directly.
import type { CloudFilters, FilterRange } from './pointCloudTypes';

// Slugs whose values are integer counters/indices by construction. Kept
// deliberately narrow: a slug earns a place here only when a fractional value
// would be nonsense in the field's own definition, not merely because a
// particular file happens to hold whole numbers.
//
//   target_index / target_count — the n-th return of a pulse and how many
//     returns that pulse produced (`_MULTI_RETURN_SLUGS` in backend-api/main.py).
//   row_index / column_index    — the (row, column) cell of a structured scan's
//     acquisition raster (`_GRID_INDEX_SLUGS`).
//
// Categorical class columns (ground_class, tree_instance, …) are NOT listed:
// they are integers too, but they render as checkboxes rather than a numeric
// range, so integer formatting never applies to them.
const INTEGER_SLUGS = new Set([
  'target_index',
  'target_count',
  'row_index',
  'column_index',
]);

/**
 * True when `field` — a filter dropdown value (`x`, `y`, `z`, `intensity`, or
 * `scalar:<slug>`) — holds integer values.
 *
 * Matching is case-insensitive on the slug, matching the convention in
 * `classification.ts`. Coordinates and intensity are always continuous.
 */
export function isIntegerFilterField(field: string | undefined | null): boolean {
  if (!field) return false;
  if (!field.startsWith('scalar:')) return false;
  return INTEGER_SLUGS.has(field.substring(7).toLowerCase());
}

/**
 * Format a bound for display, honouring the field's integer-ness.
 *
 * Integer fields round rather than truncate: a float32 `target_index` of 3 can
 * come back as 2.9999998, and `Range: 1 to 2` on a 3-return scan would be a
 * lie in the opposite direction from `Range: 1.00 to 3.00`.
 */
export function formatFilterBound(value: number, integer: boolean): string {
  if (!Number.isFinite(value)) return integer ? '0' : '0.00';
  return integer ? String(Math.round(value)) : value.toFixed(2);
}

/**
 * The value to seed a min/max input with for `field` at `value`.
 *
 * Continuous fields keep the 4-decimal seeding the panel has always used (the
 * inputs are the only place a user sees full precision); integer fields seed a
 * bare rounded integer so the field does not read as `1.0000`.
 */
export function seedFilterInput(value: number, integer: boolean): string {
  if (!Number.isFinite(value)) return integer ? '0' : '0.0000';
  return integer ? String(Math.round(value)) : value.toFixed(4);
}

/**
 * True when `filter` would actually remove points from a field whose full
 * extent is `bounds`.
 *
 * The three cases:
 *
 *   - disabled            → never narrowing.
 *   - class selection     → narrowing iff at least one class of `totalClasses`
 *                           is unticked. An EMPTY selection is narrowing (it
 *                           keeps nothing), which is a legitimate — if drastic —
 *                           filter the commit buttons surface as a 0-point
 *                           result.
 *   - continuous range    → narrowing iff the range excludes part of [min, max].
 *
 * `epsilon` absorbs the round-trip through the panel's `toFixed(4)` input
 * seeding: re-committing an untouched full-range field yields bounds that
 * differ from the true extent in the 5th decimal, and without a tolerance that
 * no-op would count as a filter. It is relative to the extent so it holds for
 * both a 0–1 intensity field and a 600 000 m UTM easting.
 */
export function isNarrowing(
  filter: FilterRange | undefined | null,
  bounds: { min: number; max: number } | undefined | null,
  totalClasses?: number,
): boolean {
  if (!filter?.enabled) return false;

  if (filter.selectedClasses) {
    if (totalClasses === undefined) return true;
    return filter.selectedClasses.length < totalClasses;
  }

  if (!bounds) return true;
  const span = Math.abs(bounds.max - bounds.min);
  // A degenerate field (every point identical) cannot be narrowed by a range.
  if (!Number.isFinite(span) || span === 0) return false;
  const epsilon = span * 1e-4;
  return filter.min > bounds.min + epsilon || filter.max < bounds.max - epsilon;
}

// ── Sharing one criteria set across a multi-scan selection ────────────────────
//
// The panel edits ONE cloud's `CloudFilters` (the primary selection), but the
// commit buttons act on every selected scan. The criteria are field-based —
// "keep intensity in [0.2, 0.8]", "keep tree_instance 1 and 3" — so they carry
// over to a sibling scan directly, with two adjustments:
//
//   - A field the sibling does not have is dropped. Intersecting the field list
//     in the picker already prevents this for scalars, but X/Y/Z bounds differ
//     per scan and intensity may be absent, so the projection is done again
//     here against the target's own filter set rather than trusted.
//   - X/Y/Z are absolute world coordinates, so they transfer as-is: filtering
//     "z between 0 and 2" across three scans of the same site means the same
//     slab in all three, which is the useful reading.

/**
 * Project `source` criteria onto `target`'s field set.
 *
 * `target` supplies the shape (which fields exist, and their full extents for
 * the fields the source does not filter); `source` supplies every criterion
 * that actually narrows. Returns a new object — neither input is mutated.
 *
 * `narrows` answers, for a field's dropdown value (`x`, `intensity`,
 * `scalar:<slug>`), whether that field's criterion actually removes points from
 * the SOURCE cloud. Passing it is what keeps a no-op criterion from becoming a
 * real one on a sibling: the panel enables a field the moment it is touched, so
 * selecting X and re-typing the primary's own full X range leaves X
 * enabled-at-full-extent. Copied blindly, that would crop every sibling to the
 * PRIMARY's footprint — a spatial filter the user never asked for, and one that
 * silently deletes most of a scan standing somewhere else on the plot. The
 * caller supplies the predicate rather than bounds because judging a CLASS
 * filter needs the field's class count, which only the caller can resolve.
 * Omit it and every enabled criterion carries over (the pre-narrowing
 * behaviour), which is only safe when the caller has already screened them.
 */
export function projectFilters(
  source: CloudFilters,
  target: CloudFilters,
  narrows?: (field: string) => boolean,
): CloudFilters {
  // A criterion carries over only if it removes something on the SOURCE.
  const carries = (field: string, f: FilterRange | undefined): boolean => {
    if (!f?.enabled) return false;
    return narrows ? narrows(field) : true;
  };

  const scalarFields: Record<string, FilterRange> = {};
  for (const [slug, tf] of Object.entries(target.scalarFields)) {
    const sf = source.scalarFields[slug];
    // Otherwise keep the target's own (disabled, full-extent) entry so its
    // bounds stay honest.
    scalarFields[slug] = carries(`scalar:${slug}`, sf) ? { ...sf! } : tf;
  }
  return {
    ...target,
    x: carries('x', source.x) ? { ...source.x } : target.x,
    y: carries('y', source.y) ? { ...source.y } : target.y,
    z: carries('z', source.z) ? { ...source.z } : target.z,
    intensity: target.intensity
      ? (carries('intensity', source.intensity) ? { ...source.intensity! } : target.intensity)
      : undefined,
    scalarFields,
  };
}
