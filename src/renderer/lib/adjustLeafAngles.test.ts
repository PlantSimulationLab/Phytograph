import { describe, it, expect } from 'vitest';
import {
  isLeafAngleSourceMesh,
  qsmAabb,
  gridOverlapsQsm,
  eligibleLeafAngleMeshes,
  meshToTriangulationInput,
  meanLeafInclination,
} from './adjustLeafAngles';
import type { MeshData, MeshEntry, QSMEntry } from './pointCloudTypes';

function meshData(opts: { withGrid?: boolean; withCells?: boolean; gridCenter?: [number, number, number] } = {}): MeshData {
  const { withGrid = true, withCells = true, gridCenter = [0, 0, 0] } = opts;
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    vertexCount: 3,
    triangleCount: 1,
    ...(withCells ? { triangleCellIds: new Uint32Array([0]) } : {}),
    ...(withGrid ? { grid: { center: gridCenter, size: [2, 2, 2], nx: 1, ny: 1, nz: 1 } } : {}),
  } as MeshData;
}

function mesh(id: string, method: MeshEntry['method'], data: MeshData): MeshEntry {
  return { id, sourceCloudId: 'c', data, visible: true, color: '#fff', method };
}

function qsm(cyls: { start: [number, number, number]; end: [number, number, number] }[]): QSMEntry {
  return {
    id: 'q',
    sourceCloudId: 'c',
    cylinders: cyls.map((c, i) => ({
      cyl_id: i, start: c.start, end: c.end, radius: 0.02, parent_id: -1,
      shoot_id: 0, rank: 0, surf_cov: null, mad: null,
    })),
    shoots: [],
    metrics: null,
    visible: true,
  };
}

describe('isLeafAngleSourceMesh', () => {
  it('accepts a Helios mesh with cell ids + grid', () => {
    expect(isLeafAngleSourceMesh(mesh('m', 'helios', meshData()))).toBe(true);
  });
  it('rejects non-Helios, or missing grid / cell ids', () => {
    expect(isLeafAngleSourceMesh(mesh('m', 'poisson', meshData()))).toBe(false);
    expect(isLeafAngleSourceMesh(mesh('m', 'helios', meshData({ withGrid: false })))).toBe(false);
    expect(isLeafAngleSourceMesh(mesh('m', 'helios', meshData({ withCells: false })))).toBe(false);
  });
});

describe('qsmAabb + gridOverlapsQsm', () => {
  it('computes the cylinder AABB', () => {
    const box = qsmAabb(qsm([{ start: [0, 0, 0], end: [1, 2, 3] }]))!;
    expect(box.min).toEqual([0, 0, 0]);
    expect(box.max).toEqual([1, 2, 3]);
  });
  it('detects overlap and disjointness', () => {
    const q = qsm([{ start: [0, 0, 0], end: [1, 1, 1] }]);
    // grid centered at origin (covers 0..1) -> overlaps
    expect(gridOverlapsQsm(mesh('m', 'helios', meshData({ gridCenter: [0, 0, 0] })), q)).toBe(true);
    // grid centered far away -> disjoint
    expect(gridOverlapsQsm(mesh('m', 'helios', meshData({ gridCenter: [100, 100, 100] })), q)).toBe(false);
  });
});

describe('eligibleLeafAngleMeshes', () => {
  it('keeps only overlapping Helios grid meshes', () => {
    const q = qsm([{ start: [0, 0, 0], end: [1, 1, 1] }]);
    const meshes = [
      mesh('ok', 'helios', meshData({ gridCenter: [0, 0, 0] })),
      mesh('far', 'helios', meshData({ gridCenter: [100, 100, 100] })),
      mesh('cloud', 'poisson', meshData({ gridCenter: [0, 0, 0] })),
    ];
    const eligible = eligibleLeafAngleMeshes(meshes, q);
    expect(eligible.map(m => m.id)).toEqual(['ok']);
  });
});

describe('meshToTriangulationInput', () => {
  it('flattens typed arrays to number[] and maps the grid', () => {
    const tin = meshToTriangulationInput(meshData())!;
    expect(tin.vertices).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(tin.indices).toEqual([0, 1, 2]);
    expect(tin.triangle_cell_ids).toEqual([0]);
    expect(tin.grid).toEqual({ center: [0, 0, 0], size: [2, 2, 2], nx: 1, ny: 1, nz: 1 });
  });
  it('maps the 0xffffffff outside-sentinel to -1', () => {
    const data = meshData();
    data.triangleCellIds = new Uint32Array([0xffffffff]);
    expect(meshToTriangulationInput(data)!.triangle_cell_ids).toEqual([-1]);
  });
  it('returns null without a grid or cell ids', () => {
    expect(meshToTriangulationInput(meshData({ withGrid: false }))).toBeNull();
    expect(meshToTriangulationInput(meshData({ withCells: false }))).toBeNull();
  });
});

describe('meanLeafInclination', () => {
  it('reads horizontal leaves (+z normal) as ~0 deg', () => {
    const data = { normals: new Float32Array([0, 0, 1, 0, 0, 1]) } as unknown as MeshData;
    expect(meanLeafInclination(data)).toBeCloseTo(0, 5);
  });
  it('reads vertical leaves (+x normal) as ~90 deg, folding |nz|', () => {
    const data = { normals: new Float32Array([1, 0, 0, 0, 0, -1]) } as unknown as MeshData;
    // first normal -> 90 deg, second (downward) folds to 0 deg -> mean 45.
    expect(meanLeafInclination(data)).toBeCloseTo(45, 5);
  });
  it('returns NaN without normals', () => {
    expect(meanLeafInclination({} as MeshData)).toBeNaN();
  });
});
