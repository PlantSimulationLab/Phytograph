import { useMemo, useEffect } from 'react';
import * as THREE from 'three';
import type { QSMCylinder, QSMShoot } from '../../../utils/backendApi';
import {
  buildShootPolylines as buildShootPolylinesPlain,
  sweepTube,
  DEFAULT_TEXTURE_TILE_SIZE,
} from '../../../lib/qsmTube';
import type { ShootPolyline as PlainShootPolyline } from '../../../lib/qsmTube';
import { useImageTexture } from './useImageTexture';
import { RANK_COLOR_HEXES, rankColorLinear, shootColorRgb } from '../../../lib/qsmColors';
import type { QSMColorMode } from '../../../lib/qsmColors';

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
// Four color modes:
//   - 'rank'    : color by shoot rank (trunk=0, scaffolds=1, ...) -- the structure.
//   - 'shoot'   : a distinct color per shoot id, so each continuous shoot reads as
//                 ONE object -- directly demonstrates the continuous-shoot output.
//   - 'color'   : one flat user-picked RGB for the whole tree.
//   - 'texture' : a tiled bark image (Helios library or user upload). See qsmTube's
//                 `wrapsForRadius` for the UV scheme that keeps bark from stretching.
// A selected shoot is highlighted (brightened) and the others dimmed so clicking a
// shoot shows the whole continuous axis.

// Re-exported from the shared (three-free) appearance module so the OBJ exporter
// can share one definition of the modes and the palette — see lib/qsmColors.
export type { QSMColorMode };

// 'rank' and 'shoot' encode DATA as hue, so they get the emissive lift that keeps
// categorical colors legible against the dark viewport. 'color' and 'texture' are
// APPEARANCE modes -- the lift would wash a bark photo out into milky pastel -- so
// they render under normal lighting instead.
function isCategoricalMode(mode: QSMColorMode): boolean {
  return mode === 'rank' || mode === 'shoot';
}

// Fallback when texture mode is selected but no image has loaded yet (or it failed):
// a neutral bark brown, so the tree never flashes white or black mid-load.
const BARK_FALLBACK = '#8b6f47';

export interface QSM3DProps {
  cylinders: QSMCylinder[];
  /** Shoots (ordered cylinder chains) -- used to build one continuous tube each. */
  shoots: QSMShoot[];
  colorMode?: QSMColorMode;
  opacity?: number;
  /**
   * number of sides of each cross-section ring (more = rounder, costlier).
   * Defaults to 8 for the categorical modes; texture mode overrides to
   * TEXTURE_RADIAL_SEGMENTS, where facets are far more obvious.
   */
  radialSegments?: number;
  /** Flat tree color for colorMode='color' (hex, e.g. '#8b6f47'). */
  solidColor?: string;
  /** Base64 bark image + its MIME type, for colorMode='texture'. */
  barkTexture?: { data: string; mime: string } | null;
  /** World-space edge length (m) of one bark tile. Defaults to 0.25 m (Helios' value). */
  textureTileSize?: number;
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
export const RANK_COLORS = RANK_COLOR_HEXES.map((h) => new THREE.Color(h));

// Thin THREE wrappers over the shared palette/hue math in lib/qsmColors. The math
// lives there (three-free) so the OBJ exporter writes the SAME colors the viewport
// shows; keeping a second copy here is how the two drifted before.
// Note the asymmetry, which is three.js's not ours: the hex parser converts sRGB
// -> linear, while setHSL stores its output verbatim. So the rank palette (defined
// as hex) must be linearized to match what `new THREE.Color(hex)` produced before
// this refactor, and the shoot hues (defined in HSL) are passed through untouched.
export function rankColor(rank: number): THREE.Color {
  const [r, g, b] = rankColorLinear(rank);
  return new THREE.Color(r, g, b);
}

export function shootColor(shootId: number): THREE.Color {
  const [r, g, b] = shootColorRgb(shootId);
  return new THREE.Color(r, g, b);
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
//
// Exhaustive switch, not a ternary: the `never` check makes the compiler reject a
// newly-added QSMColorMode that forgets a case here, rather than silently falling
// through to rank coloring.
export function shootNodeColor(
  poly: ShootPolyline,
  colorMode: QSMColorMode,
  solidColor: string
): THREE.Color {
  switch (colorMode) {
    case 'rank':
      return rankColor(poly.rank);
    case 'shoot':
      return shootColor(poly.shootId);
    case 'color':
      return new THREE.Color(solidColor);
    case 'texture':
      // White so the diffuse map shows its true colors -- the vertex color
      // multiplies the map, and anything but white would tint the bark.
      return new THREE.Color(1, 1, 1);
    default: {
      const _exhaustive: never = colorMode;
      void _exhaustive;
      return rankColor(poly.rank);
    }
  }
}

function shootNodeColors(
  poly: ShootPolyline,
  colorMode: QSMColorMode,
  m: number,
  solidColor: string
): THREE.Color[] {
  const col = shootNodeColor(poly, colorMode, solidColor);
  return Array.from({ length: m }, () => col);
}

// Accumulator for the single merged BufferGeometry across all shoots. indexOffset
// is boxed so appendTube can advance it across calls.
export interface MeshArrays {
  positions: number[];
  normals: number[];
  colors: number[];
  /** Texture coordinates (2 per vertex), parallel to `positions`. */
  uvs: number[];
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
  offset: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
  // World-space edge length (m) of one texture tile. Only affects `arrays.uvs`.
  tileSize: number = DEFAULT_TEXTURE_TILE_SIZE
): void {
  const swept = sweepTube(
    nodes.map((v) => [v.x, v.y, v.z] as [number, number, number]),
    radii,
    n,
    [offset.x, offset.y, offset.z],
    tileSize
  );
  if (!swept) return;

  const base = arrays.indexOffset.value;
  for (let i = 0; i < swept.positions.length; i++) {
    const p = swept.positions[i];
    const nrm = swept.normals[i];
    arrays.positions.push(p[0], p[1], p[2]);
    arrays.normals.push(nrm[0], nrm[1], nrm[2]);
    const uv = swept.uvs[i];
    arrays.uvs.push(uv[0], uv[1]);
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

// Cross-section sides in texture mode. The categorical modes get away with 8 (flat
// color hides facets), but a tiled bark image makes an octagonal trunk obvious.
const TEXTURE_RADIAL_SEGMENTS = 16;

export function QSM3D({
  cylinders,
  shoots,
  colorMode = 'rank',
  opacity = 1.0,
  radialSegments,
  displayOffset,
  solidColor = BARK_FALLBACK,
  barkTexture,
  textureTileSize = DEFAULT_TEXTURE_TILE_SIZE,
}: QSM3DProps) {
  const offX = displayOffset?.x ?? 0;
  const offY = displayOffset?.y ?? 0;
  const offZ = displayOffset?.z ?? 0;
  const textured = colorMode === 'texture';
  // Explicit prop wins; otherwise texture mode buys extra roundness.
  const segments = radialSegments ?? (textured ? TEXTURE_RADIAL_SEGMENTS : 8);

  const texture = useImageTexture(
    textured ? barkTexture?.data : undefined,
    barkTexture?.mime ?? 'image/jpeg'
  );

  const geometry = useMemo(() => {
    if (!cylinders || cylinders.length === 0) return null;
    if (!shoots || shoots.length === 0) return null;

    const n = Math.max(3, segments); // a tube needs >= 3 sides
    const arrays: MeshArrays = {
      positions: [],
      normals: [],
      colors: [],
      uvs: [],
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
      const colorPerNode = shootNodeColors(poly, colorMode, m, solidColor);
      appendTube(
        arrays, poly.nodes, poly.radii, colorPerNode, n,
        { x: offX, y: offY, z: offZ }, textureTileSize
      );
    }

    if (arrays.positions.length === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(arrays.normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(arrays.colors, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(arrays.uvs, 2));
    geo.setIndex(arrays.indices);
    return geo;
    // opacity is intentionally NOT a dep: it affects only the material (its own
    // useMemo), so including it would force a needless geometry rebuild.
  }, [cylinders, shoots, colorMode, segments, offX, offY, offZ, solidColor, textureTileSize]);

  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: opacity < 1,
      opacity,
      // Bark is matte; the categorical modes keep their slightly glossier look.
      roughness: textured ? 0.9 : 0.6,
      metalness: textured ? 0.0 : 0.05,
    });

    if (textured && texture) {
      mat.map = texture;
    }

    // Self-illuminate the tubes a bit so they don't render dark when the scene
    // lights are dimmed (the QSM has no dedicated light). three's flat `emissive`
    // is a single color and would wash out the per-shoot/rank hues, so instead we
    // inject a fraction of the per-vertex color into the emissive term via a tiny
    // shader patch -- each tube keeps its own color but gets a baseline glow that
    // lifts it off the dark background regardless of scene lighting.
    //
    // ONLY for the categorical modes. In 'texture' mode vColor is white, so this
    // would add a flat 25% white glow that washes the bark out to milky pastel; in
    // 'color' mode it visibly lightens the exact RGB the user picked. Both are
    // appearance modes where fidelity beats legibility, so they light normally.
    if (isCategoricalMode(colorMode)) {
      mat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vColor.rgb * 0.25;'
        );
      };
    }
    return mat;
  }, [opacity, colorMode, textured, texture]);

  useEffect(() => () => geometry?.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  if (!geometry) return null;
  return <mesh geometry={geometry} material={material} />;
}
