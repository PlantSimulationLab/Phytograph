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

// Registry of known categorical schemes, keyed by attribute slug. Future
// classifications (organ type, semantic labels, …) register here and get
// discrete coloring + a legend for free.
const SCHEMES: Record<string, CategoricalScheme> = {
  [GROUND_CLASS_ATTRIBUTE]: GROUND_SCHEME,
};

// Return the categorical scheme for an attribute, or null if it should use the
// continuous-gradient path. Matching is case-insensitive on the slug; an
// attribute label like "Ground Class" still maps via its slug `ground_class`.
export function categoricalSchemeFor(attribute: string | undefined | null): CategoricalScheme | null {
  if (!attribute) return null;
  const key = attribute.toLowerCase();
  return SCHEMES[key] ?? null;
}

export function isCategoricalAttribute(attribute: string | undefined | null): boolean {
  return categoricalSchemeFor(attribute) !== null;
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
