import { useMemo, useEffect } from 'react';
import * as THREE from 'three';
import type { QSMCylinder, QSMShoot } from '../../../utils/backendApi';
import {
  buildShootPolylines as buildShootPolylinesPlain,
  sweepTube,
} from '../../../lib/qsmTube';
import type { ShootPolyline as PlainShootPolyline } from '../../../lib/qsmTube';

// QSM (Quantitative Structure Model) visualization. Each SHOOT is drawn as ONE
// CONTINUOUS TUBE: a single shared ring of vertices per node, swept along the
// shoot's centerline with a rotation-minimizing (parallel-transport) frame so the
// surface is seamless and radius is continuous across joints -- the same approach
// Helios' plant-architecture plugin uses (one tube per branch, branches overlap at
// forks; no miter geometry). This replaces the older per-cylinder capped-frustum
// rendering, which showed seams + radius steps at every joint.
//
// The geometry itself lives in `lib/qsmTube` (three.js-free) so the OBJ/PLY
// exporters produce the SAME surface the user sees here. This module keeps the
// three.js-flavored wrappers (THREE.Vector3 nodes, merged BufferGeometry, color) --
// don't reimplement sweeping/framing here, or the viewport and the exports drift
// apart again.
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
  opacity?: number;
  /** number of sides of each cross-section ring (more = rounder, costlier). */
  radialSegments?: number;
  /**
   * Render-only display offset (Layer 2 precision safety net). Subtracted from
   * tube vertices at build time (float64) so large UTM coordinates render near
   * the origin without z-fighting. Defaults to origin.
   */
  displayOffset?: { x: number; y: number; z: number };
}

// Rank palette: trunk (0) dark/woody -> outward orders brighten. Index by rank,
// clamped. Lightened from the original palette so no rank reads as a near-black
// blob against the dark viewer background (the old trunk brown + blue were too
// dark). Trunk is still the most muted so the structure reads "solid trunk,
// brighter branches".
// Each adjacent rank pair must be clearly DISTINGUISHABLE. The previous brown
// trunk + amber scaffold were nearly the same hue (20deg vs 22deg, RGB dist 0.23),
// so a rank-0 trunk and its rank-1 scaffold read as the same colour. This palette
// keeps the trunk a neutral wood-tan but makes rank 1 a clearly different
// red-orange, and cycles well-separated hues after (every adjacent pair RGB dist
// >= 0.42), while keeping every colour bright enough for the dark background.
export const RANK_COLORS = [
  new THREE.Color('#b08d57'), // rank 0 trunk - neutral wood tan
  new THREE.Color('#e8552d'), // rank 1 scaffold - red-orange (distinct from trunk)
  new THREE.Color('#3e9bff'), // rank 2 - blue
  new THREE.Color('#2fcf6b'), // rank 3 - green
  new THREE.Color('#b76bff'), // rank 4 - violet
  new THREE.Color('#ff5fa8'), // rank 5+ - pink
];

export function rankColor(rank: number): THREE.Color {
  const idx = Math.min(Math.max(rank, 0), RANK_COLORS.length - 1);
  return RANK_COLORS[idx];
}

// Deterministic distinct color per shoot id via the golden-ratio hue rotation
// (so adjacent shoot ids look clearly different, and the same id always maps to
// the same color across renders). At equal HSL lightness, reds (~0deg) and blues
// (~0.66) look much darker than yellows/greens, so a plain red sampled here used
// to read as a near-black maroon against the dark viewer background; we add
// lightness back for those hues so no shoot color comes out dark/muddy.
export function shootColor(shootId: number): THREE.Color {
  const hue = (shootId * 0.61803398875) % 1.0;
  // Keep colors vivid (not pastel) but never DARK: a modest per-hue lightness lift
  // for the hues that read darkest at equal HSL lightness -- red (~0deg) and blue
  // (~0.66) -- so a sampled red comes out a clear red, not the near-black maroon
  // the old fixed 0.55 lightness produced against the dark viewer background. The
  // material's emissive glow provides the overall "lift off the background", so we
  // don't push lightness so high that colors wash out.
  const redLift = Math.cos(hue * 2 * Math.PI) * 0.5 + 0.5; // 1 at red, 0 at cyan
  const blueLift = Math.cos((hue - 0.66) * 2 * Math.PI) * 0.5 + 0.5; // 1 at blue
  const lightness = 0.54 + 0.06 * Math.max(redLift, blueLift); // 0.54..0.60
  return new THREE.Color().setHSL(hue, 0.7, lightness);
}

// One shoot reduced to a continuous polyline: M = (cylinders + 1) nodes, each with
// a radius. The headline color (rank/shoot) is constant per shoot, but radius (and
// later, per-node fields like surf_cov) is carried per node.
export interface ShootPolyline {
  shootId: number;
  rank: number;
  nodes: THREE.Vector3[];
  radii: number[]; // length === nodes.length
}

// Shared polyline reduction (see lib/qsmTube), lifted into THREE.Vector3 nodes for
// the renderer's convenience. The reconciliation rules -- averaging a drifted joint
// into one shared node, meaning each interior radius -- live in the shared module so
// the exports get exactly the same centerline.
export function buildShootPolylines(
  cylinders: QSMCylinder[],
  shoots: QSMShoot[]
): ShootPolyline[] {
  return buildShootPolylinesPlain(cylinders, shoots).map((p: PlainShootPolyline) => ({
    shootId: p.shootId,
    rank: p.rank,
    nodes: p.nodes.map((n) => new THREE.Vector3(n[0], n[1], n[2])),
    radii: p.radii,
  }));
}

// The per-node color for one shoot. Color is constant along the shoot (rank or
// shoot-id hue). Returned as a length-M array so future per-node coloring is a
// drop-in.
function shootNodeColors(
  poly: ShootPolyline,
  colorMode: QSMColorMode,
  m: number
): THREE.Color[] {
  const col =
    colorMode === 'shoot' ? shootColor(poly.shootId) : rankColor(poly.rank);
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
  n: number,
  // Render-only display offset (Layer 2). QSM nodes come from float64 JSON, and
  // arrays.positions is a float64 number[] until a single Float32 cast — so
  // subtracting the offset HERE, before the cast, lands vertices small in float64
  // and genuinely RECOVERS precision (this is the real fix for QSM tube
  // z-fighting at UTM magnitudes, unlike flat clouds whose buffers are already
  // float32). Defaults to origin (small-coord scenes unaffected). The frame
  // (axial/radial directions) is offset-invariant — only the emitted vertex
  // positions shift.
  offset: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }
): void {
  const swept = sweepTube(
    nodes.map((v) => [v.x, v.y, v.z] as [number, number, number]),
    radii,
    n,
    [offset.x, offset.y, offset.z]
  );
  if (!swept) return;

  const base = arrays.indexOffset.value;
  for (let i = 0; i < swept.positions.length; i++) {
    const p = swept.positions[i];
    const nrm = swept.normals[i];
    arrays.positions.push(p[0], p[1], p[2]);
    arrays.normals.push(nrm[0], nrm[1], nrm[2]);
    // Color is per-NODE, and each node owns one ring of `ringStride` vertices.
    const col = colorPerNode[Math.floor(i / swept.ringStride)];
    arrays.colors.push(col.r, col.g, col.b);
  }
  // sweepTube's face indices are local to this tube; rebase into the merged buffer.
  for (const f of swept.faces) {
    arrays.indices.push(base + f[0], base + f[1], base + f[2]);
  }
  arrays.indexOffset.value += swept.positions.length;
}

export function QSM3D({
  cylinders,
  shoots,
  colorMode = 'rank',
  opacity = 1.0,
  radialSegments = 8,
  displayOffset,
}: QSM3DProps) {
  const offX = displayOffset?.x ?? 0;
  const offY = displayOffset?.y ?? 0;
  const offZ = displayOffset?.z ?? 0;
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
      const colorPerNode = shootNodeColors(poly, colorMode, m);
      appendTube(arrays, poly.nodes, poly.radii, colorPerNode, n, { x: offX, y: offY, z: offZ });
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
  }, [cylinders, shoots, colorMode, radialSegments, offX, offY, offZ]);

  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: opacity < 1,
      opacity,
      roughness: 0.6,
      metalness: 0.05,
    });
    // Self-illuminate the tubes a bit so they don't render dark when the scene
    // lights are dimmed (the QSM has no dedicated light). three's flat `emissive`
    // is a single color and would wash out the per-shoot/rank hues, so instead we
    // inject a fraction of the per-vertex color into the emissive term via a tiny
    // shader patch -- each tube keeps its own color but gets a baseline glow that
    // lifts it off the dark background regardless of scene lighting.
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vColor.rgb * 0.25;'
      );
    };
    return mat;
  }, [opacity]);

  useEffect(() => () => geometry?.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  if (!geometry) return null;
  return <mesh geometry={geometry} material={material} />;
}
