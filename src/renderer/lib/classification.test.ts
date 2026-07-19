import { describe, expect, it } from 'vitest';
import {
  GROUND_CLASS_ATTRIBUTE,
  MISS_ATTRIBUTE,
  MISS_COLOR,
  buildCategoricalGradientStops,
  buildGenericCategoricalScheme,
  categoricalSchemeFor,
  categoricalSchemeForRange,
  colorForClassValue,
  hasRegisteredScheme,
  isCategoricalAttribute,
  registerCategoricalSlug,
  registerContinuousSlug,
  unregisterCategoricalSlug,
  unregisterContinuousSlug,
} from './classification';

describe('categoricalSchemeFor', () => {
  it('returns the ground scheme for ground_class', () => {
    const scheme = categoricalSchemeFor(GROUND_CLASS_ATTRIBUTE);
    expect(scheme).not.toBeNull();
    expect(scheme!.classes.map((c) => c.label)).toEqual(['Ground', 'Non-ground']);
  });

  it('is case-insensitive on the slug', () => {
    expect(categoricalSchemeFor('Ground_Class')).not.toBeNull();
  });

  it('returns null for continuous / unknown attributes', () => {
    expect(categoricalSchemeFor('Reflectance_dB')).toBeNull();
    expect(categoricalSchemeFor(undefined)).toBeNull();
    expect(categoricalSchemeFor(null)).toBeNull();
  });
});

describe('isCategoricalAttribute', () => {
  it('flags ground_class but not arbitrary scalars', () => {
    expect(isCategoricalAttribute('ground_class')).toBe(true);
    expect(isCategoricalAttribute('intensity')).toBe(false);
  });
});

describe('organ scheme', () => {
  // Mirror of _ORGAN_LABEL_TO_CODE in backend-api/main.py; a static scheme so
  // the 'organ' scalar from a synthetic scan colors discretely with a legend on
  // both the flat and octree render paths, with no per-cloud registration.
  it('registers organ codes 0..6 with semantic labels', () => {
    const scheme = categoricalSchemeFor('organ');
    expect(scheme).not.toBeNull();
    expect(scheme!.classes.map((c) => c.value)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(scheme!.classes.map((c) => c.label)).toEqual([
      'Unknown', 'Leaf', 'Petiole', 'Shoot', 'Peduncle', 'Fruit', 'Petiolule',
    ]);
  });

  it('resolves via categoricalSchemeForRange and is a registered categorical attribute', () => {
    expect(categoricalSchemeForRange('organ', [0, 5])).not.toBeNull();
    expect(isCategoricalAttribute('organ')).toBe(true);
    expect(hasRegisteredScheme('Organ')).toBe(true); // case-insensitive
  });
});

describe('is_miss scheme', () => {
  it('registers a two-class Hit/Miss scheme', () => {
    const scheme = categoricalSchemeFor(MISS_ATTRIBUTE);
    expect(scheme).not.toBeNull();
    expect(scheme!.classes.map((c) => c.value)).toEqual([0, 1]);
    expect(scheme!.classes.map((c) => c.label)).toEqual(['Hit', 'Miss']);
  });

  it('is categorical and case-insensitive', () => {
    expect(isCategoricalAttribute('is_miss')).toBe(true);
    expect(categoricalSchemeFor('Is_Miss')).not.toBeNull();
  });

  it('paints misses in the distinct miss colour, hits in a different colour', () => {
    const scheme = categoricalSchemeFor(MISS_ATTRIBUTE)!;
    expect(colorForClassValue(scheme, 1)).toEqual(MISS_COLOR);
    expect(colorForClassValue(scheme, 0)).not.toEqual(MISS_COLOR);
  });

  // Regression: marking is_miss as "Label" in the import wizard registers it in
  // the dynamic-categorical set. categoricalSchemeForRange must still resolve to
  // the registered Hit/Miss scheme, NOT the generic Class-N path. Before the fix
  // the dynamic check ran first, and because the octree is hits-only the observed
  // range is [0,0], so the generic path collapsed to a single bogus "Class 0".
  it('keeps the Hit/Miss scheme even when registered as a wizard categorical', () => {
    registerCategoricalSlug(MISS_ATTRIBUTE);
    try {
      const scheme = categoricalSchemeForRange(MISS_ATTRIBUTE, [0, 0]);
      expect(scheme).not.toBeNull();
      expect(scheme!.classes.map((c) => c.label)).toEqual(['Hit', 'Miss']);
      // A range with actual misses resolves to the same fixed scheme, never Class-N.
      const withMisses = categoricalSchemeForRange(MISS_ATTRIBUTE, [0, 1]);
      expect(withMisses!.classes.map((c) => c.label)).toEqual(['Hit', 'Miss']);
    } finally {
      unregisterCategoricalSlug(MISS_ATTRIBUTE);
    }
  });
});

describe('colorForClassValue', () => {
  const scheme = categoricalSchemeFor('ground_class')!;

  it('maps each class value to its distinct color', () => {
    const ground = colorForClassValue(scheme, 1);
    const plant = colorForClassValue(scheme, 2);
    expect(ground).not.toEqual(plant);
  });

  it('rounds float32 round-tripped values to the nearest class', () => {
    // A 1.0 stored as float32 and read back may be 1.0000001; 2.0 likewise.
    expect(colorForClassValue(scheme, 1.0000001)).toEqual(colorForClassValue(scheme, 1));
    expect(colorForClassValue(scheme, 1.9999999)).toEqual(colorForClassValue(scheme, 2));
  });

  it('falls back to gray for unknown class values', () => {
    expect(colorForClassValue(scheme, 7)).toEqual([0.6, 0.6, 0.6]);
  });
});

describe('buildCategoricalGradientStops', () => {
  const scheme = categoricalSchemeFor('ground_class')!;

  it('builds a step gradient spanning the full 0..1 range', () => {
    const stops = buildCategoricalGradientStops(scheme, [1, 2]);
    expect(stops[0][0]).toBe(0);
    expect(stops[stops.length - 1][0]).toBe(1);
    // Stops should be monotonically non-decreasing in t.
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i][0]).toBeGreaterThanOrEqual(stops[i - 1][0]);
    }
  });

  it('renders each class as a flat band (hard, not interpolated, edges)', () => {
    const stops = buildCategoricalGradientStops(scheme, [1, 2]);
    // The midpoint t=0.5 (value 1.5, the class boundary) should be the seam:
    // a sample just below it is ground's color, just above is plant's.
    const ground = colorForClassValue(scheme, 1);
    const plant = colorForClassValue(scheme, 2);
    // Find the colors at the extremes of the gradient.
    expect(stops[0][1]).toEqual(ground);
    expect(stops[stops.length - 1][1]).toEqual(plant);
  });

  it('does not produce NaN stops for a degenerate range', () => {
    const stops = buildCategoricalGradientStops(scheme, [1, 1]);
    for (const [t] of stops) {
      expect(Number.isNaN(t)).toBe(false);
    }
  });

  // Regression: a split sub-cloud holds only one class, so the octree reports
  // a degenerate range like [2,2] (plant only). Stops must stay within [0,1] —
  // CanvasGradient.addColorStop throws on out-of-range t (this crashed the
  // viewer on split before the clamp fix).
  it('keeps all stop offsets within [0,1] for single-class ranges', () => {
    for (const range of [[1, 1], [2, 2]] as Array<[number, number]>) {
      const stops = buildCategoricalGradientStops(scheme, range);
      for (const [t] of stops) {
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(1);
      }
    }
  });

  // Regression (all-hits is_miss): the column is constant 0, so the renderer
  // widens the zero-width range [0,0] to [-1,1] so the shader's divisor isn't
  // zero — every point then samples the gradient at t = (0-(-1))/2 = 0.5. The
  // step gradient MUST be built against that SAME widened range, else t=0.5
  // lands on the Hit/Miss seam and every (hit) point picks up the Miss colour.
  // Built against [-1,1], the t=0.5 sample must fall inside the Hit band.
  it('samples a constant all-hits column as Hit when range is widened to [-1,1]', () => {
    const miss = categoricalSchemeFor(MISS_ATTRIBUTE)!;
    const stops = buildCategoricalGradientStops(miss, [-1, 1]);
    // Find the colour the gradient yields at t = 0.5 (the value every point maps
    // to). Walk the step stops: the colour is the last stop at or before 0.5.
    let sampled = stops[0][1];
    for (const [t, color] of stops) {
      if (t <= 0.5) sampled = color;
    }
    const hit = colorForClassValue(miss, 0);
    expect(sampled).toEqual(hit);
    expect(sampled).not.toEqual(MISS_COLOR);
  });

  // Regression (ground renders as a tree colour): after ground+tree
  // segmentation, ground points carry tree_instance 0 and are meant to show as
  // the grey "Unassigned" class. The octree bakes these stops into a 64-texel
  // LinearFilter texture and the shader samples value 0 at t=0 (the range is
  // [0, N]). Two ways this broke: (1) the original ±0.5 band gave class 0 only
  // a sub-texel sliver [0, 0.5/N] that averaged away; (2) a naive "widen every
  // band to ≥1 texel" fix made the bands OVERLAP for large N, so after sorting
  // by t the neighbouring tree stops overwrote the grey. The real case that hit
  // this was 87 tree classes over [0, 86]. The fix lays out non-overlapping
  // cells and guarantees the edge cell (id 0 at t=0) at least one texel.
  it.each([20, 86])('samples tree_instance 0 as grey with %i tree classes (non-overlapping)', (N) => {
    const scheme = categoricalSchemeForRange('tree_instance', [0, N])!;
    const stops = buildCategoricalGradientStops(scheme, [0, N]);
    const unassigned = colorForClassValue(scheme, 0);
    const tree1 = colorForClassValue(scheme, 1);
    // The colour a texel at t samples ≈ the last stop at or before t. Ground
    // points sample at t=0.
    const sampleAt = (t: number): typeof unassigned => {
      let c = stops[0][1];
      for (const [st, color] of stops) {
        if (st <= t) c = color;
      }
      return c;
    };
    // Ground (t=0) reads grey, not Tree 1.
    expect(sampleAt(0)).toEqual(unassigned);
    expect(sampleAt(0)).not.toEqual(tree1);
    // Stops are monotonic in t (CanvasGradient.addColorStop requires it).
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i][0]).toBeGreaterThanOrEqual(stops[i - 1][0]);
    }
    // Class 0 owns a full texel before the first non-grey stop appears — i.e.
    // its cell does not overlap Tree 1's (the bug that buried the grey).
    const firstNonGrey = stops.find(([, color]) =>
      JSON.stringify(color) !== JSON.stringify(unassigned),
    );
    expect(firstNonGrey![0]).toBeGreaterThanOrEqual(1 / 64 - 1e-9);
  });
});

describe('wizard-marked categorical fields (dynamic registry)', () => {
  it('treats a registered slug as categorical and builds a Class-N scheme', () => {
    const slug = 'my_label_field';
    expect(isCategoricalAttribute(slug)).toBe(false);
    registerCategoricalSlug(slug);
    try {
      expect(isCategoricalAttribute(slug)).toBe(true);
      const scheme = categoricalSchemeForRange(slug, [0, 3]);
      expect(scheme).not.toBeNull();
      expect(scheme!.classes.map((c) => c.value)).toEqual([0, 1, 2, 3]);
      expect(scheme!.classes.map((c) => c.label)).toEqual(['Class 0', 'Class 1', 'Class 2', 'Class 3']);
      // Distinct colors per class (golden-angle palette).
      const colors = scheme!.classes.map((c) => JSON.stringify(c.color));
      expect(new Set(colors).size).toBe(colors.length);
    } finally {
      unregisterCategoricalSlug(slug);
    }
    expect(isCategoricalAttribute(slug)).toBe(false);
  });

  it('registration is case-insensitive', () => {
    registerCategoricalSlug('MixedCaseSlug');
    try {
      expect(isCategoricalAttribute('mixedcaseslug')).toBe(true);
    } finally {
      unregisterCategoricalSlug('MixedCaseSlug');
    }
  });

  it('caps the generated class list for a pathological range', () => {
    const scheme = buildGenericCategoricalScheme('huge', [0, 100000]);
    expect(scheme.classes.length).toBeLessThanOrEqual(256);
  });

  it('ignores empty/nullish slugs', () => {
    registerCategoricalSlug('');
    registerCategoricalSlug(null);
    registerCategoricalSlug(undefined);
    expect(isCategoricalAttribute('')).toBe(false);
  });
});

describe('forced-continuous override (wizard "Scalar" over a registered scheme)', () => {
  it('hasRegisteredScheme is true only for statically registered slugs', () => {
    expect(hasRegisteredScheme(MISS_ATTRIBUTE)).toBe(true);
    expect(hasRegisteredScheme('Is_Miss')).toBe(true);
    expect(hasRegisteredScheme('ground_class')).toBe(true);
    expect(hasRegisteredScheme('some_random_field')).toBe(false);
    expect(hasRegisteredScheme(null)).toBe(false);
    expect(hasRegisteredScheme('')).toBe(false);
  });

  it('suppresses the registered Hit/Miss scheme so is_miss colours continuously', () => {
    // Sanity: by default is_miss is categorical with the Hit/Miss scheme.
    expect(categoricalSchemeFor(MISS_ATTRIBUTE)).not.toBeNull();
    registerContinuousSlug(MISS_ATTRIBUTE);
    try {
      // The static lookup, the range-aware resolver, and the predicate all now
      // report NON-categorical, so the renderer/legend take the gradient path.
      expect(categoricalSchemeFor(MISS_ATTRIBUTE)).toBeNull();
      expect(categoricalSchemeForRange(MISS_ATTRIBUTE, [0, 1])).toBeNull();
      expect(isCategoricalAttribute(MISS_ATTRIBUTE)).toBe(false);
    } finally {
      unregisterContinuousSlug(MISS_ATTRIBUTE);
    }
    // Unregistering restores the registered scheme.
    expect(categoricalSchemeFor(MISS_ATTRIBUTE)).not.toBeNull();
    expect(isCategoricalAttribute(MISS_ATTRIBUTE)).toBe(true);
  });

  it('continuous override wins even if the slug was also marked categorical', () => {
    // A later "Scalar" choice must override an earlier categorical registration;
    // registerContinuousSlug also clears the categorical set for the slug.
    registerCategoricalSlug('dual_field');
    registerContinuousSlug('dual_field');
    try {
      expect(isCategoricalAttribute('dual_field')).toBe(false);
      expect(categoricalSchemeForRange('dual_field', [0, 3])).toBeNull();
    } finally {
      unregisterContinuousSlug('dual_field');
      unregisterCategoricalSlug('dual_field');
    }
  });

  it('is case-insensitive and ignores empty/nullish slugs', () => {
    registerContinuousSlug('Is_Miss');
    try {
      expect(categoricalSchemeFor('is_miss')).toBeNull();
    } finally {
      unregisterContinuousSlug('Is_Miss');
    }
    registerContinuousSlug('');
    registerContinuousSlug(null);
    registerContinuousSlug(undefined);
    // is_miss is categorical again (no real slug was registered).
    expect(categoricalSchemeFor(MISS_ATTRIBUTE)).not.toBeNull();
  });
});
