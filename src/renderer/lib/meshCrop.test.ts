import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import {
  countMask, cropMeshEntry, meshCropBlockReason, meshTriangleRegionMask, meshWorldBounds,
  subsetMaterials, subsetMeshData,
} from './meshCrop';
import { meshWorldMatrix } from './meshTransform';
import type { MeshData, MeshEntry } from './pointCloudTypes';
import { computeTriangleMetrics } from './triangleFilter';

// A strip of four unit right triangles along +x, two per unit square:
//   square 0 spans x 0..1 (triangles 0, 1), square 1 spans x 1..2 (triangles 2, 3).
// Vertices are shared between the squares, so cutting between them must drop
// the two vertices only the removed square used.
function strip(): MeshData {
  const vertices = new Float32Array([
    0, 0, 0,  1, 0, 0,  2, 0, 0,
    0, 1, 0,  1, 1, 0,  2, 1, 0,
  ]);
  const indices = new Uint32Array([
    0, 1, 4,  0, 4, 3,
    1, 2, 5,  1, 5, 4,
  ]);
  return {
    vertices,
    indices,
    vertexCount: 6,
    triangleCount: 4,
    surfaceArea: 2,
    vertexColors: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5]),
    triangleScanIds: new Uint32Array([10, 11, 12, 13]),
    triangleCellIds: new Uint32Array([0, 0, 1, 1]),
  };
}

const IDENTITY = new THREE.Matrix4();
const leftHalf = (x: number) => x < 1;

function entry(data: MeshData, extra: Partial<MeshEntry> = {}): MeshEntry {
  return { id: 'm', sourceCloudId: 'imported', data, visible: true, color: '#fff', method: 'ball_pivoting', ...extra };
}

describe('meshTriangleRegionMask', () => {
  it('classifies each triangle by its centroid', () => {
    const mask = meshTriangleRegionMask(strip(), IDENTITY, leftHalf);
    expect(Array.from(mask)).toEqual([1, 1, 0, 0]);
    expect(countMask(mask, 1)).toBe(2);
    expect(countMask(mask, 0)).toBe(2);
  });

  it('keeps a triangle whole when it straddles the boundary', () => {
    // Triangle 0's centroid is at x = 2/3. A boundary at x = 0.7 leaves one of
    // its vertices (x = 1) outside, and the triangle still counts as inside.
    const mask = meshTriangleRegionMask(strip(), IDENTITY, (x) => x < 0.7);
    expect(mask[0]).toBe(1);
    // Triangle 1's centroid is at x = 1/3: inside. Nothing right of it is.
    expect(Array.from(mask)).toEqual([1, 1, 0, 0]);
  });

  it('tests the DRAWN position, not the stored vertices', () => {
    // Moved +5 in x and turned 90 deg about z, the strip runs along +y from
    // x = 5: square 0 covers y 0..1, square 1 covers y 1..2.
    const m = meshWorldMatrix({ x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 90 }, { x: 1, y: 1, z: 1 });
    const mask = meshTriangleRegionMask(strip(), m, (_x, y) => y < 1);
    expect(Array.from(mask)).toEqual([1, 1, 0, 0]);
    // The same region against the untransformed mesh selects differently —
    // which is what a crop that ignored the transform would have cut.
    const stored = meshTriangleRegionMask(strip(), IDENTITY, (_x, y) => y < 1);
    expect(Array.from(stored)).toEqual([1, 1, 1, 1]);
  });
});

describe('meshWorldBounds', () => {
  it('bounds the transformed vertices', () => {
    const m = meshWorldMatrix({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 1 });
    expect(meshWorldBounds(strip(), m)).toEqual({ min: { x: 10, y: 0, z: 0 }, max: { x: 14, y: 1, z: 0 } });
  });

  it('is null for an empty mesh', () => {
    const empty: MeshData = { vertices: new Float32Array(), indices: new Uint32Array(), vertexCount: 0, triangleCount: 0 };
    expect(meshWorldBounds(empty, IDENTITY)).toBeNull();
  });
});

describe('subsetMeshData', () => {
  it('drops unused vertices and renumbers the index', () => {
    const data = strip();
    const out = subsetMeshData(data, meshTriangleRegionMask(data, IDENTITY, leftHalf), 1)!;
    expect(out.triangleCount).toBe(2);
    // Square 0 uses vertices 0, 1, 3, 4 → renumbered 0, 1, 2, 3 in that order.
    expect(out.vertexCount).toBe(4);
    expect(Array.from(out.vertices)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    expect(Array.from(out.indices)).toEqual([0, 1, 3, 0, 3, 2]);
    // Per-vertex and per-triangle arrays follow their owners.
    expect(Array.from(out.vertexColors!)).toEqual([0, 0, 0, 1, 1, 1, 3, 3, 3, 4, 4, 4]);
    expect(Array.from(out.triangleScanIds!)).toEqual([10, 11]);
    expect(Array.from(out.triangleCellIds!)).toEqual([0, 0]);
    expect(out.surfaceArea).toBeCloseTo(1, 6);
  });

  it('the two sides partition the mesh', () => {
    const data = strip();
    const mask = meshTriangleRegionMask(data, IDENTITY, leftHalf);
    const a = subsetMeshData(data, mask, 1)!;
    const b = subsetMeshData(data, mask, 0)!;
    expect(a.triangleCount + b.triangleCount).toBe(data.triangleCount);
    expect(a.surfaceArea! + b.surfaceArea!).toBeCloseTo(data.surfaceArea!, 6);
    expect(Array.from(b.triangleScanIds!)).toEqual([12, 13]);
    // The other side's geometry is the square at x 1..2.
    expect(Math.min(...Array.from(b.vertices).filter((_, i) => i % 3 === 0))).toBe(1);
  });

  it('returns null when nothing matches', () => {
    const data = strip();
    expect(subsetMeshData(data, new Uint8Array(4), 1)).toBeNull();
  });

  it('leaves surface area undefined when the source never had one', () => {
    const data = { ...strip(), surfaceArea: undefined };
    expect(subsetMeshData(data, new Uint8Array([1, 0, 0, 0]), 1)!.surfaceArea).toBeUndefined();
  });

  it('does not carry a per-triangle array of the wrong length', () => {
    // A stale array is worse than none: it would silently mislabel triangles.
    const data = { ...strip(), triangleScanIds: new Uint32Array([1, 2]) };
    expect(subsetMeshData(data, new Uint8Array([1, 1, 0, 0]), 1)!.triangleScanIds).toBeUndefined();
  });

  it('keeps a triangle-expanded mesh triangle-expanded', () => {
    // Textured meshes store triangle t at vertices 3t..3t+2 and are drawn
    // without consulting the index, so the subset must keep that layout.
    const vertices = new Float32Array(27);
    for (let i = 0; i < 27; i++) vertices[i] = i;
    const uv = new Float32Array(18);
    for (let i = 0; i < 18; i++) uv[i] = i;
    const data: MeshData = {
      vertices, indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      uvCoordinates: uv, vertexCount: 9, triangleCount: 3,
    };
    const out = subsetMeshData(data, new Uint8Array([1, 0, 1]), 1)!;
    expect(Array.from(out.indices)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Array.from(out.vertices)).toEqual([...Array(9).keys(), ...Array.from({ length: 9 }, (_, i) => 18 + i)]);
    expect(Array.from(out.uvCoordinates!)).toEqual([0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17]);
  });
});

describe('subsetMaterials', () => {
  it('renumbers triangle ordinals and drops emptied materials', () => {
    const mats = [
      { name: 'leaf', hasAlpha: true, triangleIndices: [0, 2] },
      { name: 'stem', hasAlpha: false, triangleIndices: [1] },
    ];
    // Keep triangles 0 and 2 → they become 0 and 1; 'stem' loses its only one.
    expect(subsetMaterials(mats, new Uint8Array([1, 0, 1]), 1)).toEqual([
      { name: 'leaf', hasAlpha: true, triangleIndices: [0, 1] },
    ]);
    expect(subsetMaterials(mats, new Uint8Array([1, 0, 1]), 0)).toEqual([
      { name: 'stem', hasAlpha: false, triangleIndices: [0] },
    ]);
    expect(subsetMaterials(undefined, new Uint8Array(3), 1)).toBeUndefined();
  });
});

describe('cropMeshEntry', () => {
  it('builds only the sides asked for', () => {
    const r = cropMeshEntry(entry(strip()), IDENTITY, leftHalf, { inside: true, outside: false });
    expect(r.inside!.data.triangleCount).toBe(2);
    expect(r.outside).toBeNull();
  });

  it('reports an empty side as null', () => {
    const r = cropMeshEntry(entry(strip()), IDENTITY, () => false, { inside: true, outside: true });
    expect(r.inside).toBeNull();
    expect(r.outside!.data.triangleCount).toBe(4);
  });

  it('cuts the unfiltered candidates, so loosening the filter cannot undo the crop', () => {
    // Stretch square 1's far vertices so its triangles have a long edge, then
    // filter them out. The visible mesh is square 0 only; the candidates are
    // all four triangles.
    const full = strip();
    full.vertices[6] = 6;   // vertex 2 x
    full.vertices[15] = 6;  // vertex 5 x
    Object.assign(full, computeTriangleMetrics(full));
    const mesh = entry(full, {
      unfilteredMesh: {
        data: full,
        estimate: { lmax: null, eta: 0, label: 'n/a', sepRatio: null, sepLabel: 'n/a', merged: false, mergedMessage: null },
        cap: { lmax: 100, maxAspectRatio: 100 },
      },
      triangleFilter: { lmax: 2, maxAspectRatio: 100 },
    });

    // Keep everything right of x = 1: that is exactly the filtered-out square.
    const r = cropMeshEntry(mesh, IDENTITY, (x) => x > 1, { inside: true, outside: true });
    // Nothing VISIBLE survives inside, so that side is empty…
    expect(r.inside).toBeNull();
    // …and the outside keeps square 0, with the candidate set cut down to it.
    expect(r.outside!.data.triangleCount).toBe(2);
    expect(r.outside!.unfilteredMesh!.data.triangleCount).toBe(2);
    expect(r.outside!.unfilteredMesh!.data.triEdgeMax!.length).toBe(2);
  });

  it('renumbers material groups along with the triangles', () => {
    const mesh = entry(strip(), {
      plantMaterials: [{ name: 'a', hasAlpha: false, triangleIndices: [2, 3] }],
    });
    const r = cropMeshEntry(mesh, IDENTITY, leftHalf, { inside: true, outside: true });
    expect(r.inside!.plantMaterials).toEqual([]);
    expect(r.outside!.plantMaterials).toEqual([{ name: 'a', hasAlpha: false, triangleIndices: [0, 1] }]);
  });
});

describe('meshCropBlockReason', () => {
  it('allows ordinary surfaces', () => {
    expect(meshCropBlockReason(entry(strip()))).toBeUndefined();
    expect(meshCropBlockReason(entry(strip(), { method: 'helios' }))).toBeUndefined();
  });

  it('blocks meshes whose other state describes the whole shape', () => {
    expect(meshCropBlockReason(entry(strip(), { gridSubdivisions: { x: 1, y: 1, z: 1 } }))).toMatch(/voxel grid/);
    expect(meshCropBlockReason(entry(strip(), { isPlant: true }))).toMatch(/plant/);
    expect(meshCropBlockReason(entry(strip(), { method: 'dem' }))).toMatch(/DEM/);
    expect(meshCropBlockReason(entry(strip(), { method: 'crown' }))).toMatch(/crown/);
  });
});
