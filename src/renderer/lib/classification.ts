// Categorical (classification) scalar attributes — discrete per-class colors
// + legend, as opposed to the continuous gradient used for ordinary scalars.
//
// Ground segmentation writes a `ground_class` scalar attribute (1=ground,
// 2=plant). Such labels are categorical: class 2 is not "halfway between 1 and
// 3", so a continuous colormap is misleading. These helpers give each class a
// distinct swatch and a legend, and are reused by both the flat PointCloud
// renderer and the octree (potree) renderer.
//
// Pure + stateless — safe to unit-test directly.
import type { RGB } from './colormaps';

export interface ClassDef {
  value: number;   // the integer class value stored in the scalar attribute
  label: string;   // human-readable name shown in the legend
  color: RGB;      // sRGB display color, 0-1 per channel
}

export interface CategoricalScheme {
  // The attribute slug this scheme applies to (matches the on-disk octree
  // attribute name and the flat-cloud scalarFields key).
  attribute: string;
  classes: ClassDef[];
}

// Ground/non-ground classification, written by /api/segment/ground/apply as the
// `ground_class` attribute. CSF only separates ground from everything above it,
// so class 2 is "Non-ground" — usually plant, but also any other above-ground
// object (a person, building, equipment, …) the filter can't distinguish.
// Colors: earthy brown for ground, green for non-ground (plant is the common
// case in this app's scans).
export const GROUND_CLASS_ATTRIBUTE = 'ground_class';

const GROUND_SCHEME: CategoricalScheme = {
  attribute: GROUND_CLASS_ATTRIBUTE,
  classes: [
    { value: 1, label: 'Ground', color: [0.55, 0.40, 0.26] },
    { value: 2, label: 'Non-ground', color: [0.30, 0.69, 0.31] },
  ],
};

// Tree instance segmentation (TreeIso) writes a `tree_instance` attribute:
// 0 = unassigned, 1..N = individual trees. Unlike ground_class, N is unbounded
// and only known at runtime, so this scheme is GENERATED from the data's id
// range rather than registered as a fixed class list. Each id gets a distinct,
// repeating, perceptually-spaced color via the golden-angle hue rotation;
// id 0 ("unassigned") is a muted gray.
export const TREE_INSTANCE_ATTRIBUTE = 'tree_instance';

const TREE_UNASSIGNED_COLOR: RGB = [0.55, 0.55, 0.55];
// Golden-angle hue step keeps successive ids far apart on the color wheel.
const GOLDEN_ANGLE_DEG = 137.508;

function hslToRgb(h: number, s: number, l: number): RGB {
  // h in [0,360), s,l in [0,1]. Standard HSL→sRGB.
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

// Deterministic color for a tree instance id. id 0 → gray; ids 1..N cycle the
// hue wheel by the golden angle, alternating lightness/saturation slightly so
// even hues that wrap around stay distinguishable.
export function treeInstanceColor(id: number): RGB {
  const i = Math.round(id);
  if (i <= 0) return TREE_UNASSIGNED_COLOR;
  const hue = ((i - 1) * GOLDEN_ANGLE_DEG) % 360;
  const sat = 0.62 + 0.18 * ((i % 3) / 2);   // 0.62..0.80
  const light = 0.50 + 0.12 * ((i % 2));     // 0.50 or 0.62
  return hslToRgb(hue, sat, light);
}

// Build a categorical scheme spanning ids 0..maxId, so the existing
// colorForClassValue / buildCategoricalGradientStops machinery (and the legend)
// work unchanged for tree instances.
export function buildTreeInstanceScheme(maxId: number): CategoricalScheme {
  const top = Math.max(0, Math.round(maxId));
  const classes: ClassDef[] = [];
  for (let i = 0; i <= top; i++) {
    classes.push({
      value: i,
      label: i === 0 ? 'Unassigned' : `Tree ${i}`,
      color: treeInstanceColor(i),
    });
  }
  return { attribute: TREE_INSTANCE_ATTRIBUTE, classes };
}

// Build a generic categorical scheme spanning the integer values in [min,max],
// for a field the user marked categorical in the import wizard. Reuses the
// tree-instance golden-angle palette so successive classes stay distinct, with
// neutral "Class N" labels (we have no domain names for an arbitrary field).
// Guards the span so a pathological range can't allocate a huge class list.
const GENERIC_CATEGORICAL_MAX_CLASSES = 256;

export function buildGenericCategoricalScheme(
  attribute: string,
  range: [number, number] | undefined | null,
): CategoricalScheme {
  const lo = range ? Math.floor(range[0]) : 0;
  const hiRaw = range ? Math.ceil(range[1]) : 0;
  const hi = Math.min(hiRaw, lo + GENERIC_CATEGORICAL_MAX_CLASSES - 1);
  const classes: ClassDef[] = [];
  for (let v = lo; v <= hi; v++) {
    classes.push({
      value: v,
      // Offset by 1 so v and the tree palette's id line up (id 0 = gray);
      // a value of 0 still reads as "Class 0" with the unassigned gray.
      label: `Class ${v}`,
      color: treeInstanceColor(v),
    });
  }
  return { attribute, classes };
}

// Sky/miss flag (is_miss): 0 = a real return (hit), 1 = a sky/miss point (the
// laser pulse returned nothing). Misses are hidden by default and drawn by a
// dedicated overlay, but when shown inline they get a distinct, unmistakable
// colour so they read as "not real geometry": muted slate for hits, warm orange
// for misses.
export const MISS_ATTRIBUTE = 'is_miss';
// The colour the dedicated miss overlay (and the inline scheme) paints misses.
export const MISS_COLOR: RGB = [1.0, 0.55, 0.0];

const MISS_SCHEME: CategoricalScheme = {
  attribute: MISS_ATTRIBUTE,
  classes: [
    { value: 0, label: 'Hit', color: [0.55, 0.60, 0.65] },
    { value: 1, label: 'Miss', color: MISS_COLOR },
  ],
};

// Registry of known categorical schemes, keyed by attribute slug. Future
// classifications (organ type, semantic labels, …) register here and get
// discrete coloring + a legend for free.
const SCHEMES: Record<string, CategoricalScheme> = {
  [GROUND_CLASS_ATTRIBUTE]: GROUND_SCHEME,
  [MISS_ATTRIBUTE]: MISS_SCHEME,
};

// Slugs the user marked categorical in the import wizard. Lower-cased on insert
// so lookups match the case-insensitive slug convention used elsewhere. Module-
// level (process-wide) so the three pure predicate functions below — called by
// slug from the renderers — can consult it without threading per-cloud context.
// Rehydrated from each cloud's OctreeRef.categoricalAttributes at import/restore.
const DYNAMIC_CATEGORICAL = new Set<string>();

// Mark `slug` as categorical (import wizard). Idempotent.
export function registerCategoricalSlug(slug: string | undefined | null): void {
  if (!slug) return;
  DYNAMIC_CATEGORICAL.add(slug.toLowerCase());
}

export function unregisterCategoricalSlug(slug: string | undefined | null): void {
  if (!slug) return;
  DYNAMIC_CATEGORICAL.delete(slug.toLowerCase());
}

// True for attributes whose categorical scheme is generated from the data range
// rather than registered with a fixed class list: the built-in tree_instance,
// plus any slug a user marked categorical in the import wizard. Callers build
// the scheme from the attribute's observed [min,max] via categoricalSchemeForRange.
export function isDynamicCategoricalAttribute(attribute: string | undefined | null): boolean {
  if (!attribute) return false;
  const key = attribute.toLowerCase();
  return key === TREE_INSTANCE_ATTRIBUTE || DYNAMIC_CATEGORICAL.has(key);
}

// Resolve a categorical scheme for an attribute, generating it from `range`
// (the attribute's [min,max]) when the attribute is dynamic. tree_instance uses
// its dedicated Tree-N scheme; a wizard-marked field uses the generic Class-N
// scheme. Static registered schemes (ground_class) fall through unchanged.
export function categoricalSchemeForRange(
  attribute: string | undefined | null,
  range: [number, number] | undefined | null,
): CategoricalScheme | null {
  if (!attribute) return categoricalSchemeFor(attribute);
  const key = attribute.toLowerCase();
  if (key === TREE_INSTANCE_ATTRIBUTE) {
    const maxId = range ? range[1] : 0;
    return buildTreeInstanceScheme(maxId);
  }
  if (DYNAMIC_CATEGORICAL.has(key)) {
    return buildGenericCategoricalScheme(attribute, range ?? null);
  }
  return categoricalSchemeFor(attribute);
}

// Return the categorical scheme for an attribute, or null if it should use the
// continuous-gradient path. Matching is case-insensitive on the slug; an
// attribute label like "Ground Class" still maps via its slug `ground_class`.
export function categoricalSchemeFor(attribute: string | undefined | null): CategoricalScheme | null {
  if (!attribute) return null;
  const key = attribute.toLowerCase();
  return SCHEMES[key] ?? null;
}

export function isCategoricalAttribute(attribute: string | undefined | null): boolean {
  return categoricalSchemeFor(attribute) !== null || isDynamicCategoricalAttribute(attribute);
}

const UNKNOWN_CLASS_COLOR: RGB = [0.6, 0.6, 0.6];

// Map a (possibly non-integer, due to float32 round-trip) attribute value to
// its class color. Rounds to the nearest integer class value; unknown values
// fall back to gray so a stray label never crashes the render.
export function colorForClassValue(scheme: CategoricalScheme, value: number): RGB {
  const rounded = Math.round(value);
  const cls = scheme.classes.find((c) => c.value === rounded);
  return cls ? cls.color : UNKNOWN_CLASS_COLOR;
}

// Build a STEP gradient (array of [t, RGB] stops in 0..1) for the potree
// INTENSITY_GRADIENT pipeline, given the value range [min,max] the octree
// reports for the attribute. Each class occupies a constant-color band, so
// sampling the gradient texture yields the exact class color (no interpolation
// across class boundaries). Pairs of coincident stops at each band edge keep
// the transition hard rather than ramped.
//
// `range` is [min, max] of the attribute (e.g. [1, 2] for ground_class).
export function buildCategoricalGradientStops(
  scheme: CategoricalScheme,
  range: [number, number],
): Array<[number, RGB]> {
  const [lo, hi] = range;
  const span = hi - lo || 1;
  const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
  // Sort classes by value so bands are laid out left→right.
  const classes = [...scheme.classes].sort((a, b) => a.value - b.value);
  const stops: Array<[number, RGB]> = [];
  for (const cls of classes) {
    // Each integer class value v owns the band [v-0.5, v+0.5] in value space,
    // projected onto 0..1. Clamp BOTH ends to [0,1] — a class whose band lies
    // entirely outside [lo,hi] (e.g. when a split sub-cloud holds only one
    // class) collapses to a zero-width band and contributes nothing, rather
    // than emitting an out-of-range stop (CanvasGradient.addColorStop throws
    // on t<0 or t>1).
    const tStart = clamp01((cls.value - 0.5 - lo) / span);
    const tEnd = clamp01((cls.value + 0.5 - lo) / span);
    if (tEnd <= tStart) continue; // band outside the range — skip
    // Hard edges: push the color at both ends of its band.
    stops.push([tStart, cls.color]);
    stops.push([tEnd, cls.color]);
  }
  // Guarantee coverage of the full 0..1 range.
  if (stops.length === 0) return [[0, UNKNOWN_CLASS_COLOR], [1, UNKNOWN_CLASS_COLOR]];
  if (stops[0][0] > 0) stops.unshift([0, stops[0][1]]);
  if (stops[stops.length - 1][0] < 1) stops.push([1, stops[stops.length - 1][1]]);
  return stops;
}
