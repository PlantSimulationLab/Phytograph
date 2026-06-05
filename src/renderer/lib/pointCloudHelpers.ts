// Pure, stateless helpers extracted from PointCloudViewer.tsx. No React, no
// component state — safe to unit-test directly.
import * as THREE from 'three';
import type { MeshData, ShapeType, MeshColorMode, LADVoxel } from './pointCloudTypes';
import type { HeliosGrid, LADRequest, LADScanEntry } from '../utils/backendApi';
import type { Scan } from './scan';
import { sampleColormap, type ColormapName } from './colormaps';

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
// arbitrary side per triangle — adjacent coplanar faces can disagree by 180deg,
// which made azimuth flip randomly. Helios's Triangulation stores no normal to
// follow, so there is no upstream convention. We adopt the standard leaf-angle
// convention: orient every normal into the upper hemisphere (force n.z >= 0)
// before deriving angles. This is deterministic and matches how leaf
// inclination/azimuth distributions are defined for plant LiDAR. (Inclination
// already used |n.z| so it was unaffected; azimuth now uses the oriented n.)
export function computeMeshTriangleScalars(
  data: MeshData,
  mode: MeshColorMode,
): { values: Float32Array; min: number; max: number } | null {
  if (mode === 'solid') return null;

  const { vertices, indices, triangleCount } = data;
  const values = new Float32Array(triangleCount);
  let min = Infinity;
  let max = -Infinity;

  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    ax.set(vertices[i0 * 3], vertices[i0 * 3 + 1], vertices[i0 * 3 + 2]);
    bx.set(vertices[i1 * 3], vertices[i1 * 3 + 1], vertices[i1 * 3 + 2]);
    cx.set(vertices[i2 * 3], vertices[i2 * 3 + 1], vertices[i2 * 3 + 2]);
    e1.subVectors(bx, ax);
    e2.subVectors(cx, ax);
    n.crossVectors(e1, e2); // length = 2 * area; direction = face normal

    let v: number;
    if (mode === 'area') {
      v = 0.5 * n.length();
    } else {
      const len = n.length();
      if (len < 1e-20) {
        v = NaN; // degenerate triangle — no meaningful normal
      } else if (mode === 'inclination') {
        // Fold to [0,90]: a face and its back read the same inclination.
        const cosz = Math.abs(n.z / len);
        v = Math.acos(Math.min(1, cosz)) * (180 / Math.PI);
      } else {
        // azimuth: bearing of the normal's horizontal projection. Orient the
        // normal into the upper hemisphere first (flip when n.z < 0) so the
        // arbitrary triangle winding can't flip the bearing by 180deg.
        let nx = n.x, ny = n.y;
        if (n.z < 0) { nx = -nx; ny = -ny; }
        const h = Math.hypot(nx, ny);
        if (h < 1e-12) {
          v = NaN; // (near-)horizontal face has no meaningful azimuth
        } else {
          let deg = Math.atan2(ny, nx) * (180 / Math.PI);
          if (deg < 0) deg += 360;
          v = deg;
        }
      }
    }

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

// Build non-indexed geometry buffers that color each triangle by a per-triangle
// scalar. Per-triangle coloring can't use shared (indexed) vertices, so we
// expand to 3 unique vertices per triangle and give all three the triangle's
// color. Returns flat position + color arrays (9 floats per triangle each) plus
// the scalar range used, or null for 'solid'. `rangeOverride` pins the colorbar
// scale; otherwise the data's own min/max is used.
export function buildMeshTriangleColorBuffers(
  data: MeshData,
  mode: MeshColorMode,
  colormap: ColormapName,
  rangeOverride?: { min: number; max: number },
): { positions: Float32Array; colors: Float32Array; min: number; max: number } | null {
  const scalars = computeMeshTriangleScalars(data, mode);
  if (!scalars) return null;

  const { vertices, indices, triangleCount } = data;
  const positions = new Float32Array(triangleCount * 9);
  const colors = new Float32Array(triangleCount * 9);

  const min = rangeOverride?.min ?? scalars.min;
  const max = rangeOverride?.max ?? scalars.max;
  const span = (max - min) || 1;

  for (let t = 0; t < triangleCount; t++) {
    const value = scalars.values[t];
    const tNorm = Number.isFinite(value) ? (value - min) / span : 0;
    const [r, g, b] = sampleColormap(colormap, tNorm);
    for (let k = 0; k < 3; k++) {
      const src = indices[t * 3 + k] * 3;
      const dst = (t * 3 + k) * 3;
      positions[dst] = vertices[src];
      positions[dst + 1] = vertices[src + 1];
      positions[dst + 2] = vertices[src + 2];
      colors[dst] = r;
      colors[dst + 1] = g;
      colors[dst + 2] = b;
    }
  }

  return { positions, colors, min, max };
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
  if (!meshHasScanColors(data)) return null;

  const { vertices, indices, triangleCount, triangleScanIds, scanColors } = data;
  const ids = triangleScanIds!;
  const palette = scanColors!;
  const positions = new Float32Array(triangleCount * 9);
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
    for (let k = 0; k < 3; k++) {
      const src = indices[t * 3 + k] * 3;
      const dst = (t * 3 + k) * 3;
      positions[dst] = vertices[src];
      positions[dst + 1] = vertices[src + 1];
      positions[dst + 2] = vertices[src + 2];
      colors[dst] = r;
      colors[dst + 1] = g;
      colors[dst + 2] = b;
    }
  }

  return { positions, colors };
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
  params: { lmax: number; maxAspectRatio: number; minVoxelHits: number },
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
    const sessionId = scan.data?.octree?.sessionId;
    if (sessionId) {
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
    // Request-level angular fallbacks (per-scan values above take precedence).
    theta_min: 30,
    theta_max: 130,
    phi_min: 0,
    phi_max: 360,
  };
}
