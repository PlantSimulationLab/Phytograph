// Coverage-preserving point size for octree clouds: where the level of detail
// was cut short, points grow by exactly enough to cover the screen area the
// undrawn points would have, so an LOD boundary no longer reads as a hard
// rectangle of sparse dots next to dense ones.
//
// Why: potree's `updateVisibility` refines nodes in screen-size order and stops
// dead at the point budget, so on a big scene the cut lands mid-tree and one
// side of every node boundary is drawn a full octree level coarser (~4x fewer
// points on a surface). With fixed-size points that step is a visible box edge
// even with the camera static. Below the budget the LOD is already smooth:
// refinement stops at `minNodePixelSize` (50 px radius), where a PotreeConverter
// 2 node's spacing (cube / 128 / 2^level) is under half a pixel.
//
// Why not potree's own ADAPTIVE size: it sizes a point from the octree SPACING,
// i.e. to close the gaps between samples. Tried, and it makes the boundary
// WORSE on real scans: a terrestrial scan is nowhere near gap-free at full
// detail (ground at a grazing angle, canopy edges), so the truncated region
// turned into solid squares beside the speckled full-detail one. What has to
// match across the boundary is COVERAGE — the fraction of pixels lit — not
// gaplessness. N points of diameter d cover about N·d² (until they saturate),
// so a region showing a fraction 1/k of its points needs diameter d·√k to look
// the same. k comes from the hierarchy: a node drawn without its children shows
// its own P points where P + C would be drawn (C = its children's points), so
// its fill factor is √((P + C) / P). Grandchildren aren't counted (their counts
// aren't loaded until a child is), so this under-fills a region more than one
// level short — the safe direction.
//
// Mechanics, riding on potree's ADAPTIVE machinery (its `getLOD` walks a
// per-material visibility texture to the deepest drawn node containing each
// point):
//  - The texture gets a second row holding each node's fill factor, and the
//    alpha of row 0 holds which of its octants have data in the hierarchy. The
//    patched `getLOD` records the factor only when the point's octant has
//    deeper data that wasn't drawn, so a true leaf — full detail, the user
//    zoomed in to see individual returns — keeps its fixed pixel size.
//  - The adaptive branch's world-space size is replaced by `size * fillFactor`,
//    so `size` keeps meaning PIXELS, exactly as under FIXED.
//  - A texture builder that can't throw. potree's `updateVisibilityTextureData`
//    writes into a texture hard-wired at 2048 texels with `data.set`, which
//    throws a RangeError the frame a cloud has more than 2048 visible nodes —
//    reachable at the upper end of the display-budget setting. Overflow nodes
//    here share a reserved all-zero texel (factor 1). They are the deepest
//    nodes (the list is breadth-first), so that is what they'd mostly get.
//
// Also: potree-core's Potree 2 loader never clears `isLeafNode` (it stays true
// on every node), so the hierarchy has to be read from `children` instead.
import * as THREE from 'three';

// The texture width potree-core allocates and its shader hard-codes.
export const VISIBLE_NODES_TEXTURE_WIDTH = 2048;

// Row 1 stores the factor as a byte in sixteenths: resolution 1/16, cap ~16x
// (a region drawing 1/256 of its points — no real cut is that deep).
const FACTOR_SCALE = 16;
export const MAX_FILL_FACTOR = 255 / FACTOR_SCALE;

// potree-core's PointCloudMaterial default `minSize`. Under the FIXED sizing
// the viewer used before, the shader's `clamp(size, minSize, maxSize)` meant a
// point size of 1 actually drew at 2 device px; keeping that floor makes the
// complete (unfilled) regions look exactly as they always have.
export const POTREE_DEFAULT_MIN_POINT_SIZE = 2;

/** The device-pixel size an unfilled point draws at for a user point size. */
export function basePointSize(pointSize: number): number {
  return Math.max(pointSize, POTREE_DEFAULT_MIN_POINT_SIZE);
}

interface HierarchyChild { numPoints?: number }

export interface VisibleNodeLike {
  name: string;
  index: number;
  numPoints?: number;
  // Present on potree's tree nodes (`geometryNode.children`) — the node's
  // children in the HIERARCHY, loaded or not.
  geometryNode?: { numPoints?: number; children?: ReadonlyArray<HierarchyChild | null> };
  children?: ReadonlyArray<HierarchyChild | null>;
}

function hierarchyChildren(node: VisibleNodeLike): ReadonlyArray<HierarchyChild | null> {
  return node.geometryNode?.children ?? node.children ?? [];
}

/** √((P + C) / P): the diameter multiplier that keeps a node's coverage when
 * it is drawn without its children. 1 for a leaf. */
export function fillFactor(node: VisibleNodeLike): number {
  const own = node.geometryNode?.numPoints ?? node.numPoints ?? 0;
  let below = 0;
  for (const c of hierarchyChildren(node)) below += c?.numPoints ?? 0;
  if (below <= 0) return 1;
  // A node with no points of its own (PotreeConverter writes empty interior
  // nodes) has nothing to grow; its children carry everything.
  if (own <= 0) return 1;
  return Math.min(MAX_FILL_FACTOR, Math.sqrt((own + below) / own));
}

function compareNodes(a: VisibleNodeLike, b: VisibleNodeLike): number {
  // potree-core's own order: breadth-first by name length, then lexicographic.
  // Children of one parent are then contiguous and in index order, which the
  // shader's `advance + numberOfOnes(mask, index - 1)` addressing relies on.
  if (a.name.length !== b.name.length) return a.name.length - b.name.length;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The visibility texture for the patched `getLOD`: `capacity` x 2 RGBA texels.
 * Row 0, per visible node (potree's layout, plus alpha):
 *   r = bitmask of its children that are VISIBLE (drawn this frame)
 *   g,b = offset (16-bit) from this texel to its first visible child
 *   a = bitmask of its children that EXIST in the hierarchy
 * Row 1: r = fill factor x 16.
 * Nodes past capacity share the reserved last texel, left all-zero.
 */
export function buildVisibleNodesTexels(
  visibleNodes: readonly VisibleNodeLike[],
  capacity = VISIBLE_NODES_TEXTURE_WIDTH,
): { data: Uint8Array; offsets: Map<string, number> } {
  const data = new Uint8Array(4 * capacity * 2);
  const row1 = 4 * capacity;
  const offsets = new Map<string, number>();
  const sorted = [...visibleNodes].sort(compareNodes);
  const usable = capacity - 1;
  const firstChildAdvance = new Array<number>(usable).fill(Infinity);
  for (let n = 0; n < sorted.length; n++) {
    const node = sorted[n];
    if (n >= usable) {
      offsets.set(node.name, usable);
      continue;
    }
    offsets.set(node.name, n);
    const children = hierarchyChildren(node);
    let mask = 0;
    for (let i = 0; i < 8; i++) if (children[i]) mask |= 1 << i;
    data[4 * n + 3] = mask;
    data[row1 + 4 * n] = Math.round(fillFactor(node) * FACTOR_SCALE);
    if (n === 0) continue;
    const parent = offsets.get(node.name.slice(0, -1));
    // A parent that is not visible (or overflowed) can't address the child.
    if (parent === undefined || parent >= usable) continue;
    const advance = Math.min(firstChildAdvance[parent], n - parent);
    firstChildAdvance[parent] = advance;
    const p = 4 * parent;
    data[p] |= 1 << node.index;
    data[p + 1] = advance >> 8;
    data[p + 2] = advance & 0xff;
  }
  return { data, offsets };
}

// Each rewrite must find exactly one site in potree's vertex shader; the
// octree `getLOD` comes first, ahead of the kd-tree variant (which has no
// `else` return, and is compiled out for an octree anyway).
const PATCHES: ReadonlyArray<[RegExp, string]> = [
  [
    /float getLOD\(\) \{/g,
    'float fillFactor = 1.0;\nfloat getLOD() {',
  ],
  [
    /\}\s*else\s*\{\s*return depth;\s*\}/g,
    `} else {
      if (isBitSet(int(round(value.a * 255.0)), index)) {
        fillFactor = texture(visibleNodes, vec2(float(iOffset) / 2048.0, 0.75)).r * ${(255 / FACTOR_SCALE).toFixed(4)};
      }
      return depth;
    }`,
  ],
  [
    /float worldSpaceSize = 2\.0 \* size \* spacing \/ getPointSizeAttenuation\(\);\s*pointSize = useOrthographicCamera \? \(worldSpaceSize \/ orthoWidth\) \* screenWidth : worldSpaceSize \* projFactor;/g,
    'getLOD();\n    pointSize = size * fillFactor;',
  ],
];

/**
 * Rewrite potree's adaptive point size into the coverage-preserving fill.
 * Returns the source unchanged (and false) unless every site matched once.
 */
export function patchLodShader(vertexShader: string): { source: string; patched: boolean } {
  // The first `getLOD() {` is the octree one; count only up to the kd-tree
  // block for that pattern.
  const kdStart = vertexShader.indexOf('tree_type_kdtree');
  let source = vertexShader;
  for (const [re, replacement] of PATCHES) {
    const matches = [...source.matchAll(re)];
    const relevant = re.source.startsWith('float getLOD') && kdStart >= 0
      ? matches.filter((m) => (m.index ?? 0) < kdStart)
      : matches;
    if (relevant.length !== 1) return { source: vertexShader, patched: false };
    const at = relevant[0].index!;
    source = source.slice(0, at) + replacement + source.slice(at + relevant[0][0].length);
  }
  return { source, patched: true };
}

interface FillMaterial {
  vertexShader: string;
  needsUpdate: boolean;
  visibleNodesTexture?: THREE.Texture;
  visibleNodeTextureOffsets?: Map<string, number>;
  uniforms: Record<string, { value: unknown }>;
  updateShaderSource: () => void;
  updateVisibilityTextureData: (nodes: VisibleNodeLike[]) => void;
}

const INSTALLED = Symbol.for('phytograph.coverageFill');
let warnedUnpatched = false;

/**
 * Install the coverage fill on one cloud's material: the two-row texture, the
 * safe builder and the patched shader. Idempotent. The caller sets
 * `pointSizeType = ADAPTIVE` and `size`/`minSize` to `basePointSize(...)`.
 */
export function installCoverageFill(material: unknown): void {
  const m = material as FillMaterial & { [INSTALLED]?: boolean };
  if (m[INSTALLED]) return;
  m[INSTALLED] = true;

  const tex = new THREE.DataTexture(
    new Uint8Array(4 * VISIBLE_NODES_TEXTURE_WIDTH * 2), VISIBLE_NODES_TEXTURE_WIDTH, 2, THREE.RGBAFormat,
  );
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  m.visibleNodesTexture?.dispose();
  m.visibleNodesTexture = tex;
  if (m.uniforms.visibleNodes) m.uniforms.visibleNodes.value = tex;

  m.updateVisibilityTextureData = (nodes: VisibleNodeLike[]) => {
    const { data, offsets } = buildVisibleNodesTexels(nodes);
    // potree's own `makeOnBeforeRender` reads this map for each node's vnStart.
    const target = m.visibleNodeTextureOffsets;
    if (target) {
      target.clear();
      for (const [k, v] of offsets) target.set(k, v);
    }
    (tex.image.data as Uint8Array).set(data);
    tex.needsUpdate = true;
  };

  const original = m.updateShaderSource.bind(m);
  m.updateShaderSource = () => {
    original();
    const { source, patched } = patchLodShader(m.vertexShader);
    if (!patched && /adaptive_point_size/.test(m.vertexShader) && !warnedUnpatched) {
      warnedUnpatched = true;
      console.warn('[octree] could not patch potree adaptive sizing; points will use potree\'s world-space size');
    }
    m.vertexShader = source;
    m.needsUpdate = true;
  };
  // The constructor already built an unpatched source; replace it now so a
  // frame drawn before the viewer configures the material can't link it.
  m.updateShaderSource();
}
