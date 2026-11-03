import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import {
  IDENTITY_DELTA, conjugateByShift, isIdentityDelta, isUniformScale, rotationQuat, toRowMajor, transformNormalFields,
  transformScanParamsToWorld, verticalityOf,
} from './affineDelta';
import { poseToMatrix } from './octreePoseCompose';
import type { ScanParameters } from './scanParameters';

describe('transformScanParamsToWorld', () => {
  const shift: [number, number, number] = [545_000, 4_183_000, 100];

  it('keeps the scanner where it was relative to the points, under rotation and scale of a shifted cloud', () => {
    // The scanner sits 5 m east of a point. After the move it must sit at the
    // same transformed offset from that point, in world coordinates.
    const rot = { x: 0, y: 0, z: 0.1 };
    const Ms = poseToMatrix({ x: 1, y: 2, z: 0 }, rot, { x: 3, y: 4, z: 0 }, { x: 1.5, y: 1.5, z: 1.5 });
    const Mw = conjugateByShift(Ms, shift);
    const pointStored = new THREE.Vector3(10, 20, 5);
    const originWorld = { x: 10 + 5 + shift[0], y: 20 + shift[1], z: 5 + shift[2] };

    const moved = transformScanParamsToWorld(
      { origin: originWorld } as unknown as ScanParameters, Mw, rotationQuat(rot)).origin;

    // What the renderer draws, plus the shift, is where the point really is.
    const movedPointWorld = pointStored.clone().applyMatrix4(Ms).add(new THREE.Vector3(...shift));
    const offset = new THREE.Vector3(moved.x, moved.y, moved.z).sub(movedPointWorld);
    const expected = new THREE.Vector3(5, 0, 0)
      .applyQuaternion(rotationQuat(rot)).multiplyScalar(1.5);
    expect(offset.distanceTo(expected)).toBeLessThan(1e-6);
  });

  it('is the stored-frame answer plus (I − L)·shift, which is how far the old call was off', () => {
    const rot = { x: 0, y: 0, z: 0.1 };
    const Ms = poseToMatrix({ x: 0, y: 0, z: 0 }, rot, { x: 0, y: 0, z: 0 }, undefined);
    const origin = { x: shift[0], y: shift[1], z: shift[2] };
    const fixed = transformScanParamsToWorld(
      { origin } as unknown as ScanParameters, conjugateByShift(Ms, shift), rotationQuat(rot)).origin;
    const strandedByStoredMatrix = new THREE.Vector3(origin.x, origin.y, origin.z).applyMatrix4(Ms);
    // A scanner at the shift itself is stored at 0,0,0, the pivot: it must not move.
    expect(Math.hypot(fixed.x - origin.x, fixed.y - origin.y, fixed.z - origin.z)).toBeLessThan(1e-6);
    expect(strandedByStoredMatrix.distanceTo(new THREE.Vector3(origin.x, origin.y, origin.z))).toBeGreaterThan(7000);
  });

  it('moves a moving-platform trajectory in the same frame as the origin', () => {
    const rot = { x: 0, y: 0, z: 90 };
    const Mw = conjugateByShift(poseToMatrix({ x: 0, y: 0, z: 0 }, rot, { x: 0, y: 0, z: 0 }, undefined), shift);
    const trajectory = {
      poses: [{ t: 0, x: shift[0] + 1, y: shift[1], z: shift[2], qx: 0, qy: 0, qz: 0, qw: 1 }],
    };
    const out = transformScanParamsToWorld(
      { origin: { x: shift[0], y: shift[1], z: shift[2] }, trajectory } as unknown as ScanParameters, Mw, rotationQuat(rot));
    const pose = out.trajectory!.poses[0];
    // 1 m east of the pivot, rotated 90° about it: 1 m north.
    expect(pose.x).toBeCloseTo(shift[0], 6);
    expect(pose.y).toBeCloseTo(shift[1] + 1, 6);
  });
});

describe('conjugateByShift', () => {
  it('turns a stored-frame matrix into the world-frame one session_transform expects', () => {
    // The session stores p_stored = p_world − shift and bakes
    // L·(p_stored + shift) + t − shift. Handing it the STORED-frame matrix
    // directly lands (L·shift − shift) away; the conjugated one lands exactly
    // where the renderer drew the draft.
    const shift: [number, number, number] = [545_000, 4_183_000, 0];
    const Ms = poseToMatrix({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, { x: 2, y: 3, z: 0 }, { x: 2, y: 1, z: 1 });
    const Mw = conjugateByShift(Ms, shift);
    const stored = new THREE.Vector3(4, 5, 6);
    const drawn = stored.clone().applyMatrix4(Ms);
    const shiftV = new THREE.Vector3(...shift);
    const baked = stored.clone().add(shiftV).applyMatrix4(Mw).sub(shiftV);
    expect(baked.x).toBeCloseTo(drawn.x, 6);
    expect(baked.y).toBeCloseTo(drawn.y, 6);
    expect(baked.z).toBeCloseTo(drawn.z, 6);
    // ...whereas the unconjugated matrix is thousands of kilometers out.
    const wrong = stored.clone().add(shiftV).applyMatrix4(Ms).sub(shiftV);
    expect(wrong.distanceTo(drawn)).toBeGreaterThan(1e6);
  });

  it('is a copy (no-op) for a null or zero shift', () => {
    const m = poseToMatrix({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 });
    expect(conjugateByShift(m, null).elements).toEqual(m.elements);
    expect(conjugateByShift(m, [0, 0, 0]).elements).toEqual(m.elements);
  });
});

describe('small helpers', () => {
  it('toRowMajor puts the translation in the last column of each row', () => {
    const m = new THREE.Matrix4().makeTranslation(7, 8, 9);
    const r = toRowMajor(m);
    expect([r[3], r[7], r[11], r[15]]).toEqual([7, 8, 9, 1]);
  });

  it('identity / uniform predicates', () => {
    expect(isIdentityDelta(IDENTITY_DELTA)).toBe(true);
    expect(isIdentityDelta({ ...IDENTITY_DELTA, s: { x: 1, y: 1, z: 1.001 } })).toBe(false);
    expect(isUniformScale({ x: 2, y: 2, z: 2 })).toBe(true);
    expect(isUniformScale({ x: 2, y: 2, z: 1 })).toBe(false);
    expect(verticalityOf(1)).toBeCloseTo(0, 9);
    expect(verticalityOf(0)).toBeCloseTo(90, 9);
  });
});

describe('transformNormalFields', () => {
  const field = (vals: number[]) => ({ values: new Float32Array(vals), min: Math.min(...vals), max: Math.max(...vals) });

  it('uses the inverse-transpose and renormalizes, leaving zero normals zero', () => {
    // Plane x + z = 0 under scale (2, 1, 1): the true normal becomes ∝ (0.5, 0, 1).
    const s = Math.SQRT1_2;
    const m = poseToMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 1 });
    const out = transformNormalFields({
      nx: field([s, 0]), ny: field([0, 0]), nz: field([s, 0]), verticality: field([45, 0]),
      intensity: field([1, 2]),
    }, m)!;
    const n = new THREE.Vector3(out.nx.values[0], out.ny.values[0], out.nz.values[0]);
    const want = new THREE.Vector3(0.5, 0, 1).normalize();
    expect(n.x).toBeCloseTo(want.x, 6);
    expect(n.z).toBeCloseTo(want.z, 6);
    expect(out.nx.values[1]).toBe(0);
    expect(out.nz.values[1]).toBe(0);
    expect(out.verticality.values[0]).toBeCloseTo(verticalityOf(want.z), 4);
    expect(out.intensity.values).toEqual(new Float32Array([1, 2]));  // untouched
  });

  it('returns the fields unchanged when the cloud has no normals', () => {
    const fields = { intensity: field([1]) };
    expect(transformNormalFields(fields, new THREE.Matrix4())).toBe(fields);
  });
});
