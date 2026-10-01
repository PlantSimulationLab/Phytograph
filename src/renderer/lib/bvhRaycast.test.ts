import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { buildBoundsTree, freeBoundsTree, installBvhRaycast } from './bvhRaycast';

// 200 small triangles scattered through a 100 m cube — enough that the tree has
// to partition them, which is when a default (non-indirect) build re-sorts the
// index buffer.
function scattered(n = 200) {
  let s = 1;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const positions = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const cx = rnd() * 100, cy = rnd() * 100, cz = rnd() * 100;
    for (let v = 0; v < 3; v++) {
      positions[t * 9 + v * 3] = cx + rnd();
      positions[t * 9 + v * 3 + 1] = cy + rnd();
      positions[t * 9 + v * 3 + 2] = cz + rnd();
    }
  }
  const indices = new Uint32Array(n * 3).map((_, i) => i);
  return { positions, indices };
}

describe('buildBoundsTree', () => {
  it('leaves the index buffer it was given untouched', () => {
    // The viewer hands the geometry MeshData.indices itself. Everything stored
    // per triangle beside it (source scan, grid cell, edge metrics, material
    // groups) is keyed by triangle ORDER, so a build that re-sorted the index
    // in place would silently mislabel every triangle.
    installBvhRaycast();
    const { positions, indices } = scattered();
    const before = indices.slice();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    buildBoundsTree(geo);
    expect((geo as unknown as { boundsTree?: unknown }).boundsTree).toBeTruthy();
    expect(Array.from(indices)).toEqual(Array.from(before));
    freeBoundsTree(geo);
  });

  it('still accelerates a raycast to the right triangle', () => {
    installBvhRaycast();
    const { positions, indices } = scattered();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    buildBoundsTree(geo);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld();
    // Aim straight down at triangle 57's centroid.
    const t = 57;
    const c = new THREE.Vector3();
    for (let v = 0; v < 3; v++) {
      c.x += positions[t * 9 + v * 3] / 3;
      c.y += positions[t * 9 + v * 3 + 1] / 3;
      c.z += positions[t * 9 + v * 3 + 2] / 3;
    }
    const ray = new THREE.Raycaster(new THREE.Vector3(c.x, c.y, 500), new THREE.Vector3(0, 0, -1));
    const hits = ray.intersectObject(mesh);
    expect(hits.some(h => h.faceIndex === t)).toBe(true);
    freeBoundsTree(geo);
  });
});
