import { describe, expect, it } from 'vitest';
import {
  GROUND_CLASS_ATTRIBUTE,
  buildCategoricalGradientStops,
  buildGenericCategoricalScheme,
  categoricalSchemeFor,
  categoricalSchemeForRange,
  colorForClassValue,
  isCategoricalAttribute,
  registerCategoricalSlug,
  unregisterCategoricalSlug,
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
