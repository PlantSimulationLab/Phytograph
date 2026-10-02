// Merging several mesh objects into one (the Meshes side of the Stitch tool).
//
// A mesh's transform lives beside it, not in its vertices, so every part is
// first baked to where it is DRAWN and only then concatenated — the merged mesh
// sits exactly where its sources were seen. Everything here is pure; the scene
// commit lives in PointCloudViewer.

import * as THREE from 'three';

import { meshCropBlockReason } from './meshCrop';
import { analyzeMeshOverlap, blendOverlapPositions, matchOverlapColors, overlapTriangleKeepMasks } from './meshOverlap';
import { bakeTransformIntoMeshData } from './meshTransform';
import type { MeshData, MeshEntry, PlantMaterialDef } from './pointCloudTypes';

/** Whether a mesh renders through the textured material-group path. */
export function isTexturedMeshData(data: MeshData, materials?: PlantMaterialDef[]): boolean {
  return !!(data.uvCoordinates && data.uvCoordinates.length > 0 &&
            materials && materials.some(m => m.textureData));
}

/**
 * Why this mesh cannot be merged, or undefined when it can.
 *
 * Only imported meshes and primitive shapes merge. Everything else carries
 * state describing the WHOLE object (a plant's parameters, a DEM's raster, a
 * triangulation's scan ids and adjustable filter) that a concatenation would
 * leave stale or silently discard.
 */
export function meshMergeBlockReason(mesh: MeshEntry, isTriangulated: boolean): string | undefined {
  const whole = meshCropBlockReason(mesh);
  if (whole) return whole;
  if (isTriangulated || mesh.triangulationParams || mesh.unfilteredMesh) {
    return 'A triangulation keeps its scan and filter data, which a merge would discard.';
  }
  return undefined;
}

/**
 * Why this SET of otherwise-mergeable meshes cannot be merged together, or
 * undefined when it can. A textured mesh is stored triangle-expanded and drawn
 * by a renderer that ignores vertex colors and the index buffer, so it cannot
 * share one mesh with an untextured one.
 */
export function meshMergeSetBlockReason(meshes: MeshEntry[]): string | undefined {
  const textured = meshes.filter(m => isTexturedMeshData(m.data, m.plantMaterials)).length;
  if (textured > 0 && textured < meshes.length) {
    return 'Textured and untextured meshes cannot be merged into one mesh.';
  }
  return undefined;
}

export interface MeshMergePart {
  data: MeshData;
  /** Local → merged-frame matrix (the drawn transform, relative to the pivot). */
  matrix: THREE.Matrix4;
  /** The mesh's solid display color (CSS hex), used where it has no vertex colors. */
  color: string;
  materials?: PlantMaterialDef[];
}

export interface MeshMergeOptions {
  /**
   * Even out vertex colors where the parts cover the same surface: one gain per
   * part, then a blend across each overlap. Applies to parts that HAVE vertex
   * colors and are not textured (a texture's color lives in its image).
   */
  matchColors?: boolean;
  /**
   * Drop the duplicate triangles where the parts cover the same surface, after
   * drawing the surfaces together there so the cut leaves no lip. This MOVES
   * vertices inside the overlap (by up to the gap between the surfaces).
   */
  removeOverlap?: boolean;
  /** Overlap distance. Default: per pair, from edge length and the measured alignment gap. */
  overlapTolerance?: number;
}

export interface MeshMergeOverlapStats {
  /** The overlap distance used (the largest, when pairs differ). */
  tolerance: number;
  /** Vertices (identical positions counted once) with a counterpart on another part. */
  overlapVertices: number;
  /** Parts whose vertex colors were matched (0 when not asked for, or not applicable). */
  colorMatchedParts: number;
  removedTriangles: number;
}

export interface MeshMergeResult {
  data: MeshData;
  materials?: PlantMaterialDef[];
  /** Present when an overlap option was asked for. */
  overlap?: MeshMergeOverlapStats;
}

/**
 * Drop the triangles masked out of `keep`, and the vertices only they used.
 * Kept triangles and vertices stay in order, so a triangle-expanded (textured)
 * mesh stays triangle-expanded.
 */
function dropTriangles(data: MeshData, materials: PlantMaterialDef[] | undefined, keep: Uint8Array): MeshMergeResult {
  const triRemap = new Int32Array(data.triangleCount).fill(-1);
  const used = new Uint8Array(data.vertexCount);
  let triangleCount = 0;
  for (let t = 0; t < data.triangleCount; t++) {
    if (!keep[t]) continue;
    triRemap[t] = triangleCount++;
    for (let e = 0; e < 3; e++) used[data.indices[t * 3 + e]] = 1;
  }
  const vertRemap = new Int32Array(data.vertexCount).fill(-1);
  let vertexCount = 0;
  for (let v = 0; v < data.vertexCount; v++) if (used[v]) vertRemap[v] = vertexCount++;
  const indices = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < data.triangleCount; t++) {
    if (triRemap[t] < 0) continue;
    for (let e = 0; e < 3; e++) indices[triRemap[t] * 3 + e] = vertRemap[data.indices[t * 3 + e]];
  }
  const pick = (src: Float32Array | undefined, width: number) => {
    if (!src) return undefined;
    const out = new Float32Array(vertexCount * width);
    for (let v = 0; v < data.vertexCount; v++) {
      if (vertRemap[v] < 0) continue;
      for (let c = 0; c < width; c++) out[vertRemap[v] * width + c] = src[v * width + c];
    }
    return out;
  };
  const normals = pick(data.normals, 3), vertexColors = pick(data.vertexColors, 3), uvCoordinates = pick(data.uvCoordinates, 2);
  return {
    data: {
      vertices: pick(data.vertices, 3)!,
      indices,
      ...(normals ? { normals } : {}),
      ...(vertexColors ? { vertexColors } : {}),
      ...(uvCoordinates ? { uvCoordinates } : {}),
      vertexCount,
      triangleCount,
    },
    ...(materials ? {
      materials: materials
        .map(m => ({ ...m, triangleIndices: m.triangleIndices.filter(t => triRemap[t] >= 0).map(t => triRemap[t]) }))
        .filter(m => m.triangleIndices.length > 0),
    } : {}),
  };
}

/**
 * Concatenate `parts` into one mesh.
 *
 * - Normals survive only when every part has them.
 * - Vertex colors: when any part has them, or the parts' solid colors differ,
 *   every part gets them (a part without is filled from its solid color, in the
 *   linear space vertex colors are stored in). Same-colored solids stay solid.
 * - Textured parts (all or none — see `meshMergeSetBlockReason`) keep UVs and
 *   materials, with triangle ordinals offset and colliding names made unique.
 * - Backend per-triangle metadata (scan ids, cell ids, edge stats) is not
 *   carried: the mergeable kinds do not have it.
 * - Where the parts cover the same surface nothing is reconciled unless `opts`
 *   asks: by default both surfaces stay, each with its own colors.
 */
export function mergeMeshData(parts: MeshMergePart[], opts: MeshMergeOptions = {}): MeshMergeResult {
  const baked = parts.map(p => bakeTransformIntoMeshData(p.data, p.matrix));
  const vertexCount = baked.reduce((n, d) => n + d.vertexCount, 0);
  const triangleCount = baked.reduce((n, d) => n + d.triangleCount, 0);

  const textured = parts.every(p => isTexturedMeshData(p.data, p.materials));
  const hasColors = (d: MeshData) => !!d.vertexColors && d.vertexColors.length > 0;
  const allNormals = baked.every(d => !!d.normals && d.normals.length === d.vertexCount * 3);
  const solidColorsDiffer = new Set(parts.map(p => p.color.toLowerCase())).size > 1;
  const wantColors = textured
    ? baked.every(hasColors)
    : baked.some(hasColors) || solidColorsDiffer;
  const allMaterials = parts.every(p => p.materials && p.materials.length > 0);

  const overlap = opts.matchColors || opts.removeOverlap
    ? analyzeMeshOverlap(baked, opts.overlapTolerance) : undefined;
  const colorable = baked.map(d => !textured && hasColors(d));
  const matched = overlap && opts.matchColors && overlap.overlapVertices > 0 && colorable.filter(Boolean).length >= 2
    ? matchOverlapColors(baked, overlap, colorable).colors : undefined;
  const keepMasks = overlap && opts.removeOverlap ? overlapTriangleKeepMasks(baked, overlap) : undefined;
  // Trimming one of two slightly separated surfaces leaves its cut edge hanging
  // over the other, so the surfaces are first drawn together across the overlap.
  const moved = overlap && opts.removeOverlap && overlap.overlapVertices > 0 ? blendOverlapPositions(baked, overlap) : undefined;

  const vertices = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);
  const normals = allNormals ? new Float32Array(vertexCount * 3) : undefined;
  const vertexColors = wantColors ? new Float32Array(vertexCount * 3) : undefined;
  const uvCoordinates = textured ? new Float32Array(vertexCount * 2) : undefined;
  const materials: PlantMaterialDef[] = [];
  const takenNames = new Set<string>();

  let v0 = 0, t0 = 0;
  parts.forEach((part, k) => {
    const d = baked[k];
    vertices.set((moved?.[k] ?? d.vertices).subarray(0, d.vertexCount * 3), v0 * 3);
    for (let i = 0; i < d.triangleCount * 3; i++) indices[t0 * 3 + i] = d.indices[i] + v0;
    if (normals) normals.set(d.normals!, v0 * 3);
    if (vertexColors) {
      if (hasColors(d)) {
        vertexColors.set((matched?.[k] ?? d.vertexColors!).subarray(0, d.vertexCount * 3), v0 * 3);
      } else {
        const c = new THREE.Color(part.color);  // parsed sRGB → linear working space
        for (let i = 0; i < d.vertexCount; i++) {
          vertexColors[(v0 + i) * 3] = c.r;
          vertexColors[(v0 + i) * 3 + 1] = c.g;
          vertexColors[(v0 + i) * 3 + 2] = c.b;
        }
      }
    }
    if (uvCoordinates) uvCoordinates.set(d.uvCoordinates!.subarray(0, d.vertexCount * 2), v0 * 2);
    if (allMaterials) {
      for (const m of part.materials!) {
        let name = m.name;
        for (let n = 2; takenNames.has(name); n++) name = `${m.name}_${n}`;
        takenNames.add(name);
        materials.push({ ...m, name, triangleIndices: m.triangleIndices.map(t => t + t0) });
      }
    }
    v0 += d.vertexCount;
    t0 += d.triangleCount;
  });

  const result: MeshMergeResult = {
    data: {
      vertices,
      indices,
      ...(normals ? { normals } : {}),
      ...(vertexColors ? { vertexColors } : {}),
      ...(uvCoordinates ? { uvCoordinates } : {}),
      vertexCount,
      triangleCount,
    },
    ...(allMaterials ? { materials } : {}),
  };
  if (!overlap) return result;

  const stats: MeshMergeOverlapStats = {
    tolerance: overlap.tolerance,
    overlapVertices: overlap.overlapVertices,
    colorMatchedParts: matched ? matched.filter(Boolean).length : 0,
    removedTriangles: 0,
  };
  if (!keepMasks) return { ...result, overlap: stats };
  const keep = new Uint8Array(triangleCount);
  let at = 0;
  for (const mask of keepMasks) { keep.set(mask, at); at += mask.length; }
  stats.removedTriangles = triangleCount - keep.reduce((n, k) => n + k, 0);
  if (stats.removedTriangles === 0) return { ...result, overlap: stats };
  return { ...dropTriangles(result.data, result.materials, keep), overlap: stats };
}

/**
 * Name for a merged mesh, following the stitched-cloud convention
 * (`a_b_merged`), made unique against `existing`.
 */
export function mergedMeshName(sourceNames: string[], existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = `${sourceNames.join('_')}_merged`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}
