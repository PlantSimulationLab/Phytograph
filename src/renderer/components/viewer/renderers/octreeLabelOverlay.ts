// Live per-tile label preview for octree clouds.
//
// The problem this solves. A DELETION is expressible on the GPU — the renderer
// hides the points with a clip volume, so a stale octree still draws correctly
// and `delete_region` can return in milliseconds without rebuilding anything.
// A LABEL change is not: the octree bakes attribute values into `octree.bin` at
// PotreeConverter time, so painting a class server-side has *zero* visual
// effect until a rebuild — and a rebuild is minutes on a large cloud. Rebuilding
// per brush stroke is categorically impossible.
//
// So the renderer keeps its own label column per tile, applies the pending
// strokes to it on the CPU, and aliases it into the `intensity` slot that
// potree's INTENSITY_GRADIENT path already colors from. Full density,
// immediate feedback, no backend round trip. The backend stays the source of
// truth and is reconciled on commit.
//
// Three properties make this cheap enough to run per frame:
//
//   * The label buffer lives ON the tile geometry as a named attribute, so
//     potree's LRU disposes it along with the geometry — no leak, no eviction
//     bookkeeping, unlike a side Map keyed by node name (a large cloud has
//     thousands of nodes over a session).
//   * Aliasing into `intensity` is a zero-copy reference swap, exactly as
//     `swapScalarIntoIntensity` already does for ordinary scalars.
//   * Tiles already keyed to the current stroke list are skipped, so the
//     steady-state cost is one string compare per visible node — the same
//     `maskKey` discipline `octreeCropMask` uses.
//
// STROKES ARE REPLAYED FROM SCRATCH per tile, never applied incrementally. That
// is the answer to LOD refinement: a stroke is a world-space VOLUME, so a tile
// arriving later at level 7 replays the same list and gets the correct labels
// for points no stroke has ever "touched". There is no per-point identity
// anywhere in the design — the octree reorders by morton code and carries no
// original-index column — which is exactly why selections are geometry.

import * as THREE from 'three';
import { composeTileWorldMatrix } from './octreeCropMask';

/** The per-tile label column this module owns. */
export const LABEL_ATTRIBUTE = '__phytographLabel';
/** Stroke-list key a tile's labels were last built for. */
const LABEL_KEY = '__phytographLabelKey';
/** How many of that key's strokes the tile's buffer holds (see incremental replay). */
const LABEL_COUNT = '__phytographLabelCount';
/** Whatever occupied the `intensity` slot before we aliased over it. */
const LABEL_BASE = '__phytographLabelBase';

/** Scratch, reused across the per-tile loop. */
const _tileWorld = new THREE.Matrix4();

/** A world-space membership test for one stroke. */
export type StrokePredicate = (wx: number, wy: number, wz: number) => boolean;

export interface LabelStrokeRender {
  /** World-space inclusion test, built from the stroke's region. */
  predicate: StrokePredicate;
  /**
   * World-space AABB of the stroke, for cheap per-tile rejection. A stroke
   * touches a handful of tiles out of hundreds, and skipping the rest is what
   * keeps a long session affordable. Omit only if the region is unbounded.
   */
  aabb?: THREE.Box3 | null;
  /**
   * For a SCREEN-space stroke (a lasso), which has no world AABB: false when a
   * tile with this world box cannot contain a selected point. Without it every
   * lasso stroke was replayed over every loaded tile.
   */
  tileMayHit?: (worldBox: THREE.Box3) => boolean;
  /**
   * DENSE PALETTE INDEX to write, not the class value. potree bakes the step
   * gradient into a 64-texel canvas, so a palette using values 64, 65, 66…
   * would be indistinguishable on screen; the column stores real class values
   * but the renderer paints indices. See lib/classPalettes.ts.
   */
  toIndex: number;
  /**
   * Only repaint points whose CURRENT index is in this set (TerraScan's
   * From-class gate — what makes fast, sloppy painting safe). null = any.
   */
  fromIndices: Set<number> | null;
  /** Never repaint points whose CURRENT index is in this set (hidden or locked
   *  classes). Applied after the From gate. */
  excludeIndices?: Set<number> | null;
  /**
   * A pre-label stroke (F8): the target is read PER POINT from another of the
   * tile's attributes (e.g. `wood_class`), mapped from its value to a palette
   * index, instead of being one `toIndex`. A value with no entry is left alone,
   * as the backend does; a tile without the attribute is skipped.
   */
  fromAttribute?: { name: string; indexOf: ReadonlyMap<number, number> } | null;
}

export interface LabelOverlayState {
  strokes: LabelStrokeRender[];
  /** Changes whenever the stroke list changes; drives re-application. */
  key: string;
  /** Index written where nothing has been painted (normally 0/Unclassified). */
  unlabeledIndex: number;
  /**
   * Class VALUE -> palette INDEX, for the committed baseline. The octree stores
   * real class values (0, 64, 65…) while this buffer holds palette positions
   * (0, 1, 2…); copying values straight in painted a committed 64 as whatever
   * sat at position 64 (or off the end of the gradient), and made the From gate
   * compare positions with values. A value the palette lacks reads as
   * unlabeled.
   */
  valueToIndex: ReadonlyMap<number, number>;
}

/**
 * Get (creating if absent) a tile's label column, sized to its point count.
 *
 * Float32 rather than Uint8 despite the 4x size: the INTENSITY_GRADIENT path
 * reads a float and normalizes it through `intensityRange`, and a normalized
 * integer attribute risks a driver-dependent path in the RawShaderMaterial.
 * The cost is bounded by the point budget (2M points -> 8 MB), not by cloud
 * size, because only LOADED tiles carry one.
 */
export function ensureLabelAttribute(
  geometry: any, unlabeledIndex: number,
): THREE.BufferAttribute | null {
  const position = geometry?.attributes?.position;
  if (!position) return null;
  const existing = geometry.attributes[LABEL_ATTRIBUTE];
  if (existing && existing.count === position.count) return existing;
  const array = new Float32Array(position.count);
  if (unlabeledIndex !== 0) array.fill(unlabeledIndex);
  const attr = new THREE.BufferAttribute(array, 1);
  geometry.setAttribute(LABEL_ATTRIBUTE, attr);
  return attr;
}

/**
 * Replay `strokes` onto one tile's label column, from scratch.
 *
 * `matrixWorld` takes a node-local position to the DISPLAY frame (world −
 * displayOffset), so the offset is added back before testing: predicates speak
 * world coordinates. Same round trip as `applyCropMaskToGeometry`.
 *
 * `baseLabels` carries COMMITTED labels decoded from the octree (present after
 * a commit rebuild), so the overlay shows committed + pending together rather
 * than dropping everything the user already saved.
 */
export function applyStrokesToGeometry(
  geometry: any,
  matrixWorld: THREE.Matrix4,
  displayOffset: { x: number; y: number; z: number } | undefined,
  baseLabels: ArrayLike<number> | null,
  state: LabelOverlayState,
  /** Replay from this stroke on, over the buffer as it is (the strokes before
   *  it are already applied). 0 = from scratch. */
  fromStroke = 0,
): void {
  const position = geometry?.attributes?.position;
  if (!position) return;
  const attr = ensureLabelAttribute(geometry, state.unlabeledIndex);
  if (!attr) return;
  const out = attr.array as Float32Array;
  const count = position.count;
  if (fromStroke > 0) {
    replayStrokes(geometry, matrixWorld, displayOffset, state, fromStroke, out);
    attr.needsUpdate = true;
    return;
  }

  // Reset to the committed baseline (or unlabeled) before replaying, in
  // palette INDEX space like everything else in this buffer. Class values come
  // in runs (the octree groups points spatially), so remember the last lookup.
  if (baseLabels && baseLabels.length === count) {
    const map = state.valueToIndex;
    let lastValue = NaN;
    let lastIndex = state.unlabeledIndex;
    for (let i = 0; i < count; i++) {
      const value = Math.round(baseLabels[i]);
      if (value !== lastValue) {
        lastValue = value;
        lastIndex = map.get(value) ?? state.unlabeledIndex;
      }
      out[i] = lastIndex;
    }
  } else {
    out.fill(state.unlabeledIndex);
  }
  if (state.strokes.length === 0) {
    attr.needsUpdate = true;
    return;
  }

  replayStrokes(geometry, matrixWorld, displayOffset, state, 0, out);
  attr.needsUpdate = true;
}

/** Apply `state.strokes[fromStroke..]`, in order, onto `out`. */
function replayStrokes(
  geometry: any, matrixWorld: THREE.Matrix4,
  displayOffset: { x: number; y: number; z: number } | undefined,
  state: LabelOverlayState, fromStroke: number, out: Float32Array,
): void {
  const position = geometry.attributes.position;
  const count = position.count;
  const ox = displayOffset?.x ?? 0;
  const oy = displayOffset?.y ?? 0;
  const oz = displayOffset?.z ?? 0;
  const v = new THREE.Vector3();

  // Tile bounds in WORLD space, for per-stroke rejection.
  const tileBox = geometryWorldBox(geometry, matrixWorld, ox, oy, oz);

  for (let s = fromStroke; s < state.strokes.length; s++) {
    const stroke = state.strokes[s];
    if (tileBox && stroke.aabb && !stroke.aabb.intersectsBox(tileBox)) continue;
    if (tileBox && stroke.tileMayHit && !stroke.tileMayHit(tileBox)) continue;
    const from = stroke.fromIndices;
    const exclude = stroke.excludeIndices?.size ? stroke.excludeIndices : null;
    const src: ArrayLike<number> | null = stroke.fromAttribute
      ? geometry.attributes?.[stroke.fromAttribute.name]?.array ?? null : null;
    if (stroke.fromAttribute && !src) continue;
    const indexOf = stroke.fromAttribute?.indexOf;
    for (let i = 0; i < count; i++) {
      if (from && !from.has(out[i])) continue;
      if (exclude && exclude.has(out[i])) continue;
      v.set(position.getX(i), position.getY(i), position.getZ(i))
        .applyMatrix4(matrixWorld);
      if (!stroke.predicate(v.x + ox, v.y + oy, v.z + oz)) continue;
      if (src && indexOf) {
        const t = indexOf.get(Math.round(src[i]));
        if (t !== undefined) out[i] = t;
      } else {
        out[i] = stroke.toIndex;
      }
    }
  }
}

/**
 * How many strokes of `state` a tile built for `oldKey` (holding `oldCount`
 * strokes) already has, or 0 when it must be rebuilt. A key is
 * `<base>|<id>,<id>,...`; the new key EXTENDING the old one by whole ids means
 * the old strokes are unchanged and only the new ones need applying, so a
 * stroke costs one pass per tile instead of a replay of the whole session.
 */
export function strokesAlreadyApplied(
  oldKey: unknown, oldCount: unknown, state: LabelOverlayState,
): number {
  if (typeof oldKey !== 'string' || typeof oldCount !== 'number' || oldCount <= 0) return 0;
  if (oldCount > state.strokes.length || !state.key.startsWith(oldKey)) return 0;
  const next = state.key.charAt(oldKey.length);
  return next === ',' ? oldCount : 0;
}

/** World-space bounds of a tile, or null when it has none to compute from. */
function geometryWorldBox(
  geometry: any, matrixWorld: THREE.Matrix4, ox: number, oy: number, oz: number,
): THREE.Box3 | null {
  if (!geometry.boundingBox) {
    try { geometry.computeBoundingBox(); } catch { return null; }
  }
  const bb = geometry.boundingBox;
  if (!bb) return null;
  return bb.clone().applyMatrix4(matrixWorld).translate(new THREE.Vector3(ox, oy, oz));
}

/**
 * Point a tile's `intensity` at the label column so the gradient shader colors
 * by it. Backs up whatever was there first — which may itself be an
 * already-aliased scalar; that is fine, it is only a reference — so restore is
 * exact. Idempotent by reference compare, like `swapScalarIntoIntensity`.
 */
export function swapLabelIntoIntensity(geometry: any): boolean {
  const src = geometry?.attributes?.[LABEL_ATTRIBUTE];
  if (!src) return false;
  if (geometry.attributes.intensity !== src) {
    if (!geometry.attributes[LABEL_BASE] && geometry.attributes.intensity) {
      geometry.setAttribute(LABEL_BASE, geometry.attributes.intensity);
    }
    geometry.setAttribute('intensity', src);
  }
  return true;
}

/** Undo `swapLabelIntoIntensity` and drop the label column from one tile. */
export function clearLabelOverlayFromGeometry(geometry: any): void {
  if (!geometry?.attributes) return;
  const base = geometry.attributes[LABEL_BASE];
  if (base) {
    geometry.setAttribute('intensity', base);
    geometry.deleteAttribute(LABEL_BASE);
  }
  if (geometry.attributes[LABEL_ATTRIBUTE]) {
    geometry.deleteAttribute(LABEL_ATTRIBUTE);
  }
  delete geometry[LABEL_KEY];
  delete geometry[LABEL_COUNT];
}

/**
 * Apply the overlay to every currently-loaded tile.
 *
 * Called from BOTH the material effect (tiles already loaded) and the per-frame
 * `afterUpdate` (tiles that streamed in, or were evicted and reloaded, since).
 * A tile with no key is built from scratch; a tile whose key still matches is
 * skipped, so steady state is a string compare per visible node.
 *
 * `committedSlug` names the octree's own attribute holding committed labels, so
 * a post-commit tile starts from the baked values rather than blank.
 */
export function applyLabelOverlayToVisibleNodes(
  octree: any,
  displayOffset: { x: number; y: number; z: number } | undefined,
  state: LabelOverlayState,
  committedSlug?: string | null,
  statsId?: string,
): void {
  const visible = octree?.visibleNodes;
  if (!Array.isArray(visible)) return;
  // The root DOES use position/quaternion, so refresh it once per pass — see
  // composeTileWorldMatrix's docstring.
  octree.updateWorldMatrix?.(true, false);
  let rebuilt = false;
  for (const node of visible) {
    const sn = node?.sceneNode;
    const geom = sn?.geometry;
    if (!geom) continue;
    if (geom[LABEL_KEY] === state.key) {
      // Already current; just make sure the alias survived a material swap.
      swapLabelIntoIntensity(geom);
      continue;
    }
    composeTileWorldMatrix(octree, sn, _tileWorld);
    const committed = committedSlug ? geom.attributes?.[committedSlug]?.array : null;
    const done = strokesAlreadyApplied(geom[LABEL_KEY], geom[LABEL_COUNT], state);
    applyStrokesToGeometry(geom, _tileWorld, displayOffset, committed ?? null, state, done);
    swapLabelIntoIntensity(geom);
    geom[LABEL_KEY] = state.key;
    geom[LABEL_COUNT] = state.strokes.length;
    rebuilt = true;
  }
  // Counting walks every loaded label value, so it runs only in a pass that
  // changed one, not on every frame at steady state.
  if (rebuilt) publishLabelOverlayStats(octree, state, statsId);
}

/**
 * Remove the overlay from every LOADED tile (tool close / rebuild landed).
 *
 * Loaded, not visible: a tile out of view is hidden, not unloaded, and it kept
 * the label buffer aliased into its intensity slot, so colored by intensity it
 * drew labels when it came back into view. `traverse` visits the octree's whole
 * object tree, hidden children included; evicted tiles have left the tree and
 * their buffers go with them, so nothing needs to be remembered here.
 */
export function clearLabelOverlayFromVisibleNodes(octree: any, statsId?: string): void {
  const visible = octree?.visibleNodes;
  if (!Array.isArray(visible)) return;
  for (const node of visible) {
    const geom = node?.sceneNode?.geometry;
    if (geom) clearLabelOverlayFromGeometry(geom);
  }
  octree.traverse?.((obj: any) => {
    if (obj?.geometry?.attributes?.[LABEL_ATTRIBUTE]) clearLabelOverlayFromGeometry(obj.geometry);
  });
  // Always clear, even if the octree is already gone — a stale global would
  // otherwise report counts for a cloud that no longer exists.
  (globalThis as any).__labelOverlay = undefined;
  if (statsId) delete (globalThis as any).__labelOverlayByCloud?.[statsId];
}

/**
 * Publish what the overlay is painting, for E2E.
 *
 * The DOM cannot show GPU state, so a spec has no other way to tell "the right
 * points got painted" from "nothing happened". Follows the convention
 * `publishCropMaskStats` set: expose a NARROW FACT, never the scene graph.
 * `painted` counts points whose index differs from unlabeled, over the loaded
 * tiles.
 *
 * `__labelOverlay` is whichever cloud painted last, which is ambiguous once two
 * clouds carry an overlay, so `statsId` (the cloud id) also files the same fact
 * under `__labelOverlayByCloud[statsId]`.
 */
export function publishLabelOverlayStats(
  octree: any, state: LabelOverlayState, statsId?: string,
): void {
  if (!octree) return;
  let painted = 0;
  let total = 0;
  let tiles = 0;
  octree.traverse?.((obj: any) => {
    if (!obj?.isPoints || obj.visible === false) return;
    const attr = obj.geometry?.attributes?.[LABEL_ATTRIBUTE];
    if (!attr) return;
    tiles++;
    const arr = attr.array as Float32Array;
    total += arr.length;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] !== state.unlabeledIndex) painted++;
    }
  });
  const stats = { painted, total, tiles, key: state.key };
  (globalThis as any).__labelOverlay = stats;
  if (statsId) {
    const g = globalThis as any;
    g.__labelOverlayByCloud = { ...(g.__labelOverlayByCloud ?? {}), [statsId]: stats };
  }
}
