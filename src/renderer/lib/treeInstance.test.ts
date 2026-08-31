import { describe, it, expect } from 'vitest';
import {
  TREE_INSTANCE_ATTRIBUTE,
  treeInstanceColor,
  buildTreeInstanceScheme,
  isDynamicCategoricalAttribute,
  isCategoricalAttribute,
  categoricalSchemeForRange,
  categoricalSchemeForCloud,
  buildTreeInstanceSchemeFromValues,
  colorForClassValue,
} from './classification';

const isRgb = (c: number[]) =>
  c.length === 3 && c.every((v) => v >= 0 && v <= 1);

describe('tree instance palette', () => {
  it('maps id 0 to a muted gray and ids >=1 to valid colors', () => {
    const zero = treeInstanceColor(0);
    expect(isRgb(zero)).toBe(true);
    // gray: channels roughly equal
    expect(Math.max(...zero) - Math.min(...zero)).toBeLessThan(0.05);
    for (let i = 1; i <= 50; i++) expect(isRgb(treeInstanceColor(i))).toBe(true);
  });

  it('is deterministic', () => {
    expect(treeInstanceColor(7)).toEqual(treeInstanceColor(7));
  });

  it('gives visually distinct colors to consecutive ids', () => {
    // Golden-angle hue rotation -> adjacent ids differ noticeably.
    const dist = (a: number[], b: number[]) =>
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    for (let i = 1; i < 12; i++) {
      expect(dist(treeInstanceColor(i), treeInstanceColor(i + 1))).toBeGreaterThan(0.1);
    }
  });

  it('builds a scheme covering 0..maxId with one class per id', () => {
    const scheme = buildTreeInstanceScheme(5);
    expect(scheme.attribute).toBe(TREE_INSTANCE_ATTRIBUTE);
    expect(scheme.classes.map((c) => c.value)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(scheme.classes[0].label).toBe('Unassigned');
    expect(scheme.classes[3].label).toBe('Tree 3');
    // colorForClassValue resolves a generated class color (round-trips floats).
    expect(colorForClassValue(scheme, 3.0)).toEqual(treeInstanceColor(3));
  });

  it('treats tree_instance as dynamic categorical', () => {
    expect(isDynamicCategoricalAttribute('tree_instance')).toBe(true);
    expect(isDynamicCategoricalAttribute('TREE_INSTANCE')).toBe(true);
    expect(isDynamicCategoricalAttribute('ground_class')).toBe(false);
    expect(isCategoricalAttribute('tree_instance')).toBe(true);
  });

  it('categoricalSchemeForRange generates from range for tree_instance', () => {
    const scheme = categoricalSchemeForRange('tree_instance', [0, 4]);
    expect(scheme).not.toBeNull();
    expect(scheme!.classes.length).toBe(5);
    // static attribute still resolves via the registry, ignoring range
    const ground = categoricalSchemeForRange('ground_class', [1, 2]);
    expect(ground?.attribute).toBe('ground_class');
  });
});

// Regression: after filtering a plot down to a subset of tree instances, the
// panel kept listing classes that no longer owned a single point — which reads
// as "the filter didn't run". The class list must come from the backend's
// observed values, because a [min,max] pair cannot express either a non-zero
// floor or a gap.
describe('tree instance scheme from observed values', () => {
  it('lists ONLY the surviving class after filtering to one tree', () => {
    // The reported case: keep Tree 3, backend reports range [3,3] + values [3].
    const scheme = categoricalSchemeForRange('tree_instance', [3, 3], [3]);
    expect(scheme!.classes.map((c) => c.value)).toEqual([3]);
    expect(scheme!.classes.map((c) => c.label)).toEqual(['Tree 3']);
  });

  it('honours GAPS, which no min/max pair can express', () => {
    // Keep Trees 1 and 3: the range is [1,3], so any range-derived list
    // resurrects Tree 2.
    const scheme = categoricalSchemeForRange('tree_instance', [1, 3], [1, 3]);
    expect(scheme!.classes.map((c) => c.value)).toEqual([1, 3]);
  });

  it('keeps each class colour keyed to its id, not its position', () => {
    // A surviving tree must not change colour because its siblings were
    // filtered away.
    const before = categoricalSchemeForRange('tree_instance', [0, 3], [0, 1, 2, 3]);
    const after = categoricalSchemeForRange('tree_instance', [3, 3], [3]);
    const colorOf = (s: typeof before, v: number) =>
      s!.classes.find((c) => c.value === v)!.color;
    expect(colorOf(after, 3)).toEqual(colorOf(before, 3));
  });

  it('falls back to the range enumeration when no observed list is given', () => {
    // Octree metadata not produced by a live session carries no observed values.
    const scheme = categoricalSchemeForRange('tree_instance', [0, 2]);
    expect(scheme!.classes.map((c) => c.value)).toEqual([0, 1, 2]);
    // An empty list is "unknown", not "no classes" — same fallback.
    expect(categoricalSchemeForRange('tree_instance', [0, 2], [])!.classes.length).toBe(3);
  });

  it('dedupes and sorts a raw observed list', () => {
    const scheme = buildTreeInstanceSchemeFromValues([3, 1, 3, 1, 0]);
    expect(scheme.classes.map((c) => c.value)).toEqual([0, 1, 3]);
  });

  it('threads observed values through the per-cloud resolver', () => {
    const scheme = categoricalSchemeForCloud('tree_instance', [3, 3], undefined, [3]);
    expect(scheme!.classes.map((c) => c.value)).toEqual([3]);
  });

  it('lets a user palette outrank observed values', () => {
    // The palette is the list the user authored; hiding a class merely because
    // no point currently carries it would make the legend flicker while painting.
    const palettes = {
      manual_class: {
        slug: 'manual_class',
        classes: [
          { value: 0, label: 'Leaf', color: [0, 1, 0] as [number, number, number] },
          { value: 1, label: 'Wood', color: [1, 0, 0] as [number, number, number] },
        ],
      },
    };
    const scheme = categoricalSchemeForCloud('manual_class', [0, 0], palettes, [0]);
    expect(scheme!.classes.map((c) => c.label)).toEqual(['Leaf', 'Wood']);
  });
});
