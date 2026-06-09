import { describe, expect, it } from 'vitest';
import {
  anyTargetVisible,
  buildDeleteLabel,
  resolveDeleteIds,
  resolveTargets,
} from './bulkActions';

const items = [
  { id: 'a', visible: true },
  { id: 'b', visible: false },
  { id: 'c', visible: true },
];

describe('resolveTargets', () => {
  it('targets every item when nothing is selected', () => {
    const { targetIds } = resolveTargets(items, new Set());
    expect(targetIds).toEqual(['a', 'b', 'c']);
  });

  it('targets only the selection when one exists', () => {
    const { targetIds } = resolveTargets(items, new Set(['a', 'c']));
    expect(targetIds).toEqual(['a', 'c']);
  });

  it('hides everything when any target is visible (mixed visibility)', () => {
    const { nextVisible } = resolveTargets(items, new Set());
    expect(nextVisible).toBe(false);
  });

  it('shows everything only when all targets are hidden', () => {
    const allHidden = [
      { id: 'a', visible: false },
      { id: 'b', visible: false },
    ];
    expect(resolveTargets(allHidden, new Set()).nextVisible).toBe(true);
  });

  it('decides show/hide over the selection, not the whole list', () => {
    // b is hidden; selecting only b should show it even though a/c are visible.
    expect(resolveTargets(items, new Set(['b'])).nextVisible).toBe(true);
  });

  it('returns no targets for an empty list', () => {
    const { targetIds, nextVisible } = resolveTargets([], new Set());
    expect(targetIds).toEqual([]);
    expect(nextVisible).toBe(true); // some([]) === false → !false
  });
});

describe('anyTargetVisible', () => {
  it('reflects the whole section when nothing is selected', () => {
    expect(anyTargetVisible(items, new Set())).toBe(true);
  });

  it('reflects only the selection', () => {
    expect(anyTargetVisible(items, new Set(['b']))).toBe(false);
    expect(anyTargetVisible(items, new Set(['a', 'b']))).toBe(true);
  });
});

describe('resolveDeleteIds', () => {
  it('deletes everything when nothing is selected', () => {
    expect(resolveDeleteIds(items, new Set())).toEqual(['a', 'b', 'c']);
  });

  it('deletes only the selection when one exists', () => {
    expect(resolveDeleteIds(items, new Set(['b', 'c']))).toEqual(['b', 'c']);
  });
});

describe('buildDeleteLabel', () => {
  it('uses the single name for one id', () => {
    expect(buildDeleteLabel(['a'], 'scan_01.las', 'scans')).toBe('scan_01.las');
  });

  it('uses the count plus plural noun for a batch', () => {
    expect(buildDeleteLabel(['a', 'b', 'c'], 'ignored', 'scans')).toBe('3 scans');
    expect(buildDeleteLabel(['a', 'b'], 'ignored', 'meshes')).toBe('2 meshes');
  });
});
