import { describe, it, expect } from 'vitest';

import {
  diffTargets, idsOfKind, parseTargetKey, pruneTargets, seedTransformTargets, targetKey, transformPickerItems,
} from './transformTargets';

describe('seedTransformTargets', () => {
  const base = { cloudIds: ['c1', 'c2'], meshIds: ['m1', 'm2'] };

  it('checks NOTHING when nothing is selected', () => {
    // Every other picker tool checks all eligible inputs on an empty selection;
    // a cloud transform bake cannot be undone, so this one must not.
    expect(seedTransformTargets({ ...base, selectedScanIds: [], selectedMeshIds: [] }).size).toBe(0);
  });

  it('checks the selected clouds and meshes together', () => {
    const got = seedTransformTargets({ ...base, selectedScanIds: ['c2'], selectedMeshIds: ['m1'] });
    expect([...got].sort()).toEqual(['cloud:c2', 'mesh:m1']);
  });

  it('leaves out a selected param-only scanner marker and stale ids', () => {
    const got = seedTransformTargets({ ...base, selectedScanIds: ['marker', 'c1', 'gone'], selectedMeshIds: ['old'] });
    expect([...got]).toEqual(['cloud:c1']);
  });
});

describe('keys', () => {
  it('round-trips and keeps the two id spaces apart', () => {
    expect(parseTargetKey(targetKey('mesh', 'a:b'))).toEqual({ kind: 'mesh', id: 'a:b' });
    expect(parseTargetKey('bogus')).toBeNull();
    expect(parseTargetKey('skeleton:x')).toBeNull();
    const keys = [targetKey('cloud', 'same'), targetKey('mesh', 'same')];
    expect(idsOfKind(keys, 'cloud')).toEqual(['same']);
    expect(idsOfKind(keys, 'mesh')).toEqual(['same']);
  });

  it('diffTargets reports additions and removals', () => {
    expect(diffTargets(new Set(['a', 'b']), new Set(['b', 'c']))).toEqual({ added: ['c'], removed: ['a'] });
  });

  it('pruneTargets drops objects that no longer exist', () => {
    const got = pruneTargets(new Set(['cloud:c1', 'cloud:c9', 'mesh:m1', 'mesh:m9']), ['c1'], ['m1']);
    expect([...got]).toEqual(['cloud:c1', 'mesh:m1']);
  });
});

describe('transformPickerItems', () => {
  it('lists clouds first, then meshes, with kind-prefixed ids', () => {
    const items = transformPickerItems(
      [{ id: 'c1', label: 'tree', color: '#f00', pointCount: 1234 }],
      [{ id: 'm1', label: 'cube', disabledReason: 'nope' }],
    );
    expect(items.map(i => i.id)).toEqual(['cloud:c1', 'mesh:m1']);
    expect(items[0].detail).toBe(`cloud · ${(1234).toLocaleString()} pts`);
    expect(items[1].detail).toBe('mesh');
    expect(items[1].disabledReason).toBe('nope');
  });
});
