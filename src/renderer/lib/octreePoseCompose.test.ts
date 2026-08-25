import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { composeCloudPose, hasStoredPose, transformBoundsAabb, transformGroundZ, transformPoint } from './octreePoseCompose';
import { applyOctreePose } from '../components/viewer/renderers/octreePose';
import type { CloudEditState } from './pointCloudTypes';

/**
 * Checked against the REAL `applyOctreePose` — the function the viewer renders
 * with — not against a re-derivation of the same algebra. A test that
 * reimplemented the pose math would agree with a wrong composition just as
 * happily. Same harness as octreePoseDecompose.test.ts, for the same reason.
 *
 * The property under test: a cloud drawn with the composed pose must land every
 * point where `M_draft · M_stored` puts it. If it doesn't, the octree is drawn
 * somewhere the session geometry isn't, which is the exact silent frame
 * mismatch this whole area exists to prevent.
 */

function fakePco() {
  const o = new THREE.Object3D();
  return o as unknown as Parameters<typeof applyOctreePose>[0] & THREE.Object3D;
}

function renderedPoint(
  world: THREE.Vector3,
  pose: { translation: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number }; pivot: { x: number; y: number; z: number } },
): THREE.Vector3 {
  const pco = fakePco();
  applyOctreePose(pco, new THREE.Vector3(0, 0, 0), pose.translation, pose.rotation, pose.pivot, null);
  pco.updateMatrixWorld(true);
  return world.clone().applyMatrix4(pco.matrix);
}

/** The world matrix a (translation, rotation-about-pivot) pair represents. */
function poseMatrix(
  t: { x: number; y: number; z: number },
  rDeg: { x: number; y: number; z: number },
  pivot: { x: number; y: number; z: number },
): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(rDeg.x),
    THREE.MathUtils.degToRad(rDeg.y),
    THREE.MathUtils.degToRad(rDeg.z),
    'XYZ',
  ));
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  const p = new THREE.Vector3(pivot.x, pivot.y, pivot.z);
  const rp = p.clone().applyMatrix4(m);
  return m.setPosition(p.x - rp.x + t.x, p.y - rp.y + t.y, p.z - rp.z + t.z);
}

const probes = [
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-3.5, 2.25, 7),
  new THREE.Vector3(120, -40, 3),
];

const CACHE = 'abc123';

function editWith(
  draft: { t?: [number, number, number]; r?: [number, number, number] },
  stored?: { t: [number, number, number]; r: [number, number, number]; pivot: [number, number, number]; cacheId?: string },
): CloudEditState {
  return {
    translation: { x: draft.t?.[0] ?? 0, y: draft.t?.[1] ?? 0, z: draft.t?.[2] ?? 0 },
    rotation: { x: draft.r?.[0] ?? 0, y: draft.r?.[1] ?? 0, z: draft.r?.[2] ?? 0 },
    erasedIndices: new Set<number>(),
    storedPose: stored
      ? {
          translation: { x: stored.t[0], y: stored.t[1], z: stored.t[2] },
          rotation: { x: stored.r[0], y: stored.r[1], z: stored.r[2] },
          pivot: { x: stored.pivot[0], y: stored.pivot[1], z: stored.pivot[2] },
          cacheId: stored.cacheId ?? CACHE,
        }
      : undefined,
  };
}

describe('composeCloudPose', () => {
  it('with no stored pose, passes the draft through unchanged', () => {
    const edit = editWith({ t: [3, -4, 0.5], r: [0, 0, 25] });
    const pivot = { x: 10, y: 20, z: 30 };
    const out = composeCloudPose(edit, CACHE, pivot);
    expect(out.translation).toEqual(edit.translation);
    expect(out.rotation).toEqual(edit.rotation);
    expect(out.pivot).toEqual(pivot);
  });

  it('ignores a stored pose whose cacheId does not match the current octree', () => {
    // A rebuild has folded the transform into the geometry; applying it again
    // would double-transform the cloud.
    const edit = editWith({ t: [1, 0, 0] }, { t: [500, 0, 0], r: [0, 0, 90], pivot: [0, 0, 0], cacheId: 'OLD' });
    const out = composeCloudPose(edit, CACHE, { x: 0, y: 0, z: 0 });
    expect(out.translation).toEqual({ x: 1, y: 0, z: 0 });
    expect(out.rotation).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('renders a stored pose alone exactly where its matrix puts the points', () => {
    const pivot = { x: 500_000, y: 4_200_000, z: 120 };
    const edit = editWith({}, { t: [12, -400, 3.5], r: [10, -20, 45], pivot: [500_000, 4_200_000, 120] });
    const expectM = poseMatrix(edit.storedPose!.translation, edit.storedPose!.rotation, edit.storedPose!.pivot);

    const out = composeCloudPose(edit, CACHE, pivot);
    for (const p of probes) {
      const expected = p.clone().applyMatrix4(expectM);
      const actual = renderedPoint(p, out);
      expect(actual.x).toBeCloseTo(expected.x, 5);
      expect(actual.y).toBeCloseTo(expected.y, 5);
      expect(actual.z).toBeCloseTo(expected.z, 5);
    }
  });

  it('applies the draft ON TOP of the stored pose, in that order', () => {
    // Order matters: rotations do not commute. Stored 90deg about Z, then a
    // draft +X translation. Reversed, (1,0,0) would land somewhere else.
    const pivot = { x: 0, y: 0, z: 0 };
    const edit = editWith({ t: [1, 0, 0] }, { t: [0, 0, 0], r: [0, 0, 90], pivot: [0, 0, 0] });
    const expectM = poseMatrix({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, pivot)
      .multiply(poseMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, pivot));

    const out = composeCloudPose(edit, CACHE, pivot);
    for (const p of probes) {
      const expected = p.clone().applyMatrix4(expectM);
      const actual = renderedPoint(p, out);
      expect(actual.x).toBeCloseTo(expected.x, 5);
      expect(actual.y).toBeCloseTo(expected.y, 5);
      expect(actual.z).toBeCloseTo(expected.z, 5);
    }
  });

  it('composes two rotations correctly (not by adding Euler angles)', () => {
    // Adding degrees would happen to work for two Z rotations, so use axes that
    // expose the difference.
    const pivot = { x: 5, y: -3, z: 2 };
    // Z-then-X: in 'XYZ' Euler order R = Rz·Ry·Rx, so applying Rz AFTER Rx is not
    // the same as the single Euler (40, 0, 70) that naive addition would produce.
    const edit = editWith({ r: [0, 0, 70] }, { t: [0, 0, 0], r: [40, 0, 0], pivot: [5, -3, 2] });
    const expectM = poseMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 70 }, pivot)
      .multiply(poseMatrix({ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }, pivot));

    const out = composeCloudPose(edit, CACHE, pivot);
    // Naively summing Eulers would give (40, 60, 0) — assert we did not.
    const naive = { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 40, y: 0, z: 70 }, pivot };
    let naiveDiffers = false;
    for (const p of probes) {
      const expected = p.clone().applyMatrix4(expectM);
      const actual = renderedPoint(p, out);
      expect(actual.x).toBeCloseTo(expected.x, 5);
      expect(actual.y).toBeCloseTo(expected.y, 5);
      expect(actual.z).toBeCloseTo(expected.z, 5);
      if (renderedPoint(p, naive).distanceTo(expected) > 1e-3) naiveDiffers = true;
    }
    expect(naiveDiffers, 'fixture must distinguish composition from Euler addition').toBe(true);
  });

  it('honours a pivot that MOVED between commit and render', () => {
    // storedPose.pivot is frozen at commit; the scene origin can move afterwards.
    // The rendered result must still match the stored matrix exactly.
    const commitPivot: [number, number, number] = [1000, -500, 30];
    const livePivot = { x: -20, y: 7, z: 3 };
    const edit = editWith({}, { t: [4, 5, 6], r: [0, 0, 35], pivot: commitPivot });
    const expectM = poseMatrix(edit.storedPose!.translation, edit.storedPose!.rotation, edit.storedPose!.pivot);

    const out = composeCloudPose(edit, CACHE, livePivot);
    expect(out.pivot).toEqual(livePivot);
    for (const p of probes) {
      const expected = p.clone().applyMatrix4(expectM);
      const actual = renderedPoint(p, out);
      expect(actual.x).toBeCloseTo(expected.x, 5);
      expect(actual.y).toBeCloseTo(expected.y, 5);
      expect(actual.z).toBeCloseTo(expected.z, 5);
    }
  });

  it('a draft that exactly undoes the stored rotation renders as no pose at all', () => {
    // Guards applyOctreePose's pure-translation fast path: the composed rotation
    // cancels to zero, so the fast path is taken and the translation it carries
    // must be the composition's, not either input's.
    const pivot = { x: 250, y: 40, z: 6 };
    const edit = editWith({ r: [0, 0, -30] }, { t: [0, 0, 0], r: [0, 0, 30], pivot: [250, 40, 6] });
    const out = composeCloudPose(edit, CACHE, pivot);

    for (const p of probes) {
      const actual = renderedPoint(p, out);
      expect(actual.x).toBeCloseTo(p.x, 4);
      expect(actual.y).toBeCloseTo(p.y, 4);
      expect(actual.z).toBeCloseTo(p.z, 4);
    }
  });
});

describe('hasStoredPose', () => {
  it('is true only while the pose matches the current octree', () => {
    const edit = editWith({}, { t: [1, 0, 0], r: [0, 0, 0], pivot: [0, 0, 0] });
    expect(hasStoredPose(edit, CACHE)).toBe(true);
    expect(hasStoredPose(edit, 'OTHER')).toBe(false);
    expect(hasStoredPose(editWith({}), CACHE)).toBe(false);
    expect(hasStoredPose(undefined, CACHE)).toBe(false);
  });
});

describe('transformBoundsAabb', () => {
  const box = {
    min: new THREE.Vector3(-1, -2, 0),
    max: new THREE.Vector3(3, 2, 4),
  };

  it('translates exactly', () => {
    const out = transformBoundsAabb(box, { x: 10, y: -5, z: 1 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(out.min.toArray()).toEqual([9, -7, 1]);
    expect(out.max.toArray()).toEqual([13, -3, 5]);
  });

  it('a 90 degree turn about Z swaps the X and Y extents exactly', () => {
    const out = transformBoundsAabb(box, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, { x: 0, y: 0, z: 0 });
    expect(out.min.x).toBeCloseTo(-2);
    expect(out.max.x).toBeCloseTo(2);
    expect(out.min.y).toBeCloseTo(-1);
    expect(out.max.y).toBeCloseTo(3);
    expect(out.min.z).toBeCloseTo(0);
    expect(out.max.z).toBeCloseTo(4);
  });

  it('rotates about the PIVOT, not the origin', () => {
    // The failure this catches is worth thousands of metres on a UTM scene.
    const pivot = { x: 500_000, y: 4_200_000, z: 0 };
    const far = {
      min: new THREE.Vector3(pivot.x - 1, pivot.y - 1, 0),
      max: new THREE.Vector3(pivot.x + 1, pivot.y + 1, 2),
    };
    const out = transformBoundsAabb(far, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, pivot);
    // Spinning in place: the box stays put.
    expect(out.min.x).toBeCloseTo(far.min.x, 3);
    expect(out.max.x).toBeCloseTo(far.max.x, 3);
    expect(out.min.y).toBeCloseTo(far.min.y, 3);
    expect(out.max.y).toBeCloseTo(far.max.y, 3);
  });

  it('a 45 degree turn inflates the rotated plane by root two', () => {
    const square = {
      min: new THREE.Vector3(-1, -1, 0),
      max: new THREE.Vector3(1, 1, 0),
    };
    const out = transformBoundsAabb(square, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 45 }, { x: 0, y: 0, z: 0 });
    expect(out.max.x).toBeCloseTo(Math.SQRT2, 5);
    expect(out.max.y).toBeCloseTo(Math.SQRT2, 5);
  });
});

describe('transformGroundZ', () => {
  const centre = { x: 0, y: 0 };

  it('a pure translation shifts it exactly', () => {
    expect(transformGroundZ(3, centre, { x: 0, y: 0, z: 7 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }))
      .toBeCloseTo(10, 6);
  });

  it('a turn about Z leaves a ground level alone', () => {
    // Spinning about the vertical cannot change how high the ground is.
    expect(transformGroundZ(2.5, centre, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, { x: 0, y: 0, z: 0 }))
      .toBeCloseTo(2.5, 6);
  });

  it('does NOT collapse to the raw bounding-box minimum', () => {
    // groundZ is an outlier-RESISTANT percentile: the raw minimum is set by a
    // single stray return, which is exactly what it exists to ignore. Deriving
    // it from a rotated bounding box would sink it below even that minimum and
    // drag the scene origin (and every rotation pivot) down with it.
    const rawMin = -12;          // a lone sub-terrain noise point
    const ground = 0.4;          // the real terrain
    const box = {
      min: new THREE.Vector3(-5, -5, rawMin),
      max: new THREE.Vector3(5, 5, 8),
    };
    const rot = { x: 20, y: 0, z: 0 };
    const pivot = { x: 0, y: 0, z: 0 };
    const movedBox = transformBoundsAabb(box, { x: 0, y: 0, z: 0 }, rot, pivot);
    const movedGround = transformGroundZ(ground, centre, { x: 0, y: 0, z: 0 }, rot, pivot);

    expect(movedGround).toBeGreaterThan(movedBox.min.z + 1);
    expect(Math.abs(movedGround - ground)).toBeLessThan(3);
  });
});

describe('transformPoint', () => {
  // A point that rides with a cloud (its scanner origin) must land exactly where
  // the cloud's own corners land — otherwise "snap the scene origin to this
  // scanner" puts the pivot somewhere the user can see the scanner is not.
  // Checked AGAINST transformBoundsAabb rather than against re-derived algebra:
  // a degenerate box's corners are all the same point, so the AABB of the
  // transformed box is that point transformed.
  const cases: { t: { x: number; y: number; z: number }; r: { x: number; y: number; z: number } }[] = [
    { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 0 } },
    { t: { x: 3, y: -2, z: 0.5 }, r: { x: 0, y: 0, z: 0 } },
    { t: { x: 0, y: 0, z: 0 }, r: { x: 0, y: 0, z: 90 } },
    { t: { x: 1.5, y: 4, z: -3 }, r: { x: 15, y: -40, z: 110 } },
  ];
  const point: [number, number, number] = [7, -1.25, 2];
  const pivot = { x: 2, y: 2, z: 0 };

  for (const { t, r } of cases) {
    it(`agrees with the AABB transform for t=${JSON.stringify(t)} r=${JSON.stringify(r)}`, () => {
      const box = {
        min: new THREE.Vector3(...point),
        max: new THREE.Vector3(...point),
      };
      const moved = transformBoundsAabb(box, t, r, pivot);
      const p = transformPoint(point, t, r, pivot);
      expect(p[0]).toBeCloseTo(moved.min.x, 6);
      expect(p[1]).toBeCloseTo(moved.min.y, 6);
      expect(p[2]).toBeCloseTo(moved.min.z, 6);
    });
  }

  it('rotates ABOUT the pivot, not about the world origin', () => {
    // The bug this catches: dropping the pivot term turns a 180° yaw of a scan
    // parked away from (0,0,0) into a reflection through the world origin.
    const p = transformPoint([3, 2, 1], { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 180 }, { x: 2, y: 2, z: 0 });
    expect(p[0]).toBeCloseTo(1, 6);
    expect(p[1]).toBeCloseTo(2, 6);
    expect(p[2]).toBeCloseTo(1, 6);
  });
});
