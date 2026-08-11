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

/** The lowest unused value in the user-definable band, for "add class". */
export function nextFreeClassValue(palette: ClassPalette): number {
  const used = new Set(palette.classes.map((c) => c.value));
  for (let v = USER_CLASS_MIN; v <= CLASS_VALUE_MAX; v++) {
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
