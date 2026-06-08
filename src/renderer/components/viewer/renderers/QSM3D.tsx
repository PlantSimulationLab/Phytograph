import { useMemo, useEffect } from 'react';
import * as THREE from 'three';
import type { QSMCylinder, QSMShoot } from '../../../utils/backendApi';

// QSM (Quantitative Structure Model) visualization. Each SHOOT is drawn as ONE
// CONTINUOUS TUBE: a single shared ring of vertices per node, swept along the
// shoot's centerline with a rotation-minimizing (parallel-transport) frame so the
// surface is seamless and radius is continuous across joints -- the same approach
// Helios' plant-architecture plugin uses (one tube per branch, branches overlap at
// forks; no miter geometry). This replaces the older per-cylinder capped-frustum
// rendering, which showed seams + radius steps at every joint.
//
// Two color modes make the headline feature legible:
//   - 'rank'  : color by shoot rank (trunk=0, scaffolds=1, ...) -- the structure.
//   - 'shoot' : a distinct color per shoot id, so each continuous shoot reads as
//               ONE object -- directly demonstrates the continuous-shoot output.
// A selected shoot is highlighted (brightened) and the others dimmed so clicking a
// shoot shows the whole continuous axis.

export type QSMColorMode = 'rank' | 'shoot';

export interface QSM3DProps {
  cylinders: QSMCylinder[];
  /** Shoots (ordered cylinder chains) -- used to build one continuous tube each. */
  shoots: QSMShoot[];
  colorMode?: QSMColorMode;
  /** shoot_id to highlight (the whole continuous axis), or null. */
  selectedShootId?: number | null;
  opacity?: number;
  /** number of sides of each cross-section ring (more = rounder, costlier). */
  radialSegments?: number;
}

// Rank palette: trunk (0) dark/woody -> outward orders brighten. Index by rank,
// clamped. Chosen to read as "thick dark trunk, lighter branches".
export const RANK_COLORS = [
  new THREE.Color('#5b3a1e'), // rank 0 trunk - dark brown
  new THREE.Color('#c2761a'), // rank 1 scaffold - amber
  new THREE.Color('#3b82f6'), // rank 2 - blue
  new THREE.Color('#22c55e'), // rank 3 - green
  new THREE.Color('#a855f7'), // rank 4 - violet
  new THREE.Color('#ec4899'), // rank 5+ - pink
];

export function rankColor(rank: number): THREE.Color {
  const idx = Math.min(Math.max(rank, 0), RANK_COLORS.length - 1);
  return RANK_COLORS[idx];
}

// Reused (not re-allocated per cylinder) for the selected-shoot highlight/dim
// lerp in the geometry hot loop.
const HIGHLIGHT_COLOR = new THREE.Color('#ffffff');
const DIM_COLOR = new THREE.Color('#000000');

// Deterministic distinct color per shoot id via the golden-ratio hue rotation
// (so adjacent shoot ids look clearly different, and the same id always maps to
// the same color across renders).
export function shootColor(shootId: number): THREE.Color {
  const hue = (shootId * 0.61803398875) % 1.0;
  return new THREE.Color().setHSL(hue, 0.62, 0.55);
}

const MIN_RADIUS = 1e-5;

// One shoot reduced to a continuous polyline: M = (cylinders + 1) nodes, each with
// a radius. The headline color (rank/shoot) is constant per shoot, but radius (and
// later, per-node fields like surf_cov) is carried per node.
export interface ShootPolyline {
  shootId: number;
  rank: number;
  nodes: THREE.Vector3[];
  radii: number[]; // length === nodes.length
}

function midpoint(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): THREE.Vector3 {
  return new THREE.Vector3(
    (a[0] + b[0]) * 0.5,
    (a[1] + b[1]) * 0.5,
    (a[2] + b[2]) * 0.5
  );
}

// Reduce each shoot's ordered cylinder chain to a single node polyline. Consecutive
// cylinders are MEANT to share a node, but after the backend's per-cylinder axis fit
// the shared point can drift apart by ~1cm; we reconcile by averaging the two sides
// into one node so the tube meets exactly. A K-cylinder shoot -> K+1 nodes. Each
// interior node's radius is the mean of its two adjoining cylinders (single shared
// ring => continuous radius); endpoints take their one adjoining cylinder's radius.
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

    const nodes: THREE.Vector3[] = [];
    const radii: number[] = [];

    nodes.push(new THREE.Vector3(cyls[0].start[0], cyls[0].start[1], cyls[0].start[2]));
    radii.push(Math.max(cyls[0].radius, MIN_RADIUS));

    for (let i = 1; i < cyls.length; i++) {
      // Interior shared node: average the (possibly drifted) joint position + radius.
      nodes.push(midpoint(cyls[i - 1].end, cyls[i].start));
      radii.push(Math.max(0.5 * (cyls[i - 1].radius + cyls[i].radius), MIN_RADIUS));
    }

    const last = cyls[cyls.length - 1];
    nodes.push(new THREE.Vector3(last.end[0], last.end[1], last.end[2]));
    radii.push(Math.max(last.radius, MIN_RADIUS));

    out.push({ shootId: s.shoot_id, rank: s.rank, nodes, radii });
  }
  return out;
}

// The per-node color for one shoot. Color is constant along the shoot (rank or
// shoot-id hue), with the exact selection highlight/dim the per-cylinder renderer
// used. Returned as a length-M array so future per-node coloring is a drop-in.
function shootNodeColors(
  poly: ShootPolyline,
  colorMode: QSMColorMode,
  selectedShootId: number | null,
  m: number
): THREE.Color[] {
  const base =
    colorMode === 'shoot' ? shootColor(poly.shootId) : rankColor(poly.rank);
  const col = base.clone();
  if (selectedShootId != null) {
    if (poly.shootId === selectedShootId) col.lerp(HIGHLIGHT_COLOR, 0.35);
    else col.lerp(DIM_COLOR, 0.55);
  }
  return Array.from({ length: m }, () => col);
}

// Accumulator for the single merged BufferGeometry across all shoots. indexOffset
// is boxed so appendTube can advance it across calls.
export interface MeshArrays {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
  indexOffset: { value: number };
}

// Sweep a continuous tube along `nodes` (radius/color per node) into the shared
// arrays, using a rotation-minimizing frame (parallel transport) so rings don't
// twist and the surface stays seamless. One shared ring per node => continuous
// radius. N = radial subdivisions; each ring has N+1 vertices (duplicated seam
// vertex) so the quad indexing wraps cleanly.
export function appendTube(
  arrays: MeshArrays,
  nodes: THREE.Vector3[],
  radii: number[],
  colorPerNode: THREE.Color[],
  n: number
): void {
  const m = nodes.length;
  if (m < 2) return;

  // 1) Per-node axial direction (central difference at interior nodes), with a
  //    fallback to the previous valid axial when a segment is degenerate.
  const axial: THREE.Vector3[] = new Array(m);
  let prevValid = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < m; i++) {
    const a = new THREE.Vector3();
    if (i === 0) {
      a.subVectors(nodes[1], nodes[0]);
    } else if (i === m - 1) {
      a.subVectors(nodes[m - 1], nodes[m - 2]);
    } else {
      const f = new THREE.Vector3().subVectors(nodes[i], nodes[i - 1]);
      const g = new THREE.Vector3().subVectors(nodes[i + 1], nodes[i]);
      a.addVectors(f, g).multiplyScalar(0.5);
    }
    if (a.length() < 1e-8) a.copy(prevValid);
    else {
      a.normalize();
      prevValid = a;
    }
    axial[i] = a;
  }

  // Pick an initial radial direction at node 0 not parallel to the axis.
  const pickInitial = (ax: THREE.Vector3): THREE.Vector3 => {
    let init = new THREE.Vector3(1, 0, 0);
    if (Math.abs(ax.dot(init)) > 0.95) init = new THREE.Vector3(0, 1, 0);
    if (Math.abs(ax.z) > 0.95) init = new THREE.Vector3(1, 0, 0);
    return new THREE.Vector3().crossVectors(ax, init).normalize();
  };

  // 2) Parallel-transport the radial frame node to node.
  const radial: THREE.Vector3[] = new Array(m);
  radial[0] = pickInitial(axial[0]);
  for (let i = 1; i < m; i++) {
    const r = radial[i - 1].clone();
    const rotAxis = new THREE.Vector3().crossVectors(axial[i - 1], axial[i]);
    if (rotAxis.length() > 1e-5) {
      const angle = Math.acos(Math.max(-1, Math.min(1, axial[i - 1].dot(axial[i]))));
      r.applyAxisAngle(rotAxis.normalize(), angle);
    }
    // Re-orthogonalize against the new axial to kill drift / the parallel case.
    r.addScaledVector(axial[i], -r.dot(axial[i]));
    if (r.length() < 1e-6) r.copy(pickInitial(axial[i])); // collapsed (180deg kink)
    radial[i] = r.normalize();
  }

  // 3) Emit rings (N+1 verts each) + 4) connect consecutive rings.
  const base = arrays.indexOffset.value;
  const orthogonal = new THREE.Vector3();
  for (let i = 0; i < m; i++) {
    orthogonal.crossVectors(radial[i], axial[i]).normalize();
    const col = colorPerNode[i];
    const r = radii[i];
    for (let j = 0; j <= n; j++) {
      const theta = (2 * Math.PI * j) / n;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const nx = c * radial[i].x + s * orthogonal.x;
      const ny = c * radial[i].y + s * orthogonal.y;
      const nz = c * radial[i].z + s * orthogonal.z;
      arrays.positions.push(
        nodes[i].x + r * nx,
        nodes[i].y + r * ny,
        nodes[i].z + r * nz
      );
      arrays.normals.push(nx, ny, nz);
      arrays.colors.push(col.r, col.g, col.b);
    }
  }
  for (let i = 0; i < m - 1; i++) {
    const ringA = base + i * (n + 1);
    const ringB = base + (i + 1) * (n + 1);
    for (let j = 0; j < n; j++) {
      const a = ringA + j;
      const b = ringA + j + 1;
      const cc = ringB + j;
      const d = ringB + j + 1;
      arrays.indices.push(a, cc, b);
      arrays.indices.push(b, cc, d);
    }
  }
  arrays.indexOffset.value += m * (n + 1);
}

export function QSM3D({
  cylinders,
  shoots,
  colorMode = 'rank',
  selectedShootId = null,
  opacity = 1.0,
  radialSegments = 8,
}: QSM3DProps) {
  const geometry = useMemo(() => {
    if (!cylinders || cylinders.length === 0) return null;
    if (!shoots || shoots.length === 0) return null;

    const n = Math.max(3, radialSegments); // a tube needs >= 3 sides
    const arrays: MeshArrays = {
      positions: [],
      normals: [],
      colors: [],
      indices: [],
      indexOffset: { value: 0 },
    };

    // Every cylinder belongs to exactly one shoot's cylinder_ids (pipeline
    // invariant), so iterating shoots renders each cylinder once. Cylinders absent
    // from any shoot are intentionally not drawn.
    const polylines = buildShootPolylines(cylinders, shoots);
    for (const poly of polylines) {
      const m = poly.nodes.length;
      if (m < 2) continue; // a 1-cylinder shoot still yields M=2
      const colorPerNode = shootNodeColors(poly, colorMode, selectedShootId, m);
      appendTube(arrays, poly.nodes, poly.radii, colorPerNode, n);
    }

    if (arrays.positions.length === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(arrays.normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(arrays.colors, 3));
    geo.setIndex(arrays.indices);
    return geo;
    // opacity is intentionally NOT a dep: it affects only the material (its own
    // useMemo), so including it would force a needless geometry rebuild.
  }, [cylinders, shoots, colorMode, selectedShootId, radialSegments]);

  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        transparent: opacity < 1,
        opacity,
        roughness: 0.7,
        metalness: 0.1,
      }),
    [opacity]
  );

  useEffect(() => () => geometry?.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  if (!geometry) return null;
  return <mesh geometry={geometry} material={material} />;
}
