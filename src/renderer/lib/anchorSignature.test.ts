import { describe, it, expect } from 'vitest';
import {
  rigidPoseKey,
  geometryKey,
  anchorFate,
  type RigidPoseInput,
  type GeometryInput,
} from './anchorSignature';

const NO_EDIT: RigidPoseInput = {};
const BASE_GEOM: GeometryInput = { pointCount: 100, cacheId: 'sha-1' };

describe('rigidPoseKey', () => {
  it('is stable for an unchanged pose', () => {
    const edit: RigidPoseInput = { translation: { x: 1, y: 2, z: 3 } };
    expect(rigidPoseKey(edit)).toBe(rigidPoseKey({ translation: { x: 1, y: 2, z: 3 } }));
  });

  it('changes when the cloud is translated', () => {
    const before = rigidPoseKey(NO_EDIT);
    const after = rigidPoseKey({ translation: { x: 0, y: 0, z: 1 } });
    expect(after).not.toBe(before);
  });

  it('changes when the cloud is rotated', () => {
    const before = rigidPoseKey(NO_EDIT);
    const after = rigidPoseKey({ rotation: { x: 0, y: 0, z: 90 } });
    expect(after).not.toBe(before);
  });

  it('changes when a committed pose is applied', () => {
    const before = rigidPoseKey(NO_EDIT);
    const after = rigidPoseKey({
      storedPose: {
        translation: { x: 5, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        pivot: { x: 0, y: 0, z: 0 },
        cacheId: 'sha-1',
      },
    });
    expect(after).not.toBe(before);
  });

  it('changes when a stored pose stops applying because the octree was rebuilt', () => {
    // composeCloudPose gates the stored pose on a cacheId match, so a new id
    // means the pose is no longer drawn — a change in where the cloud appears.
    const pose = {
      translation: { x: 5, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      pivot: { x: 0, y: 0, z: 0 },
    };
    const a = rigidPoseKey({ storedPose: { ...pose, cacheId: 'sha-1' } });
    const b = rigidPoseKey({ storedPose: { ...pose, cacheId: 'sha-2' } });
    expect(a).not.toBe(b);
  });

  it('treats a missing edit state as the identity pose', () => {
    expect(rigidPoseKey(undefined)).toBe(rigidPoseKey({}));
    expect(rigidPoseKey(null)).toBe(rigidPoseKey({
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    }));
  });

  it('changes when the PIVOT moves under a rotated cloud', () => {
    // Moving the scene origin re-pivots a rotated cloud and visibly swings it,
    // with translation and rotation untouched. A key blind to the pivot reads
    // that as "nothing happened" and strands every anchor.
    const rotated = { rotation: { x: 0, y: 0, z: 45 } };
    const a = rigidPoseKey({ ...rotated, pivot: { x: 0, y: 0, z: 0 } });
    const b = rigidPoseKey({ ...rotated, pivot: { x: 10, y: 0, z: 0 } });
    expect(a).not.toBe(b);
  });

  it('does NOT change when only the point count changes', () => {
    // This is the half of the split that matters: a pose key must be blind to
    // geometry, or every erase would masquerade as a move.
    const edit: RigidPoseInput = { translation: { x: 1, y: 0, z: 0 } };
    expect(rigidPoseKey(edit)).toBe(rigidPoseKey({ ...edit }));
  });
});

describe('geometryKey', () => {
  it('is stable for unchanged geometry', () => {
    expect(geometryKey(BASE_GEOM)).toBe(geometryKey({ pointCount: 100, cacheId: 'sha-1' }));
  });

  it('changes when the point count changes', () => {
    expect(geometryKey({ ...BASE_GEOM, pointCount: 99 })).not.toBe(geometryKey(BASE_GEOM));
  });

  it('changes when the octree is rebuilt', () => {
    expect(geometryKey({ ...BASE_GEOM, cacheId: 'sha-2' })).not.toBe(geometryKey(BASE_GEOM));
  });

  it('changes when points are pending deletion', () => {
    expect(geometryKey({ ...BASE_GEOM, pendingDeletedCount: 5 })).not.toBe(geometryKey(BASE_GEOM));
  });

  it('changes when points are erased on a flat cloud', () => {
    expect(geometryKey({ ...BASE_GEOM, erasedCount: 3 })).not.toBe(geometryKey(BASE_GEOM));
  });

  it('does NOT change when the cloud is merely translated', () => {
    // The key assertion of the whole feature: moving a cloud must leave its
    // geometry key untouched, or anchors get dropped instead of carried.
    const before = geometryKey(BASE_GEOM);
    // A translate changes no field of GeometryInput at all.
    expect(geometryKey({ pointCount: 100, cacheId: 'sha-1' })).toBe(before);
  });

  it('treats absent optional counts as zero', () => {
    expect(geometryKey({ pointCount: 1, cacheId: 'x' }))
      .toBe(geometryKey({ pointCount: 1, cacheId: 'x', pendingDeletedCount: 0, erasedCount: 0 }));
  });
});

describe('anchorFate', () => {
  const keys = (pose: string, geometry: string) => ({ pose, geometry });

  it('keeps an anchor when nothing changed', () => {
    expect(anchorFate(keys('p1', 'g1'), keys('p1', 'g1'))).toEqual({ kind: 'keep' });
  });

  it('moves an anchor when only the pose changed', () => {
    expect(anchorFate(keys('p1', 'g1'), keys('p2', 'g1'))).toEqual({ kind: 'move' });
  });

  it('drops an anchor when the geometry changed', () => {
    expect(anchorFate(keys('p1', 'g1'), keys('p1', 'g2'))).toEqual({ kind: 'drop' });
  });

  it('drops when the cloud disappears', () => {
    expect(anchorFate(keys('p1', 'g1'), undefined)).toEqual({ kind: 'drop' });
  });

  it('keeps on first sighting, with nothing to compare against', () => {
    expect(anchorFate(undefined, keys('p1', 'g1'))).toEqual({ kind: 'keep' });
  });

  it('drops rather than moves when BOTH changed', () => {
    // A crop-apply on a translated cloud both moves and rebuilds it. Carrying
    // the anchor onto rebuilt geometry would place it confidently in the wrong
    // spot — a plausible-looking wrong number is worse than a lost label.
    expect(anchorFate(keys('p1', 'g1'), keys('p2', 'g2'))).toEqual({ kind: 'drop' });
  });
});

describe('the split, end to end', () => {
  // These three cases are the reason the module exists. Before the split a
  // single signature covered all of them and every one dropped the anchor.

  it('a pure translate moves anchors instead of dropping them', () => {
    const prev = {
      pose: rigidPoseKey({}),
      geometry: geometryKey(BASE_GEOM),
    };
    const next = {
      pose: rigidPoseKey({ translation: { x: 10, y: 0, z: 0 } }),
      geometry: geometryKey(BASE_GEOM),
    };
    expect(anchorFate(prev, next)).toEqual({ kind: 'move' });
  });

  it('a rotation moves anchors instead of dropping them', () => {
    const prev = { pose: rigidPoseKey({}), geometry: geometryKey(BASE_GEOM) };
    const next = {
      pose: rigidPoseKey({ rotation: { x: 0, y: 0, z: 45 } }),
      geometry: geometryKey(BASE_GEOM),
    };
    expect(anchorFate(prev, next)).toEqual({ kind: 'move' });
  });

  it('an erase drops anchors', () => {
    const prev = { pose: rigidPoseKey({}), geometry: geometryKey(BASE_GEOM) };
    const next = {
      pose: rigidPoseKey({}),
      geometry: geometryKey({ ...BASE_GEOM, erasedCount: 12 }),
    };
    expect(anchorFate(prev, next)).toEqual({ kind: 'drop' });
  });

  it('a bake that rebuilds the octree drops anchors', () => {
    // Baking a committed transform produces a new octree from already-moved
    // arrays, so the anchor's point is in a rebuilt cloud — drop, not move.
    const prev = {
      pose: rigidPoseKey({
        storedPose: {
          translation: { x: 5, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          pivot: { x: 0, y: 0, z: 0 },
          cacheId: 'sha-1',
        },
      }),
      geometry: geometryKey(BASE_GEOM),
    };
    const next = {
      pose: rigidPoseKey({}),
      geometry: geometryKey({ ...BASE_GEOM, cacheId: 'sha-2' }),
    };
    expect(anchorFate(prev, next)).toEqual({ kind: 'drop' });
  });
});
