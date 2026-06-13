// Pure, stateless helpers extracted from PointCloudViewer.tsx. No React, no
// component state — safe to unit-test directly.
import * as THREE from 'three';
import type { MeshData, ShapeType, MeshColorMode, LADVoxel, PointCloudData } from './pointCloudTypes';
import type { HeliosGrid, LADRequest, LADScanEntry } from '../utils/backendApi';
import type { Scan } from './scan';
import { sampleColormapInto, type ColormapName } from './colormaps';

// Format a numeric range tick so the colorbar labels stay readable across
// many orders of magnitude.
export function formatColorbarTick(value: number): string {
  if (!isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e5 || abs < 1e-3)) return value.toExponential(2);
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

// Round a coordinate suggested for an editable input field. Scene-derived
// values (bounding-box centers, etc.) carry full floating-point precision —
// e.g. -0.035371989011764526 — which is meaningless noise to show in a number
// box the user is meant to read and tweak. Snap to millimeter precision (3
// decimals), matching the crop panel's dimension/center inputs.
export function roundCoord(value: number, decimals = 3): number {
  if (!isFinite(value)) return 0;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

// Round each axis of an {x,y,z} coordinate suggested for input fields.
export function roundCoord3(
  p: { x: number; y: number; z: number },
  decimals = 3,
): { x: number; y: number; z: number } {
  return {
    x: roundCoord(p.x, decimals),
    y: roundCoord(p.y, decimals),
    z: roundCoord(p.z, decimals),
  };
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

// Deep-copy a FLAT (in-RAM) point cloud so the copy shares no typed-array
// buffers with the source — mutating one must never corrupt the other. Every
// position/color/intensity array and each scalar field gets a fresh
// Float32Array; the bounds Vector3s are cloned. Callers pass only flat clouds:
// octree-backed clouds carry no points here (they live in a backend session and
// are duplicated server-side), so any `octree` ref is intentionally NOT carried
// over — duplicating that path goes through the backend, not this helper.
export function cloneFlatPointCloudData(data: PointCloudData): PointCloudData {
  const scalarFields = data.scalarFields
    ? Object.fromEntries(
        Object.entries(data.scalarFields).map(([name, f]) => [
          name,
          { ...f, values: new Float32Array(f.values) },
        ]),
      )
    : undefined;
  return {
    positions: new Float32Array(data.positions),
    colors: data.colors ? new Float32Array(data.colors) : undefined,
    intensities: data.intensities ? new Float32Array(data.intensities) : undefined,
    scalarFields,
    pointCount: data.pointCount,
    bounds: {
      min: data.bounds.min.clone(),
      max: data.bounds.max.clone(),
      center: data.bounds.center.clone(),
      size: data.bounds.size.clone(),
    },
    fileName: data.fileName,
  };
}

// Fit a voxel box to a set of world-space axis-aligned bounding boxes (one per
// selected scan, already translation-baked). Returns the center/size a voxel
// mesh needs — a voxel's base geometry is a unit cube (±0.5), so mesh position
// == world center and mesh scale == world size (see voxelMeshToHeliosGrid).
// The box is padded on every side by `eps`, computed as 2% of the largest span
// (floored at 1 cm) so points on the very edge of the cloud aren't clipped by a
// grid face. Returns null when given no boxes or non-finite bounds.
export function fitGridToBounds(
  boxes: Array<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }>,
): { center: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } } | null {
  if (boxes.length === 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.min.x); minY = Math.min(minY, b.min.y); minZ = Math.min(minZ, b.min.z);
    maxX = Math.max(maxX, b.max.x); maxY = Math.max(maxY, b.max.y); maxZ = Math.max(maxZ, b.max.z);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const eps = Math.max(span * 0.02, 0.01);
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
    size: { x: maxX - minX + 2 * eps, y: maxY - minY + 2 * eps, z: maxZ - minZ + 2 * eps },
  };
}

// Convert a voxel-box mesh into the explicit Helios triangulation grid the
// backend expects. A voxel shape's base geometry is a unit cube spanning
// ±0.5, so its world center is the mesh position and its world size equals the
// mesh scale directly. `subdivisions` becomes the grid's per-axis cell count
// (defaulting to a single cell when unset). Returns null when the mesh carries
// no grid subdivisions (i.e. it isn't a voxel box).
export function voxelMeshToHeliosGrid(
  position: { x: number; y: number; z: number } | undefined,
  scale: { x: number; y: number; z: number } | undefined,
  subdivisions: { x: number; y: number; z: number } | undefined,
): HeliosGrid | null {
  if (!subdivisions) return null;
  const p = position ?? { x: 0, y: 0, z: 0 };
  const s = scale ?? { x: 1, y: 1, z: 1 };
  return {
    center: [p.x, p.y, p.z],
    size: [s.x, s.y, s.z],
    nx: Math.max(1, Math.round(subdivisions.x)),
    ny: Math.max(1, Math.round(subdivisions.y)),
    nz: Math.max(1, Math.round(subdivisions.z)),
  };
}

// Per-triangle geometry derived from the face normal, in the leaf-angle
// convention (Z up). Single source of truth for the mesh pseudocolor modes
// (computeMeshTriangleScalars) and the leaf-angle distribution
// (leafAngleDistribution.ts), so both read identical angles/areas.
//   inclination — angle of the face normal from +Z, folded to [0,90]deg
//                 (0 = horizontal face, 90 = vertical); NaN for degenerate tris.
//   azimuth     — bearing of the (outward) normal's horizontal projection in
//                 [0,360)deg; NaN for (near-)horizontal faces with no meaningful
//                 azimuth. See `outwardRef` for how "outward" is decided.
//   area        — triangle area in the mesh's squared units (always finite >= 0).
// `vertices` is x,y,z-interleaved; `indices` is the flat triangle index list;
// `t` is the triangle ordinal (reads indices[t*3 .. t*3+2]).
//
// `outwardRef` (optional) is a point the facet's outward normal should face —
// the sensor origin that scanned this triangle. When given, the normal is
// oriented toward it (away from the surface, toward the scanner), so a scanned
// closed surface like a sphere reads a CONTINUOUS outward azimuth with no
// hemisphere seam. When omitted (no scan provenance, or unreliable winding), we
// fall back to orienting the normal into the upper hemisphere (flip when nz<0),
// which is deterministic but seams a sphere at its equator. Inclination is
// orientation-independent (uses |nz|), so this only affects azimuth.
export function triangleGeometry(
  vertices: Float32Array | number[],
  indices: Uint32Array | number[],
  t: number,
  outwardRef?: { x: number; y: number; z: number } | null,
): { inclination: number; azimuth: number; area: number } {
  const out = { inclination: 0, azimuth: 0, area: 0 };
  triangleGeometryInto(vertices, indices, t, outwardRef ?? null, out);
  return out;
}

// Allocation-free variant of `triangleGeometry`: writes the result into the
// caller-supplied `out` object instead of returning a fresh one. Hot per-
// triangle loops (millions of facets) reuse a single scratch object so they
// don't spawn millions of throwaway objects — the GC churn that otherwise
// freezes the UI and OOMs the renderer when coloring a large mesh.
export function triangleGeometryInto(
  vertices: Float32Array | number[],
  indices: Uint32Array | number[],
  t: number,
  outwardRef: { x: number; y: number; z: number } | null,
  out: { inclination: number; azimuth: number; area: number },
): void {
  const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
  const ax = vertices[i0 * 3], ay = vertices[i0 * 3 + 1], az = vertices[i0 * 3 + 2];
  const bx = vertices[i1 * 3], by = vertices[i1 * 3 + 1], bz = vertices[i1 * 3 + 2];
  const cx = vertices[i2 * 3], cy = vertices[i2 * 3 + 1], cz = vertices[i2 * 3 + 2];
  // n = (b - a) x (c - a); |n| = 2 * area; direction = face normal.
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz);
  const area = 0.5 * len;
  out.area = area;

  if (len < 1e-20) {
    out.inclination = NaN;
    out.azimuth = NaN;
    return;
  }
  // Inclination folds up/down faces together via |n.z|.
  out.inclination = Math.acos(Math.min(1, Math.abs(nz / len))) * (180 / Math.PI);

  // Orient the normal before reading its bearing.
  let ox = nx, oy = ny, oz = nz;
  if (outwardRef) {
    // Point the normal toward the scanner: flip it if it currently points away
    // from `outwardRef` (negative dot with centroid→ref). Gives the true
    // outward direction on a scanned surface regardless of triangle winding.
    const gx = (ax + bx + cx) / 3, gy = (ay + by + cy) / 3, gz = (az + bz + cz) / 3;
    const rx = outwardRef.x - gx, ry = outwardRef.y - gy, rz = outwardRef.z - gz;
    if (nx * rx + ny * ry + nz * rz < 0) { ox = -ox; oy = -oy; oz = -oz; }
  } else if (nz < 0) {
    // No reference: fold into the upper hemisphere for determinism.
    ox = -ox; oy = -oy; oz = -oz;
  }

  // Azimuth: compass bearing of the oriented normal's horizontal projection.
  const h = Math.hypot(ox, oy);
  if (h < 1e-12) {
    out.azimuth = NaN;  // (near-)horizontal face has no meaningful azimuth
  } else {
    let deg = Math.atan2(oy, ox) * (180 / Math.PI);
    if (deg < 0) deg += 360;
    out.azimuth = deg;
  }
}

// Resolve the per-triangle outward reference (the scanner origin that saw
// triangle `t`) from a mesh's scan provenance, or null when the mesh carries no
// scan origins. Pass the result as `triangleGeometry`'s `outwardRef` so azimuth
// uses the true outward normal. Returns a closure so the flat scanOrigins
// buffer is decoded lazily per triangle without per-call allocation.
export function outwardRefForMesh(
  data: MeshData,
): ((t: number) => { x: number; y: number; z: number } | null) | null {
  const { triangleScanIds, scanOrigins } = data;
  if (!triangleScanIds || !scanOrigins) return null;
  const nScans = scanOrigins.length / 3;
  return (t: number) => {
    const s = triangleScanIds[t];
    if (s < 0 || s >= nScans) return null;
    return { x: scanOrigins[s * 3], y: scanOrigins[s * 3 + 1], z: scanOrigins[s * 3 + 2] };
  };
}

// Compute one scalar per triangle of a mesh for a given pseudocolor mode.
// Returns the per-triangle values plus their finite min/max (for the colorbar).
// 'solid' returns null — there's nothing to scale.
//   inclination: angle between the face normal and the +Z axis, in degrees,
//                folded to [0,90] so up- and down-facing faces read the same
//                (a horizontal face is 0deg, a vertical one 90deg).
//   azimuth:     compass bearing of the normal's horizontal projection, in
//                [0,360) degrees; near-horizontal faces (no azimuth) are NaN.
//   area:        triangle area in the mesh's units squared.
//
// IMPORTANT (azimuth/normal orientation): a triangulated point cloud has no
// consistent face winding, so the raw cross-product normal points to an
// arbitrary side per triangle. For azimuth we orient each normal toward the
// scanner that saw the triangle when the mesh carries scan origins (true
// outward bearing, continuous across a closed surface); otherwise we fall back
// to folding into the upper hemisphere (deterministic but seams a sphere at the
// equator). See `triangleGeometry`/`outwardRefForMesh`. Inclination uses |n.z|
// and is orientation-independent.
export function computeMeshTriangleScalars(
  data: MeshData,
  mode: MeshColorMode,
): { values: Float32Array; min: number; max: number } | null {
  if (mode === 'solid') return null;

  const { vertices, indices, triangleCount } = data;
  const values = new Float32Array(triangleCount);
  let min = Infinity;
  let max = -Infinity;

  // Only azimuth needs the outward reference; skip the lookup for other modes.
  const refFor = mode === 'azimuth' ? outwardRefForMesh(data) : null;

  // Reused scratch — see `triangleGeometryInto`. Allocating one object per
  // triangle here (millions of them) is what flooded the GC and OOM'd the
  // renderer on large meshes.
  const g = { inclination: 0, azimuth: 0, area: 0 };
  for (let t = 0; t < triangleCount; t++) {
    triangleGeometryInto(vertices, indices, t, refFor ? refFor(t) : null, g);
    const v = mode === 'area' ? g.area
      : mode === 'inclination' ? g.inclination
      : g.azimuth;

    values[t] = v;
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { values, min: 0, max: 1 };
  }
  return { values, min, max };
}

// Expand a mesh's indexed vertices into the non-indexed position buffer that
// per-triangle coloring requires (3 unique vertices per triangle, 9 floats per
// triangle). This depends ONLY on the geometry, not the color mode or colormap,
// so callers cache it once per mesh and reuse it across color-mode changes —
// re-expanding it on every recolor wastes a 100+ MB allocation and GPU upload
// on multi-million-triangle meshes.
export function buildMeshNonIndexedPositions(data: MeshData): Float32Array {
  const { vertices, indices, triangleCount } = data;
  const positions = new Float32Array(triangleCount * 9);
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const src = indices[t * 3 + k] * 3;
      const dst = (t * 3 + k) * 3;
      positions[dst] = vertices[src];
      positions[dst + 1] = vertices[src + 1];
      positions[dst + 2] = vertices[src + 2];
    }
  }
  return positions;
}

// Build just the non-indexed per-triangle color buffer for a scalar mode (9
// floats per triangle, all three vertices of a face share the face's color),
// plus the scalar range used. Separate from the positions so a recolor only
// rebuilds/uploads the colors. `rangeOverride` pins the colorbar scale;
// otherwise the data's own min/max is used. Returns null for 'solid'.
export function buildMeshTriangleColors(
  data: MeshData,
  mode: MeshColorMode,
  colormap: ColormapName,
  rangeOverride?: { min: number; max: number },
): { colors: Float32Array; min: number; max: number } | null {
  const scalars = computeMeshTriangleScalars(data, mode);
  if (!scalars) return null;

  const { triangleCount } = data;
  const colors = new Float32Array(triangleCount * 9);

  const min = rangeOverride?.min ?? scalars.min;
  const max = rangeOverride?.max ?? scalars.max;
  const span = (max - min) || 1;

  // Reused 3-slot scratch so the colormap lookup doesn't allocate per triangle.
  const rgb = new Float32Array(3);
  for (let t = 0; t < triangleCount; t++) {
    const value = scalars.values[t];
    const tNorm = Number.isFinite(value) ? (value - min) / span : 0;
    sampleColormapInto(colormap, tNorm, rgb, 0);
    const base = t * 9;
    for (let k = 0; k < 3; k++) {
      const dst = base + k * 3;
      colors[dst] = rgb[0];
      colors[dst + 1] = rgb[1];
      colors[dst + 2] = rgb[2];
    }
  }

  return { colors, min, max };
}

// Build non-indexed geometry buffers that color each triangle by a per-triangle
// scalar (positions + colors together). Thin wrapper over
// `buildMeshNonIndexedPositions` + `buildMeshTriangleColors`; the viewer caches
// those two halves separately, but this combined form is convenient for tests
// and one-shot callers. Returns null for 'solid'.
export function buildMeshTriangleColorBuffers(
  data: MeshData,
  mode: MeshColorMode,
  colormap: ColormapName,
  rangeOverride?: { min: number; max: number },
): { positions: Float32Array; colors: Float32Array; min: number; max: number } | null {
  const built = buildMeshTriangleColors(data, mode, colormap, rangeOverride);
  if (!built) return null;
  return {
    positions: buildMeshNonIndexedPositions(data),
    colors: built.colors,
    min: built.min,
    max: built.max,
  };
}

// Human-readable colorbar label for a mesh pseudocolor mode.
export function meshColorModeLabel(mode: MeshColorMode): string {
  switch (mode) {
    case 'inclination': return 'Inclination (°)';
    case 'azimuth': return 'Azimuth (°)';
    case 'area': return 'Triangle area';
    case 'scan': return 'Source scan';
    default: return '';
  }
}

// Whether a mesh carries the per-triangle scan provenance needed for the
// 'scan' color mode (a Helios multi-scan mesh).
export function meshHasScanColors(data: MeshData): boolean {
  return !!data.triangleScanIds
    && data.triangleScanIds.length === data.triangleCount
    && !!data.scanColors
    && data.scanColors.length > 0;
}

// Build non-indexed buffers that color each triangle by its source scan's
// color. Categorical (no colormap/normalization): each triangle's scan index
// looks up a hex color in `data.scanColors`. Returns null when the mesh has no
// scan provenance. Like the scalar builder, expands to 3 unique vertices per
// triangle (9 floats per triangle).
export function buildMeshScanColorBuffers(
  data: MeshData,
): { positions: Float32Array; colors: Float32Array } | null {
  const colors = buildMeshScanColors(data);
  if (!colors) return null;
  return { positions: buildMeshNonIndexedPositions(data), colors };
}

// Build just the non-indexed per-triangle scan-color buffer (9 floats per
// triangle). Like `buildMeshTriangleColors` but categorical: each triangle's
// scan index looks up a hex color in `data.scanColors`. Separate from the
// positions so the viewer caches them independently. Returns null with no scan
// provenance.
export function buildMeshScanColors(data: MeshData): Float32Array | null {
  if (!meshHasScanColors(data)) return null;

  const { triangleCount, triangleScanIds, scanColors } = data;
  const ids = triangleScanIds!;
  const palette = scanColors!;
  const colors = new Float32Array(triangleCount * 9);

  // Pre-parse each scan's hex color to linear-ish RGB once.
  const rgb = palette.map(hex => {
    const c = new THREE.Color(hex);
    return [c.r, c.g, c.b] as const;
  });
  const fallback = [0.6, 0.6, 0.6] as const; // out-of-range scan id

  for (let t = 0; t < triangleCount; t++) {
    const sid = ids[t];
    const [r, g, b] = (sid >= 0 && sid < rgb.length) ? rgb[sid] : fallback;
    const base = t * 9;
    for (let k = 0; k < 3; k++) {
      const dst = base + k * 3;
      colors[dst] = r;
      colors[dst + 1] = g;
      colors[dst + 2] = b;
    }
  }

  return colors;
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

// Octree attribute names that are builtin LAS/Potree schema fields, not
// user-imported scalar columns. Excluded from the scalar picker because they
// either have a dedicated color mode (intensity, rgb) or aren't meaningful as
// a continuous gradient here (position, classification, return number, …).
// Compared case-insensitively against attribute names from octree metadata.
// Names are compared case-insensitively. PotreeConverter 2.x emits these with
// spaces/hyphens ('return number', 'gps-time', 'point source id'); the
// potree-core decoder / older tooling uses the squashed forms — list both.
const OCTREE_BUILTIN_ATTRIBUTES = new Set([
  'position', 'rgb', 'rgba', 'color', 'intensity', 'classification',
  'returnnumber', 'return number',
  'numberofreturns', 'number of returns',
  'scananglerank', 'scan angle rank', 'scanangle', 'scan angle',
  'userdata', 'user data',
  'pointsourceid', 'point source id', 'sourceid', 'source id',
  'gpstime', 'gps-time', 'gps time',
  'normal', 'indices', 'spacing',
]);

// Derive the selectable scalar-field options for an octree-backed cloud from
// its per-attribute ranges, filtering out builtin schema attributes and
// applying human-readable labels. Returns `{ value, label }` pairs sorted by
// label so the picker order is stable. `value` is the on-disk attribute slug
// (what OctreePointCloud uses to find the geometry buffer); `label` is the
// display text (falls back to the slug when no label was supplied).
export function octreeScalarFieldOptions(
  attributeRanges?: Record<string, { min: number[]; max: number[] }>,
  attributeLabels?: Record<string, string>,
): Array<{ value: string; label: string }> {
  if (!attributeRanges) return [];
  return Object.keys(attributeRanges)
    .filter((name) => !OCTREE_BUILTIN_ATTRIBUTES.has(name.toLowerCase()))
    .map((name) => ({ value: name, label: attributeLabels?.[name] ?? name }))
    .sort((a, b) => a.label.localeCompare(b.label));
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

// ==================== LEAF AREA DENSITY (LAD) HELPERS ====================

// Normalize a LAD value to a [0,1] colormap parameter, clamped. Returns 0 when
// the domain is degenerate (min >= max) or the value isn't finite, so empty
// cells map to the low end of the colormap rather than producing NaN colors.
export function ladColorT(lad: number, min: number, max: number): number {
  if (!isFinite(lad) || !isFinite(min) || !isFinite(max) || max <= min) return 0;
  const t = (lad - min) / (max - min);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// Finite min/max of LAD across a voxel set, ignoring empty cells when asked.
// Falls back to [0, 0] when there's nothing to scale.
export function ladRange(
  voxels: LADVoxel[],
  ignoreEmpty = true,
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of voxels) {
    if (ignoreEmpty && (v.hitCount === 0 || v.lad <= 0)) continue;
    if (!isFinite(v.lad)) continue;
    if (v.lad < min) min = v.lad;
    if (v.lad > max) max = v.lad;
  }
  if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 0 };
  return { min, max };
}

// Assemble a LADRequest from the selected scans, the chosen voxel grid, and the
// algorithm parameters. Pure so it can be unit-tested. Mirrors how the Helios
// triangulation popup builds its request: prefer the on-disk file path, fall
// back to serialising the points; carry each scan's own angular geometry and
// return type. Each scan's multi-return beam fields are attached only when that
// scan is actually multi-return.
// The per-pulse multi-return columns Helios needs to run the full-waveform LAD
// algorithm. On a synthetic-scan cloud they live in `scalarFields` under exactly
// these names (the backend records them under the same keys).
const LAD_MULTI_RETURN_FIELDS = ['timestamp', 'target_index', 'target_count'] as const;

export function buildLADRequest(
  scans: Scan[],
  grid: HeliosGrid,
  params: { lmax: number; maxAspectRatio: number; minVoxelHits: number; elementWidth?: number },
): LADRequest {
  const requestScans: LADScanEntry[] = scans.map(scan => {
    const p = scan.params!;
    const entry: LADScanEntry = {
      origin: [p.origin.x, p.origin.y, p.origin.z],
      n_theta: p.zenithPoints,
      n_phi: p.azimuthPoints,
      theta_min: p.zenithMinDeg,
      theta_max: p.zenithMaxDeg,
      phi_min: p.azimuthMinDeg,
      phi_max: p.azimuthMaxDeg,
      return_type: p.returnType,
    };
    if (p.returnType === 'multi') {
      entry.beam_exit_diameter = p.beamExitDiameterM;
      entry.beam_divergence = p.beamDivergenceMrad;
    }
    // Source priority mirrors the backend's feed resolution:
    //   1. session_id — a session-backed (octree) cloud, fed from its in-RAM
    //      arrays (honors unbaked deletions, carries multi-return columns).
    //   2. file_path — a file-backed cloud; Helios reads it from disk with its
    //      own columns (no huge JSON, preserves multi-return columns in-file).
    //   3. inline points (+ scalar_columns) — an in-memory cloud with neither a
    //      session nor a source file (e.g. a synthetic full-waveform scan).
    // When a cloud has BOTH a session and a source file, send both: the backend
    // prefers the session (honoring unbaked deletions) but falls back to the
    // file if the session is gone — e.g. after a backend restart, which orphans
    // the in-memory session while the renderer still holds its id.
    const sessionId = scan.data?.octree?.sessionId;
    if (sessionId && scan.sourcePath) {
      entry.session_id = sessionId;
      entry.file_path = scan.sourcePath;
      entry.ascii_format = scan.asciiFormat ?? null;
    } else if (sessionId) {
      entry.session_id = sessionId;
    } else if (scan.sourcePath) {
      entry.file_path = scan.sourcePath;
      entry.ascii_format = scan.asciiFormat ?? null;
    } else if (scan.data && scan.data.positions.length > 0) {
      const points: number[][] = [];
      for (let i = 0; i < scan.data.pointCount; i++) {
        const idx = i * 3;
        points.push([
          scan.data.positions[idx],
          scan.data.positions[idx + 1],
          scan.data.positions[idx + 2],
        ]);
      }
      entry.points = points;
      // Carry the per-pulse columns for a synthetic full-waveform cloud so the
      // backend runs the multi-return algorithm. Attach only when ALL three are
      // present and aligned with the points.
      const fields = scan.data.scalarFields;
      if (fields && LAD_MULTI_RETURN_FIELDS.every(
        f => fields[f] && fields[f].values.length === scan.data!.pointCount)) {
        const cols: Record<string, number[]> = {};
        for (const f of LAD_MULTI_RETURN_FIELDS) {
          cols[f] = Array.from(fields[f].values);
        }
        entry.scalar_columns = cols;
      }
    }
    return entry;
  });

  return {
    scans: requestScans,
    grid,
    lmax: params.lmax,
    max_aspect_ratio: params.maxAspectRatio,
    min_voxel_hits: params.minVoxelHits,
    // Drives the Pimont (2018) uncertainty; omit to let the backend default it.
    ...(params.elementWidth !== undefined ? { element_width: params.elementWidth } : {}),
    // Request-level angular fallbacks (per-scan values above take precedence).
    theta_min: 30,
    theta_max: 130,
    phi_min: 0,
    phi_max: 360,
  };
}

// Randomly downsample a flat point cloud, keeping a fraction of the points.
// `targetCount` is derived from `originalCount * fraction` (the original count is
// passed in so a live preview resamples against the pristine point total, not a
// previously-previewed subset), then that many points are drawn from `data`
// without replacement (Fisher–Yates, kept indices sorted to preserve order).
// All parallel buffers — colors, intensities, scalar fields — are carried along,
// and bounds are recomputed. Returns a new PointCloudData; `data` is untouched.
export function resampleCloud(
  data: PointCloudData,
  fraction: number,
  originalCount: number,
): PointCloudData {
  const sourceCount = data.pointCount;
  const targetCount = Math.max(1, Math.round(originalCount * fraction));

  // Fisher–Yates shuffle of [0..sourceCount), then take the first targetCount.
  const indices: number[] = [];
  for (let i = 0; i < sourceCount; i++) indices.push(i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const keptIndices = indices.slice(0, targetCount).sort((a, b) => a - b);

  const newPositions = new Float32Array(targetCount * 3);
  const newColors = data.colors ? new Float32Array(targetCount * 3) : undefined;
  const newIntensities = data.intensities ? new Float32Array(targetCount) : undefined;
  const newScalarFields: Record<string, { values: Float32Array; min: number; max: number }> = {};

  Object.keys(data.scalarFields || {}).forEach(name => {
    newScalarFields[name] = { values: new Float32Array(targetCount), min: Infinity, max: -Infinity };
  });

  for (let i = 0; i < targetCount; i++) {
    const srcIdx = keptIndices[i];
    newPositions[i * 3] = data.positions[srcIdx * 3];
    newPositions[i * 3 + 1] = data.positions[srcIdx * 3 + 1];
    newPositions[i * 3 + 2] = data.positions[srcIdx * 3 + 2];

    if (newColors && data.colors) {
      newColors[i * 3] = data.colors[srcIdx * 3];
      newColors[i * 3 + 1] = data.colors[srcIdx * 3 + 1];
      newColors[i * 3 + 2] = data.colors[srcIdx * 3 + 2];
    }
    if (newIntensities && data.intensities) {
      newIntensities[i] = data.intensities[srcIdx];
    }
    Object.entries(data.scalarFields || {}).forEach(([name, field]) => {
      const val = field.values[srcIdx];
      newScalarFields[name].values[i] = val;
      newScalarFields[name].min = Math.min(newScalarFields[name].min, val);
      newScalarFields[name].max = Math.max(newScalarFields[name].max, val);
    });
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < targetCount; i++) {
    const x = newPositions[i * 3];
    const y = newPositions[i * 3 + 1];
    const z = newPositions[i * 3 + 2];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }

  return {
    ...data,
    positions: newPositions,
    colors: newColors,
    intensities: newIntensities,
    scalarFields: newScalarFields,
    pointCount: targetCount,
    bounds: {
      min: new THREE.Vector3(minX, minY, minZ),
      max: new THREE.Vector3(maxX, maxY, maxZ),
      center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
      size: new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ),
    },
  } as PointCloudData;
}
