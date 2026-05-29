// Pure, stateless helpers extracted from PointCloudViewer.tsx. No React, no
// component state — safe to unit-test directly.
import * as THREE from 'three';
import type { MeshData, ShapeType } from './pointCloudTypes';

// Format a numeric range tick so the colorbar labels stay readable across
// many orders of magnitude.
export function formatColorbarTick(value: number): string {
  if (!isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e5 || abs < 1e-3)) return value.toExponential(2);
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

// Compute bounding box center and size from interleaved [x,y,z,...] positions
export function computeBoundsFromPositions(positions: Float32Array, count: number) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    min.x = Math.min(min.x, x);
    min.y = Math.min(min.y, y);
    min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x);
    max.y = Math.max(max.y, y);
    max.z = Math.max(max.z, z);
  }
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const size = new THREE.Vector3().subVectors(max, min);
  return { center, size };
}

// Fuzzy search helper. Returns 2 for an exact substring match, 1 for an
// in-order subsequence match (or empty query), 0 otherwise.
export function fuzzyMatch(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 2; // Exact substring match
  // Check if all chars appear in order
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length ? 1 : 0;
}

// Generate mesh data from shape type with default unit size
export function generateShapeMesh(shapeType: ShapeType): MeshData {
  let geometry: THREE.BufferGeometry;
  const segments = 32;

  switch (shapeType) {
    case 'voxel':
      // Unit cube
      geometry = new THREE.BoxGeometry(1, 1, 1);
      break;
    case 'sphere':
      // Unit sphere (radius 0.5, diameter 1)
      geometry = new THREE.SphereGeometry(0.5, segments, segments / 2);
      break;
    case 'cylinder':
      // Unit cylinder (radius 0.5, height 1), rotated so flat side is down (Z-up)
      geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, segments, 1);
      geometry.rotateX(-Math.PI / 2);
      break;
    case 'cone':
      // Unit cone (base radius 0.5, height 1), rotated so flat side is down (Z-up)
      geometry = new THREE.CylinderGeometry(0, 0.5, 1, segments, 1);
      geometry.rotateX(-Math.PI / 2);
      break;
    default:
      geometry = new THREE.BoxGeometry(1, 1, 1);
  }

  // Ensure geometry has non-indexed buffer
  const nonIndexedGeometry = geometry.toNonIndexed ? geometry.toNonIndexed() : geometry;
  nonIndexedGeometry.computeVertexNormals();

  // Extract vertices and create indices
  const positionAttr = nonIndexedGeometry.getAttribute('position') as THREE.BufferAttribute;
  const normalAttr = nonIndexedGeometry.getAttribute('normal') as THREE.BufferAttribute;

  const vertexCount = positionAttr.count;
  const vertices = new Float32Array(positionAttr.array);
  const normals = normalAttr ? new Float32Array(normalAttr.array) : undefined;

  // Create triangle indices (for non-indexed geometry, just sequential)
  const triangleCount = Math.floor(vertexCount / 3);
  const indices = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    indices[i] = i;
  }

  geometry.dispose();
  nonIndexedGeometry.dispose();

  return {
    vertices,
    indices,
    normals,
    vertexCount,
    triangleCount,
  };
}
