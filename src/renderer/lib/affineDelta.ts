import * as THREE from 'three';

import {
  NORMAL_X_ATTRIBUTE, NORMAL_Y_ATTRIBUTE, NORMAL_Z_ATTRIBUTE, VERTICALITY_ATTRIBUTE,
} from './classification';
import type { ScalarField } from './pointCloudTypes';

/**
 * Helpers for baking the Transformation tool's AFFINE draft (move, rotate and
 * scale about a pivot — see `poseToMatrix`) into geometry.
 *
 * A rigid transform lets you treat positions, normals and directions alike; a
 * scale does not. Positions take the full matrix, normals take the
 * inverse-transpose of its linear part (then renormalize), and anything read as
 * a length (a range, an extent) changes with it. Each helper here is one of
 * those rules, kept pure so it is testable without the viewer.
 */

type Vec3 = { x: number; y: number; z: number };

/**
 * The Transformation tool's one shared draft: move by `t`, rotate by `r`
 * (Euler XYZ, degrees) and scale by `s`, about the scene origin — applied to
 * every checked object alike. See `poseToMatrix` for the composition order.
 */
export interface AffineDelta {
  t: Vec3;
  r: Vec3;
  s: Vec3;
}

export const IDENTITY_DELTA: AffineDelta = Object.freeze({
  t: Object.freeze({ x: 0, y: 0, z: 0 }),
  r: Object.freeze({ x: 0, y: 0, z: 0 }),
  s: Object.freeze({ x: 1, y: 1, z: 1 }),
}) as AffineDelta;

export function isIdentityDelta(d: AffineDelta, eps = 1e-12): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) <= eps;
  return near(d.t.x, 0) && near(d.t.y, 0) && near(d.t.z, 0)
    && near(d.r.x, 0) && near(d.r.y, 0) && near(d.r.z, 0)
    && near(d.s.x, 1) && near(d.s.y, 1) && near(d.s.z, 1);
}

/** True when every axis of `s` is the same (a similarity when paired with R). */
export function isUniformScale(s: Vec3 | null | undefined): boolean {
  return !s || (s.x === s.y && s.y === s.z);
}

/** THREE's column-major Matrix4 as the ROW-MAJOR flat 16 the backend reads. */
export function toRowMajor(m: THREE.Matrix4): number[] {
  return m.clone().transpose().toArray();
}

/**
 * Re-express a matrix built in a cloud's STORED frame (world − worldShift, the
 * frame the renderer draws, bounds live in and the scene origin is picked in)
 * as the TRUE-WORLD matrix `session_transform` expects:
 *
 *     M_world = T(shift) · M_stored · T(−shift)
 *
 * Without it the backend computes L·(stored + shift) + t − shift, which is off
 * by (L·shift − shift): zero for a pure translation, and thousands of meters
 * for a rotation of a UTM-shifted scan.
 */
export function conjugateByShift(
  m: THREE.Matrix4,
  shift: readonly [number, number, number] | null | undefined,
): THREE.Matrix4 {
  if (!shift || (shift[0] === 0 && shift[1] === 0 && shift[2] === 0)) return m.clone();
  return new THREE.Matrix4()
    .makeTranslation(shift[0], shift[1], shift[2])
    .multiply(m)
    .multiply(new THREE.Matrix4().makeTranslation(-shift[0], -shift[1], -shift[2]));
}

/** The rotation quaternion of an Euler XYZ draft in DEGREES. */
export function rotationQuat(rotationDeg: Vec3): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(rotationDeg.x),
    THREE.MathUtils.degToRad(rotationDeg.y),
    THREE.MathUtils.degToRad(rotationDeg.z),
    'XYZ',
  ));
}

/** Verticality from a unit normal: degrees from vertical, folded to [0, 90]. */
export function verticalityOf(nz: number): number {
  return THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(nz))));
}

/**
 * Transform per-point normals held as `nx`/`ny`/`nz` scalar fields by the
 * inverse-transpose of `m`'s linear part and renormalize. Zero normals (points
 * that never received one) stay zero. Recomputes `verticality` when present,
 * since it is a function of the normal. Returns `scalarFields` unchanged when
 * the cloud carries no normals.
 */
export function transformNormalFields(
  scalarFields: Record<string, ScalarField> | undefined,
  m: THREE.Matrix4,
): Record<string, ScalarField> | undefined {
  const fx = scalarFields?.[NORMAL_X_ATTRIBUTE];
  const fy = scalarFields?.[NORMAL_Y_ATTRIBUTE];
  const fz = scalarFields?.[NORMAL_Z_ATTRIBUTE];
  if (!scalarFields || !fx || !fy || !fz) return scalarFields;
  const n = new THREE.Matrix3().getNormalMatrix(m).elements;  // column-major
  const len = fx.values.length;
  const ox = new Float32Array(len), oy = new Float32Array(len), oz = new Float32Array(len);
  const vf = scalarFields[VERTICALITY_ATTRIBUTE];
  const ov = vf ? new Float32Array(len) : null;
  for (let i = 0; i < len; i++) {
    const x = fx.values[i], y = fy.values[i], z = fz.values[i];
    let tx = n[0] * x + n[3] * y + n[6] * z;
    let ty = n[1] * x + n[4] * y + n[7] * z;
    let tz = n[2] * x + n[5] * y + n[8] * z;
    const l = Math.hypot(tx, ty, tz);
    if (l > 0) { tx /= l; ty /= l; tz /= l; }
    ox[i] = tx; oy[i] = ty; oz[i] = tz;
    if (ov) ov[i] = l > 0 ? verticalityOf(tz) : vf!.values[i];
  }
  const field = (values: Float32Array): ScalarField => {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { values, min: len ? min : 0, max: len ? max : 0 };
  };
  return {
    ...scalarFields,
    [NORMAL_X_ATTRIBUTE]: field(ox),
    [NORMAL_Y_ATTRIBUTE]: field(oy),
    [NORMAL_Z_ATTRIBUTE]: field(oz),
    ...(ov ? { [VERTICALITY_ATTRIBUTE]: field(ov) } : {}),
  };
}
