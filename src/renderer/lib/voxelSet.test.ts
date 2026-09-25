import { describe, it, expect } from 'vitest';
import contract from '../../shared/voxelSet.contract.json';
import { decodeVoxelKeys, voxelSetAabb, voxelSetPredicate, type VoxelSetRegion } from './voxelSet';

const region = contract.region as VoxelSetRegion;

describe('voxelSetPredicate — the shared contract', () => {
  // backend-api/tests/test_segment_pick.py asserts the same vectors against
  // _region_mask: the preview must label exactly what the session will.
  it('matches every golden vector', () => {
    const test = voxelSetPredicate(region);
    expect(contract.points.map(([x, y, z]) => test(x, y, z))).toEqual(contract.expected);
  });

  it('inverts', () => {
    const test = voxelSetPredicate({ ...region, invert: true });
    expect(contract.points.map(([x, y, z]) => test(x, y, z))).toEqual(contract.expected.map((e) => !e));
  });
});

describe('voxel keys', () => {
  it('decode as int32 triplets, negatives included', () => {
    expect(Array.from(decodeVoxelKeys(region.keys))).toEqual([0, 0, 0, 2, 1, 0, -1, 0, 3]);
  });

  it('bound the set', () => {
    const b = voxelSetAabb(region)!;
    expect(b.min.toArray()).toEqual([0.25, -1, 0]);
    expect(b.max.toArray()).toEqual([1.25, -0.5, 1]);
    expect(voxelSetAabb({ ...region, invert: true })).toBeNull();
  });
});
