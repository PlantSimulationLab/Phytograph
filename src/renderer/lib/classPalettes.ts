// User-definable class palettes for the manual labelling tool.
//
// A palette is just a named, ordered list of `ClassDef` — the SAME interface
// `classification.ts` already uses for its built-in schemes. That reuse is the
// point: a palette converts to a `CategoricalScheme` with a field rename, so
// discrete point colouring, the legend, the potree step gradient, scalar
// filtering and split-by-class all work on user-defined classes with no changes
// downstream.
//
// The model follows TerraScan's `.PTC` class-definition files: classes are
// project-level DATA the user owns, shareable between collaborators, not a
// hardcoded enum. We ship presets as starting points, never as a constraint.
//
// Pure + stateless — no React, no DOM, no three.js.
import type { ClassDef, CategoricalScheme } from './classification';
import {
  ORGAN_SCHEME_CLASSES, WOOD_SCHEME_CLASSES, ASPRS_CLASS_LIST,
  LAS_CLASSIFICATION_ATTRIBUTE, GROUND_CLASS_ATTRIBUTE, GROUND_SCHEME_CLASSES,
} from './classification';
import type { RGB } from './colormaps';

export type PalettePreset = 'asprs' | 'organ' | 'wood_leaf' | 'ground';

export interface ClassPalette {
  /** Stable id, so a rename doesn't break a cloud's binding. */
  id: string;
  name: string;
  /** The attribute slug this palette colours (e.g. 'manual_class'). */
  slug: string;
  classes: ClassDef[];
  /** Provenance; undefined once the user edits it into something of their own. */
  preset?: PalettePreset;
  /**
   * True when the class list was DERIVED from values already in the column
   * (a tree segmentation's instance ids, an imported class byte) rather than
   * authored as a vocabulary.
   *
   * It decides where "Add class" numbers from, and cannot be inferred from the
   * values: the wood/leaf and organ presets also use low numbers, so a
   * "are the classes below 64" test would renumber those too. Provenance, like
   * `preset` — and for the same reason the two are separate fields.
   */
  derived?: boolean;
  updatedAt: number;
}

// ── Invariants ───────────────────────────────────────────────────────────────

/**
 * Class 0 is reserved as "Unclassified" in EVERY palette, and this is
 * load-bearing rather than cosmetic: the backend's `merge` zero-fills a column
 * missing from one of its input sessions, so points from a never-labelled cloud
 * arrive as 0. That is only correct if 0 means "unclassified" everywhere.
 * Mirrors ASPRS class 0 and MANUAL_CLASS_UNLABELED in main.py.
 */
export const UNCLASSIFIED_VALUE = 0;
export const UNCLASSIFIED_LABEL = 'Unclassified';
export const UNCLASSIFIED_COLOR: RGB = [0.55, 0.55, 0.55];

/** Class values are one byte, matching the LAS classification range. */
export const CLASS_VALUE_MIN = 0;
export const CLASS_VALUE_MAX = 255;

/**
 * ASPRS reserves 19–63 for future standard use. Custom classes belong in
 * 64–255, the explicitly user-definable band — keeping them there means a
 * future writer to the real LAS classification byte is pure serialisation with
 * no renumbering of data users already painted.
 */
export const ASPRS_RESERVED_MIN = 19;
export const ASPRS_RESERVED_MAX = 63;
export const USER_CLASS_MIN = 64;

/**
 * The potree step gradient bakes into a 64-texel canvas
 * (`GRADIENT_TEXELS` in classification.ts), so classes packed closer than a
 * texel apart blend into each other on screen. The overlay works around this by
 * rendering a DENSE palette index rather than the raw class value, but a
 * palette this large is still hard to read, so warn.
 */
export const PALETTE_SOFT_MAX = 48;
/** Hard ceiling, matching GENERIC_CATEGORICAL_MAX_CLASSES. */
export const PALETTE_HARD_MAX = 256;

/**
 * The slug rule, MIRRORED from `_LABEL_SLUG_RE` in backend-api/main.py.
 *
 * Mirrored rather than discovered at runtime so the column picker can refuse a
 * column the backend would reject, instead of offering it and taking a 400 on
 * the user's first brush stroke. `classPalettes.test.ts` parses the pattern out
 * of main.py and asserts the two agree, so a backend tightening fails here.
 */
export const LABEL_SLUG_RE = /^[a-z][a-z0-9_]{0,30}$/;

/**
 * Standard LAS dimension names a label column must never take, MIRRORED from
 * `_LAS_RESERVED_SLUGS` in backend-api/main.py.
 *
 * `classification` is the one that matters most: laspy would try to bit-pack a
 * float column into the classification-flags byte and HARD-CRASH the backend
 * process. The rest would silently shadow real LAS data on export. Note this is
 * the bare name only — `las_classification` (what an imported classification
 * byte carries under) is deliberately NOT reserved and stays labelable.
 */
export const LAS_RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'x', 'y', 'z', 'intensity', 'classification', 'classification_flags',
  'raw_classification', 'return_number', 'number_of_returns', 'scan_direction_flag',
  'edge_of_flight_line', 'scan_angle', 'scan_angle_rank', 'user_data',
  'point_source_id', 'gps_time', 'red', 'green', 'blue', 'nir',
  'scanner_channel', 'synthetic', 'key_point', 'withheld', 'overlap',
]);

/** True when `slug` is one the backend's `_validate_label_slug` would accept. */
export function isValidLabelSlug(slug: string | undefined | null): boolean {
  if (!slug) return false;
  if (!LABEL_SLUG_RE.test(slug)) return false;
  // Case-insensitive: laspy resolves standard dimension names case-blind.
  return !LAS_RESERVED_SLUGS.has(slug.toLowerCase());
}

export interface PaletteIssue {
  level: 'error' | 'warning';
  message: string;
  /** The offending class value, when the issue is about one. */
  value?: number;
}

/** Validate a palette. Errors block saving; warnings are advisory. */
export function validatePalette(palette: ClassPalette): PaletteIssue[] {
  const issues: PaletteIssue[] = [];
  const classes = palette.classes ?? [];

  if (!palette.name?.trim()) {
    issues.push({ level: 'error', message: 'Palette needs a name.' });
  }
  // The column this palette writes to. Checked here so a palette that could
  // never be painted is rejected at Save rather than at the first stroke.
  if (!isValidLabelSlug(palette.slug)) {
    issues.push({
      level: 'error',
      message: !palette.slug?.trim()
        ? 'Palette needs a column.'
        : LAS_RESERVED_SLUGS.has(palette.slug.toLowerCase())
          ? `Column "${palette.slug}" is a standard LAS dimension name; pick another.`
          : `Column ${palette.slug} must start with a letter and use only `
            + 'lowercase letters, digits and underscores (max 31 characters).',
    });
  }
  if (classes.length === 0) {
    issues.push({ level: 'error', message: 'Palette needs at least one class.' });
  }
  if (classes.length > PALETTE_HARD_MAX) {
    issues.push({
      level: 'error',
      message: `Too many classes (${classes.length}); the maximum is ${PALETTE_HARD_MAX}.`,
    });
  } else if (classes.length > PALETTE_SOFT_MAX) {
    issues.push({
      level: 'warning',
      message: `${classes.length} classes may be hard to tell apart on screen; `
        + `around ${PALETTE_SOFT_MAX} is the practical limit.`,
    });
  }

  const unclassified = classes.find((c) => c.value === UNCLASSIFIED_VALUE);
  if (!unclassified) {
    issues.push({
      level: 'error',
      value: UNCLASSIFIED_VALUE,
      message: `Class ${UNCLASSIFIED_VALUE} (${UNCLASSIFIED_LABEL}) is required — `
        + 'merged and unlabelled points arrive as 0.',
    });
  }

  const seen = new Set<number>();
  for (const c of classes) {
    if (!Number.isInteger(c.value)) {
      issues.push({ level: 'error', value: c.value,
        message: `Class values must be whole numbers; got ${c.value}.` });
      continue;
    }
    if (c.value < CLASS_VALUE_MIN || c.value > CLASS_VALUE_MAX) {
      issues.push({ level: 'error', value: c.value,
        message: `Class ${c.value} is outside ${CLASS_VALUE_MIN}–${CLASS_VALUE_MAX}.` });
    }
    if (seen.has(c.value)) {
      issues.push({ level: 'error', value: c.value,
        message: `Duplicate class value ${c.value}.` });
    }
    seen.add(c.value);
    if (!c.label?.trim()) {
      issues.push({ level: 'error', value: c.value,
        message: `Class ${c.value} needs a name.` });
    }
    if (c.value >= ASPRS_RESERVED_MIN && c.value <= ASPRS_RESERVED_MAX) {
      issues.push({ level: 'warning', value: c.value,
        message: `Class ${c.value} is in the ASPRS reserved range `
          + `(${ASPRS_RESERVED_MIN}–${ASPRS_RESERVED_MAX}); prefer ${USER_CLASS_MIN}+ `
          + 'for custom classes.' });
    }
  }
  return issues;
}

export function paletteErrors(palette: ClassPalette): PaletteIssue[] {
  return validatePalette(palette).filter((i) => i.level === 'error');
}

/**
 * The lowest unused value for "add class".
 *
 * Defaults to the ASPRS user-definable band (64+) so a hand-built vocabulary
 * never collides with the standard codes. But a palette DERIVED from an
 * existing column must continue THAT column's own numbering instead: a user
 * splitting a wrongly-merged tree in a `tree_instance` column wants Tree 3, not
 * class 64 — the ids are data written by the segmentation, not a vocabulary we
 * chose, and jumping to 64 would both look wrong and leave a 61-value hole in
 * the legend. `derivePaletteForColumn` passes `startAt` for exactly that case.
 */
export function nextFreeClassValue(palette: ClassPalette, startAt?: number): number {
  const used = new Set(palette.classes.map((c) => c.value));
  const from = Number.isFinite(startAt)
    ? Math.max(CLASS_VALUE_MIN, Math.round(startAt as number))
    : USER_CLASS_MIN;
  for (let v = from; v <= CLASS_VALUE_MAX; v++) {
    if (!used.has(v)) return v;
  }
  // The preferred band is full — fall back to any free value at all before
  // giving up, so a derived palette starting high can still grow downward.
  for (let v = CLASS_VALUE_MIN; v < from; v++) {
    if (!used.has(v)) return v;
  }
  return CLASS_VALUE_MAX;
}

// ── Scheme bridge ────────────────────────────────────────────────────────────

/**
 * A palette IS a categorical scheme; this is the whole reason `ClassDef` is
 * reused rather than redefined. Everything downstream (colourForClassValue,
 * buildCategoricalGradientStops, the legend, filtering) takes it unchanged.
 */
export function paletteToScheme(palette: ClassPalette): CategoricalScheme {
  return { attribute: palette.slug, classes: palette.classes };
}

/**
 * Dense 0..n-1 index for each class value, and its inverse.
 *
 * The label column stores real class VALUES (so they round-trip to LAS and to a
 * future ASPRS writer), but the renderer paints the palette INDEX, because the
 * potree step gradient only has 64 texels: a palette using 64, 65, 66… would be
 * indistinguishable on screen even though the stored data is perfectly correct.
 * Rendering a dense index sidesteps that entirely and makes the gradient range
 * a trivial [0, n-1].
 */
export function paletteIndexMaps(palette: ClassPalette): {
  valueToIndex: Map<number, number>;
  indexToValue: number[];
} {
  const valueToIndex = new Map<number, number>();
  const indexToValue: number[] = [];
  palette.classes.forEach((c, i) => {
    valueToIndex.set(c.value, i);
    indexToValue.push(c.value);
  });
  return { valueToIndex, indexToValue };
}

/**
 * The scheme the OVERLAY renders: the same colours, but keyed by dense index so
 * it matches the index values written into the per-tile label buffer.
 */
export function paletteToIndexScheme(palette: ClassPalette): CategoricalScheme {
  return {
    attribute: palette.slug,
    classes: palette.classes.map((c, i) => ({ ...c, value: i })),
  };
}

// ── Presets ──────────────────────────────────────────────────────────────────

function def(value: number, label: string, color: RGB): ClassDef {
  return { value, label, color };
}

/**
 * ASPRS LAS 1.4 standard classes 0–18.
 *
 * Re-exported from `classification.ts` rather than redefined, so the labelling
 * tool's ASPRS preset and the scheme that names an IMPORTED file's
 * `las_classification` column are literally the same list — they cannot drift.
 */
export const ASPRS_CLASSES: ClassDef[] = ASPRS_CLASS_LIST;

/**
 * The COLUMN each preset describes.
 *
 * A palette names both a class vocabulary and the attribute it applies to, and
 * conflating the two is a real bug: binding every preset to `manual_class`
 * meant switching to the ASPRS palette read the (empty) manual column while the
 * cloud's real classes sat in `ground_class`, so Ground showed 0 points and
 * nothing coloured.
 *
 * ASPRS describes an imported LAS classification byte; wood/leaf and organs are
 * hand-labelling vocabularies that live in the manual column. A user editing a
 * preset into something of their own keeps whatever slug it was bound to.
 */
export function defaultSlugForPreset(
  preset: PalettePreset, manualSlug: string,
): string {
  if (preset === 'asprs') return LAS_CLASSIFICATION_ATTRIBUTE;
  if (preset === 'ground') return GROUND_CLASS_ATTRIBUTE;
  return manualSlug;
}

export function makePreset(
  preset: PalettePreset, slug: string, now: number,
): ClassPalette {
  switch (preset) {
    case 'asprs':
      return { id: 'preset-asprs', name: 'ASPRS standard', slug,
               classes: ASPRS_CLASSES.map((c) => ({ ...c })), preset, updatedAt: now };
    case 'organ':
      // Reuses the exact values/colours the Helios synthetic-scan `organ`
      // attribute carries, so hand labels and simulated ground truth share one
      // vocabulary and can be compared directly.
      return { id: 'preset-organ', name: 'Plant organs', slug,
               classes: ORGAN_SCHEME_CLASSES.map((c) => ({ ...c })), preset, updatedAt: now };
    case 'ground':
      // Mirrors what the ground-segmentation tool writes (1=ground,
      // 2=non-ground), so a cloud already segmented by that tool shows its real
      // classes the moment this palette is selected. Prepends the required
      // Unclassified for points the segmentation never assigned.
      return {
        id: 'preset-ground', name: 'Ground / non-ground', slug,
        classes: [
          def(UNCLASSIFIED_VALUE, UNCLASSIFIED_LABEL, UNCLASSIFIED_COLOR),
          ...GROUND_SCHEME_CLASSES.map((c) => ({ ...c })),
        ],
        preset, updatedAt: now,
      };
    case 'wood_leaf':
      // Mirrors the automatic wood/leaf segmentation output, so a user can
      // correct its result by hand in the same vocabulary. That tool emits
      // 1=wood, 2=leaf and no 0, so prepend the required Unclassified.
      return {
        id: 'preset-wood-leaf', name: 'Wood / leaf', slug,
        classes: [
          def(UNCLASSIFIED_VALUE, UNCLASSIFIED_LABEL, UNCLASSIFIED_COLOR),
          ...WOOD_SCHEME_CLASSES.map((c) => ({ ...c })),
        ],
        preset, updatedAt: now,
      };
  }
}

/** A minimal starting palette for a user who wants to define their own. */
export function makeEmptyPalette(slug: string, now: number, id: string): ClassPalette {
  return {
    id, name: 'My classes', slug, updatedAt: now,
    classes: [def(UNCLASSIFIED_VALUE, UNCLASSIFIED_LABEL, UNCLASSIFIED_COLOR)],
  };
}

// ── Labelable columns ────────────────────────────────────────────────────────

/**
 * A column the labelling tool can paint into.
 *
 * The tool used to be able to reach exactly four columns, because a PRESET
 * named both a vocabulary and its column. That made any other classification a
 * cloud carried — a `tree_instance` from a failed tree segmentation being the
 * motivating case — unreachable for hand correction, however plainly it was
 * displayed everywhere else in the app.
 */
export interface LabelableColumn {
  slug: string;
  /** Display text: the cloud's own attribute label, else a humanised slug. */
  label: string;
  /**
   * `manual` — the hand-labelling column, always offered.
   * `categorical` — a real classification: class-valued, safe to repaint.
   * `scalar` — a continuous measurement. Offered deliberately (see below) but
   *   painting one OVERWRITES measured values, so the caller must confirm.
   */
  kind: 'manual' | 'categorical' | 'scalar';
  /** True when the cloud does not carry this column yet (created on first paint). */
  missing: boolean;
  observed?: readonly number[];
  range?: [number, number];
}

/** `tree_instance` → `Tree instance`. Only used when the cloud names no label. */
function humaniseSlug(slug: string): string {
  const spaced = slug.replace(/_/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : slug;
}

/** True when every observed value is an integer inside the one-byte class range. */
function looksLikeClassValues(observed: readonly number[] | undefined): boolean {
  if (!observed || observed.length === 0) return false;
  if (observed.length > PALETTE_HARD_MAX) return false;
  return observed.every((v) => Number.isInteger(v)
    && v >= CLASS_VALUE_MIN && v <= CLASS_VALUE_MAX);
}

/**
 * The columns of one cloud that the labelling tool can paint into.
 *
 * `isCategorical` is INJECTED rather than imported because the real
 * implementation (`isCategoricalAttribute`) consults process-wide registries in
 * classification.ts. Injecting keeps this function pure — testable without
 * mutating module globals, and deterministic across both branches — which is
 * the same discipline `categoricalSchemeForCloud` already uses for palettes.
 *
 * `columnOptions` comes from `octreeScalarFieldOptions`, reused rather than
 * re-derived so this list, the Color-by picker and the Filter panel cannot
 * disagree about which columns a cloud has.
 */
export function labelableColumnsFor(args: {
  columnOptions: ReadonlyArray<{ value: string; label: string }>;
  attributeRanges?: Record<string, { min: number[]; max: number[] }>;
  observedClasses?: Record<string, number[]>;
  classPalettes?: Record<string, ClassPalette>;
  manualSlug: string;
  isCategorical: (slug: string) => boolean;
}): LabelableColumn[] {
  const {
    columnOptions, attributeRanges, observedClasses, classPalettes,
    manualSlug, isCategorical,
  } = args;

  const rangeFor = (slug: string): [number, number] | undefined => {
    const r = attributeRanges?.[slug];
    if (!r?.min?.length || !r?.max?.length) return undefined;
    return [r.min[0], r.max[0]];
  };

  const out: LabelableColumn[] = [];
  for (const { value: slug, label } of columnOptions) {
    // Never offer a column the backend would refuse — a picker entry that 400s
    // on the first stroke is worse than one that isn't there.
    if (!isValidLabelSlug(slug)) continue;
    if (slug === manualSlug) continue;   // added below, always first

    const observed = observedClasses?.[slug];
    const categorical = isCategorical(slug)
      || !!classPalettes?.[slug]
      || looksLikeClassValues(observed);
    out.push({
      slug,
      label: label || humaniseSlug(slug),
      kind: categorical ? 'categorical' : 'scalar',
      missing: false,
      ...(observed ? { observed } : {}),
      ...(rangeFor(slug) ? { range: rangeFor(slug) } : {}),
    });
  }

  out.sort((a, b) => (
    a.kind === b.kind ? a.label.localeCompare(b.label) : (a.kind === 'categorical' ? -1 : 1)
  ));

  // The hand-labelling column is ALWAYS offered, even on a cloud that has no
  // such column yet: the backend creates it on the first stroke. Without this
  // the picker would be empty on a fresh import and the tool would regress to
  // less than it could do before.
  const manualObserved = observedClasses?.[manualSlug];
  out.unshift({
    slug: manualSlug,
    label: columnOptions.find((o) => o.value === manualSlug)?.label ?? 'Hand labels',
    kind: 'manual',
    missing: !attributeRanges || !(manualSlug in attributeRanges),
    ...(manualObserved ? { observed: manualObserved } : {}),
    ...(rangeFor(manualSlug) ? { range: rangeFor(manualSlug) } : {}),
  });
  return out;
}

/**
 * Add a column the SESSION already carries but the octree does not yet list.
 *
 * `labelableColumnsFor` reads the OCTREE's attribute metadata, which is the
 * right source for everything except the window between committing a label
 * column and the background rebuild landing. In that window the column is real
 * — the backend created it on the first stroke and export, filter and every
 * compute path can already read it — while the octree, which is rebuilt lazily,
 * has never heard of it. Without this a user who creates a classification and
 * commits it watches their own column stay missing from the picker for the
 * length of a PotreeConverter run.
 *
 * Idempotent: a slug the octree already lists wins, since its metadata is
 * authoritative once it exists.
 */
export function withPendingLabelColumn(
  columns: LabelableColumn[],
  pending: { slug: string; label: string; observed?: number[] } | null,
): LabelableColumn[] {
  if (!pending || !isValidLabelSlug(pending.slug)) return columns;
  if (columns.some((c) => c.slug === pending.slug && !c.missing)) return columns;
  const observed = pending.observed && pending.observed.length > 0
    ? [...pending.observed].sort((a, b) => a - b)
    : undefined;
  const entry: LabelableColumn = {
    slug: pending.slug,
    label: pending.label || humaniseSlug(pending.slug),
    kind: 'categorical',
    missing: false,
    ...(observed ? { observed } : {}),
    ...(observed ? { range: [observed[0], observed[observed.length - 1]] as [number, number] } : {}),
  };
  // Replace a `missing` placeholder in place (the hand-label column is always
  // offered, flagged missing until the cloud actually has it) rather than
  // listing the slug twice.
  const at = columns.findIndex((c) => c.slug === pending.slug);
  if (at >= 0) {
    const next = [...columns];
    next[at] = { ...entry, kind: columns[at].kind };
    return next;
  }
  return [...columns, entry];
}

/**
 * Ensure class 0 exists, prepending it when it does not.
 *
 * Class 0 is required in every palette and this is load-bearing rather than
 * cosmetic (see UNCLASSIFIED_VALUE above): `merge` zero-fills a column missing
 * from one of its inputs, so 0 must mean "unclassified" on EVERY column.
 *
 * A column derived from real data often has no 0 — `tree_instance` from a tree
 * segmentation starts at 1. Synthesising one is right anyway, for a reason
 * beyond the merge rule: the labelling tool can WRITE 0, so a palette without
 * it would make "un-assign these mis-grabbed points" unreachable, which is
 * half of what correcting a bad segmentation means.
 */
export function withRequiredUnclassified(
  classes: ClassDef[], label?: string, color?: RGB,
): ClassDef[] {
  if (classes.some((c) => c.value === UNCLASSIFIED_VALUE)) return classes;
  return [
    def(UNCLASSIFIED_VALUE, label ?? UNCLASSIFIED_LABEL, color ?? UNCLASSIFIED_COLOR),
    ...classes,
  ];
}

/**
 * A starting palette for an existing column, derived from the values it holds.
 *
 * `schemeFor` is `categoricalSchemeForRange`, injected to keep this pure. It
 * already routes every case correctly — `tree_instance` to the Tree-N scheme
 * with its golden-angle colours, a registered slug (ground_class, organ, …) to
 * its fixed domain names, a wizard-marked column to generic Class-N — so this
 * function derives NO class list of its own. Deriving one here would be a
 * second definition of the same thing, and the two would drift.
 *
 * A `scalar` column is NEVER enumerated from its values: a continuous column
 * can hold millions of distinct floats, and the user picking one is declaring
 * an intent to classify INTO it, not to describe what is already there.
 */
export function derivePaletteForColumn(
  column: LabelableColumn,
  now: number,
  schemeFor: (
    slug: string,
    range: [number, number] | null,
    observed?: readonly number[] | null,
  ) => CategoricalScheme | null,
  fallbackScheme: (slug: string, observed: readonly number[]) => CategoricalScheme,
): ClassPalette {
  // `derived-<slug>` is deterministic per column, so the editor (keyed on
  // palette.id) remounts when the user switches column instead of showing the
  // previous column's draft.
  const id = `derived-${column.slug}`;
  const name = column.label;

  if (column.kind === 'scalar') {
    return { ...makeEmptyPalette(column.slug, now, id), name };
  }

  const scheme = schemeFor(column.slug, column.range ?? null, column.observed ?? null)
    ?? (column.observed?.length ? fallbackScheme(column.slug, column.observed) : null);

  // The name for class 0. A scheme that already describes 0 supplies it; one
  // whose values start at 1 does not, so ask the scheme what it WOULD call 0 —
  // for tree instances that is "Unassigned", the same word the viewer and the
  // filter panel already use for id 0. validatePalette requires the VALUE 0,
  // not any particular label, so this is free.
  const zeroFromScheme = scheme?.classes.find((c) => c.value === UNCLASSIFIED_VALUE)
    ?? schemeFor(column.slug, [0, 0], [0])?.classes
      .find((c) => c.value === UNCLASSIFIED_VALUE);

  const classes = scheme
    ? withRequiredUnclassified(
        scheme.classes.map((c) => ({ ...c })),
        zeroFromScheme?.label,
        zeroFromScheme?.color,
      )
    : [def(UNCLASSIFIED_VALUE, UNCLASSIFIED_LABEL, UNCLASSIFIED_COLOR)];

  // `preset` stays undefined: a derived palette is not one of the four stock
  // vocabularies, and marking it as one would make Preset cycle away from it.
  // `derived` records where the class VALUES came from, which is what decides
  // whether Add class continues the column's numbering or starts a new band.
  return { id, name, slug: column.slug, classes, derived: true, updatedAt: now };
}

/** Free text → a slug the backend will accept, or '' when nothing survives. */
export function slugifyLabelColumn(name: string): string {
  const base = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    // A slug must START with a letter, so drop any leading digits ("2nd pass").
    .replace(/^[0-9_]+/, '');
  return base.slice(0, 31);
}

/**
 * Validate a user-typed column name for a NEW classification. Returns the same
 * `PaletteIssue[]` shape `validatePalette` does, so the editor can concatenate
 * them and its existing disabled-Save wiring covers both with no new gating.
 */
export function validateLabelColumn(
  name: string, takenSlugs: readonly string[],
): PaletteIssue[] {
  const slug = slugifyLabelColumn(name);
  if (!slug) {
    return [{ level: 'error', message: 'Classification needs a name (letters, digits, spaces).' }];
  }
  if (LAS_RESERVED_SLUGS.has(slug)) {
    return [{ level: 'error',
      message: `"${slug}" is a standard LAS dimension name; pick another name.` }];
  }
  if (takenSlugs.includes(slug)) {
    return [{ level: 'error',
      message: `This cloud already has a "${slug}" column — pick it from the Column list to edit it.` }];
  }
  if (!isValidLabelSlug(slug)) {
    return [{ level: 'error', message: `"${slug}" is not a usable column name.` }];
  }
  return [];
}

// ── Serialisation (for the shareable library / JSON export) ──────────────────

/** Narrow an untrusted parsed-JSON value to a ClassPalette, or null. */
export function parsePalette(raw: unknown): ClassPalette | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string'
      || typeof o.slug !== 'string' || !Array.isArray(o.classes)) {
    return null;
  }
  const classes: ClassDef[] = [];
  for (const c of o.classes as unknown[]) {
    if (!c || typeof c !== 'object') return null;
    const cc = c as Record<string, unknown>;
    const color = cc.color;
    if (typeof cc.value !== 'number' || typeof cc.label !== 'string'
        || !Array.isArray(color) || color.length !== 3
        || !color.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return null;
    }
    classes.push({
      value: cc.value, label: cc.label,
      color: [color[0], color[1], color[2]] as RGB,
    });
  }
  return {
    id: o.id, name: o.name, slug: o.slug, classes,
    preset: typeof o.preset === 'string' ? (o.preset as PalettePreset) : undefined,
    ...(o.derived === true ? { derived: true } : {}),
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
  };
}

export function parsePaletteList(raw: unknown): ClassPalette[] {
  if (!Array.isArray(raw)) return [];
  const out: ClassPalette[] = [];
  for (const entry of raw) {
    const p = parsePalette(entry);
    if (p) out.push(p);
  }
  return out;
}
