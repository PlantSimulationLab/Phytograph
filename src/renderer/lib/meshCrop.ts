// Crop for triangle meshes: the mesh half of the Crop tool.
//
// A mesh is cut by WHOLE TRIANGLES. Each triangle goes to the side its centroid
// is on — never split along the region boundary. That is deliberate:
//  - it is a partition, so Keep Inside, Keep Outside and Segment are the same
//    test read three ways and no triangle is ever lost or counted twice;
//  - every per-triangle attribute a mesh may carry (source scan, grid cell,
//    organ code, edge metrics) stays meaningful, which a clipped triangle's
//    would not — a cut triangle has no honest max-edge or aspect ratio, and
//    those drive the triangle filter and the LAD reuse of this mesh.
// The cost is a boundary that follows triangle edges rather than the region's
// face, which is invisible on a triangulated scan and visible on a mesh of a
// few huge triangles.
//
// The region test is the SAME world-space predicate the point-cloud crop uses
// (see PointCloudViewer.buildCropPredicate), so a mesh and the cloud it was
// built from are cut by one rule when both are checked.

import * as THREE from 'three';

import type { CropPredicate } from './cropGeometry';
import type { MeshData, MeshEntry, PlantMaterialDef } from './pointCloudTypes';
import { applyTriangleFilter } from './triangleFilter';

/**
 * Why this mesh cannot be cropped, or undefined when it can.
 *
 * Each of these carries state that describes the WHOLE mesh and that nothing
 * would bring back into line after a cut, so the crop would leave the mesh
 * disagreeing with its own row in the Meshes pane.
 */
export function meshCropBlockReason(mesh: MeshEntry): string | undefined {
  if (mesh.gridSubdivisions) {
    return 'A voxel grid is a box of cells, not a surface — resize it with its transform instead.';
  }
  if (mesh.isPlant) {
    return 'A generated plant is rebuilt from its parameters (age, morph), which would undo the crop.';
  }
  if (mesh.method === 'dem' || mesh.demGrid) {
    return 'A DEM keeps an elevation raster behind its surface — crop the point cloud and regenerate it.';
  }
  if (mesh.method === 'crown' || mesh.crownMetrics) {
    return 'A fitted crown carries metrics for its whole shape.';
  }
  return undefined;
}

/**
 * Per-triangle region test: 1 where the triangle's centroid, in world space,
 * satisfies `predicate`. `worldMatrix` is the mesh's local → crop-frame matrix
 * (an affine map, so the centroid of the transformed triangle is the
 * transformed centroid — one matrix multiply per triangle instead of three).
 */
export function meshTriangleRegionMask(
  data: MeshData,
  worldMatrix: THREE.Matrix4,
  predicate: CropPredicate,
): Uint8Array {
  const e = worldMatrix.elements;  // column-major
  const v = data.vertices;
  const idx = data.indices;
  const n = data.triangleCount;
  const mask = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const x = (v[a] + v[b] + v[c]) / 3;
    const y = (v[a + 1] + v[b + 1] + v[c + 1]) / 3;
    const z = (v[a + 2] + v[b + 2] + v[c + 2]) / 3;
    if (predicate(
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14],
    )) mask[t] = 1;
  }
  return mask;
}

/** Triangles of `mask` equal to `value`. */
export function countMask(mask: Uint8Array, value: 0 | 1): number {
  let ones = 0;
  for (let i = 0; i < mask.length; i++) ones += mask[i];
  return value === 1 ? ones : mask.length - ones;
}

/**
 * The world-space AABB of a mesh, in the shape `worldBoundsUnion` takes — so a
 * checked mesh sizes the crop box exactly as a checked cloud does.
 */
export function meshWorldBounds(
  data: MeshData,
  worldMatrix: THREE.Matrix4,
): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
  if (!(data.vertexCount > 0)) return null;
  const e = worldMatrix.elements;
  const v = data.vertices;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < data.vertexCount; i++) {
    const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    if (wx < min.x) min.x = wx; if (wx > max.x) max.x = wx;
    if (wy < min.y) min.y = wy; if (wy > max.y) max.y = wy;
    if (wz < min.z) min.z = wz; if (wz > max.z) max.z = wz;
  }
  return { min, max };
}

function pickTriangles<T extends Uint32Array | Uint8Array | Float32Array>(
  src: T | undefined,
  triangleCount: number,
  mask: Uint8Array,
  value: 0 | 1,
  kept: number,
): T | undefined {
  if (!src || src.length !== triangleCount) return undefined;
  const out = new (src.constructor as { new(n: number): T })(kept);
  let w = 0;
  for (let t = 0; t < triangleCount; t++) if (mask[t] === value) out[w++] = src[t];
  return out;
}

function pickVertices(
  src: Float32Array | undefined,
  vertexCount: number,
  stride: number,
  remap: Int32Array,
  kept: number,
): Float32Array | undefined {
  if (!src || src.length !== vertexCount * stride) return undefined;
  const out = new Float32Array(kept * stride);
  for (let i = 0; i < vertexCount; i++) {
    const j = remap[i];
    if (j < 0) continue;
    for (let k = 0; k < stride; k++) out[j * stride + k] = src[i * stride + k];
  }
  return out;
}

/**
 * The triangles of `data` whose mask entry equals `value`, as a self-contained
 * mesh: unused vertices are dropped and every per-vertex / per-triangle array
 * is carried across. Returns null when no triangle matches.
 *
 * Surviving vertices keep their relative ORDER. Textured meshes are stored
 * triangle-expanded (triangle t owns vertices 3t..3t+2, and the textured
 * renderer reads them that way without consulting `indices`), and an
 * order-preserving compaction keeps that layout intact.
 */
export function subsetMeshData(data: MeshData, mask: Uint8Array, value: 0 | 1): MeshData | null {
  const n = data.triangleCount;
  const kept = countMask(mask, value);
  if (kept === 0) return null;

  const src = data.indices;
  const remap = new Int32Array(data.vertexCount).fill(-1);
  for (let t = 0; t < n; t++) {
    if (mask[t] !== value) continue;
    remap[src[t * 3]] = 0;
    remap[src[t * 3 + 1]] = 0;
    remap[src[t * 3 + 2]] = 0;
  }
  let vertexCount = 0;
  for (let i = 0; i < remap.length; i++) if (remap[i] === 0) remap[i] = vertexCount++;

  const indices = new Uint32Array(kept * 3);
  let w = 0;
  for (let t = 0; t < n; t++) {
    if (mask[t] !== value) continue;
    indices[w++] = remap[src[t * 3]];
    indices[w++] = remap[src[t * 3 + 1]];
    indices[w++] = remap[src[t * 3 + 2]];
  }

  const vertices = pickVertices(data.vertices, data.vertexCount, 3, remap, vertexCount)!;

  let surfaceArea: number | undefined;
  if (data.surfaceArea !== undefined) {
    let area = 0;
    for (let t = 0; t < kept; t++) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2];
      const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      area += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    }
    surfaceArea = area;
  }

  return {
    ...data,
    vertices,
    indices,
    normals: pickVertices(data.normals, data.vertexCount, 3, remap, vertexCount),
    vertexColors: pickVertices(data.vertexColors, data.vertexCount, 3, remap, vertexCount),
    uvCoordinates: pickVertices(data.uvCoordinates, data.vertexCount, 2, remap, vertexCount),
    vertexCount,
    triangleCount: kept,
    surfaceArea,
    triangleScanIds: pickTriangles(data.triangleScanIds, n, mask, value, kept),
    triangleOrganCodes: pickTriangles(data.triangleOrganCodes, n, mask, value, kept),
    triangleCellIds: pickTriangles(data.triangleCellIds, n, mask, value, kept),
    triEdgeMax: pickTriangles(data.triEdgeMax, n, mask, value, kept),
    triAspect: pickTriangles(data.triAspect, n, mask, value, kept),
  };
}

/**
 * Material groups name their triangles by ORDINAL, so they must be renumbered
 * against the subset. A material left with no triangles is dropped.
 */
export function subsetMaterials(
  materials: PlantMaterialDef[] | undefined,
  mask: Uint8Array,
  value: 0 | 1,
): PlantMaterialDef[] | undefined {
  if (!materials) return undefined;
  const newOrdinal = new Int32Array(mask.length).fill(-1);
  let w = 0;
  for (let t = 0; t < mask.length; t++) if (mask[t] === value) newOrdinal[t] = w++;
  const out: PlantMaterialDef[] = [];
  for (const m of materials) {
    const triangleIndices: number[] = [];
    for (const t of m.triangleIndices) {
      const j = t < newOrdinal.length ? newOrdinal[t] : -1;
      if (j >= 0) triangleIndices.push(j);
    }
    if (triangleIndices.length > 0) out.push({ ...m, triangleIndices });
  }
  return out;
}

/**
 * One side of a cropped mesh, as a full entry (same id — the caller renames /
 * re-ids the half that becomes a new mesh). Null when that side is empty.
 *
 * A mesh with an interactive triangle filter is cut in its UNFILTERED candidate
 * set and the visible `data` re-derived from that. Cutting only `data` would
 * let the cropped-away triangles come back the next time the Lmax / aspect
 * inputs move, since every filter change re-derives `data` from the candidates.
 */
function meshSide(
  mesh: MeshEntry,
  worldMatrix: THREE.Matrix4,
  predicate: CropPredicate,
  value: 0 | 1,
): MeshEntry | null {
  if (mesh.unfilteredMesh && mesh.triangleFilter) {
    const full = mesh.unfilteredMesh.data;
    const mask = meshTriangleRegionMask(full, worldMatrix, predicate);
    const cut = subsetMeshData(full, mask, value);
    if (!cut) return null;
    const data = applyTriangleFilter(cut, mesh.triangleFilter.lmax, mesh.triangleFilter.maxAspectRatio);
    if (data.triangleCount === 0) return null;
    return { ...mesh, data, unfilteredMesh: { ...mesh.unfilteredMesh, data: cut } };
  }
  const mask = meshTriangleRegionMask(mesh.data, worldMatrix, predicate);
  const data = subsetMeshData(mesh.data, mask, value);
  if (!data) return null;
  return {
    ...mesh,
    data,
    ...(mesh.plantMaterials ? { plantMaterials: subsetMaterials(mesh.plantMaterials, mask, value) } : {}),
  };
}

export interface MeshCropResult {
  /** Triangles whose centroid is inside the region; null when there are none. */
  inside: MeshEntry | null;
  /** The rest; null when there are none. */
  outside: MeshEntry | null;
}

/**
 * Partition a mesh by the crop region. Building a side is skipped unless it is
 * asked for — a plain crop needs only the half it keeps.
 */
export function cropMeshEntry(
  mesh: MeshEntry,
  worldMatrix: THREE.Matrix4,
  predicate: CropPredicate,
  want: { inside: boolean; outside: boolean },
): MeshCropResult {
  return {
    inside: want.inside ? meshSide(mesh, worldMatrix, predicate, 1) : null,
    outside: want.outside ? meshSide(mesh, worldMatrix, predicate, 0) : null,
  };
}
