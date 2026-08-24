import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { poseFromMatrix, renderPivot } from './octreePoseDecompose';
import { applyOctreePose } from '../components/viewer/renderers/octreePose';

/**
 * These check `poseFromMatrix` against the REAL `applyOctreePose` — the function
 * the viewer actually renders with — not against a re-derivation of the same
 * algebra. A test that reimplemented the pose math would agree with a wrong
 * decomposition just as happily.
 *
 * The property under test: for a queued matrix M, drawing the cloud with the
 * decomposed pose must land every point exactly where M would put it. If it
 * doesn't, the cloud is drawn in one place and baked into another, and the user
 * sees it jump when the bake lands.
 */

/** A stand-in for potree's PointCloudOctree: applyOctreePose only touches these. */
function fakePco() {
  const o = new THREE.Object3D();
  return o as unknown as Parameters<typeof applyOctreePose>[0] & THREE.Object3D;
}

/**
 * Where a world point ends up on screen, given a pose.
 *
 * `applyOctreePose` maps NODE-LOCAL coordinates (world − base) to the display
 * frame, so a world point is fed in as `world − base` and comes back as
 * `rendered − displayOffset`. Both are zero here, isolating the pose itself.
 */
function renderedPoint(
  world: THREE.Vector3,
  pose: { translation: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } },
  pivot: { x: number; y: number; z: number },
): THREE.Vector3 {
  const pco = fakePco();
  const base = new THREE.Vector3(0, 0, 0);
  applyOctreePose(pco, base, pose.translation, pose.rotation, pivot, null);
  pco.updateMatrixWorld(true);
  return world.clone().applyMatrix4(pco.matrix);
}

const probes = [
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-3.5, 2.25, 7),
  new THREE.Vector3(120, -40, 3),
];

function expectMatchesMatrix(m: THREE.Matrix4, pivot: { x: number; y: number; z: number }) {
  const pose = poseFromMatrix(m, pivot);
  for (const p of probes) {
    const expected = p.clone().applyMatrix4(m);
    const actual = renderedPoint(p, pose, pivot);
    expect(actual.x).toBeCloseTo(expected.x, 6);
    expect(actual.y).toBeCloseTo(expected.y, 6);
    expect(actual.z).toBeCloseTo(expected.z, 6);
  }
}

describe('poseFromMatrix', () => {
  it('reproduces a pure translation', () => {
    expectMatchesMatrix(new THREE.Matrix4().makeTranslation(5, -2, 0.25), { x: 0, y: 0, z: 0 });
  });

  it('reproduces a rotation about the ORIGIN pivot', () => {
    expectMatchesMatrix(new THREE.Matrix4().makeRotationZ(Math.PI / 3), { x: 0, y: 0, z: 0 });
  });

  it('reproduces a rotation when the pivot is FAR from the origin', () => {
    // The case the pivot correction exists for: with a non-origin pivot, a naive
    // `translation = t` is wrong by (pivot − R·pivot), which here is huge.
    const m = new THREE.Matrix4().makeRotationZ(Math.PI / 4);
    expectMatchesMatrix(m, { x: 500_000, y: 4_200_000, z: 120 });
  });

  it('reproduces a general rotation + translation about a far pivot', () => {
    const m = new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(0.3, -0.7, 1.1, 'XYZ'))
      .setPosition(12, -400, 3.5);
    expectMatchesMatrix(m, { x: 1000, y: -500, z: 30 });
  });

  it('reproduces a composed ICP-style matrix (rotation then translation)', () => {
    const m = new THREE.Matrix4()
      .makeTranslation(3, 4, 5)
      .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.2, 0.4, -0.6, 'XYZ')));
    expectMatchesMatrix(m, { x: 25, y: -60, z: 2 });
  });

  it('identity matrix yields a no-op pose', () => {
    const pose = poseFromMatrix(new THREE.Matrix4(), { x: 10, y: 20, z: 30 });
    expect(pose.translation.x).toBeCloseTo(0);
    expect(pose.translation.y).toBeCloseTo(0);
    expect(pose.translation.z).toBeCloseTo(0);
    expect(pose.rotation.x).toBeCloseTo(0);
    expect(pose.rotation.y).toBeCloseTo(0);
    expect(pose.rotation.z).toBeCloseTo(0);
  });

  it('ignoring the pivot correction WOULD be wrong (guards the correction itself)', () => {
    // Pins that the pivot term is load-bearing: without it the rendered cloud
    // sits `pivot − R·pivot` away from where the bake will put it.
    const pivot = { x: 1000, y: 0, z: 0 };
    const m = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    const correct = poseFromMatrix(m, pivot);
    const naive = { translation: { x: 0, y: 0, z: 0 }, rotation: correct.rotation };

    const p = new THREE.Vector3(0, 0, 0);
    const expected = p.clone().applyMatrix4(m);
    expect(renderedPoint(p, correct, pivot).distanceTo(expected)).toBeLessThan(1e-6);
    expect(renderedPoint(p, naive, pivot).distanceTo(expected)).toBeGreaterThan(100);
  });
});

describe('renderPivot', () => {
  it('prefers the scene origin when one is set', () => {
    expect(renderPivot([1, 2, 3], { x: 9, y: 9, z: 9 })).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('falls back to the cloud bbox centre (spin in place)', () => {
    expect(renderPivot(null, { x: 9, y: 8, z: 7 })).toEqual({ x: 9, y: 8, z: 7 });
  });
});

describe('round-trip: draft -> world matrix -> draft', () => {
  /**
   * The Transformation tool builds its world matrix as R about a PIVOT plus a
   * translation (`t_eff = P - R*P + t`), and `runQueuedBake` later subtracts the
   * pose it decomposes from that matrix to clear the draft it stood in for.
   *
   * Those two must be exact inverses. If they aren't, the cloud shifts by the
   * residual the moment the deferred bake lands — the same class of bug that
   * showed up as a 3.5 m error in the registration E2E.
   */
  function draftToWorldMatrix(
    draft: { translation: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } },
    pivot: { x: number; y: number; z: number },
  ): THREE.Matrix4 {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(draft.rotation.x),
      THREE.MathUtils.degToRad(draft.rotation.y),
      THREE.MathUtils.degToRad(draft.rotation.z),
      'XYZ',
    ));
    const R = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const P = new THREE.Vector3(pivot.x, pivot.y, pivot.z);
    const rp = P.clone().applyMatrix4(R);
    // t_eff = P - R*P + t  (exactly what bakeCloudTransform sends)
    return R.clone().setPosition(
      P.x - rp.x + draft.translation.x,
      P.y - rp.y + draft.translation.y,
      P.z - rp.z + draft.translation.z,
    );
  }

  const cases = [
    { name: 'pure translation', d: { translation: { x: 3, y: -4, z: 0.5 }, rotation: { x: 0, y: 0, z: 0 } } },
    { name: 'pure rotation', d: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 30 } } },
    { name: 'rotation + translation', d: { translation: { x: 12, y: 3, z: -2 }, rotation: { x: 10, y: -20, z: 45 } } },
  ];

  for (const { name, d } of cases) {
    it(`${name} decomposes back to the same draft (far pivot)`, () => {
      const pivot = { x: 500_000, y: 4_200_000, z: 120 };
      const m = draftToWorldMatrix(d, pivot);
      const back = poseFromMatrix(m, pivot);
      expect(back.translation.x).toBeCloseTo(d.translation.x, 4);
      expect(back.translation.y).toBeCloseTo(d.translation.y, 4);
      expect(back.translation.z).toBeCloseTo(d.translation.z, 4);
      expect(back.rotation.x).toBeCloseTo(d.rotation.x, 4);
      expect(back.rotation.y).toBeCloseTo(d.rotation.y, 4);
      expect(back.rotation.z).toBeCloseTo(d.rotation.z, 4);
    });
  }
});
