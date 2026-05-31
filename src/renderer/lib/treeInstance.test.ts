import { describe, it, expect } from 'vitest';
import {
  TREE_INSTANCE_ATTRIBUTE,
  treeInstanceColor,
  buildTreeInstanceScheme,
  isDynamicCategoricalAttribute,
  isCategoricalAttribute,
  categoricalSchemeForRange,
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
