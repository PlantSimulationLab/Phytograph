// Reconciling several clouds' scalar-field listings into the one list the
// Scalar Fields panel can safely act on.
//
// Pure + stateless — no React, no fetch. The panel works on a SET of clouds
// (seeded from the viewport selection but owned by its own picker), and the
// three tabs mean three different things across that set: Stats pools the
// clouds into one distribution, while Compute and Fields fan the same action
// out over each cloud in turn. Both readings need the same precondition —
// every checked cloud actually carries the field — so the offered list is the
// INTERSECTION of their listings, never the union.
//
// The reconciliation rules below all follow one principle: never offer an
// action that will succeed on some clouds and fail on others. A half-applied
// rename is the worst outcome this tool can produce (see `intersectScalarFields`).
import type { ScalarFieldInfo, ScalarFieldListResult } from '../utils/backendApi';
import type { ExpressionVocabulary } from './scalarFieldExpression';
import type { ScalarStats } from './scalarFieldStats';

/**
 * Fields that cannot be POOLED across clouds, and why.
 *
 * `x`/`y`/`z` come from the session's `positions`, which is its OWN frame —
 * each cloud's global shift was subtracted at import. Two clouds imported at
 * different shifts therefore store coordinate columns that are not in a common
 * frame, so a pooled mean or percentile is arithmetic over mixed origins: not
 * merely uninformative, wrong. (`_merge_sessions_locked` has to do a real
 * re-expression for exactly this reason when stitching.)
 *
 * Blocked rather than warned about, because the resulting number looks
 * perfectly ordinary. The backend refuses these independently, so a stale
 * renderer cannot produce one either.
 */
export const UNPOOLABLE_SLUGS: readonly string[] = ['x', 'y', 'z'];

export const UNPOOLABLE_REASON =
  'Each cloud stores its coordinates in its own frame, so pooling them across '
  + 'clouds would mix origins. Check a single cloud to measure coordinates.';

/** A field that exists everywhere but must not be measured across clouds. */
export interface BlockedScalarField {
  field: ScalarFieldInfo;
  reason: string;
}

export interface ScalarFieldIntersection {
  /** Fields every checked cloud carries, reconciled, in the first cloud's order. */
  fields: ScalarFieldInfo[];
  /** Carried by every cloud but unmeasurable across them (coordinates). */
  blocked: BlockedScalarField[];
  /** Slugs some — but not all — checked clouds carry. Surfaced, not silent. */
  omitted: string[];
  /** Slugs whose display label disagrees between clouds; the first one wins. */
  labelConflicts: string[];
  /** The grammar an expression may reference. Intersected, see below. */
  vocabulary: ExpressionVocabulary;
  /** Summed across the checked clouds, so the Stats caption stays true. */
  pointCount: number;
  visibleCount: number;
}

const EMPTY: ScalarFieldIntersection = {
  fields: [], blocked: [], omitted: [], labelConflicts: [],
  vocabulary: { fields: [], functions: [], aggregates: [], constants: [] },
  pointCount: 0, visibleCount: 0,
};

/** Slugs common to every listing, preserving the first listing's order. */
function commonSlugs(listings: ScalarFieldListResult[]): string[] {
  const rest = listings.slice(1).map(l => new Set(l.fields.map(f => f.slug)));
  return listings[0].fields
    .map(f => f.slug)
    .filter(slug => rest.every(set => set.has(slug)));
}

/**
 * Reconcile one slug's metadata across the clouds that carry it.
 *
 * Each rule exists to stop the panel offering something that would fail
 * partway through a fan-out:
 *
 *  - `kind`: builtin if ANY cloud calls it builtin. `intensity` is a builtin
 *    where the session holds it as a dedicated array, but an ordinary editable
 *    extra where it was imported as a column — and `manage` 404s on the former.
 *  - `editable`: ANDed. This is the load-bearing one: it is what stops a rename
 *    succeeding on cloud A and 404-ing on cloud B, which would split the field's
 *    identity so that NEITHER name is in the intersection any more and the panel
 *    appears to have lost two fields.
 *  - `reserved`: ORed. The reserved set is global, so this is defensive only.
 *  - `expression`: kept only when every cloud derived it from the identical
 *    formula. Two clouds deriving `refl` differently must not display one
 *    formula as though it described both.
 *  - `label`: first cloud's wins — a display string is not a contract — and the
 *    disagreement is reported rather than merged.
 */
function reconcile(
  slug: string, entries: ScalarFieldInfo[],
): { field: ScalarFieldInfo; labelConflict: boolean } {
  const first = entries[0];
  const expression = entries.every(e => e.expression && e.expression === first.expression)
    ? first.expression
    : null;
  return {
    field: {
      slug,
      label: first.label,
      kind: entries.some(e => e.kind === 'builtin') ? 'builtin' : 'extra',
      editable: entries.every(e => e.editable),
      reserved: entries.some(e => e.reserved),
      expression,
    },
    labelConflict: entries.some(e => e.label !== first.label),
  };
}

/** Values common to every list, preserving the first's order. */
function intersectNames(lists: readonly string[][]): string[] {
  if (lists.length === 0) return [];
  const rest = lists.slice(1).map(l => new Set(l));
  return lists[0].filter(name => rest.every(set => set.has(name)));
}

/**
 * The one field list the panel may act on across `listings`.
 *
 * `scanCount` is the number of clouds the user has CHECKED, which is not
 * always `listings.length` — a listing can still be in flight or have failed.
 * The coordinate block keys off the checked count, so a cloud whose listing
 * hasn't arrived can't briefly un-block `z`.
 */
export function intersectScalarFields(
  listings: ScalarFieldListResult[],
  scanCount: number,
): ScalarFieldIntersection {
  if (listings.length === 0) return EMPTY;

  const shared = new Set(commonSlugs(listings));
  const fields: ScalarFieldInfo[] = [];
  const blocked: BlockedScalarField[] = [];
  const labelConflicts: string[] = [];
  const pooling = scanCount > 1;

  for (const slug of shared) {
    const entries = listings
      .map(l => l.fields.find(f => f.slug === slug))
      .filter((f): f is ScalarFieldInfo => !!f);
    const { field, labelConflict } = reconcile(slug, entries);
    if (labelConflict) labelConflicts.push(slug);
    if (pooling && UNPOOLABLE_SLUGS.includes(slug)) {
      blocked.push({ field, reason: UNPOOLABLE_REASON });
    } else {
      fields.push(field);
    }
  }

  // Every slug SOME cloud carries that didn't make the intersection. Reported
  // so the panel can say how many fields it is hiding and why, rather than
  // leaving the user to notice a field silently missing.
  const omitted: string[] = [];
  for (const listing of listings) {
    for (const f of listing.fields) {
      if (!shared.has(f.slug) && !omitted.includes(f.slug)) omitted.push(f.slug);
    }
  }

  // The vocabulary must follow the intersection too. If it carried the first
  // cloud's full field list, a formula could reference a field cloud 3 lacks,
  // pass client-side validation, and 400 partway through the fan-out — leaving
  // the run half-applied. Intersecting it here is what makes "an expression
  // error aborts the whole loop" a safe rule.
  //
  // Coordinates stay in the vocabulary even while blocked as a stats target:
  // `z - ground_height` is a perfectly good per-cloud formula, and Compute runs
  // per cloud, so it never crosses frames.
  const vocabFields = [...fields, ...blocked.map(b => b.field)].map(f => f.slug);

  return {
    fields,
    blocked,
    omitted,
    labelConflicts,
    vocabulary: {
      fields: vocabFields,
      functions: intersectNames(listings.map(l => l.functions ?? [])),
      aggregates: intersectNames(listings.map(l => l.aggregates ?? [])),
      constants: intersectNames(listings.map(l => l.constants ?? [])),
    },
    pointCount: listings.reduce((n, l) => n + (l.point_count ?? 0), 0),
    visibleCount: listings.reduce((n, l) => n + (l.visible_count ?? 0), 0),
  };
}

/** Class-column slugs whose ids are per-cloud, so pooling them mixes identities. */
const PER_CLOUD_CLASS_SLUGS: readonly string[] = ['tree_instance'];

/** Above this many distinct values, an integer column reads as a measurement. */
const CLASS_LIKE_MAX_SPAN = 64;

/**
 * A caution to show beside pooled statistics, or null when there is nothing
 * worth saying.
 *
 * Unlike the coordinate block this never refuses: a pooled histogram of a class
 * column is genuinely useful (it shows the class mix over the plot), it is only
 * the mean and the percentiles that mean nothing. So the panel states the
 * limitation beside the numbers, exactly as it already explains why the counts
 * exclude hidden and sky/miss points, rather than hiding the readout.
 */
export function poolingCaution(
  slug: string, stats: ScalarStats | null, scanCount: number,
): string | null {
  if (scanCount <= 1 || !stats) return null;

  if (PER_CLOUD_CLASS_SLUGS.includes(slug)) {
    return `Ids in ${slug} are assigned per cloud, so the same id means a `
      + 'different object on each. Pooled percentiles are not meaningful — read '
      + 'the histogram.';
  }

  const { min, max } = stats;
  if (min === undefined || max === undefined) return null;
  const integral = Number.isInteger(min) && Number.isInteger(max)
    && (stats.median === undefined || Number.isInteger(stats.median));
  if (integral && max - min <= CLASS_LIKE_MAX_SPAN) {
    return 'This looks like a class column. A pooled mean or percentile over '
      + 'class ids is not meaningful — read the histogram.';
  }
  return null;
}
