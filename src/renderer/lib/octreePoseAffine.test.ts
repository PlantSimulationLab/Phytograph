import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import {
  commitStoredPose, composeCloudPose, poseMatrixOf, poseToMatrix, transformBoundsAabb, transformPoint,
  unposePoint,
} from './octreePoseCompose';
import { applyOctreePose } from '../components/viewer/renderers/octreePose';
import type { CloudEditState } from './pointCloudTypes';

/**
 * The Transformation tool's SCALE, through the octree pose path.
 *
 * A scale composed onto a rotation has no (translation, rotation, pivot) form,
 * so `composeCloudPose` hands the renderer a matrix. These check the drawn
 * result through the REAL `applyOctreePose` (as octreePoseCompose.test.ts does
 * for the rigid path) against the matrix algebra the bake uses.
 */

const probes = [
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-3.5, 2.25, 7),
  new THREE.Vector3(120, -40, 3),
];
const CACHE = 'cache-1';

function rendered(world: THREE.Vector3, pose: ReturnType<typeof composeCloudPose>, base = new THREE.Vector3()) {
  const pco = new THREE.Object3D() as unknown as Parameters<typeof applyOctreePose>[0] & THREE.Object3D;
  applyOctreePose(pco, base, pose.translation, pose.rotation, pose.pivot, null, pose.matrix ?? null);
  pco.updateMatrixWorld(true);
  // The octree stores points relative to `base`.
  return world.clone().sub(base).applyMatrix4(pco.matrix);
}

function expectClose(a: THREE.Vector3, b: THREE.Vector3, digits = 6) {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
}

function edit(partial: Partial<CloudEditState>): CloudEditState {
  return { translation: { x: 0, y: 0, z: 0 }, erasedIndices: new Set<number>(), ...partial };
}

describe('poseToMatrix with scale', () => {
  it('scales about the pivot, then rotates, then translates', () => {
    const P = { x: 2, y: 0, z: 0 };
    const m = poseToMatrix({ x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, P, { x: 2, y: 1, z: 1 });
    // (3, 1, 0) − P = (1, 1, 0) → scale → (2, 1, 0) → Rz90 → (−1, 2, 0) → + P + t = (6, 2, 0)
    const v = new THREE.Vector3(3, 1, 0).applyMatrix4(m);
    expectClose(v, new THREE.Vector3(6, 2, 0));
  });

  it('is the rigid matrix when the scale is omitted or unit', () => {
    const a = poseToMatrix({ x: 1, y: 2, z: 3 }, { x: 10, y: 20, z: 30 }, { x: 4, y: 5, z: 6 });
    const b = poseToMatrix({ x: 1, y: 2, z: 3 }, { x: 10, y: 20, z: 30 }, { x: 4, y: 5, z: 6 }, { x: 1, y: 1, z: 1 });
    expect(a.elements).toEqual(b.elements);
  });
});

describe('composeCloudPose (affine)', () => {
  it('returns no matrix for a rigid draft (the rigid path is untouched)', () => {
    const out = composeCloudPose(edit({ translation: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 30 } }), CACHE, { x: 0, y: 0, z: 0 });
    expect(out.matrix).toBeUndefined();
  });

  it('draws a scaled draft exactly where its matrix puts the points', () => {
    const pivot = { x: 500_000, y: 4_200_000, z: 120 };
    const e = edit({ translation: { x: 3, y: -1, z: 0 }, rotation: { x: 0, y: 15, z: 40 }, scale: { x: 2, y: 0.5, z: 1.5 } });
    const expectM = poseToMatrix(e.translation, e.rotation!, pivot, e.scale);
    const out = composeCloudPose(e, CACHE, pivot);
    expect(out.matrix).toBeDefined();
    for (const p0 of probes) {
      const p = p0.clone().add(new THREE.Vector3(pivot.x, pivot.y, pivot.z));
      expectClose(rendered(p, out, new THREE.Vector3(pivot.x, pivot.y, pivot.z)), p.clone().applyMatrix4(expectM), 4);
    }
  });

  it('composes a rigid draft ON TOP of an affine stored pose', () => {
    const pivot = { x: 0, y: 0, z: 0 };
    const storedM = poseToMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 30 }, pivot, { x: 2, y: 1, z: 1 });
    const e = edit({
      translation: { x: 1, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 90 },
      storedPose: {
        translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, pivot, cacheId: CACHE,
        matrix: storedM.toArray(),
      },
    });
    const expectM = poseToMatrix(e.translation, e.rotation!, pivot).multiply(storedM);
    const out = composeCloudPose(e, CACHE, pivot);
    for (const p of probes) expectClose(rendered(p, out), p.clone().applyMatrix4(expectM));
  });

  it('drops an affine stored pose whose cacheId no longer matches', () => {
    const pivot = { x: 0, y: 0, z: 0 };
    const e = edit({
      storedPose: {
        translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, pivot, cacheId: 'OLD',
        matrix: poseToMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, pivot, { x: 3, y: 3, z: 3 }).toArray(),
      },
    });
    const out = composeCloudPose(e, CACHE, pivot);
    expect(out.matrix).toBeUndefined();
    expect(poseMatrixOf(out).elements).toEqual(new THREE.Matrix4().elements);
  });

  it('commitStoredPose records the TOTAL affine displacement as a matrix', () => {
    const pivot = { x: 1, y: 2, z: 3 };
    const first = commitStoredPose(
      edit({ scale: { x: 2, y: 1, z: 1 } }), CACHE, pivot,
    );
    expect(first.matrix).toHaveLength(16);
    const second = commitStoredPose(
      edit({ rotation: { x: 0, y: 0, z: 90 }, storedPose: first }), CACHE, pivot,
    );
    const expectM = poseToMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, pivot)
      .multiply(poseToMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, pivot, { x: 2, y: 1, z: 1 }));
    const got = new THREE.Matrix4().fromArray(second.matrix!);
    for (const p of probes) expectClose(p.clone().applyMatrix4(got), p.clone().applyMatrix4(expectM));
  });

  it('keeps the rigid (matrix-free) form when nothing is scaled', () => {
    const sp = commitStoredPose(edit({ rotation: { x: 0, y: 0, z: 45 } }), CACHE, { x: 0, y: 0, z: 0 });
    expect(sp.matrix).toBeUndefined();
    expect(sp.rotation.z).toBeCloseTo(45, 9);
  });
});

describe('point / bounds helpers with scale', () => {
  const t = { x: 1, y: -2, z: 0.5 };
  const r = { x: 30, y: 40, z: 50 };
  const P = { x: 10, y: 20, z: 30 };
  const s = { x: 2, y: 0.5, z: 3 };

  it('unposePoint inverts transformPoint under a non-uniform scale', () => {
    const p: [number, number, number] = [1, 2, 3];
    const there = transformPoint(p, t, r, P, s);
    const back = unposePoint(there, t, r, P, s);
    expect(back[0]).toBeCloseTo(1, 9);
    expect(back[1]).toBeCloseTo(2, 9);
    expect(back[2]).toBeCloseTo(3, 9);
  });

  it('transformBoundsAabb stretches the box by the scale', () => {
    const out = transformBoundsAabb(
      { min: new THREE.Vector3(0, 0, 0), max: new THREE.Vector3(1, 2, 3) },
      { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 0.5 },
    );
    expect(out.min.toArray()).toEqual([0, 0, 0]);
    expect(out.max.toArray()).toEqual([2, 2, 1.5]);
  });
});
