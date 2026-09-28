import { describe, it, expect } from 'vitest';
import type { ClassPalette } from './classPalettes';
import { instancePrefix, withNewInstance, WHOLE_CLOUD } from './instances';
import { treeInstanceColor } from './classification';

// Non-contiguous ids, as a real segmentation leaves them.
const trees: ClassPalette = {
  id: 'p', name: 'Trees', slug: 'tree_instance', derived: true, updatedAt: 0,
  classes: [
    { value: 0, label: 'Unassigned', color: [0.5, 0.5, 0.5] },
    { value: 3, label: 'Tree 3', color: [1, 0, 0] },
    { value: 17, label: 'Tree 17', color: [0, 1, 0] },
    { value: 9, label: 'Big one', color: [0, 0, 1] },
  ],
};

describe('instancePrefix', () => {
  it('follows the naming the column already uses', () => {
    expect(instancePrefix(trees)).toBe('Tree');
  });
  it('falls back to Instance', () => {
    expect(instancePrefix({ ...trees, classes: [trees.classes[0], trees.classes[3]] })).toBe('Instance');
  });
});

describe('withNewInstance', () => {
  it('takes the id after the highest in use, named and colored like its siblings', () => {
    const { palette, value } = withNewInstance(trees);
    expect(value).toBe(18);
    const added = palette.classes.find((c) => c.value === 18)!;
    expect(added.label).toBe('Tree 18');
    expect(added.color).toEqual(treeInstanceColor(18));
    expect(palette.classes).toHaveLength(5);
    expect(trees.classes).toHaveLength(4);   // not mutated
  });
  it('starts at 1 on an empty instance column', () => {
    const empty = { ...trees, classes: [trees.classes[0]] };
    expect(withNewInstance(empty).value).toBe(1);
  });
});

it('WHOLE_CLOUD covers any real coordinate', () => {
  const r = WHOLE_CLOUD as { kind: 'box'; min: number[]; max: number[] };
  expect(r.min.every((v) => v < -1e20) && r.max.every((v) => v > 1e20)).toBe(true);
});
