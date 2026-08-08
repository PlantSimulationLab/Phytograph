// Shared QSM tube geometry. This is the SINGLE source of truth for how a QSM's
// cylinders become a surface — used by both the viewport renderer (QSM3D.tsx) and
// the OBJ/PLY exporters (qsmExport.ts).
//
// Why it's shared: the two used to build geometry independently, and the exported
// mesh did NOT match what the user saw. The viewport swept one continuous tube per
// shoot; the exporters emitted an independent CAPPED cylinder per cylinder, with a
// world-referenced (not transported) ring frame, unreconciled joints, and stepped
// radii. The result was visibly disjoint cylinders in Blender/CloudCompare where
// the viewport showed a smooth tube — and, worse, wrong surface area / volume,
// since the buried caps and radius steps are real geometry.
//
// The model here is the viewport's: each SHOOT is one continuous tube. A single
// shared ring of vertices per node is swept along the shoot's centerline with a
// rotation-minimizing (parallel-transport) frame, so the surface is seamless, the
// radius varies continuously across joints, and rings don't twist. This matches
// what Helios' plant-architecture plugin does (one tube per branch; branches simply
// overlap at forks, with no miter geometry).
//
// Deliberately three.js-free so the exporters (pure string serializers, unit-tested
// without a WebGL context) can share it. QSM3D.tsx adapts the plain [x,y,z] tuples
// to THREE.Vector3 at its boundary.

import type { QSMCylinder, QSMShoot } from '../utils/backendApi';

export type Vec3 = [number, number, number];

// Radii below this collapse the ring to a point and produce degenerate normals.
const MIN_RADIUS = 1e-5;

/**
 * Default world-space edge length of one texture tile, in metres. Matches the
 * `texture_repeat_length` Helios' plant-architecture plugin uses for bark
 * (PlantArchitecture.cpp), so a QSM tube tiles at the same physical scale as a
 * Helios-generated plant.
 */
export const DEFAULT_TEXTURE_TILE_SIZE = 0.25;

/**
 * How many times the texture wraps around a ring of radius `r`.
 *
 * Both UV axes are measured in the SAME world units (metres / tileSize), which is
 * what keeps a bark tile roughly SQUARE at every girth. Helios instead wraps
 * exactly ONCE around regardless of radius (Context_object.cpp assigns the
 * circumferential coordinate as j/radial_subdivisions), so its tile aspect scales
 * with girth — ~0.25:1 on a 1cm twig vs ~7.5:1 on a 30cm trunk, a ~30x swing that
 * reads as badly stretched bark on a trunk. Helios can't do better: its
 * Tube::appendTubeSegment hard-errors if the coordinate leaves [0,1]. three.js has
 * no such limit (RepeatWrapping), so we tile proportionally instead.
 *
 * The count is ROUNDED to an integer so the pattern closes seamlessly: the ring's
 * duplicated seam vertex lands on an integer u, which coincides with u=0 under
 * RepeatWrapping. A fractional count would leave a visible vertical seam stripe
 * down every tube. Floored at 1 so a hair-thin twig still gets a whole tile.
 */
export function wrapsForRadius(radius: number, tileSize: number): number {
  if (!(tileSize > 0)) return 1;
  return Math.max(1, Math.round((2 * Math.PI * radius) / tileSize));
}

// --- small vector helpers ----------------------------------------------------

function sub(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function norm(v: readonly number[]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function cross(a: readonly number[], b: readonly number[]): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: readonly number[]): Vec3 {
  const n = norm(v);
  if (n === 0) return [0, 0, 0];
  return [v[0] / n, v[1] / n, v[2] / n];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Rodrigues rotation of v about a UNIT axis by `angle` radians.
function rotateAboutAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = dot(axis, v) * (1 - c);
  const cr = cross(axis, v);
  return [
    v[0] * c + cr[0] * s + axis[0] * k,
    v[1] * c + cr[1] * s + axis[1] * k,
    v[2] * c + cr[2] * s + axis[2] * k,
  ];
}

// --- per-cylinder scalars (used by the CSV export) ---------------------------

/** Unit cylinder axis from start->end. Returns null for degenerate cylinders. */
export function cylinderAxis(c: QSMCylinder): Vec3 | null {
  const d = sub(c.end, c.start);
  const n = norm(d);
  if (n === 0) return null;
  return [d[0] / n, d[1] / n, d[2] / n];
}

export function cylinderLength(c: QSMCylinder): number {
  return norm(sub(c.end, c.start));
}

// --- shoot polylines ---------------------------------------------------------

/**
 * One shoot reduced to a continuous polyline: M = (cylinders + 1) nodes, each with
 * a radius. `rank` is constant per shoot; radius is carried per node.
 */
export interface ShootPolyline {
  shootId: number;
  rank: number;
  nodes: Vec3[];
  radii: number[]; // length === nodes.length
}

function midpoint(a: readonly number[], b: readonly number[]): Vec3 {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
}

/**
 * Reduce each shoot's ordered cylinder chain to a single node polyline. Consecutive
 * cylinders are MEANT to share a node, but after the backend's per-cylinder axis fit
 * the shared point can drift apart by ~1cm; we reconcile by averaging the two sides
 * into one node so the tube meets exactly. A K-cylinder shoot -> K+1 nodes. Each
 * interior node's radius is the mean of its two adjoining cylinders (single shared
 * ring => continuous radius); endpoints take their one adjoining cylinder's radius.
 */
export function buildShootPolylines(
  cylinders: QSMCylinder[],
  shoots: QSMShoot[]
): ShootPolyline[] {
  const byId = new Map<number, QSMCylinder>();
  for (const c of cylinders) byId.set(c.cyl_id, c);

  const out: ShootPolyline[] = [];
  for (const s of shoots) {
    // Resolve the ordered (base->tip) cylinders; defensively skip missing ids.
    const cyls = s.cylinder_ids
      .map((id) => byId.get(id))
      .filter((c): c is QSMCylinder => c != null);
    if (cyls.length === 0) continue;

    const nodes: Vec3[] = [];
    const radii: number[] = [];

    nodes.push([cyls[0].start[0], cyls[0].start[1], cyls[0].start[2]]);
    radii.push(Math.max(cyls[0].radius, MIN_RADIUS));

    for (let i = 1; i < cyls.length; i++) {
      // Interior shared node: average the (possibly drifted) joint position + radius.
      nodes.push(midpoint(cyls[i - 1].end, cyls[i].start));
      radii.push(Math.max(0.5 * (cyls[i - 1].radius + cyls[i].radius), MIN_RADIUS));
    }

    const last = cyls[cyls.length - 1];
    nodes.push([last.end[0], last.end[1], last.end[2]]);
    radii.push(Math.max(last.radius, MIN_RADIUS));

    out.push({ shootId: s.shoot_id, rank: s.rank, nodes, radii });
  }
  return out;
}

// --- parallel-transport frame ------------------------------------------------

/** Per-node axial (tangent) and radial directions for a polyline. */
export interface TubeFrame {
  axial: Vec3[];
  radial: Vec3[];
}

// Pick an initial radial direction not parallel to the axis.
function pickInitial(ax: Vec3): Vec3 {
  let init: Vec3 = [1, 0, 0];
  if (Math.abs(dot(ax, init)) > 0.95) init = [0, 1, 0];
  if (Math.abs(ax[2]) > 0.95) init = [1, 0, 0];
  return normalize(cross(ax, init));
}

/**
 * Rotation-minimizing frame along `nodes`. Axial direction uses a central
 * difference at interior nodes (so the tube bends smoothly through a joint rather
 * than kinking), falling back to the previous valid axial on a degenerate segment.
 * The radial direction is parallel-transported node to node and re-orthogonalized,
 * which is what keeps consecutive rings from twisting relative to each other — the
 * property the old per-cylinder exporter lacked.
 */
export function buildTubeFrame(nodes: Vec3[]): TubeFrame {
  const m = nodes.length;
  const axial: Vec3[] = new Array(m);
  let prevValid: Vec3 = [0, 0, 1];
  for (let i = 0; i < m; i++) {
    let a: Vec3;
    if (i === 0) {
      a = sub(nodes[1], nodes[0]);
    } else if (i === m - 1) {
      a = sub(nodes[m - 1], nodes[m - 2]);
    } else {
      const f = sub(nodes[i], nodes[i - 1]);
      const g = sub(nodes[i + 1], nodes[i]);
      a = [(f[0] + g[0]) * 0.5, (f[1] + g[1]) * 0.5, (f[2] + g[2]) * 0.5];
    }
    if (norm(a) < 1e-8) {
      a = [prevValid[0], prevValid[1], prevValid[2]];
    } else {
      a = normalize(a);
      prevValid = a;
    }
    axial[i] = a;
  }

  const radial: Vec3[] = new Array(m);
  radial[0] = pickInitial(axial[0]);
  for (let i = 1; i < m; i++) {
    let r = radial[i - 1];
    const rotAxis = cross(axial[i - 1], axial[i]);
    if (norm(rotAxis) > 1e-5) {
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(axial[i - 1], axial[i]))));
      r = rotateAboutAxis(r, normalize(rotAxis), angle);
    }
    // Re-orthogonalize against the new axial to kill drift / the parallel case.
    const d = dot(r, axial[i]);
    r = [r[0] - d * axial[i][0], r[1] - d * axial[i][1], r[2] - d * axial[i][2]];
    if (norm(r) < 1e-6) r = pickInitial(axial[i]); // collapsed (180deg kink)
    radial[i] = normalize(r);
  }

  return { axial, radial };
}

// --- swept tube surface ------------------------------------------------------

/**
 * A swept tube: M rings of (N+1) vertices each. The extra per-ring vertex is a
 * DUPLICATED SEAM vertex — it coincides with vertex 0 of its ring, and exists so
 * the quad indexing wraps without modulo. Both the viewport and the exporters use
 * the same layout, so a face index computed here means the same thing in both.
 */
export interface SweptTube {
  /** (M * (N+1)) vertex positions. */
  positions: Vec3[];
  /** Outward unit normals, parallel to `positions`. */
  normals: Vec3[];
  /**
   * Texture coordinates, parallel to `positions`. `u` runs AROUND the tube and
   * `v` runs ALONG it (note Helios uses the opposite convention internally).
   * Both are in tile units and deliberately EXCEED [0,1] — the material must use
   * RepeatWrapping. See `wrapsForRadius` for why this doesn't stretch.
   */
  uvs: [number, number][];
  /** Triangles as 0-based indices into `positions`. */
  faces: [number, number, number][];
  /** Ring count (M) and per-ring vertex count (N+1), for callers that index rings. */
  ringCount: number;
  ringStride: number;
}

/**
 * Sweep one continuous tube along `nodes` with per-node `radii`. `segments` is the
 * radial subdivision count (>= 3).
 *
 * `offset` is subtracted from every emitted position. The viewport uses it as a
 * render-only display offset so large UTM coordinates land near the origin in
 * float64 BEFORE the Float32 cast (the real fix for QSM tube z-fighting). Exporters
 * leave it at the origin so files carry true world coordinates. The frame itself is
 * offset-invariant — only positions shift.
 *
 * No end caps: shoots overlap their parent at forks, so caps would be buried inside
 * the joint, adding phantom interior surface (and inflating exported surface area).
 * Returns null if the polyline is too short to sweep.
 *
 * `tileSize` is the world-space edge length (metres) of one texture tile, used only
 * to derive `uvs`. Geometry is unaffected by it.
 */
export function sweepTube(
  nodes: Vec3[],
  radii: number[],
  segments: number,
  offset: Vec3 = [0, 0, 0],
  tileSize: number = DEFAULT_TEXTURE_TILE_SIZE
): SweptTube | null {
  const m = nodes.length;
  if (m < 2) return null;
  const n = Math.max(3, segments);
  const tile = tileSize > 0 ? tileSize : DEFAULT_TEXTURE_TILE_SIZE;

  const { axial, radial } = buildTubeFrame(nodes);

  // Cumulative arc length along the centerline, in tile units. This is what makes
  // the texture advance at a constant PHYSICAL rate down the shoot rather than
  // being squeezed into a fixed 0..1 span (which would stretch long shoots and
  // compress short ones).
  const vAlong: number[] = new Array(m);
  let arc = 0;
  vAlong[0] = 0;
  for (let i = 1; i < m; i++) {
    arc += norm(sub(nodes[i], nodes[i - 1]));
    vAlong[i] = arc / tile;
  }

  const positions: Vec3[] = [];
  const normals: Vec3[] = [];
  const uvs: [number, number][] = [];
  for (let i = 0; i < m; i++) {
    const orthogonal = normalize(cross(radial[i], axial[i]));
    const r = radii[i];
    // Wrap count is per-ring, so a tapering shoot keeps a consistent tile scale as
    // it thins. Rounded => the seam vertex lands on an integer u and closes cleanly.
    const wraps = wrapsForRadius(r, tile);
    for (let j = 0; j <= n; j++) {
      const theta = (2 * Math.PI * j) / n;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const nx = c * radial[i][0] + s * orthogonal[0];
      const ny = c * radial[i][1] + s * orthogonal[1];
      const nz = c * radial[i][2] + s * orthogonal[2];
      positions.push([
        nodes[i][0] + r * nx - offset[0],
        nodes[i][1] + r * ny - offset[1],
        nodes[i][2] + r * nz - offset[2],
      ]);
      normals.push([nx, ny, nz]);
      uvs.push([(j / n) * wraps, vAlong[i]]);
    }
  }

  const faces: [number, number, number][] = [];
  for (let i = 0; i < m - 1; i++) {
    const ringA = i * (n + 1);
    const ringB = (i + 1) * (n + 1);
    for (let j = 0; j < n; j++) {
      const a = ringA + j;
      const b = ringA + j + 1;
      const cc = ringB + j;
      const d = ringB + j + 1;
      faces.push([a, cc, b]);
      faces.push([b, cc, d]);
    }
  }

  return { positions, normals, uvs, faces, ringCount: m, ringStride: n + 1 };
}
