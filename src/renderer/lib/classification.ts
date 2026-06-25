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

// Height-above-ground (DEM-normalized elevation; canopy-height-model precursor).
// Written onto a cloud by the DEM tool when "compute height above ground" is on.
// CONTINUOUS, not categorical — rendered as a gradient with a numeric colorbar
// (register it via registerContinuousSlug, the opposite of ground_class).
export const HEIGHT_ABOVE_GROUND_ATTRIBUTE = 'height_above_ground';

const GROUND_SCHEME: CategoricalScheme = {
  attribute: GROUND_CLASS_ATTRIBUTE,
  classes: [
    { value: 1, label: 'Ground', color: [0.55, 0.40, 0.26] },
    { value: 2, label: 'Non-ground', color: [0.30, 0.69, 0.31] },
  ],
};

// Wood/leaf classification (segment_wood writes `wood_class`): 1 = wood
// (trunk/branches), 2 = leaf. Dark woody brown for wood, leaf green for leaf —
// distinct from the ground scheme's lighter earth/green so the two are not
// confused when both are present.
export const WOOD_CLASS_ATTRIBUTE = 'wood_class';

const WOOD_SCHEME: CategoricalScheme = {
  attribute: WOOD_CLASS_ATTRIBUTE,
  classes: [
    { value: 1, label: 'Wood', color: [0.40, 0.26, 0.13] },
    { value: 2, label: 'Leaf', color: [0.30, 0.69, 0.31] },
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

// Organ type carried from a Helios plant-architecture model through a synthetic
// scan: each hit is tagged with the organ it struck. Codes are a MIRROR of
// _ORGAN_LABEL_TO_CODE in backend-api/main.py — keep them in sync. Semantic
// colors: leaf/petiolule green, woody-brown shoot, tan petiole/peduncle, red
// fruit, gray for unlabeled.
export const ORGAN_ATTRIBUTE = 'organ';

const ORGAN_SCHEME: CategoricalScheme = {
  attribute: ORGAN_ATTRIBUTE,
  classes: [
    { value: 0, label: 'Unknown', color: [0.55, 0.55, 0.55] },
    { value: 1, label: 'Leaf', color: [0.30, 0.69, 0.31] },
    { value: 2, label: 'Petiole', color: [0.65, 0.72, 0.30] },
    { value: 3, label: 'Shoot', color: [0.45, 0.30, 0.15] },
    { value: 4, label: 'Peduncle', color: [0.78, 0.60, 0.32] },
    { value: 5, label: 'Fruit', color: [0.82, 0.26, 0.24] },
    { value: 6, label: 'Petiolule', color: [0.40, 0.60, 0.45] },
  ],
};

// Registry of known categorical schemes, keyed by attribute slug. Future
// classifications (semantic labels, …) register here and get discrete coloring
// + a legend for free.
const SCHEMES: Record<string, CategoricalScheme> = {
  [GROUND_CLASS_ATTRIBUTE]: GROUND_SCHEME,
  [WOOD_CLASS_ATTRIBUTE]: WOOD_SCHEME,
  [MISS_ATTRIBUTE]: MISS_SCHEME,
  [ORGAN_ATTRIBUTE]: ORGAN_SCHEME,
};

// True when `slug` has a STATIC registered scheme (is_miss, ground_class, …) —
// i.e. a field that colours categorically by name regardless of the wizard's
// Scalar/Label dropdown. The wizard uses this to detect when a user picked
// "Scalar" for such a slug (e.g. a Miss Flag downgraded to Scalar) and must
// register a continuous override so the choice actually takes effect. Ignores
// the dynamic sets — this is purely "does a fixed scheme exist for this name".
export function hasRegisteredScheme(slug: string | undefined | null): boolean {
  if (!slug) return false;
  return slug.toLowerCase() in SCHEMES;
}

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

// Slugs the user explicitly forced to CONTINUOUS ("Scalar") in the import
// wizard, overriding a registered categorical scheme they'd otherwise get by
// name. The miss flag is the motivating case: a Miss Flag column carries under
// the canonical is_miss slug (the LAD path needs it by name), so it always
// resolves to the fixed Hit/Miss scheme — but a user who picks "Scalar" for it
// is asking to see the raw 0/1 as a gradient with a numeric legend. This set
// suppresses the registered scheme for those slugs so categoricalSchemeFor
// returns null and the continuous-gradient path runs. Same process-wide,
// additive, slug-keyed model as DYNAMIC_CATEGORICAL; rehydrated from each
// cloud's OctreeRef.continuousAttributes at import/restore. If two clouds
// disagree on the same slug, continuous wins (a registered scheme reappearing
// would surprise the user who explicitly chose Scalar).
const FORCE_CONTINUOUS = new Set<string>();

// Mark `slug` as continuous (import wizard "Scalar" over a registered scheme).
// Idempotent. Also clears any categorical registration for the slug so the two
// sets can't both claim it.
export function registerContinuousSlug(slug: string | undefined | null): void {
  if (!slug) return;
  const key = slug.toLowerCase();
  FORCE_CONTINUOUS.add(key);
  DYNAMIC_CATEGORICAL.delete(key);
}

export function unregisterContinuousSlug(slug: string | undefined | null): void {
  if (!slug) return;
  FORCE_CONTINUOUS.delete(slug.toLowerCase());
}

// True for attributes whose categorical scheme is generated from the data range
// rather than registered with a fixed class list: the built-in tree_instance,
// plus any slug a user marked categorical in the import wizard. Callers build
// the scheme from the attribute's observed [min,max] via categoricalSchemeForRange.
export function isDynamicCategoricalAttribute(attribute: string | undefined | null): boolean {
  if (!attribute) return false;
  const key = attribute.toLowerCase();
  if (FORCE_CONTINUOUS.has(key)) return false;
  return key === TREE_INSTANCE_ATTRIBUTE || DYNAMIC_CATEGORICAL.has(key);
}

// Resolve a categorical scheme for an attribute, generating it from `range`
// (the attribute's [min,max]) when the attribute is dynamic. tree_instance uses
// its dedicated Tree-N scheme; a wizard-marked field uses the generic Class-N
// scheme. Static registered schemes (ground_class, is_miss) fall through
// unchanged.
//
// A REGISTERED scheme always wins over the generic Class-N path, even when the
// user marked the column categorical ("Label") in the import wizard. A known
// semantic field like is_miss carries fixed domain labels (Hit/Miss); routing
// it through the generic path would discard those for neutral "Class N" — and
// worse, since the octree is built hits-only its observed range is [0,0], so
// the generic path would collapse to a single bogus "Class 0". Honour the
// registered scheme so "Label" never degrades a known field below "Scalar".
export function categoricalSchemeForRange(
  attribute: string | undefined | null,
  range: [number, number] | undefined | null,
): CategoricalScheme | null {
  if (!attribute) return categoricalSchemeFor(attribute);
  const key = attribute.toLowerCase();
  // Explicit "Scalar" override wins over EVERY categorical path (registered,
  // tree_instance, and the generic wizard-marked one) — the user asked for a
  // gradient, so report no scheme and let the continuous path run.
  if (FORCE_CONTINUOUS.has(key)) return null;
  if (key === TREE_INSTANCE_ATTRIBUTE) {
    const maxId = range ? range[1] : 0;
    return buildTreeInstanceScheme(maxId);
  }
  const registered = categoricalSchemeFor(attribute);
  if (registered) return registered;
  if (DYNAMIC_CATEGORICAL.has(key)) {
    return buildGenericCategoricalScheme(attribute, range ?? null);
  }
  return null;
}

// Return the categorical scheme for an attribute, or null if it should use the
// continuous-gradient path. Matching is case-insensitive on the slug; an
// attribute label like "Ground Class" still maps via its slug `ground_class`.
export function categoricalSchemeFor(attribute: string | undefined | null): CategoricalScheme | null {
  if (!attribute) return null;
  const key = attribute.toLowerCase();
  // A slug the user forced to continuous ("Scalar") suppresses its registered
  // scheme so the renderer falls through to the gradient path with a numeric
  // legend, honouring the explicit choice over the by-name default.
  if (FORCE_CONTINUOUS.has(key)) return null;
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
