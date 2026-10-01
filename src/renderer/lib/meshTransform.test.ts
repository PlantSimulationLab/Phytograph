import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import {
  bakeResidualIntoMeshData, bakeTransformIntoMeshData, composeMeshDelta, forEachWorldVertex, matrix4FromRowMajor, meshWorldMatrix,
  meshWorldVertices, polarRotation,
} from './meshTransform';
import { poseToMatrix } from './octreePoseCompose';
import type { MeshData } from './pointCloudTypes';

function close(a: ArrayLike<number>, b: ArrayLike<number>, digits = 6) {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], digits);
}

describe('meshWorldMatrix', () => {
  it('matches the matrix three.js draws a mesh group with', () => {
    // The viewer sets position / Euler rotation (radians) / scale on a <group>.
    // Three hand-rolled copies used to rotate X, then Y, then Z instead, which
    // only agrees while at most one angle is non-zero — so use two or more.
    const p = { x: 1, y: -2, z: 3 };
    const r = { x: 30, y: 40, z: 50 };
    const s = { x: 2, y: 0.5, z: 1.5 };
    const o = new THREE.Object3D();
    o.position.set(p.x, p.y, p.z);
    o.rotation.set(THREE.MathUtils.degToRad(r.x), THREE.MathUtils.degToRad(r.y), THREE.MathUtils.degToRad(r.z));
    o.scale.set(s.x, s.y, s.z);
    o.updateMatrix();
    close(meshWorldMatrix(p, r, s).elements, o.matrix.elements, 9);
  });

  it('forEachWorldVertex pushes every vertex through the matrix', () => {
    const m = meshWorldMatrix({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, { x: 2, y: 2, z: 2 });
    const out: number[] = [];
    forEachWorldVertex(new Float32Array([1, 0, 0, 0, 1, 0]), 2, m, (x, y, z) => out.push(x, y, z));
    close(out, [10, 2, 0, 8, 0, 0]);
  });
});

describe('composeMeshDelta', () => {
  const P = { x: 0, y: 0, z: 0 };

  it('folds a translate + rotate + uniform scale into position / rotation / scale', () => {
    const D = poseToMatrix({ x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, P, { x: 2, y: 2, z: 2 });
    const res = composeMeshDelta(D, { position: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
    expect(res.kind).toBe('trs');
    if (res.kind !== 'trs') return;
    // (1,0,0) ×2 → (2,0,0) → Rz90 → (0,2,0) → +5x
    close([res.position.x, res.position.y, res.position.z], [5, 2, 0]);
    close([res.rotation.x, res.rotation.y, res.rotation.z], [0, 0, 90]);
    close([res.scale.x, res.scale.y, res.scale.z], [2, 2, 2]);
  });

  it('keeps a non-uniform scale on an axis-aligned mesh as a plain scale', () => {
    const D = poseToMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, P, { x: 2, y: 1, z: 1 });
    const res = composeMeshDelta(D, { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 3, z: 1 } });
    expect(res.kind).toBe('trs');
    if (res.kind === 'trs') close([res.scale.x, res.scale.y, res.scale.z], [2, 3, 1]);
  });

  it('bakes the shear of a non-uniform scale on a rotated mesh into a residual', () => {
    const D = poseToMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, P, { x: 2, y: 1, z: 1 });
    const mesh = { position: { x: 1, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 45 }, scale: { x: 1, y: 1, z: 1 } };
    const res = composeMeshDelta(D, mesh);
    expect(res.kind).toBe('residual');
    if (res.kind !== 'residual') return;
    // Drawn result: meshWorldMatrix(new) · K must equal D · meshWorldMatrix(old)
    // on every vertex.
    const before = meshWorldMatrix(mesh.position, mesh.rotation, mesh.scale);
    const after = meshWorldMatrix(res.position, res.rotation, { x: 1, y: 1, z: 1 });
    const K4 = new THREE.Matrix4().setFromMatrix3(res.K);
    for (const v of [[1, 0, 0], [0, 1, 0], [0.3, -0.7, 2]]) {
      const expected = new THREE.Vector3(...v).applyMatrix4(before).applyMatrix4(D);
      const got = new THREE.Vector3(...v).applyMatrix4(K4).applyMatrix4(after);
      close(got.toArray(), expected.toArray());
    }
    // K is symmetric positive-definite.
    const k = res.K.elements;
    expect(k[1]).toBeCloseTo(k[3], 9);
    expect(k[2]).toBeCloseTo(k[6], 9);
    expect(k[5]).toBeCloseTo(k[7], 9);
    expect(res.K.determinant()).toBeGreaterThan(0);
  });

  it('accounts for the mesh worldShift (its vertices are in the unshifted frame)', () => {
    const D = poseToMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, P);
    const ws: [number, number, number] = [1000, 0, 0];
    // Drawn at position − ws = (1, 0, 0) → rotated to (0, 1, 0) → stored + ws.
    const res = composeMeshDelta(D, {
      position: { x: 1001, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, worldShift: ws,
    });
    expect(res.kind).toBe('trs');
    if (res.kind === 'trs') close([res.position.x, res.position.y, res.position.z], [1000, 1, 0]);
  });

  it('blocks a shear on a voxel grid and on a plant, and a tilt on a grid', () => {
    const shear = poseToMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, P, { x: 2, y: 1, z: 1 });
    const rotated = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 30 }, scale: { x: 1, y: 1, z: 1 } };
    expect(composeMeshDelta(shear, { ...rotated, kind: 'grid' }).kind).toBe('blocked');
    expect(composeMeshDelta(shear, { ...rotated, kind: 'plant' }).kind).toBe('blocked');
    const tilt = poseToMatrix({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, P);
    const axisAligned = { ...rotated, rotation: { x: 0, y: 0, z: 0 }, kind: 'grid' as const };
    expect(composeMeshDelta(tilt, axisAligned).kind).toBe('blocked');
    const spin = poseToMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 25 }, P);
    expect(composeMeshDelta(spin, axisAligned).kind).toBe('trs');
  });
});

describe('polarRotation / bakeResidualIntoMeshData', () => {
  it('returns an orthonormal rotation', () => {
    const L = new THREE.Matrix3().set(2, 0.3, 0, 0.1, 1, 0.2, 0, 0.4, 0.5);
    const R = polarRotation(L);
    const I = R.clone().transpose().multiply(R);
    close(I.elements, new THREE.Matrix3().identity().elements, 9);
    expect(R.determinant()).toBeCloseTo(1, 9);
  });

  it('stretches vertices by K and keeps normals perpendicular to the surface', () => {
    const K = new THREE.Matrix3().set(2, 0, 0, 0, 1, 0, 0, 0, 1);
    // A plane x + z = 0 through the origin: two in-plane vertices, one normal.
    const data: MeshData = {
      vertices: new Float32Array([1, 0, -1, 0, 1, 0, 0, 0, 0]),
      normals: new Float32Array([Math.SQRT1_2, 0, Math.SQRT1_2, Math.SQRT1_2, 0, Math.SQRT1_2, Math.SQRT1_2, 0, Math.SQRT1_2]),
      indices: new Uint32Array([0, 1, 2]),
      vertexCount: 3,
      triangleCount: 1,
      surfaceArea: 1.23,
    };
    const out = bakeResidualIntoMeshData(data, K);
    close(Array.from(out.vertices.slice(0, 3)), [2, 0, -1]);
    const n = new THREE.Vector3(out.normals![0], out.normals![1], out.normals![2]);
    expect(n.length()).toBeCloseTo(1, 6);
    // Perpendicular to both transformed tangents: (2,0,-1) and (0,1,0).
    expect(n.dot(new THREE.Vector3(2, 0, -1))).toBeCloseTo(0, 6);
    expect(n.dot(new THREE.Vector3(0, 1, 0))).toBeCloseTo(0, 6);
    // Stale geometric metadata is dropped rather than left wrong.
    expect(out.surfaceArea).toBeUndefined();
    expect(data.vertices[0]).toBe(1);  // input untouched
  });
});

describe('applying a backend ICP matrix to a mesh', () => {
  // The two ICP tools send the mesh as drawn and compose the returned matrix
  // onto its transform. Both used to send `vertex + position` and overwrite the
  // rotation, which is only right for an unscaled mesh.
  const local = new Float32Array([1, 0, 0, 0, 2, 0, 0, 0, 3, -1, 1, 2]);
  const transform = {
    position: { x: 40, y: 30, z: -300 },
    rotation: { x: 20, y: -35, z: 80 },
    scale: { x: 0.5, y: 0.5, z: 2 },
  };
  // A rigid delta as NumPy would flatten it: 90° about Z, then a translation.
  const rowMajor = [
    0, -1, 0, 7,
    1, 0, 0, -3,
    0, 0, 1, 12,
    0, 0, 0, 1,
  ];

  it('reads a row-major matrix without transposing it', () => {
    const p = new THREE.Vector3(1, 0, 0).applyMatrix4(matrix4FromRowMajor(rowMajor));
    close([p.x, p.y, p.z], [7, -2, 12]);
  });

  it('lands a rotated, scaled mesh exactly where the matrix sends its drawn vertices', () => {
    const W = meshWorldMatrix(transform.position, transform.rotation, transform.scale);
    const sent = meshWorldVertices(local, 4, W);
    const D = matrix4FromRowMajor(rowMajor);
    const res = composeMeshDelta(D, transform);
    expect(res.kind).toBe('trs');
    if (res.kind !== 'trs') return;
    close([res.scale.x, res.scale.y, res.scale.z], [0.5, 0.5, 2]);

    const redrawn = meshWorldVertices(local, 4, meshWorldMatrix(res.position, res.rotation, transform.scale));
    const expected: number[] = [];
    for (let i = 0; i < 4; i++) {
      const v = new THREE.Vector3(sent[i * 3], sent[i * 3 + 1], sent[i * 3 + 2]).applyMatrix4(D);
      expected.push(v.x, v.y, v.z);
    }
    close(redrawn, expected, 3);
  });
});

describe('bakeTransformIntoMeshData', () => {
  const data = {
    vertices: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    normals: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    vertexCount: 3,
    triangleCount: 1,
  } as unknown as MeshData;

  it('returns the same data for an untransformed mesh', () => {
    const m = meshWorldMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    expect(bakeTransformIntoMeshData(data, m)).toBe(data);
  });

  it('writes vertices where the mesh is drawn and turns the normals with it', () => {
    // 90° about Z, doubled along the mesh's own X, then moved.
    const m = meshWorldMatrix({ x: 10, y: 20, z: 30 }, { x: 0, y: 0, z: 90 }, { x: 2, y: 1, z: 1 });
    const out = bakeTransformIntoMeshData(data, m);
    close(out.vertices, [10, 22, 30, 9, 20, 30, 10, 20, 31]);
    close(out.normals!, [0, 1, 0, -1, 0, 0, 0, 0, 1]);
    // The source mesh is untouched.
    close(data.vertices, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});
