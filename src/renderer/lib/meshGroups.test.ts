import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { subsetMeshData } from './meshCrop';
import { serializeMeshObj } from './meshExport';
import {
  compactGroups,
  groupDisplayColor,
  groupLocalCentroid,
  groupTriangleCounts,
  intersectTriangleMasks,
  recolorGroups,
  remapHiddenGroups,
  splitGroups,
  transformGroups,
  unshareGroupVertices,
  visibleTriangleMask,
} from './meshGroups';
import { mergeMeshData } from './meshMerge';
import { parseOBJMesh } from './pointCloudParsers';
import type { MeshData } from './pointCloudTypes';

/**
 * Two triangles sharing an edge (vertices 1 and 2), each in its own group, plus
 * a third triangle in group "a" that shares vertex 0 with the first — so a
 * vertex shared ACROSS groups (1, 2) and one shared WITHIN a group (0) both exist.
 */
function shared(): MeshData {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, -1, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 1, 3, 2, 0, 2, 4]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    vertexCount: 5,
    triangleCount: 3,
    triangleGroupIds: new Uint32Array([0, 1, 0]),
    groupNames: ['a', 'b'],
  };
}

function worldTriangle(d: MeshData, t: number): number[][] {
  return [0, 1, 2].map((e) => {
    const v = d.indices[t * 3 + e];
    return Array.from(d.vertices.subarray(v * 3, v * 3 + 3));
  });
}

describe('masks', () => {
  it('leaves hidden and excluded groups out, and is null when nothing is', () => {
    const d = shared();
    expect(visibleTriangleMask(d, undefined)).toBeNull();
    expect(Array.from(visibleTriangleMask(d, [1])!)).toEqual([1, 0, 1]);
    expect(Array.from(visibleTriangleMask(d, [], new Set([0]))!)).toEqual([0, 1, 0]);
    expect(visibleTriangleMask({ ...d, triangleGroupIds: undefined, groupNames: undefined }, [0])).toBeNull();
  });

  it('intersects, treating null as everything', () => {
    const a = new Uint8Array([1, 0, 1]);
    expect(intersectTriangleMasks(null, a)).toBe(a);
    expect(Array.from(intersectTriangleMasks(a, new Uint8Array([1, 1, 0]))!)).toEqual([1, 0, 0]);
  });
});

describe('unshareGroupVertices', () => {
  it('splits vertices shared across groups and keeps ones shared within a group', () => {
    const d = unshareGroupVertices(shared());
    // Vertices 1 and 2 are each copied once for group b; vertex 0 is not.
    expect(d.vertexCount).toBe(7);
    expect(d.normals!.length).toBe(21);
    // Group a's triangles still share vertex 0.
    expect(d.indices[0]).toBe(d.indices[6]);
    // Group b no longer references any vertex group a uses.
    const aVerts = new Set([...d.indices.subarray(0, 3), ...d.indices.subarray(6, 9)]);
    for (const v of d.indices.subarray(3, 6)) expect(aVerts.has(v)).toBe(false);
    // Geometry is unchanged.
    for (let t = 0; t < 3; t++) expect(worldTriangle(d, t)).toEqual(worldTriangle(shared(), t));
  });

  it('returns the input when nothing is shared', () => {
    const d = { ...shared(), triangleGroupIds: new Uint32Array([0, 0, 0]) };
    expect(unshareGroupVertices(d)).toBe(d);
  });
});

describe('transformGroups', () => {
  it('moves only the selected group, by exactly m', () => {
    const before = shared();
    const m = new THREE.Matrix4().makeTranslation(2, 0, 0);
    const after = transformGroups(before, new Set([1]), m);
    expect(worldTriangle(after, 0)).toEqual(worldTriangle(before, 0));
    expect(worldTriangle(after, 2)).toEqual(worldTriangle(before, 2));
    expect(worldTriangle(after, 1)).toEqual(worldTriangle(before, 1).map(([x, y, z]) => [x + 2, y, z]));
  });

  it('rotates normals with the group', () => {
    const m = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    const after = transformGroups(shared(), new Set([0]), m);
    const v = after.indices[0];
    expect(after.normals![v * 3 + 1]).toBeCloseTo(-1);
    expect(after.normals![v * 3 + 2]).toBeCloseTo(0);
    // The other group's normals are untouched.
    const w = after.indices[3];
    expect(Array.from(after.normals!.subarray(w * 3, w * 3 + 3))).toEqual([0, 0, 1]);
  });

  it('centers its pivot on the group', () => {
    const c = groupLocalCentroid(shared(), new Set([1]))!;
    expect([c.x, c.y, c.z]).toEqual([2 / 3, 2 / 3, 0]);
  });
});

describe('recolorGroups', () => {
  it('fills a solid mesh from its base color and paints only the group', () => {
    const d = recolorGroups(shared(), new Set([1]), '#ff0000', '#00ff00');
    expect(groupDisplayColor(d, 1)).toBe('#ff0000');
    expect(groupDisplayColor(d, 0)).toBe('#00ff00');
  });
});

describe('compaction and splitting', () => {
  it('drops emptied groups and renumbers the rest', () => {
    const d = { ...shared(), triangleGroupIds: new Uint32Array([2, 2, 0]), groupNames: ['a', 'b', 'c'] };
    const c = compactGroups(d);
    expect(c.groupNames).toEqual(['a', 'c']);
    expect(Array.from(c.triangleGroupIds!)).toEqual([1, 1, 0]);
    expect(remapHiddenGroups([2], d.groupNames, c.groupNames)).toEqual([1]);
    expect(remapHiddenGroups([1], d.groupNames, c.groupNames)).toBeUndefined();
  });

  it('a crop subset keeps its triangles tagged', () => {
    const sub = subsetMeshData(shared(), new Uint8Array([0, 1, 1]), 1)!;
    expect(sub.groupNames).toEqual(['a', 'b']);
    expect(Array.from(sub.triangleGroupIds!)).toEqual([1, 0]);
  });

  it('splits a group off with its material triangles renumbered', () => {
    const materials = [{ name: 'm', hasAlpha: false, triangleIndices: [1, 2] }];
    const { rest, taken } = splitGroups(shared(), materials, new Set([1]));
    expect(rest!.data.triangleCount).toBe(2);
    expect(rest!.data.groupNames).toEqual(['a']);
    expect(rest!.materials![0].triangleIndices).toEqual([1]);
    expect(taken!.data.triangleCount).toBe(1);
    expect(taken!.data.groupNames).toEqual(['b']);
    expect(taken!.materials![0].triangleIndices).toEqual([0]);
    expect(groupTriangleCounts(taken!.data)).toEqual([1]);
  });

  it('splitting off every group leaves no rest', () => {
    expect(splitGroups(shared(), undefined, new Set([0, 1])).rest).toBeNull();
  });
});

describe('merge', () => {
  it('keeps each part\'s groups and names a group-less part after itself', () => {
    const plain: MeshData = {
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      vertexCount: 3,
      triangleCount: 1,
    };
    const { data } = mergeMeshData([
      { data: shared(), matrix: new THREE.Matrix4(), color: '#ffffff' },
      { data: plain, matrix: new THREE.Matrix4(), color: '#ffffff', name: 'a' },
    ]);
    expect(data.groupNames).toEqual(['a', 'b', 'a_2']);
    expect(Array.from(data.triangleGroupIds!)).toEqual([0, 1, 0, 2]);
  });
});

describe('OBJ round trip', () => {
  it('writes g lines that read back as the same groups', async () => {
    const d = { ...shared(), triangleGroupIds: new Uint32Array([1, 0, 1]), groupNames: ['left leaf', 'stem'] };
    const [obj] = serializeMeshObj(d, { baseName: 'm' });
    expect(obj.text).toContain('g left leaf');
    expect(obj.text).toContain('g stem');
    const back = await parseOBJMesh(new File([obj.text!], 'm.obj'));
    // Faces are written group-major, so group order (and every id) survives.
    expect(back.groupNames).toEqual(['left leaf', 'stem']);
    expect(groupTriangleCounts(back)).toEqual([1, 2]);
  });

  it('a mesh without groups writes no g lines', () => {
    const { triangleGroupIds: _i, groupNames: _n, ...plain } = shared();
    const [obj] = serializeMeshObj(plain, { baseName: 'm' });
    expect(obj.text).not.toMatch(/^g /m);
  });
});
