import * as THREE from 'three';

import { subsetMaterials, subsetMeshData } from './meshCrop';
import type { MeshData, PlantMaterialDef } from './pointCloudTypes';

/**
 * Object groups inside one mesh — an imported OBJ's `o`/`g` parts.
 *
 * A group is not an object of its own: it is the set of triangles whose
 * `data.triangleGroupIds` entry names it. So the mesh keeps its single
 * transform, and every group operation here rewrites the mesh's arrays (a
 * transform moves that group's vertices, a recolor writes its vertex colors)
 * and hands back a new MeshData for the caller to commit as one undoable
 * `replaceObject`.
 *
 * Vertices can be SHARED across groups (a PLY, the in-renderer OBJ fallback, a
 * merged mesh): moving one group would then drag its neighbor's corners along.
 * `unshareGroupVertices` splits those first; the backend's OBJ import is
 * triangle-expanded, so it never needs to.
 */

export function hasGroups(data: MeshData): boolean {
  return !!data.triangleGroupIds
    && !!data.groupNames
    && data.groupNames.length > 0
    && data.triangleGroupIds.length === data.triangleCount;
}

/** Triangles per group, indexed like `data.groupNames`. */
export function groupTriangleCounts(data: MeshData): number[] {
  if (!hasGroups(data)) return [];
  const counts = new Array<number>(data.groupNames!.length).fill(0);
  const ids = data.triangleGroupIds!;
  for (let t = 0; t < ids.length; t++) counts[ids[t]]++;
  return counts;
}

/** 1 for every triangle in one of `groups`, else 0. */
export function groupTriangleMask(data: MeshData, groups: ReadonlySet<number>): Uint8Array {
  const mask = new Uint8Array(data.triangleCount);
  if (!hasGroups(data)) return mask;
  const ids = data.triangleGroupIds!;
  for (let t = 0; t < ids.length; t++) if (groups.has(ids[t])) mask[t] = 1;
  return mask;
}

/**
 * The draw mask for the mesh's main surface: every triangle except those in a
 * hidden group and those in `exclude` (the selected groups, which are drawn
 * separately so they can be outlined and previewed mid-gesture). Null when
 * nothing is left out, so the renderer draws the plain geometry.
 */
export function visibleTriangleMask(
  data: MeshData,
  hidden: Iterable<number> | undefined,
  exclude?: ReadonlySet<number>,
): Uint8Array | null {
  if (!hasGroups(data)) return null;
  const out = new Set<number>(hidden ?? []);
  if (exclude) for (const g of exclude) out.add(g);
  if (out.size === 0) return null;
  const mask = new Uint8Array(data.triangleCount);
  const ids = data.triangleGroupIds!;
  for (let t = 0; t < ids.length; t++) mask[t] = out.has(ids[t]) ? 0 : 1;
  return mask;
}

/** Triangles drawn under both masks; a null mask means "all". */
export function intersectTriangleMasks(a: Uint8Array | null, b: Uint8Array | null): Uint8Array | null {
  if (!a) return b;
  if (!b) return a;
  const out = new Uint8Array(a.length);
  for (let t = 0; t < a.length; t++) out[t] = a[t] & b[t];
  return out;
}

/**
 * Drop group names no triangle uses any more and renumber the rest, keeping
 * their order. After a crop, delete or extract, a group can end up empty, and
 * an empty row in the panel would be noise. Returns the input when nothing
 * changed. A mesh left with no group data at all loses both fields together.
 */
export function compactGroups(data: MeshData): MeshData {
  if (!data.triangleGroupIds || !data.groupNames) return data;
  if (data.triangleGroupIds.length !== data.triangleCount) {
    // Misaligned (an operation that doesn't know about groups resized the
    // triangles): the tags no longer mean anything, so drop them.
    const { triangleGroupIds: _ids, groupNames: _names, ...rest } = data;
    return rest;
  }
  const counts = groupTriangleCounts(data);
  if (counts.every((c) => c > 0)) return data;
  const remap = new Int32Array(counts.length).fill(-1);
  const groupNames: string[] = [];
  counts.forEach((c, g) => { if (c > 0) { remap[g] = groupNames.length; groupNames.push(data.groupNames![g]); } });
  if (groupNames.length === 0) {
    const { triangleGroupIds: _ids, groupNames: _names, ...rest } = data;
    return rest;
  }
  const triangleGroupIds = Uint32Array.from(data.triangleGroupIds, (g) => remap[g]);
  return { ...data, triangleGroupIds, groupNames };
}

/**
 * Remap a hidden-group list across `compactGroups`: `before`/`after` are the
 * group-name tables. Names are unique within a mesh, so matching by name is exact.
 */
export function remapHiddenGroups(
  hidden: number[] | undefined,
  before: string[] | undefined,
  after: string[] | undefined,
): number[] | undefined {
  if (!hidden || hidden.length === 0 || !before || !after) return undefined;
  const index = new Map(after.map((n, i) => [n, i]));
  const out = hidden.map((g) => index.get(before[g])).filter((g): g is number => g !== undefined);
  return out.length > 0 ? out : undefined;
}

/**
 * Give every group its own copies of the vertices it shares with another
 * group, so a per-group edit can't reach across a seam. Vertices shared only
 * within one group stay shared. Returns the input when nothing is shared.
 */
export function unshareGroupVertices(data: MeshData): MeshData {
  if (!hasGroups(data)) return data;
  const ids = data.triangleGroupIds!;
  const owner = new Int32Array(data.vertexCount).fill(-1);
  let shared = false;
  for (let t = 0; t < data.triangleCount && !shared; t++) {
    for (let e = 0; e < 3; e++) {
      const v = data.indices[t * 3 + e];
      if (owner[v] < 0) owner[v] = ids[t];
      else if (owner[v] !== ids[t]) { shared = true; break; }
    }
  }
  if (!shared) return data;

  // A vertex keeps its slot for the first group that uses it; each further
  // group gets a fresh copy, appended, looked up by (vertex, group).
  owner.fill(-1);
  const copies = new Map<number, number>();  // v * groupCount + g → new index
  const groupCount = data.groupNames!.length;
  const extra: number[] = [];  // source vertex of each appended copy
  const indices = new Uint32Array(data.indices.length);
  for (let t = 0; t < data.triangleCount; t++) {
    const g = ids[t];
    for (let e = 0; e < 3; e++) {
      const v = data.indices[t * 3 + e];
      if (owner[v] < 0) owner[v] = g;
      if (owner[v] === g) { indices[t * 3 + e] = v; continue; }
      const key = v * groupCount + g;
      let nv = copies.get(key);
      if (nv === undefined) {
        nv = data.vertexCount + extra.length;
        extra.push(v);
        copies.set(key, nv);
      }
      indices[t * 3 + e] = nv;
    }
  }
  const vertexCount = data.vertexCount + extra.length;
  const grow = (src: Float32Array | undefined, width: number): Float32Array | undefined => {
    if (!src || src.length !== data.vertexCount * width) return undefined;
    const out = new Float32Array(vertexCount * width);
    out.set(src);
    extra.forEach((v, i) => {
      for (let c = 0; c < width; c++) out[(data.vertexCount + i) * width + c] = src[v * width + c];
    });
    return out;
  };
  const normals = grow(data.normals, 3);
  const vertexColors = grow(data.vertexColors, 3);
  const uvCoordinates = grow(data.uvCoordinates, 2);
  return {
    ...data,
    vertices: grow(data.vertices, 3)!,
    indices,
    vertexCount,
    ...(normals ? { normals } : {}),
    ...(vertexColors ? { vertexColors } : {}),
    ...(uvCoordinates ? { uvCoordinates } : {}),
  };
}

/** 1 for every vertex used by a triangle in `groups` (after `unshareGroupVertices`, exactly that group's own). */
function groupVertexMask(data: MeshData, groups: ReadonlySet<number>): Uint8Array {
  const mask = new Uint8Array(data.vertexCount);
  const ids = data.triangleGroupIds!;
  for (let t = 0; t < data.triangleCount; t++) {
    if (!groups.has(ids[t])) continue;
    mask[data.indices[t * 3]] = 1;
    mask[data.indices[t * 3 + 1]] = 1;
    mask[data.indices[t * 3 + 2]] = 1;
  }
  return mask;
}

/** Centroid (mesh-LOCAL frame) of the vertices used by `groups`; null when the groups are empty. */
export function groupLocalCentroid(data: MeshData, groups: ReadonlySet<number>): THREE.Vector3 | null {
  if (!hasGroups(data)) return null;
  const mask = groupVertexMask(data, groups);
  let x = 0, y = 0, z = 0, n = 0;
  for (let v = 0; v < data.vertexCount; v++) {
    if (!mask[v]) continue;
    x += data.vertices[v * 3]; y += data.vertices[v * 3 + 1]; z += data.vertices[v * 3 + 2];
    n++;
  }
  return n > 0 ? new THREE.Vector3(x / n, y / n, z / n) : null;
}

/**
 * Apply `m` (a mesh-LOCAL matrix) to the vertices of `groups`, and the normal
 * matrix to their normals. Every other vertex is copied through untouched.
 *
 * Backend-computed metadata that a scale would leave stale (surfaceArea and the
 * Helios edge stats) is dropped, as the whole-mesh bakes in meshTransform.ts do.
 */
export function transformGroups(data: MeshData, groups: ReadonlySet<number>, m: THREE.Matrix4): MeshData {
  if (!hasGroups(data) || groups.size === 0) return data;
  const src = unshareGroupVertices(data);
  const mask = groupVertexMask(src, groups);
  const e = m.elements;  // column-major
  const vertices = new Float32Array(src.vertices);
  for (let v = 0; v < src.vertexCount; v++) {
    if (!mask[v]) continue;
    const x = src.vertices[v * 3], y = src.vertices[v * 3 + 1], z = src.vertices[v * 3 + 2];
    vertices[v * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
    vertices[v * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    vertices[v * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  let normals: Float32Array | undefined;
  if (src.normals && src.normals.length === src.vertexCount * 3) {
    const n = new THREE.Matrix3().getNormalMatrix(m).elements;
    normals = new Float32Array(src.normals);
    for (let v = 0; v < src.vertexCount; v++) {
      if (!mask[v]) continue;
      const x = src.normals[v * 3], y = src.normals[v * 3 + 1], z = src.normals[v * 3 + 2];
      let tx = n[0] * x + n[3] * y + n[6] * z;
      let ty = n[1] * x + n[4] * y + n[7] * z;
      let tz = n[2] * x + n[5] * y + n[8] * z;
      const l = Math.hypot(tx, ty, tz);
      if (l > 0) { tx /= l; ty /= l; tz /= l; }
      normals[v * 3] = tx; normals[v * 3 + 1] = ty; normals[v * 3 + 2] = tz;
    }
  }
  const { surfaceArea: _a, triEdgeMax: _e, triAspect: _r, ...rest } = src;
  return { ...rest, vertices, ...(normals ? { normals } : {}) };
}

/**
 * Paint `groups` one color by writing their vertex colors. A mesh drawn in a
 * solid color has no vertex colors yet, so they are first filled from
 * `baseColor` (its CSS hex), keeping every other group looking as it did.
 * `color` is a CSS hex too; both are stored linear, as vertex colors are.
 */
export function recolorGroups(data: MeshData, groups: ReadonlySet<number>, color: string, baseColor: string): MeshData {
  if (!hasGroups(data) || groups.size === 0) return data;
  const src = unshareGroupVertices(data);
  const vertexColors = new Float32Array(src.vertexCount * 3);
  if (src.vertexColors && src.vertexColors.length === src.vertexCount * 3) {
    vertexColors.set(src.vertexColors);
  } else {
    const b = new THREE.Color(baseColor);
    for (let v = 0; v < src.vertexCount; v++) {
      vertexColors[v * 3] = b.r; vertexColors[v * 3 + 1] = b.g; vertexColors[v * 3 + 2] = b.b;
    }
  }
  const c = new THREE.Color(color);
  const mask = groupVertexMask(src, groups);
  for (let v = 0; v < src.vertexCount; v++) {
    if (!mask[v]) continue;
    vertexColors[v * 3] = c.r; vertexColors[v * 3 + 1] = c.g; vertexColors[v * 3 + 2] = c.b;
  }
  return { ...src, vertexColors };
}

/** Display color (CSS hex, sRGB) of a group: its first vertex's color, or null for a solid-colored mesh. */
export function groupDisplayColor(data: MeshData, group: number): string | null {
  if (!hasGroups(data) || !data.vertexColors || data.vertexColors.length !== data.vertexCount * 3) return null;
  const ids = data.triangleGroupIds!;
  for (let t = 0; t < data.triangleCount; t++) {
    if (ids[t] !== group) continue;
    const v = data.indices[t * 3];
    return '#' + new THREE.Color(data.vertexColors[v * 3], data.vertexColors[v * 3 + 1], data.vertexColors[v * 3 + 2]).getHexString();
  }
  return null;
}

/**
 * Split `groups` off a mesh: `rest` is the mesh without them, `taken` is just
 * them (both null when empty). Delete keeps `rest`; Extract keeps both. Each
 * side's material triangle lists are renumbered and its group table compacted.
 */
export function splitGroups(
  data: MeshData,
  materials: PlantMaterialDef[] | undefined,
  groups: ReadonlySet<number>,
): {
  rest: { data: MeshData; materials?: PlantMaterialDef[] } | null;
  taken: { data: MeshData; materials?: PlantMaterialDef[] } | null;
} {
  const mask = groupTriangleMask(data, groups);
  const side = (value: 0 | 1) => {
    const d = subsetMeshData(data, mask, value);
    if (!d) return null;
    const m = subsetMaterials(materials, mask, value);
    return { data: compactGroups(d), ...(m ? { materials: m } : {}) };
  };
  return { rest: side(0), taken: side(1) };
}
