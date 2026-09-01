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

// Exported so the labelling tool's ground preset is the same class list the
// segmentation writes — one vocabulary for machine and hand classification.
export const GROUND_SCHEME_CLASSES: ClassDef[] = [
  { value: 1, label: 'Ground', color: [0.55, 0.40, 0.26] },
  { value: 2, label: 'Non-ground', color: [0.30, 0.69, 0.31] },
];

const GROUND_SCHEME: CategoricalScheme = {
  attribute: GROUND_CLASS_ATTRIBUTE,
  classes: GROUND_SCHEME_CLASSES,
};

// Wood/leaf classification (segment_wood writes `wood_class`): 1 = wood
// (trunk/branches), 2 = leaf. Dark woody brown for wood, leaf green for leaf —
// distinct from the ground scheme's lighter earth/green so the two are not
// confused when both are present.
export const WOOD_CLASS_ATTRIBUTE = 'wood_class';

// Exported so the manual-labelling tool's "Wood / leaf" preset palette is
// literally the same class list the automatic segmentation writes — a user
// correcting segment_wood's output by hand works in one vocabulary, and a
// colour tweak here can never leave the two out of sync.
export const WOOD_SCHEME_CLASSES: ClassDef[] = [
  { value: 1, label: 'Wood', color: [0.40, 0.26, 0.13] },
  { value: 2, label: 'Leaf', color: [0.30, 0.69, 0.31] },
];

const WOOD_SCHEME: CategoricalScheme = {
  attribute: WOOD_CLASS_ATTRIBUTE,
  classes: WOOD_SCHEME_CLASSES,
};

// Noise classification (the Filter panel's Noise section writes `noise_class`):
// 1 = clean, 2 = noise. Deliberately only two classes so the panel's categorical
// checkbox UI stays a single "keep clean / keep noise" choice.
//
// Muted grey for clean and a hot red for noise, because the whole point of the
// Detect step is that the flagged points POP against the rest of the cloud —
// this colouring IS the preview the user judges before committing a removal.
// Nothing else in the registry uses saturated red.
export const NOISE_CLASS_ATTRIBUTE = 'noise_class';

// The two class values, named so no call site writes a bare 1/2. They must match
// NOISE_CLEAN / NOISE_NOISE in backend-api/denoise.py.
export const NOISE_CLEAN = 1;
export const NOISE_NOISE = 2;

export const NOISE_SCHEME_CLASSES: ClassDef[] = [
  { value: NOISE_CLEAN, label: 'Clean', color: [0.55, 0.55, 0.58] },
  { value: NOISE_NOISE, label: 'Noise', color: [0.90, 0.20, 0.20] },
];

const NOISE_SCHEME: CategoricalScheme = {
  attribute: NOISE_CLASS_ATTRIBUTE,
  classes: NOISE_SCHEME_CLASSES,
};

// Tree instance segmentation (TreeIso) writes a `tree_instance` attribute:
// 0 = unassigned, 1..N = individual trees. Unlike ground_class, N is unbounded
// and only known at runtime, so this scheme is GENERATED from the data's id
// range rather than registered as a fixed class list. Each id gets a distinct,
// repeating, perceptually-spaced color via the golden-angle hue rotation;
// id 0 ("unassigned") is a muted gray.
export const TREE_INSTANCE_ATTRIBUTE = 'tree_instance';

// Dark gray, deliberately OUTSIDE the tree palette's lightness band (trees are
// saturated hues at L≈0.50–0.62). A medium gray reads as just a desaturated
// tree; going much darker makes "unassigned"/ground stand out as clearly
// not-a-tree in the tree_instance colouring.
const TREE_UNASSIGNED_COLOR: RGB = [0.22, 0.22, 0.22];
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

// Build a tree-instance scheme over an EXACT list of surviving ids. Preferred
// over buildTreeInstanceScheme whenever the backend reported observed classes:
// the 0..max enumeration above cannot represent a filtered cloud (keeping only
// Tree 3 must list Tree 3 alone, not Unassigned/Tree 1/Tree 2/Tree 3), and no
// [min,max] pair can represent the gap left by keeping Trees 1 and 3.
// Colours stay keyed to the id, so a class's colour never shifts when its
// siblings are filtered away.
export function buildTreeInstanceSchemeFromValues(values: readonly number[]): CategoricalScheme {
  const ids = Array.from(new Set(values.map((v) => Math.round(v)))).sort((a, b) => a - b);
  return {
    attribute: TREE_INSTANCE_ATTRIBUTE,
    classes: ids.map((i) => ({
      value: i,
      label: i === 0 ? 'Unassigned' : `Tree ${i}`,
      color: treeInstanceColor(i),
    })),
  };
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

// Generic wizard-marked scheme over an EXACT list of surviving values — the
// gap-safe counterpart of buildGenericCategoricalScheme, for the same reason
// buildTreeInstanceSchemeFromValues exists.
export function buildGenericCategoricalSchemeFromValues(
  attribute: string,
  values: readonly number[],
): CategoricalScheme {
  const vals = Array.from(new Set(values.map((v) => Math.round(v))))
    .sort((a, b) => a - b)
    .slice(0, GENERIC_CATEGORICAL_MAX_CLASSES);
  return {
    attribute,
    classes: vals.map((v) => ({
      value: v,
      label: `Class ${v}`,
      color: treeInstanceColor(v),
    })),
  };
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

// Exported so the labelling tool's "Plant organs" preset reuses these exact
// values and colours. That makes hand labels directly comparable with the
// organ tags a Helios synthetic scan carries — one vocabulary for measured and
// simulated ground truth.
export const ORGAN_SCHEME_CLASSES: ClassDef[] = [
  { value: 0, label: 'Unknown', color: [0.55, 0.55, 0.55] },
  { value: 1, label: 'Leaf', color: [0.30, 0.69, 0.31] },
  { value: 2, label: 'Petiole', color: [0.65, 0.72, 0.30] },
  { value: 3, label: 'Shoot', color: [0.45, 0.30, 0.15] },
  { value: 4, label: 'Peduncle', color: [0.78, 0.60, 0.32] },
  { value: 5, label: 'Fruit', color: [0.82, 0.26, 0.24] },
  { value: 6, label: 'Petiolule', color: [0.40, 0.60, 0.45] },
];

const ORGAN_SCHEME: CategoricalScheme = {
  attribute: ORGAN_ATTRIBUTE,
  classes: ORGAN_SCHEME_CLASSES,
};

// A LAS file's own `classification` byte, carried in by the importer under the
// `las_` prefix (the bare name would collide with a reserved LAS dimension and
// crash laspy on export — see main.py's _LAS_STD_DIMS note).
//
// Registering the ASPRS 1.4 standard classes here is what turns an imported
// file's classes from "Class 5" into "High Vegetation" in the legend and the
// class-filter checkboxes. Colours follow Potree's ClassificationScheme, which
// is the convention users will recognise from other LiDAR tools — brown ground,
// a three-shade green vegetation ramp.
//
// Codes 8 and 12 are Reserved in LAS 1.4: their old meanings (Model Key-point,
// Overlap) moved to per-point FLAGS, which are orthogonal to the class code.
// The class list is shared with the labelling tool's ASPRS preset palette
// (lib/classPalettes.ts) so the two can never drift apart.
export const LAS_CLASSIFICATION_ATTRIBUTE = 'las_classification';

export const ASPRS_CLASS_LIST: ClassDef[] = [
  { value: 0, label: 'Never Classified', color: [0.50, 0.50, 0.50] },
  { value: 1, label: 'Unassigned', color: [0.60, 0.60, 0.60] },
  { value: 2, label: 'Ground', color: [0.63, 0.32, 0.18] },
  { value: 3, label: 'Low Vegetation', color: [0.00, 1.00, 0.00] },
  { value: 4, label: 'Medium Vegetation', color: [0.00, 0.80, 0.00] },
  { value: 5, label: 'High Vegetation', color: [0.00, 0.60, 0.00] },
  { value: 6, label: 'Building', color: [1.00, 0.66, 0.00] },
  { value: 7, label: 'Low Point (Noise)', color: [1.00, 0.00, 1.00] },
  { value: 8, label: 'Reserved', color: [0.55, 0.55, 0.55] },
  { value: 9, label: 'Water', color: [0.00, 0.00, 1.00] },
  { value: 10, label: 'Rail', color: [0.40, 0.20, 0.60] },
  { value: 11, label: 'Road Surface', color: [0.35, 0.35, 0.35] },
  { value: 12, label: 'Reserved', color: [0.55, 0.55, 0.55] },
  { value: 13, label: 'Wire — Guard', color: [0.90, 0.90, 0.20] },
  { value: 14, label: 'Wire — Conductor', color: [0.90, 0.70, 0.20] },
  { value: 15, label: 'Transmission Tower', color: [0.70, 0.50, 0.30] },
  { value: 16, label: 'Wire Connector', color: [0.80, 0.80, 0.50] },
  { value: 17, label: 'Bridge Deck', color: [0.50, 0.30, 0.70] },
  { value: 18, label: 'High Noise', color: [1.00, 0.20, 0.60] },
];

const LAS_CLASSIFICATION_SCHEME: CategoricalScheme = {
  attribute: LAS_CLASSIFICATION_ATTRIBUTE,
  classes: ASPRS_CLASS_LIST,
};

// Registry of known categorical schemes, keyed by attribute slug. Future
// classifications (semantic labels, …) register here and get discrete coloring
// + a legend for free.
const SCHEMES: Record<string, CategoricalScheme> = {
  [GROUND_CLASS_ATTRIBUTE]: GROUND_SCHEME,
  [WOOD_CLASS_ATTRIBUTE]: WOOD_SCHEME,
  [NOISE_CLASS_ATTRIBUTE]: NOISE_SCHEME,
  [MISS_ATTRIBUTE]: MISS_SCHEME,
  [ORGAN_ATTRIBUTE]: ORGAN_SCHEME,
  [LAS_CLASSIFICATION_ATTRIBUTE]: LAS_CLASSIFICATION_SCHEME,
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
  // The attribute's EXACT surviving values, when the backend reported them
  // (octree.observedClasses). Always preferred over `range` for a dynamic
  // scheme: a range cannot express gaps and its floor is not the lowest
  // surviving class, so a filtered cloud otherwise lists classes that own no
  // points. Omitted/empty falls back to the range-derived enumeration.
  observed?: readonly number[] | null,
): CategoricalScheme | null {
  if (!attribute) return categoricalSchemeFor(attribute);
  const key = attribute.toLowerCase();
  // Explicit "Scalar" override wins over EVERY categorical path (registered,
  // tree_instance, and the generic wizard-marked one) — the user asked for a
  // gradient, so report no scheme and let the continuous path run.
  if (FORCE_CONTINUOUS.has(key)) return null;
  const haveObserved = !!observed && observed.length > 0;
  if (key === TREE_INSTANCE_ATTRIBUTE) {
    if (haveObserved) return buildTreeInstanceSchemeFromValues(observed!);
    const maxId = range ? range[1] : 0;
    return buildTreeInstanceScheme(maxId);
  }
  const registered = categoricalSchemeFor(attribute);
  if (registered) return registered;
  if (DYNAMIC_CATEGORICAL.has(key)) {
    return haveObserved
      ? buildGenericCategoricalSchemeFromValues(attribute, observed!)
      : buildGenericCategoricalScheme(attribute, range ?? null);
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

// The manual labelling tool's column. Declared here (rather than only in
// classPalettes.ts) so the resolution helpers can special-case it, and MIRRORED
// from MANUAL_CLASS_SLUG in backend-api/main.py — keep them in sync.
export const MANUAL_CLASS_ATTRIBUTE = 'manual_class';

/**
 * Resolve a categorical scheme for an attribute ON A SPECIFIC CLOUD, honouring
 * that cloud's user-defined palette.
 *
 * Why this exists as a separate, additive function rather than a change to
 * `categoricalSchemeForRange`: the three registries above (`SCHEMES`,
 * `DYNAMIC_CATEGORICAL`, `FORCE_CONTINUOUS`) are module-level and therefore
 * PROCESS-WIDE. That is fine for by-name defaults and even for the import
 * wizard's flags — the file already documents its global-winner tie-break for
 * those ("if two clouds disagree on the same slug, continuous wins").
 *
 * It is NOT fine for user palettes. Two clouds with different palettes bound to
 * `manual_class` is the normal case, not an edge case: a rose labelled with
 * organ classes and a plot labelled with ASPRS classes, both open at once. A
 * process-wide Set can only pick one winner and would silently mis-colour the
 * other cloud's points and legend. So the palette is threaded explicitly from
 * the cloud that owns it.
 *
 * Resolution order — the palette sits immediately after the explicit
 * "show me a gradient" override and before every by-name default, because a
 * palette the user attached to THIS cloud is a more explicit statement than any
 * default keyed on the slug:
 *
 *   FORCE_CONTINUOUS → user palette → tree_instance → SCHEMES → generic → null
 *
 * `categoricalSchemeForRange` remains the unchanged fallback tail, so every
 * existing call site keeps working and consumers migrate incrementally.
 */
export function categoricalSchemeForCloud(
  attribute: string | undefined | null,
  range: [number, number] | undefined | null,
  palettes: Record<string, { slug: string; classes: ClassDef[] }> | undefined | null,
  // This cloud's exact surviving values for the attribute, when known. A user
  // palette still outranks it: the palette is the class list the user AUTHORED,
  // and hiding one of its classes because the current cloud happens to have no
  // points in it would make the legend flicker as they paint.
  observed?: readonly number[] | null,
): CategoricalScheme | null {
  if (!attribute) return null;
  const key = attribute.toLowerCase();
  if (FORCE_CONTINUOUS.has(key)) return null;
  const palette = palettes?.[key];
  if (palette && palette.classes.length > 0) {
    return { attribute: key, classes: palette.classes };
  }
  return categoricalSchemeForRange(attribute, range, observed);
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

// sRGB 0-1 triple → "#rrggbb". Lives here (rather than in each consumer) so the
// scan-swatch hexes and the rendered point colors are produced by one function.
export function rgbToHex([r, g, b]: readonly [number, number, number]): string {
  const to255 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const h = (v: number) => to255(v).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// The swatch hex for a fixed categorical class — so a child cloud split out by
// class (ground/non-ground, wood/leaf) carries exactly the colour the viewer
// paints that class, and a scheme tweak can never leave the two out of sync.
// Returns null for a slug with no registered scheme, so callers can fall back.
export function classColorHex(attribute: string, value: number): string | null {
  const scheme = categoricalSchemeFor(attribute);
  if (!scheme) return null;
  return rgbToHex(colorForClassValue(scheme, value));
}

// potree-core bakes the stop array into a 64-texel CanvasGradient sampled with
// LinearFilter, and the shader samples class value v at t = (v-lo)/span. Two
// failure modes to avoid:
//   (a) a band narrower than a texel gets averaged away — its colour bleeds
//       into the neighbour;
//   (b) widening bands so they OVERLAP is worse: after the stops are sorted by
//       t, a later class's stop at the same offset overwrites the earlier one,
//       so a class can be emitted yet buried.
// The edge class matters most here: ground is tree_instance 0, sampled at
// t = 0. With many classes (tree_instance over [0, 86]) its natural band is a
// sub-texel sliver, so it read as Tree 1's colour instead of grey.
const GRADIENT_TEXELS = 64; // potree-core canvas width (must match its bake)

// Build a STEP gradient (array of [t, RGB] stops in 0..1) for the potree
// INTENSITY_GRADIENT pipeline, given the value range [min,max] the octree
// reports for the attribute. Bands are laid out as NON-OVERLAPPING cells: each
// class owns [midpoint-with-prev, midpoint-with-next] in t-space, so sampling
// value v at t = (v-lo)/span always lands in v's own cell (no interpolation
// across class boundaries, and — unlike a widen-and-clamp scheme — no cell ever
// overwrites its neighbour).
//
// The first and last cells are additionally guaranteed at least one texel of
// width against the texture edge, so the edge classes (value == lo at t=0,
// value == hi at t=1) survive the LinearFilter bake even when the range packs
// classes tighter than a texel apart. That is what keeps ground (id 0) grey.
//
// `range` is [min, max] of the attribute (e.g. [1, 2] for ground_class).
export function buildCategoricalGradientStops(
  scheme: CategoricalScheme,
  range: [number, number],
): Array<[number, RGB]> {
  const [lo, hi] = range;
  const span = hi - lo || 1;
  const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
  const EDGE_MIN = 1 / GRADIENT_TEXELS; // one texel, in 0..1 texture space
  // Classes sorted by value, keeping only those whose sample point lies within
  // the rendered range — e.g. a split sub-cloud holds only some class values.
  const cells = [...scheme.classes]
    .sort((a, b) => a.value - b.value)
    .map((cls) => ({ cls, tCenter: (cls.value - lo) / span }))
    .filter((c) => c.tCenter >= -1e-9 && c.tCenter <= 1 + 1e-9);
  if (cells.length === 0) return [[0, UNKNOWN_CLASS_COLOR], [1, UNKNOWN_CLASS_COLOR]];
  if (cells.length === 1) {
    // Single visible class fills the whole texture.
    return [[0, cells[0].cls.color], [1, cells[0].cls.color]];
  }
  // Cell boundaries: midpoints between adjacent sample points. Boundary i sits
  // between cell i and cell i+1; boundary 0 = 0, boundary N = 1.
  const bounds: number[] = [0];
  for (let i = 0; i < cells.length - 1; i++) {
    bounds.push(clamp01((cells[i].tCenter + cells[i + 1].tCenter) / 2));
  }
  bounds.push(1);
  // Guarantee the edge cells are at least one texel wide so they survive the
  // LinearFilter bake (nudge only the first inner boundary right / last left;
  // this cannot cross because there are ≥2 cells and EDGE_MIN is tiny).
  bounds[1] = Math.max(bounds[1], EDGE_MIN);
  bounds[bounds.length - 2] = Math.min(bounds[bounds.length - 2], 1 - EDGE_MIN);
  const stops: Array<[number, RGB]> = [];
  for (let i = 0; i < cells.length; i++) {
    const tStart = bounds[i];
    const tEnd = bounds[i + 1];
    if (tEnd <= tStart) continue; // squeezed to nothing by an interior neighbour
    // Hard edges: same colour at both ends of the cell.
    stops.push([tStart, cells[i].cls.color]);
    stops.push([tEnd, cells[i].cls.color]);
  }
  return stops;
}
