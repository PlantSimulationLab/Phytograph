// Pure helpers for the "Adjust Leaf Angles" tool (Phase 2): selecting eligible
// leaf-on Helios triangulation meshes and building the backend triangulation
// payload from a MeshData. Kept React/three-free so they can be unit-tested.

import type { MeshData, MeshEntry, QSMEntry } from './pointCloudTypes';
import type { QSMTriangulationInput, QSMGrid } from '../utils/backendApi';

// A mesh is eligible as a leaf-angle target when it is a Helios triangulation
// carrying per-triangle cell ids AND the grid they index into. Those are exactly
// the meshes that yield a per-voxel leaf-angle distribution.
export function isLeafAngleSourceMesh(mesh: MeshEntry): boolean {
  return (
    mesh.method === 'helios' &&
    !!mesh.data.triangleCellIds &&
    !!mesh.data.grid
  );
}

// Axis-aligned bounding box of a QSM's cylinders (world space), or null if empty.
export function qsmAabb(qsm: QSMEntry): { min: [number, number, number]; max: [number, number, number] } | null {
  if (!qsm.cylinders.length) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const c of qsm.cylinders) {
    for (const p of [c.start, c.end]) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
    }
  }
  return { min, max };
}

// Does a mesh's grid AABB overlap the QSM's cylinder AABB? Used to only offer
// triangulations that actually cover the tree. Returns true when either AABB is
// unavailable (don't over-filter).
export function gridOverlapsQsm(mesh: MeshEntry, qsm: QSMEntry): boolean {
  const grid = mesh.data.grid;
  const box = qsmAabb(qsm);
  if (!grid || !box) return true;
  for (let k = 0; k < 3; k++) {
    const gmin = grid.center[k] - grid.size[k] / 2;
    const gmax = grid.center[k] + grid.size[k] / 2;
    if (gmax < box.min[k] || gmin > box.max[k]) return false; // disjoint on this axis
  }
  return true;
}

// Meshes eligible as a leaf-angle source for a given QSM (Helios+grid+overlap).
export function eligibleLeafAngleMeshes(meshes: MeshEntry[], qsm: QSMEntry): MeshEntry[] {
  return meshes.filter(m => isLeafAngleSourceMesh(m) && gridOverlapsQsm(m, qsm));
}

// Mean leaf inclination (degrees, 0=horizontal..90=vertical) of a leaf MeshData,
// computed from per-vertex normals folded with |nz|. Returns NaN with no normals.
// Used as an at-a-glance readout and an observable signal that an angle
// adjustment changed the foliage. The leaf quad mesh has a constant normal per
// 6-vertex leaf; averaging every vertex weights each leaf equally.
export function meanLeafInclination(data: MeshData): number {
  const n = data.normals;
  if (!n || n.length < 3) return NaN;
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 2 < n.length; i += 3) {
    const nx = n[i], ny = n[i + 1], nz = n[i + 2];
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    sum += Math.acos(Math.min(1, Math.abs(nz) / len)) * (180 / Math.PI);
    count++;
  }
  return count > 0 ? sum / count : NaN;
}

// Build the backend triangulation payload from a mesh's MeshData. Converts the
// typed arrays to plain number[] (JSON-serializable) and maps the grid.
export function meshToTriangulationInput(data: MeshData): QSMTriangulationInput | null {
  if (!data.triangleCellIds || !data.grid) return null;
  const grid: QSMGrid = {
    center: data.grid.center,
    size: data.grid.size,
    nx: data.grid.nx,
    ny: data.grid.ny,
    nz: data.grid.nz,
  };
  // triangleCellIds are stored as uint32 with 0xffffffff for "outside"; send them
  // as signed -1 so the backend's int parsing treats them as outside-grid.
  const cellIds = Array.from(data.triangleCellIds, v => (v === 0xffffffff ? -1 : v));
  return {
    vertices: Array.from(data.vertices),
    indices: Array.from(data.indices),
    triangle_cell_ids: cellIds,
    triangle_scan_ids: data.triangleScanIds ? Array.from(data.triangleScanIds) : undefined,
    scan_origins: data.scanOrigins ? Array.from(data.scanOrigins) : undefined,
    grid,
  };
}
