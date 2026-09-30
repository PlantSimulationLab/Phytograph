import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import {
  IDENTITY_DELTA, conjugateByShift, isIdentityDelta, isUniformScale, toRowMajor, transformNormalFields,
  verticalityOf,
} from './affineDelta';
import { poseToMatrix } from './octreePoseCompose';

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
