import * as THREE from 'three';

import type { MeshData } from './pointCloudTypes';

type Vec3 = { x: number; y: number; z: number };

/**
 * A mesh's local → world matrix, exactly as the viewer draws it: the mesh
 * `<group>` sets position, Euler 'XYZ' rotation (DEGREES) and scale, which
 * three.js composes as M = T(p) · R · S with R = Rx·Ry·Rz.
 *
 * Everything that needs a mesh's world geometry off-screen (framing, scene
 * bounds, synthetic scans) must go through this rather than hand-rolling the
 * rotation. Three hand-rolled copies used to rotate about X, then Y, then Z —
 * i.e. Rz·Ry·Rx — which agrees with the drawn mesh only while at most one axis
 * is non-zero, so a mesh turned about two axes was scanned somewhere other
 * than where it appeared.
 */
export function meshWorldMatrix(position: Vec3, rotationDeg: Vec3, scale: Vec3): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(position.x, position.y, position.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(rotationDeg.x),
      THREE.MathUtils.degToRad(rotationDeg.y),
      THREE.MathUtils.degToRad(rotationDeg.z),
      'XYZ',
    )),
    new THREE.Vector3(scale.x, scale.y, scale.z),
  );
}

/** Push `vertexCount` interleaved xyz vertices through `m`; calls `emit` per vertex. */
export function forEachWorldVertex(
  vertices: ArrayLike<number>,
  vertexCount: number,
  m: THREE.Matrix4,
  emit: (x: number, y: number, z: number, i: number) => void,
): void {
  const e = m.elements;  // column-major
  for (let i = 0; i < vertexCount; i++) {
    const x = vertices[i * 3], y = vertices[i * 3 + 1], z = vertices[i * 3 + 2];
    emit(
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14],
      i,
    );
  }
}

/**
 * A mesh's vertices in WORLD space as a packed Float32Array — what a backend
 * tool that registers or measures the mesh must be sent. Sending
 * `vertex + position` instead (as both ICP tools once did) drops the mesh's
 * rotation and scale, so the backend aligns a shape that is not the one drawn
 * and returns a matrix sized for it: on a scaled mesh the result landed the
 * mesh far from its target.
 */
export function meshWorldVertices(vertices: ArrayLike<number>, vertexCount: number, m: THREE.Matrix4): Float32Array {
  const out = new Float32Array(vertexCount * 3);
  forEachWorldVertex(vertices, vertexCount, m, (x, y, z, i) => {
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
  });
  return out;
}

/**
 * A backend 4x4 (NumPy `flatten()`, row-major) as a THREE.Matrix4.
 * `Matrix4.set` takes row-major arguments, so no transpose is needed.
 */
export function matrix4FromRowMajor(m: ArrayLike<number>): THREE.Matrix4 {
  return new THREE.Matrix4().set(
    m[0], m[1], m[2], m[3],
    m[4], m[5], m[6], m[7],
    m[8], m[9], m[10], m[11],
    m[12], m[13], m[14], m[15],
  );
}

/**
 * The result of composing a world-space delta D onto one mesh's transform.
 *
 *  - `trs`: D ∘ mesh is still position + Euler rotation + axis scale.
 *  - `residual`: it is not — a non-uniform scale applied to a mesh whose axes
 *    are not aligned with the scale axes is a SHEAR in the mesh's frame. The
 *    rotation part goes to the transform, and the leftover symmetric stretch
 *    `K` must be baked into the vertices (see `bakeResidualIntoMeshData`).
 *  - `blocked`: the mesh cannot take this delta at all (see `reason`).
 */
export type MeshDeltaResult =
  | { kind: 'trs'; position: Vec3; rotation: Vec3; scale: Vec3 }
  | { kind: 'residual'; position: Vec3; rotation: Vec3; K: THREE.Matrix3 }
  | { kind: 'blocked'; reason: string };

const OFF_DIAGONAL_TOL = 1e-9;

/**
 * Compose the Transformation tool's delta `D` (a world-space affine in the
 * scene's render frame, e.g. `poseToMatrix(t, r, pivot, s)`) onto a mesh whose
 * drawn matrix is T(position − worldShift)·R·S.
 *
 * With W = T(p − ws)·R·S the new world matrix is W' = D·W, so
 *   p′ = D(p − ws) + ws,     L′ = L_D · R · S.
 * L′ splits into a rotation times an axis scale iff L′ᵀL′ is diagonal.
 * Otherwise a polar decomposition L′ = R″·K (R″ a rotation, K symmetric
 * positive-definite) keeps the rotation on the transform and hands back K.
 *
 * `kind` says what the mesh is, because two kinds cannot take a residual:
 * a voxel GRID must stay an axis-scaled box that only turns about Z (its
 * subdivisions index cells along its own axes), and a generated PLANT is
 * regenerated from parameters by Morph/Age, which would silently drop baked
 * vertex edits.
 */
export function composeMeshDelta(
  D: THREE.Matrix4,
  mesh: {
    position: Vec3;
    rotation: Vec3;
    scale: Vec3;
    worldShift?: readonly [number, number, number] | null;
    kind?: 'grid' | 'plant' | 'mesh';
  },
): MeshDeltaResult {
  const ws = mesh.worldShift ?? [0, 0, 0];
  const p = new THREE.Vector3(mesh.position.x - ws[0], mesh.position.y - ws[1], mesh.position.z - ws[2])
    .applyMatrix4(D);
  const position = { x: p.x + ws[0], y: p.y + ws[1], z: p.z + ws[2] };

  const W = meshWorldMatrix({ x: 0, y: 0, z: 0 }, mesh.rotation, mesh.scale);
  const L = new THREE.Matrix3().setFromMatrix4(D).multiply(new THREE.Matrix3().setFromMatrix4(W));
  if (L.determinant() <= 0) {
    return { kind: 'blocked', reason: 'Scale factors must be positive.' };
  }

  // G = LᵀL. Diagonal ⇔ L's columns are orthogonal ⇔ L = R·diag(s).
  const G = L.clone().transpose().multiply(L).elements;  // column-major 3x3
  const diagMax = Math.max(G[0], G[4], G[8]);
  const offMax = Math.max(Math.abs(G[1]), Math.abs(G[2]), Math.abs(G[5]));
  if (offMax <= OFF_DIAGONAL_TOL * diagMax) {
    const scale = { x: Math.sqrt(G[0]), y: Math.sqrt(G[4]), z: Math.sqrt(G[8]) };
    const R = L.clone().multiply(new THREE.Matrix3().set(
      1 / scale.x, 0, 0,
      0, 1 / scale.y, 0,
      0, 0, 1 / scale.z,
    ));
    const rotation = eulerDegFromMatrix3(R);
    if (mesh.kind === 'grid' && (Math.abs(rotation.x) > 1e-6 || Math.abs(rotation.y) > 1e-6)) {
      return { kind: 'blocked', reason: 'A voxel grid can only rotate about Z.' };
    }
    return { kind: 'trs', position, rotation, scale };
  }

  if (mesh.kind === 'grid') {
    return { kind: 'blocked', reason: 'A non-uniform scale would shear this rotated voxel grid.' };
  }
  if (mesh.kind === 'plant') {
    return {
      kind: 'blocked',
      reason: 'A non-uniform scale would shear this rotated plant; plants must keep their generated shape.',
    };
  }
  const R = polarRotation(L);
  const K = R.clone().transpose().multiply(L);
  return { kind: 'residual', position, rotation: eulerDegFromMatrix3(R), K };
}

/** Euler 'XYZ' angles (DEGREES) of a pure rotation matrix. */
function eulerDegFromMatrix3(R: THREE.Matrix3): Vec3 {
  const m4 = new THREE.Matrix4().setFromMatrix3(R);
  const e = new THREE.Euler().setFromRotationMatrix(m4, 'XYZ');
  const clean = (rad: number) => {
    const d = THREE.MathUtils.radToDeg(rad);
    return Math.abs(d) < 1e-9 ? 0 : d;
  };
  return { x: clean(e.x), y: clean(e.y), z: clean(e.z) };
}

/**
 * The rotation factor of the polar decomposition L = R·K, by Newton iteration
 * R ← (R + R⁻ᵀ)/2. Converges quadratically for det(L) > 0 (the caller checks).
 */
export function polarRotation(L: THREE.Matrix3): THREE.Matrix3 {
  let R = L.clone();
  for (let i = 0; i < 50; i++) {
    const invT = R.clone().invert().transpose();
    const next = new THREE.Matrix3();
    for (let k = 0; k < 9; k++) next.elements[k] = 0.5 * (R.elements[k] + invT.elements[k]);
    let diff = 0;
    for (let k = 0; k < 9; k++) diff = Math.max(diff, Math.abs(next.elements[k] - R.elements[k]));
    R = next;
    if (diff < 1e-14) break;
  }
  return R;
}

/**
 * Bake a residual stretch `K` (from `composeMeshDelta`) into a mesh's LOCAL
 * geometry: vertices v ← K·v, normals n ← normalize(K⁻ᵀ·n) (K is symmetric,
 * so K⁻ᵀ = K⁻¹). Returns a new MeshData; the input is untouched.
 *
 * Per-triangle metadata that is a function of the geometry but was computed by
 * the backend (surfaceArea, triEdgeMax, triAspect) is dropped rather than left
 * stale — the consumers treat an absent field as "not available".
 */
export function bakeResidualIntoMeshData(data: MeshData, K: THREE.Matrix3): MeshData {
  const k = K.elements;  // column-major
  const vertices = new Float32Array(data.vertices.length);
  for (let i = 0; i < data.vertexCount; i++) {
    const x = data.vertices[i * 3], y = data.vertices[i * 3 + 1], z = data.vertices[i * 3 + 2];
    vertices[i * 3] = k[0] * x + k[3] * y + k[6] * z;
    vertices[i * 3 + 1] = k[1] * x + k[4] * y + k[7] * z;
    vertices[i * 3 + 2] = k[2] * x + k[5] * y + k[8] * z;
  }
  let normals: Float32Array | undefined;
  if (data.normals) {
    const n = K.clone().invert().transpose().elements;
    normals = new Float32Array(data.normals.length);
    for (let i = 0; i < data.normals.length; i += 3) {
      const x = data.normals[i], y = data.normals[i + 1], z = data.normals[i + 2];
      let tx = n[0] * x + n[3] * y + n[6] * z;
      let ty = n[1] * x + n[4] * y + n[7] * z;
      let tz = n[2] * x + n[5] * y + n[8] * z;
      const l = Math.hypot(tx, ty, tz);
      if (l > 0) { tx /= l; ty /= l; tz /= l; }
      normals[i] = tx; normals[i + 1] = ty; normals[i + 2] = tz;
    }
  }
  const { surfaceArea: _a, triEdgeMax: _e, triAspect: _r, ...rest } = data;
  return { ...rest, vertices, ...(normals ? { normals } : {}) };
}
