// Pure, stateless helpers extracted from PointCloudViewer.tsx. No React, no
// component state — safe to unit-test directly.
import * as THREE from 'three';
import type { MeshData, ShapeType, MeshColorMode, LADVoxel, PointCloudData, ScalarField } from './pointCloudTypes';
import type { HeliosGrid, HeliosScanEntry, HeliosTriangulationRequest, LADRequest, LADScanEntry } from '../utils/backendApi';
import type { Scan } from './scan';
import { poseStreamToWire } from './poseStream';
import { sampleColormapInto, type ColormapName } from './colormaps';
import { applyTriangleFilter } from './triangleFilter';

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

// ── Render-only display offset (Layer 2 precision safety net) ──────────────
//
// Projected/UTM scans carry huge coordinates (5e5–1e6+ m). float32 has ~24
// mantissa bits, so at magnitude 5e5 the representable spacing is ~6 cm — and
// vertex BufferAttributes are float32. The grid kinks and QSM/skeleton/triangle
// meshes z-fight because the *vertex data itself* is already quantized the
// moment it lands in the Float32Array, before any matrix is applied. Merely
// translating the object via a float64 `.position` does NOT recover those lost
// bits.
//
// The fix is a render-only `displayOffset`: an INTEGER per-axis offset near the
// scene center. We subtract it from the owned vertex buffers (so the stored
// float32 values are small, ~30 µm spacing) and from the camera (so the image
// is unchanged), then ADD IT BACK at every boundary where a coordinate is shown
// to the user or sent to the backend — exports/payloads stay in true world
// space. `displayOffset` is transient and render-only; it is conceptually
// distinct from a cloud's persistent `worldShift` (world = stored + worldShift).

export type Vec3Like = { x: number; y: number; z: number };

// Per axis: 0 when |center| is below `threshold` (small-coord scenes are a
// complete no-op — buffers shared uncopied, image identical), else the rounded
// integer nearest the center. Integers are exact in float32/float64, so the
// offset is stable across recomputes and never reintroduces fractional error.
export function computeDisplayOffset(
  worldCenter: Vec3Like,
  threshold = 1e4,
): { x: number; y: number; z: number } {
  const pick = (c: number) =>
    !isFinite(c) || Math.abs(c) < threshold ? 0 : Math.round(c);
  return { x: pick(worldCenter.x), y: pick(worldCenter.y), z: pick(worldCenter.z) };
}

// Subtract `offset` from interleaved [x,y,z,...] positions to move them into
// display space. When the offset is all-zero the source array is returned
// UNCHANGED (zero copy — preserves the shared-buffer memory model that keeps
// big flat clouds off the heap twice).
//
// PRECISION NOTE: this only RECOVERS precision when `src` still carries the
// full-precision value. Flat-cloud positions arrive from the backend ALREADY
// float32-quantized (the float64→float32 cast happens server-side in
// `_pack_pointcloud_response`), so re-centering them here cannot restore the
// lost low bits — it only fixes the SECONDARY error (a huge modelView
// translation column / depth-buffer range), which still meaningfully reduces
// shimmer. The PRIMARY fix for renderer-built geometry (QSM/skeleton, whose
// vertices are computed from float64 JSON into a number[] before the single
// float32 cast) is to subtract the offset on that float64 path, where it lands
// the vertex small BEFORE quantization. See QSM3D.appendTube / Skeleton3D.
export function recenterPositions(
  src: Float32Array,
  count: number,
  offset: Vec3Like,
): Float32Array {
  if (offset.x === 0 && offset.y === 0 && offset.z === 0) return src;
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = src[i * 3] - offset.x;
    out[i * 3 + 1] = src[i * 3 + 1] - offset.y;
    out[i * 3 + 2] = src[i * 3 + 2] - offset.z;
  }
  return out;
}

// World↔display scalar point conversion (display = world − offset).
export function worldToDisplay(p: Vec3Like, offset: Vec3Like): { x: number; y: number; z: number } {
  return { x: p.x - offset.x, y: p.y - offset.y, z: p.z - offset.z };
}
export function displayToWorld(p: Vec3Like, offset: Vec3Like): { x: number; y: number; z: number } {
  return { x: p.x + offset.x, y: p.y + offset.y, z: p.z + offset.z };
}

// Convert a display-space view matrix (the live offset camera's
// matrixWorldInverse) into the WORLD-space view matrix the backend needs.
//
// The scene renders a world point p at p − offset, and the display camera's
// view V_disp maps display points to eye space, so V_disp · (p − offset) is the
// eye-space position the user actually saw. The backend reprojects TRUE WORLD
// positions p through the frozen view, so it needs V_world with
// V_world · p == V_disp · (p − offset), i.e.
//   V_world = V_disp · T(−offset)
// (right-multiply by a translation of −offset). The projection matrix is
// unaffected by a uniform translation of geometry + camera (it consumes only
// eye space), so it is frozen and sent unchanged.
export function displayViewToWorldView(
  vDisp: THREE.Matrix4,
  offset: Vec3Like,
): THREE.Matrix4 {
  return vDisp
    .clone()
    .multiply(new THREE.Matrix4().makeTranslation(-offset.x, -offset.y, -offset.z));
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
// (defaulting to a single cell when unset). `rotationDeg` is the box's z-Euler
// angle (degrees); a meaningful non-zero value becomes the grid's azimuthal
// rotation (only z is representable in a Helios grid — x/y tilt is ignored).
// Returns null when the mesh carries no grid subdivisions (i.e. it isn't a
// voxel box).
export function voxelMeshToHeliosGrid(
  position: { x: number; y: number; z: number } | undefined,
  scale: { x: number; y: number; z: number } | undefined,
  subdivisions: { x: number; y: number; z: number } | undefined,
  rotationDeg?: number,
): HeliosGrid | null {
  if (!subdivisions) return null;
  const p = position ?? { x: 0, y: 0, z: 0 };
  const s = scale ?? { x: 1, y: 1, z: 1 };
  const grid: HeliosGrid = {
    center: [p.x, p.y, p.z],
    size: [s.x, s.y, s.z],
    nx: Math.max(1, Math.round(subdivisions.x)),
    ny: Math.max(1, Math.round(subdivisions.y)),
    nz: Math.max(1, Math.round(subdivisions.z)),
  };
  if (rotationDeg && Math.abs(rotationDeg) > 1e-6) grid.rotation = rotationDeg;
  return grid;
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

// Octree attribute names that have a dedicated render path (geometry / colour /
// intensity), so they must never appear in the *scalar* picker. Everything else
// in the octree metadata IS a user-selectable scalar — including the standard
// LAS dimensions the backend now carries explicitly (classification, scan_angle,
// point_source_id, user_data, …; see `_read_las_into_arrays`). Those used to be
// filtered out here, but the backend rebuilds the octree from session arrays and
// only surfaces a dim when it holds non-constant data, so carrying them through
// to the picker is the whole point of the fix. Compared case-insensitively.
// PotreeConverter 2.x can emit position/colour with spaces ('rgb', 'position');
// the potree-core decoder uses the squashed forms — list both spellings.
//
// PotreeConverter also writes LAS standard point dimensions (return number,
// scan angle rank, gps-time, …) even when the source is a plain XYZ with no such
// data — they come through degenerate (all-zero). These are sensor/schema
// plumbing, not user-meaningful scalars, so they must NOT appear in the
// colour-by picker. Names are PotreeConverter's exact spellings (spaces and the
// hyphen in 'gps-time'); the filter lowercases before comparing.
//
// NOTE: 'classification' is intentionally NOT filtered — it's a real LAS dim a
// user may have segmented (ground/wood/leaf), so it stays selectable.
const OCTREE_BUILTIN_ATTRIBUTES = new Set([
  'position', 'rgb', 'rgba', 'color', 'intensity',
  'normal', 'indices', 'spacing',
  // LAS sensor/schema dimensions PotreeConverter always emits (degenerate for
  // non-LAS sources); never user-meaningful as a colour-by field.
  'return number', 'number of returns',
  'scan angle rank', 'user data', 'point source id', 'gps-time',
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

// Turn a synthetic scan's returned per-hit scalar arrays into the cloud's
// color-by `scalarFields` map, honoring the user's retained-fields selection.
//
//   - `intensity` is never a scalar field — it owns a dedicated color mode and
//     the cloud's `intensities` array — so it's skipped here (the caller pulls
//     it out separately) and returned via `intensities`.
//   - A STANDARD field (per `standardSlugs`) the user did NOT retain is pruned,
//     so it never reaches the picker.
//   - A RETAINED field is kept even when constant (bypassing the variance check)
//     so e.g. a single-sweep `timestamp` still shows in Color by. Anything else
//     keeps the legacy varies-only rule (constant fields are useless to color by
//     and would clutter the picker).
//   - All-NaN fields are always dropped (the backend already prunes them, but
//     guard here too).
export function assembleScanScalarFields(
  scalars: Record<string, Float32Array>,
  n: number,
  retainedSlugs: Iterable<string>,
  standardSlugs: Iterable<string>,
): { scalarFields: Record<string, ScalarField>; intensities?: Float32Array } {
  const retainedSet = new Set(retainedSlugs);
  const standardSet = new Set(standardSlugs);
  const scalarFields: Record<string, ScalarField> = {};
  let intensities: Float32Array | undefined;
  for (const [name, arr] of Object.entries(scalars)) {
    if (!arr || arr.length !== n) continue;
    if (name === 'intensity') { intensities = arr; continue; }
    // Prune any standard field the user didn't retain.
    if (standardSet.has(name) && !retainedSet.has(name)) continue;
    let mn = Infinity, mx = -Infinity;
    for (const v of arr) { if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; } }
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) continue; // all-NaN
    if (retainedSet.has(name) || mn !== mx) {
      scalarFields[name] = { values: arr, min: mn, max: mx };
    }
  }
  return { scalarFields, intensities };
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
    case 'plane':
      // Unit quad in the XY plane (facing +Z). Width/length come from the mesh's
      // per-axis scale transform; Euler rotation reorients it.
      geometry = new THREE.PlaneGeometry(1, 1);
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

// Resolve a scan's point-data SOURCE for a Helios request (triangulation or LAD)
// by the priority the backend feed expects, and write it onto `entry`:
//   1. session_id — a session-backed (octree) cloud: the backend triangulates its
//      surviving in-RAM HIT points (deletions honored, sky/miss points excluded).
//      This is the source of truth after ANY edit (crop/erase/backfill/segment),
//      so the original file is never re-read. Sent with file_path as a restart
//      fallback when the cloud has both.
//   2. file_path — a file-backed cloud with no session (Helios reads it from disk;
//      tiny request body, original columns preserved).
//   3. inline points — a FLAT in-RAM cloud with populated positions and neither a
//      session nor a source file (e.g. a synthetic scan).
// The `positions.length > 0` guard on (3) is load-bearing: an octree cloud has
// EMPTY positions but a full pointCount, so an unguarded points loop would
// serialise millions of `[undefined, undefined, undefined]` (including any
// backfilled misses) into a multi-hundred-MB JSON body that OOM'd the backend's
// pydantic parse. Returns true if a source was found, false if the scan has none.
export function resolveHeliosScanSource(scan: Scan, entry: HeliosScanEntry): boolean {
  const sessionId = scan.data?.octree?.sessionId;
  if (sessionId && scan.sourcePath) {
    entry.session_id = sessionId;
    entry.file_path = scan.sourcePath;
    entry.ascii_format = scan.asciiFormat ?? null;
    return true;
  }
  if (sessionId) {
    entry.session_id = sessionId;
    return true;
  }
  if (scan.sourcePath) {
    entry.file_path = scan.sourcePath;
    entry.ascii_format = scan.asciiFormat ?? null;
    return true;
  }
  if (scan.data && scan.data.positions.length > 0) {
    const points: number[][] = [];
    for (let i = 0; i < scan.data.pointCount; i++) {
      const idx = i * 3;
      points.push([scan.data.positions[idx], scan.data.positions[idx + 1], scan.data.positions[idx + 2]]);
    }
    entry.points = points;
    return true;
  }
  return false;
}

// Assemble a Helios triangulation request from the selected scans + optional
// voxel grid. Pure so it can be unit-tested. Runs UNFILTERED (lmax/aspect huge):
// the backend returns every candidate triangle and the interactive Lmax/aspect
// filter is applied client-side afterwards. Throws if a scan has no resolvable
// point source (see resolveHeliosScanSource).
export function buildHeliosTriangulationRequest(
  scans: Scan[],
  grid: HeliosGrid | null,
): HeliosTriangulationRequest {
  const requestScans: HeliosScanEntry[] = scans.map(scan => {
    const p = scan.params!;
    const entry: HeliosScanEntry = {
      origin: [p.origin.x, p.origin.y, p.origin.z],
      n_theta: p.zenithPoints,
      n_phi: p.azimuthPoints,
      theta_min: p.zenithMinDeg,
      theta_max: p.zenithMaxDeg,
      phi_min: p.azimuthMinDeg,
      phi_max: p.azimuthMaxDeg,
    };
    if (!resolveHeliosScanSource(scan, entry)) {
      throw new Error(
        `Scan "${scan.label}" has no triangulation source: no session, no source file, and no in-RAM points. Re-import the scan and try again.`,
      );
    }
    return entry;
  });

  return {
    scans: requestScans,
    lmax: 1.0e9,
    max_aspect_ratio: 1.0e9,
    theta_min: 30,
    theta_max: 130,
    phi_min: 0,
    phi_max: 360,
    ...(grid ? { grid } : {}),
  };
}

// Assemble a LADRequest from the selected scans, the chosen voxel grid, and the
// algorithm parameters. Pure so it can be unit-tested. Uses the same source
// priority as buildHeliosTriangulationRequest / the backend feed (session →
// file → inline points), plus each scan's angular geometry, return type, and —
// for multi-return scans — the per-pulse beam fields.
// The per-pulse multi-return columns Helios needs to run the full-waveform LAD
// algorithm. On a synthetic-scan cloud they live in `scalarFields` under exactly
// these names (the backend records them under the same keys).
const LAD_MULTI_RETURN_FIELDS = ['timestamp', 'target_index', 'target_count'] as const;

export function buildLADRequest(
  scans: Scan[],
  grid: HeliosGrid,
  params: {
    lmax: number; maxAspectRatio: number; minVoxelHits: number;
    elementWidth?: number;
    // Mean leaf-projection coefficient G(theta) — required for moving-platform
    // scans (no triangulation to derive it), ignored for static scans.
    gtheta?: number;
  },
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
      // LAD's wire field is the single/multi binary the inversion keys on (multi
      // needs the per-pulse target_count weighting); it mirrors returnMode directly.
      return_type: p.returnMode,
    };
    if (p.returnMode === 'multi') {
      entry.beam_exit_diameter = p.beamExitDiameterM;
      entry.beam_divergence = p.beamDivergenceMrad;
    }
    // Moving-platform scan: forward the trajectory so the backend reconstructs a
    // per-beam origin per return (joined by timestamp) and runs the beam-based
    // (Gtheta) inversion. The point data must carry a `timestamp` column for the
    // join — session-backed clouds surface it from their extras; for an inline
    // cloud it must be included in scalar_columns below.
    if (p.trajectory) {
      entry.trajectory = poseStreamToWire(p.trajectory);
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
      const cols: Record<string, number[]> = {};
      if (fields && LAD_MULTI_RETURN_FIELDS.every(
        f => fields[f] && fields[f].values.length === scan.data!.pointCount)) {
        for (const f of LAD_MULTI_RETURN_FIELDS) {
          cols[f] = Array.from(fields[f].values);
        }
      }
      // A moving scan needs the per-return timestamp (the trajectory join key) and
      // is_miss; include whichever columns the inline cloud carries even when the
      // full multi-return triple is absent (single-return moving clouds).
      if (p.trajectory && fields) {
        for (const f of ['timestamp', 'is_miss']) {
          if (!cols[f] && fields[f] && fields[f].values.length === scan.data!.pointCount) {
            cols[f] = Array.from(fields[f].values);
          }
        }
      }
      if (Object.keys(cols).length > 0) {
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
    // G(theta) for moving-platform scans (no-op for static); omit to let the
    // backend default it to 0.5 (spherical) with a warning.
    ...(params.gtheta !== undefined ? { gtheta: params.gtheta } : {}),
    // Request-level angular fallbacks (per-scan values above take precedence).
    theta_min: 30,
    theta_max: 130,
    phi_min: 0,
    phi_max: 360,
  };
}

// The indexed triangle mesh + per-triangle scan ids to inject into a reused LAD
// run. `vertices`/`indices` are the filtered mesh's buffers (vertices shared,
// unexpanded); `scanIds` is remapped to the LAD request's scan order (see
// extractReuseMeshPayload). The backend expands indices->soup before injection.
export interface ReuseMeshPayload {
  vertices: Float32Array;  // (V*3) interleaved xyz
  indices: Uint32Array;    // (T*3) triangle vertex indices
  scanIds: Int32Array;     // (T) source scan index in request-scan order
  triangleCount: number;
}

// The uint32 sentinel the backend packs for a triangle whose centroid fell
// outside every grid cell (-1 & 0xffffffff). Such triangles must not feed the
// LAD inversion — only in-grid geometry is valid for the per-cell G(theta).
const CELL_OUTSIDE = 0xffffffff;

// Build the mesh payload for reusing a triangulation in LAD. Reusing a mesh must
// reproduce EXACTLY the triangulation the user sees, so:
//   1. Apply the current interactive filter (lmax/maxAspectRatio) — the inversion
//      keys on the filtered triangle set, not the unfiltered candidate set. (A
//      ball-pivot mesh has no edge/aspect metrics, so the filter is a no-op and
//      every triangle passes through.)
//   2. Drop any triangle whose grid cell id is the "outside" sentinel, so only
//      in-grid triangles reach the inversion. The backend crop already confines
//      ball-pivot points to the grid, but a centroid can still straddle a cell
//      boundary — this is the belt-and-suspenders for "only in-grid triangles".
//   3. Remap each surviving triangle's scan id. A Helios mesh's triangleScanIds
//      are indices into the ORIGINAL triangulation's scan list (sourceScanIds
//      order). At LAD time the cloud's scans are added in the request's scan
//      order, so each id is translated: originalIdx -> sourceScanIds[originalIdx]
//      (scan-id string) -> its position in requestScanIdOrder. A per-scan
//      ball-pivot mesh carries NO triangleScanIds (one source scan, so every
//      triangle is scan index 0) — synthesized here. Throws if any source scan is
//      missing from the request order — a partial mesh would silently change
//      G(theta).
// `meshData` is the mesh to reuse (the UNFILTERED Helios candidate set, or a
// ball-pivot mesh's `data`); pass requestScanIdOrder = the exact scan-id list, in
// order, that buildLADRequest will emit (i.e. selectedScans.map(s => s.id)).
export function extractReuseMeshPayload(
  meshData: MeshData,
  lmax: number,
  maxAspectRatio: number,
  sourceScanIds: string[],
  requestScanIdOrder: string[],
): ReuseMeshPayload {
  const filtered = applyTriangleFilter(meshData, lmax, maxAspectRatio);
  const n = filtered.triangleCount;

  // Per-triangle scan ids. Helios meshes carry them; a per-scan ball-pivot mesh
  // (exactly one source scan) does not — every triangle is scan index 0.
  let triScan = filtered.triangleScanIds;
  if (!triScan || triScan.length !== n) {
    if (sourceScanIds.length === 1) {
      triScan = new Uint32Array(n); // all zeros: the single source scan
    } else {
      throw new Error(
        'Cannot reuse this triangulation: it has no per-triangle scan ids '
        + '(re-run the Helios triangulation to record them).');
    }
  }

  const requestIndexOf = new Map<string, number>();
  requestScanIdOrder.forEach((id, i) => requestIndexOf.set(id, i));

  // Drop out-of-grid triangles (sentinel cell id) so only in-grid geometry feeds
  // the inversion. With no cell ids (legacy Helios meshes) keep every triangle.
  const cellIds = filtered.triangleCellIds;
  const hasCellIds = !!cellIds && cellIds.length === n;

  const srcIdx = filtered.indices;
  const keptIndices: number[] = [];
  const keptScanIds: number[] = [];
  for (let t = 0; t < n; t++) {
    if (hasCellIds && cellIds![t] === CELL_OUTSIDE) continue;
    const originalIdx = triScan[t];
    const scanIdStr = sourceScanIds[originalIdx];
    const reqIdx = scanIdStr !== undefined ? requestIndexOf.get(scanIdStr) : undefined;
    if (reqIdx === undefined) {
      throw new Error(
        'Cannot reuse this triangulation: one of its source scans is no longer '
        + 'available, so the result would not match the original mesh.');
    }
    keptIndices.push(srcIdx[t * 3], srcIdx[t * 3 + 1], srcIdx[t * 3 + 2]);
    keptScanIds.push(reqIdx);
  }

  const T = keptScanIds.length;
  return {
    vertices: filtered.vertices,
    indices: Uint32Array.from(keptIndices),
    scanIds: Int32Array.from(keptScanIds),
    triangleCount: T,
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
