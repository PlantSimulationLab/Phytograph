import { describe, it, expect } from 'vitest';

import {
  exclusiveFlatTargets, seedFromSelection, diffTargets, idsOfKind, parseTargetKey, pruneTargets, seedTransformTargets, targetKey, transformPickerItems,
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

describe('seedFromSelection', () => {
  it('checks the selected eligible ids in list order, and nothing for an empty selection', () => {
    expect([...seedFromSelection(['a', 'b', 'c'], ['c', 'a', 'marker'])]).toEqual(['a', 'c']);
    expect(seedFromSelection(['a', 'b'], []).size).toBe(0);
  });
});

describe('exclusiveFlatTargets', () => {
  const flat = (id: string) => id.startsWith('f');
  const set = (...ids: string[]) => new Set(ids);

  it('lets any number of streamed clouds be checked together', () => {
    expect([...exclusiveFlatTargets(set('a'), set('a', 'b', 'c'), flat)]).toEqual(['a', 'b', 'c']);
  });
  it('makes a newly checked flat cloud the only target', () => {
    expect([...exclusiveFlatTargets(set('a', 'b'), set('a', 'b', 'f1'), flat)]).toEqual(['f1']);
  });
  it('drops a checked flat cloud when a streamed one is checked', () => {
    expect([...exclusiveFlatTargets(set('f1'), set('f1', 'a'), flat)]).toEqual(['a']);
  });
  it('seeds streamed clouds over flat ones, else the first flat one', () => {
    expect([...exclusiveFlatTargets(set(), set('f1', 'a', 'f2', 'b'), flat)]).toEqual(['a', 'b']);
    expect([...exclusiveFlatTargets(set(), set('f2', 'f1'), flat)]).toEqual(['f2']);
    expect(exclusiveFlatTargets(set(), set(), flat).size).toBe(0);
  });
});
