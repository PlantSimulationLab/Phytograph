import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import {
  isTexturedMeshData, mergeMeshData, mergedMeshName, meshMergeBlockReason, meshMergeSetBlockReason,
} from './meshMerge';
import { meshWorldMatrix } from './meshTransform';
import type { MeshData, MeshEntry, PlantMaterialDef } from './pointCloudTypes';

// One unit right triangle in the z=0 plane, facing +z.
function tri(extra: Partial<MeshData> = {}): MeshData {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    vertexCount: 3,
    triangleCount: 1,
    ...extra,
  };
}

// A unit square as two triangles sharing an edge (4 vertices, indexed).
function quad(extra: Partial<MeshData> = {}): MeshData {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    vertexCount: 4,
    triangleCount: 2,
    ...extra,
  };
}

const IDENTITY = new THREE.Matrix4();
const UP = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
const TEXTURE: PlantMaterialDef = { name: 'leaf', textureData: 'AAAA', hasAlpha: true, triangleIndices: [0] };
const TRI_UV = new Float32Array([0, 0, 1, 0, 0, 1]);

function entry(data: MeshData, extra: Partial<MeshEntry> = {}): MeshEntry {
  return { id: 'm', sourceCloudId: 'imported', data, visible: true, color: '#ff0000', method: 'delaunay', ...extra };
}

describe('mergeMeshData', () => {
  it('concatenates vertices and offsets each part\'s indices by the vertices before it', () => {
    const { data } = mergeMeshData([
      { data: quad(), matrix: IDENTITY, color: '#ff0000' },
      { data: tri(), matrix: IDENTITY, color: '#ff0000' },
    ]);
    expect(data.vertexCount).toBe(7);
    expect(data.triangleCount).toBe(3);
    expect(Array.from(data.indices)).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6]);
    expect(Array.from(data.vertices.subarray(12))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('bakes each part to where it is drawn', () => {
    // Second triangle: scaled 2x, turned 90° about z, then moved to (10, 0, 5).
    // Local (1,0,0) → scale (2,0,0) → rotate (0,2,0) → translate (10,2,5).
    const m = meshWorldMatrix({ x: 10, y: 0, z: 5 }, { x: 0, y: 0, z: 90 }, { x: 2, y: 2, z: 2 });
    const { data } = mergeMeshData([
      { data: tri(), matrix: IDENTITY, color: '#ff0000' },
      { data: tri(), matrix: m, color: '#ff0000' },
    ]);
    const v = Array.from(data.vertices.subarray(9)).map(x => Math.round(x * 1e5) / 1e5);
    expect(v).toEqual([10, 0, 5, 10, 2, 5, 8, 0, 5]);
    // The first part is untouched.
    expect(Array.from(data.vertices.subarray(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('rotates normals with the part and keeps them only when every part has them', () => {
    const flip = meshWorldMatrix({ x: 0, y: 0, z: 0 }, { x: 180, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    const both = mergeMeshData([
      { data: tri({ normals: UP.slice() }), matrix: IDENTITY, color: '#ff0000' },
      { data: tri({ normals: UP.slice() }), matrix: flip, color: '#ff0000' },
    ]).data;
    expect(both.normals!.length).toBe(18);
    expect(both.normals![2]).toBeCloseTo(1);
    expect(both.normals![11]).toBeCloseTo(-1);

    const one = mergeMeshData([
      { data: tri({ normals: UP.slice() }), matrix: IDENTITY, color: '#ff0000' },
      { data: tri(), matrix: IDENTITY, color: '#ff0000' },
    ]).data;
    expect(one.normals).toBeUndefined();
  });

  it('fills a part without vertex colors from its solid color, in linear space', () => {
    const colors = new Float32Array([0.1, 0.2, 0.3, 0.1, 0.2, 0.3, 0.1, 0.2, 0.3]);
    const { data } = mergeMeshData([
      { data: tri({ vertexColors: colors }), matrix: IDENTITY, color: '#00ff00' },
      { data: tri(), matrix: IDENTITY, color: '#808080' },
    ]);
    expect(data.vertexColors!.length).toBe(18);
    expect(data.vertexColors![0]).toBeCloseTo(0.1);
    expect(data.vertexColors![1]).toBeCloseTo(0.2);
    // sRGB 0x80 (0.502) is 0.2159 linear — NOT 0.502, which would draw too light.
    for (const i of [9, 10, 11, 15, 16, 17]) expect(data.vertexColors![i]).toBeCloseTo(0.2159, 3);
  });

  it('gives solids of different colors vertex colors so each keeps its own', () => {
    const { data } = mergeMeshData([
      { data: tri(), matrix: IDENTITY, color: '#ff0000' },
      { data: tri(), matrix: IDENTITY, color: '#0000ff' },
    ]);
    expect(Array.from(data.vertexColors!.subarray(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(data.vertexColors!.subarray(9, 12))).toEqual([0, 0, 1]);
  });

  it('leaves same-colored solids without vertex colors', () => {
    const { data } = mergeMeshData([
      { data: tri(), matrix: IDENTITY, color: '#FF0000' },
      { data: tri(), matrix: IDENTITY, color: '#ff0000' },
    ]);
    expect(data.vertexColors).toBeUndefined();
  });

  it('offsets material triangle ordinals and de-duplicates colliding names', () => {
    const part = (): { data: MeshData; matrix: THREE.Matrix4; color: string; materials: PlantMaterialDef[] } => ({
      data: tri({ uvCoordinates: TRI_UV.slice() }), matrix: IDENTITY, color: '#ff0000', materials: [{ ...TEXTURE }],
    });
    const { data, materials } = mergeMeshData([part(), part()]);
    expect(data.uvCoordinates!.length).toBe(12);
    expect(materials!.map(m => m.name)).toEqual(['leaf', 'leaf_2']);
    expect(materials!.map(m => m.triangleIndices)).toEqual([[0], [1]]);
    // Textured meshes ignore vertex colors; none are invented for them.
    expect(data.vertexColors).toBeUndefined();
  });

  it('drops materials unless every part has them', () => {
    const { materials } = mergeMeshData([
      { data: tri(), matrix: IDENTITY, color: '#ff0000', materials: [{ name: 'a', hasAlpha: false, triangleIndices: [0] }] },
      { data: tri(), matrix: IDENTITY, color: '#ff0000' },
    ]);
    expect(materials).toBeUndefined();
  });

  it('does not carry backend per-triangle metadata', () => {
    const { data } = mergeMeshData([
      { data: tri({ surfaceArea: 0.5, triangleScanIds: new Uint32Array([3]) }), matrix: IDENTITY, color: '#ff0000' },
      { data: tri(), matrix: IDENTITY, color: '#ff0000' },
    ]);
    expect(data.surfaceArea).toBeUndefined();
    expect(data.triangleScanIds).toBeUndefined();
  });
});

describe('meshMergeBlockReason', () => {
  it('allows imported meshes and primitive shapes', () => {
    expect(meshMergeBlockReason(entry(tri()), false)).toBeUndefined();
    expect(meshMergeBlockReason(entry(tri(), { sourceCloudId: 'shape-cylinder-1' }), false)).toBeUndefined();
    expect(meshMergeBlockReason(entry(tri(), { sourceCloudId: 'shape-plane-1', isPlane: true }), false)).toBeUndefined();
  });

  it('refuses triangulations, however they are recognized', () => {
    expect(meshMergeBlockReason(entry(tri()), true)).toMatch(/triangulation/);
    expect(meshMergeBlockReason(entry(tri(), { triangulationParams: { lmax: 0.1 } }), false)).toMatch(/triangulation/);
  });

  it('refuses the kinds a crop refuses', () => {
    expect(meshMergeBlockReason(entry(tri(), { gridSubdivisions: { x: 2, y: 2, z: 2 } }), false)).toMatch(/voxel grid/);
    expect(meshMergeBlockReason(entry(tri(), { isPlant: true }), false)).toMatch(/plant/);
    expect(meshMergeBlockReason(entry(tri(), { method: 'dem' }), false)).toMatch(/DEM/);
    expect(meshMergeBlockReason(entry(tri(), { method: 'crown' }), false)).toMatch(/crown/);
  });
});

describe('meshMergeSetBlockReason', () => {
  const textured = () => entry(tri({ uvCoordinates: TRI_UV.slice() }), { plantMaterials: [{ ...TEXTURE }] });

  it('refuses a mix of textured and untextured meshes', () => {
    expect(meshMergeSetBlockReason([textured(), entry(tri())])).toMatch(/Textured and untextured/);
  });

  it('allows an all-textured or all-untextured set', () => {
    expect(meshMergeSetBlockReason([textured(), textured()])).toBeUndefined();
    expect(meshMergeSetBlockReason([entry(tri()), entry(tri())])).toBeUndefined();
  });

  it('treats UVs without a texture as untextured', () => {
    const data = tri({ uvCoordinates: TRI_UV.slice() });
    expect(isTexturedMeshData(data, [{ name: 'flat', hasAlpha: false, triangleIndices: [0] }])).toBe(false);
    expect(isTexturedMeshData(data, [{ ...TEXTURE }])).toBe(true);
  });
});

describe('mergedMeshName', () => {
  it('joins the source names like a stitched cloud', () => {
    expect(mergedMeshName(['cube', 'sphere'], [])).toBe('cube_sphere_merged');
  });

  it('numbers the name when it is already taken', () => {
    expect(mergedMeshName(['a', 'b'], ['a_b_merged'])).toBe('a_b_merged (2)');
    expect(mergedMeshName(['a', 'b'], ['a_b_merged', 'a_b_merged (2)'])).toBe('a_b_merged (3)');
  });
});
