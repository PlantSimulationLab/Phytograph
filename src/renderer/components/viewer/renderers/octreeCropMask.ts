// Exact per-point crop AND FILTER preview for octree clouds.
//
// Despite the filename this module owns the whole per-point visibility mask,
// not just cropping. Both previews want to hide individual points of a tile,
// both do it with the geometry INDEX, and a geometry has exactly one index —
// so two independent writers would silently erase each other. They compose here
// instead, in ONE pass: a point draws only if it survives every crop rule AND
// every filter clause. (Same reasoning that already made `rules` a stack rather
// than a single test — see the note on `applyCropMaskToGeometry`.)
//
// Today the tool panels are mutually exclusive — `closeAllToolPanels` sets
// `editMode = 'none'` when the Filter panel opens, so a crop preview and a
// filter preview cannot actually be on screen together, and the composition is
// not reachable through the UI. It is still written this way rather than as two
// writers because the alternative is a latent trap: the day those tools stop
// being exclusive (or a third per-point preview arrives), independent writers
// would fail SILENTLY, by drawing the wrong points rather than by erroring.
// Composition costs nothing here and cannot break that way. Note that this also
// means the composed case is covered by unit tests only — an E2E cannot reach
// it, and one written as if it could passes without discriminating anything.
//
// The two clause kinds differ only in where they read from. Crop rules test a
// WORLD-space position, so they pay for the node→world transform below. Filter
// clauses test a value straight out of a tile's own attribute buffer
// (`geometry.attributes[slug]`), which potree has already decoded and uploaded
// — no transform, no fetch, no backend call. Resolving which buffer, and in
// what units, happens once per filter change in `lib/octreeFilterSpec.ts`; the
// RULE itself is `filterValueKeeps`, shared with the flat preview and the
// destructive commit so the three cannot drift.
//
// The GPU clip volume (`clipBox`) is the fast path and handles BOX crops
// completely — an AABB is exactly what potree's shader tests. Screen-space
// crops (freeform polygon, and rect drawn from an arbitrary camera) are not
// boxes, and potree-core's material has no per-point discard we could drive:
// its only vertex-kill is `use_filter_by_normal`, hard-wired to the `normal`
// attribute and a threshold uniform. Approximating a lasso with the union of
// its bounding boxes previews a visibly different shape than the one the user
// drew, which for a concave lasso is most of the point of drawing it.
//
// So the polygon preview runs the real predicate on the CPU, over the points
// that are actually on screen, and hides the rest with an INDEX BUFFER.
//
// Why an index buffer and not buffer compaction: potree tile geometries are
// non-indexed (potree-core calls setIndex only for the bbox wireframe and its
// fullscreen quad — never for point tiles), so adding an index is purely
// additive. It selects which points draw and touches no attribute buffer at
// all. Compaction would mean filtering position, color, intensity,
// classification and every decoded scalar in lockstep, where one missed
// attribute smears colors onto the wrong points — the same trap
// `collectHitPoints()` exists to avoid on the flat path. Restoring is also
// exact and free: drop the index, and the original geometry is untouched
// underneath. Nothing here can corrupt the cloud's data.
//
// Cost: bounded by the resident point budget rather than by the cloud size, and
// it only re-runs when the closed polygon changes — a closed polygon is static,
// unlike a dragging box gizmo — so a 100 M-point cloud costs the same as a
// 1 M-point one.
//
// Note that budget is the FULL display budget here, not the reduced one: a
// screen-space region uses no clip volume, hence no fragment `discard`, hence
// none of the overdraw the reduction guards against (see the gating in
// PointCloudViewer). Both of the crop preview's decimations — the reduced
// budget and CROP_PREVIEW_MAX_LEVEL — are keyed on `clipBox` and so apply to
// Box mode ALONE. Rect and Polygon preview at full detail.
//
// A FILTER preview deliberately does NOT cap the LOD. The cap exists because a
// dragging box gizmo re-masks continuously; a filter is static between edits
// (and debounced), so it can preview at the full point budget and look like the
// real cloud rather than a thinned one. What it still inherits is the other
// half of that tradeoff: the mask only ever sees LOADED tiles, so it previews
// the SHAPE of the result, not an exact point count. That is why the stats
// below are reported as a RATIO — `drawn/full` over loaded tiles is meaningful
// at any LOD, whereas an absolute count invites being read as the answer the
// backend will give on commit.

import * as THREE from 'three';
import { cropMaskRulesKey, cropRulesKeep, type CropMaskRule, type CropPredicate } from '../../../lib/cropGeometry';
import { filterValueKeeps } from '../../../lib/pointCloudHelpers';
import { EMPTY_FILTER_SPEC, type FilterClause, type OctreeFilterSpec } from '../../../lib/octreeFilterSpec';

export { cropMaskRulesKey };
export type { CropMaskRule, CropPredicate };

/** The composite key for a mask: crop rules AND filter clauses. A geometry
 *  already masked under this key needs no re-test, which is what keeps the
 *  per-frame call a string compare per visible node. */
export function visibilityMaskKey(
  rules: readonly CropMaskRule[],
  filter: OctreeFilterSpec,
): string {
  return `${cropMaskRulesKey(rules)}#${filter.key}`;
}

// Resolve one filter clause's attribute buffer on a tile geometry.
//
// Returns null when the tile does not carry the attribute at all, which the
// caller treats as "this clause does not apply" — matching
// `pointPassesFilters`, which skips a scalar filter for a field the cloud has
// no values for. Dropping the points instead would blank a cloud the moment a
// sibling scan's field was filtered.
function clauseAttribute(geometry: any, clause: FilterClause): any | null {
  const src = clause.source;
  if (src.kind === 'position') return geometry?.attributes?.position ?? null;
  return geometry?.attributes?.[src.slug]
    ?? (src.fallbackSlug ? geometry?.attributes?.[src.fallbackSlug] : null)
    ?? null;
}

// Marks an index buffer as ours, so restore only ever removes an index this
// module added and never one that legitimately belongs to a geometry.
const CROP_MASK_FLAG = '__phytographCropMask';

// Scratch for composing a tile's world transform. Reused across the masking
// loop — this runs per tile, per re-mask.
const _tileWorld = new THREE.Matrix4();

/**
 * Compose a tile's node→scene transform into `out`, WITHOUT touching any matrix.
 *
 * Every per-tile CPU pass needs this, and getting it wrong is subtle and
 * expensive, so it lives in one place:
 *
 * potree sets `matrixAutoUpdate = false` on every tile and writes
 * `sceneNode.matrix` itself (the node-local re-origin baked at tiling time);
 * `position`/`quaternion` are never populated to match. So `updateMatrix()`
 * would overwrite potree's matrix with an identity built from that empty TRS,
 * and `updateWorldMatrix()` refreshes ancestors but leaves `matrixWorld` stale
 * for a tile potree just repositioned — measured 93 world-units off in X on an
 * ALS scan, which is ~70px on screen. Points then tested at the wrong place.
 *
 * Multiplying the octree's own (correct, live) world matrix by the tile's own
 * (potree-authored) matrix reproduces exactly the transform three.js will
 * compose at render time, and mutates nothing.
 *
 * The caller is responsible for refreshing the OCTREE ROOT first — the root
 * does use position/quaternion (applyOctreePose writes them), so
 * `octree.updateWorldMatrix(true, false)` on it is both safe and necessary.
 * Hoist that out of per-tile loops; it only needs doing once per pass.
 *
 * NOTE the frame this lands in: the result takes a node-local position to the
 * DISPLAY frame (world − displayOffset), so a world-space predicate must add
 * the display offset back. See `applyCropMaskToGeometry`.
 */
export function composeTileWorldMatrix(
  octree: any,
  sceneNode: any,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  return out.multiplyMatrices(octree.matrixWorld, sceneNode.matrix);
}

function isMaskedGeometry(geometry: any): boolean {
  return !!geometry?.index?.[CROP_MASK_FLAG];
}

/**
 * Hide the points of one tile geometry that the predicate rejects.
 *
 * `matrixWorld` is the geometry's node→scene transform and `displayOffset` is
 * the render-only shift the whole scene draws under; together they take a
 * node-local position back to true world coordinates, which is the frame the
 * predicate speaks. (Node positions are re-origined server-side at tiling
 * time, so they are small float32 — the round-trip through world space is
 * done in float64 here.)
 *
 * `rules` is a STACK, not a single test, and a point must survive all of them.
 * That is what lets an applied crop keep hiding its points while the user draws
 * the next one: the committed regions (whose octree rebuild is still running in
 * the background) and the live preview compose here rather than fighting over
 * one index buffer. Each rule's `invert` flips its own test, matching the Crop
 * tool's Keep-Outside checkbox. An empty stack keeps everything.
 */
export function applyCropMaskToGeometry(
  geometry: any,
  matrixWorld: THREE.Matrix4,
  displayOffset: { x: number; y: number; z: number } | undefined,
  rules: readonly CropMaskRule[],
  filter: OctreeFilterSpec = EMPTY_FILTER_SPEC,
): void {
  const position = geometry?.attributes?.position;
  if (!position) return;
  // Clauses this tile can actually evaluate. Resolved ONCE per tile rather than
  // per point: an attribute lookup per point over a few hundred thousand points
  // would dominate the loop.
  const clauses: { clause: FilterClause; attr: any }[] = [];
  for (const clause of filter.clauses) {
    const attr = clauseAttribute(geometry, clause);
    if (attr) clauses.push({ clause, attr });
  }
  if (rules.length === 0 && clauses.length === 0) {
    if (isMaskedGeometry(geometry)) geometry.setIndex(null);
    return;
  }

  const count = position.count;
  const ox = displayOffset?.x ?? 0;
  const oy = displayOffset?.y ?? 0;
  const oz = displayOffset?.z ?? 0;

  // ATTRIBUTE clauses read a tile buffer directly and need no transform, so
  // test them FIRST — a point they reject skips the matrix multiply entirely.
  const attrClauses = clauses.filter(c => c.clause.source.kind === 'attribute');
  const passesAttrClauses = (i: number): boolean => {
    for (const { clause, attr } of attrClauses) {
      if (!filterValueKeeps(clause.range, attr.getX(i))) return false;
    }
    return true;
  };

  // POSITION clauses (an X/Y/Z filter) must NOT read the raw buffer: node
  // positions are re-origined server-side at tiling time, so they are small
  // node-local float32, while the panel's bounds come from the cloud's world
  // bounds. Testing one against the other would hide an essentially arbitrary
  // set of points. They are tested in world space alongside the crop rules,
  // below, off the same transform.
  const posClauses = clauses.filter(c => c.clause.source.kind === 'position');
  const passesPosClauses = (wx: number, wy: number, wz: number): boolean => {
    for (const { clause } of posClauses) {
      const axis = (clause.source as { kind: 'position'; axis: 0 | 1 | 2 }).axis;
      const v = axis === 0 ? wx : axis === 1 ? wy : wz;
      if (!filterValueKeeps(clause.range, v)) return false;
    }
    return true;
  };

  const needsWorld = rules.length > 0 || posClauses.length > 0;

  // Reused across the loop — allocating per point would dominate the cost.
  const v = new THREE.Vector3();
  const kept: number[] = [];
  for (let i = 0; i < count; i++) {
    if (!passesAttrClauses(i)) continue;
    if (!needsWorld) { kept.push(i); continue; }
    v.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(matrixWorld);
    // matrixWorld lands the point in the DISPLAY frame (world − offset);
    // add the offset back to get the world coords the predicates expect.
    const wx = v.x + ox, wy = v.y + oy, wz = v.z + oz;
    if (!passesPosClauses(wx, wy, wz)) continue;
    if (rules.length > 0 && !cropRulesKeep(rules, wx, wy, wz)) continue;
    kept.push(i);
  }

  // Every point survives: drop any mask we previously set rather than paying
  // for a full-length index. Common while the polygon still covers the tile.
  if (kept.length === count) {
    if (isMaskedGeometry(geometry)) geometry.setIndex(null);
    return;
  }

  const IndexArray = count > 65535 ? Uint32Array : Uint16Array;
  const index = new THREE.BufferAttribute(IndexArray.from(kept), 1);
  (index as any)[CROP_MASK_FLAG] = true;
  geometry.setIndex(index);
}

/** Drop the crop mask from one geometry, if this module put one there. */
export function clearCropMaskFromGeometry(geometry: any): void {
  if (isMaskedGeometry(geometry)) geometry.setIndex(null);
}

/**
 * Apply the predicate to every currently-loaded tile of an octree.
 *
 * Tiles stream in asynchronously and the LRU evicts and reloads them, so a
 * node can appear (or reappear, unmasked) at any time. Call this both when the
 * crop region changes AND per-frame from `afterUpdate`, exactly as the
 * scalar→intensity swap does — a newly arrived tile would otherwise render its
 * cropped-away points.
 *
 * Re-masking is driven by `maskKey`: a value that changes when the crop region
 * changes. A geometry already masked under the current key is skipped, which is
 * what keeps the per-frame call cheap (a string compare per visible node, not a
 * re-test of 150k points every frame).
 */
export function applyCropMaskToVisibleNodes(
  octree: any,
  displayOffset: { x: number; y: number; z: number } | undefined,
  rules: readonly CropMaskRule[],
  maskKey: string,
  filter: OctreeFilterSpec = EMPTY_FILTER_SPEC,
  cacheId?: string,
): void {
  const visible = octree?.visibleNodes;
  if (!Array.isArray(visible)) return;
  // The octree root DOES use position/quaternion (applyOctreePose writes them,
  // or sets `matrix` with matrixAutoUpdate off), so refreshing it is both safe
  // and necessary — the pose may have changed since the last render.
  octree.updateWorldMatrix?.(true, false);
  for (const node of visible) {
    const sn = node?.sceneNode;
    const geom = sn?.geometry;
    if (!geom) continue;
    if (geom[CROP_MASK_FLAG + 'Key'] === maskKey) continue;
    // Compose this tile's world transform WITHOUT touching its matrices — see
    // composeTileWorldMatrix's docstring for why updateWorldMatrix is not an
    // option here (measured 93 world-units of drift on an ALS scan).
    composeTileWorldMatrix(octree, sn, _tileWorld);
    applyCropMaskToGeometry(geom, _tileWorld, displayOffset, rules, filter);
    geom[CROP_MASK_FLAG + 'Key'] = maskKey;
  }
  publishCropMaskStats(octree, cacheId);
}

/**
 * Remove crop masks from every loaded tile and forget the mask key, so the
 * cloud renders at full density again. Called when the crop region clears,
 * the tool exits, or the component unmounts.
 */
export function clearCropMaskFromVisibleNodes(octree: any, cacheId?: string): void {
  const visible = octree?.visibleNodes;
  if (!Array.isArray(visible)) return;
  for (const node of visible) {
    const geom = node?.sceneNode?.geometry;
    if (!geom) continue;
    clearCropMaskFromGeometry(geom);
    delete geom[CROP_MASK_FLAG + 'Key'];
  }
  publishCropMaskStats(octree, cacheId);
}

/**
 * Summarize what the mask is currently hiding, over the loaded tiles:
 * `drawn` (points that will actually render) vs `full` (points present).
 *
 * Exposed on `window.__octreeCropMask` for E2E, which otherwise has no way to
 * tell "the preview hid the right points" from "nothing happened" — the DOM
 * shows neither. Mirrors the existing `__octreeCropHidden` hook's convention of
 * publishing a narrow fact rather than handing out the scene graph.
 */
export function publishCropMaskStats(octree: any, cacheId?: string): void {
  if (!octree) return;
  // E2E seam: hide only the point tiles, leaving the crop overlay and all other
  // chrome untouched. A test screenshots with and without this and diffs the
  // two, which is the only reliable way to isolate the CLOUD's pixels — the
  // overlay tints the crop interior and the panels have blues of their own, so
  // an absolute colour threshold on a single frame counts chrome as cloud.
  // Re-applied every frame because potree resets node visibility as it streams.
  if ((globalThis as any).__hideCloudForPixelTest) {
    octree.traverse?.((o: any) => { if (o.isPoints) o.visible = false; });
  }
  let drawn = 0;
  let full = 0;
  let maskedTiles = 0;
  let tiles = 0;
  // Walk what the renderer will actually DRAW — the octree's scene subtree —
  // rather than `visibleNodes`. Measuring the same list the masking loop walks
  // would be self-confirming: a tile that renders but is absent from
  // visibleNodes is exactly the failure this needs to be able to see, and it
  // would go uncounted. Anything visible and unindexed here is a tile drawing
  // at full length, i.e. showing points the crop should have hidden.
  octree.traverse?.((obj: any) => {
    if (!obj?.isPoints || obj.visible === false) return;
    const count = obj.geometry?.attributes?.position?.count;
    if (typeof count !== 'number') return;
    tiles++;
    full += count;
    if (isMaskedGeometry(obj.geometry)) {
      maskedTiles++;
      drawn += obj.geometry.index.count;
    } else {
      drawn += count;
    }
  });
  // `shown` is the RATIO of points surviving the mask over the loaded tiles.
  // It is the only honest summary the panel can display: the mask sees whatever
  // the LOD happens to have streamed in, so an absolute `drawn` is a sample,
  // not the count the backend will return on commit — but the proportion is
  // meaningful at any LOD. 1 when nothing is loaded yet, so a cloud mid-stream
  // reads as "nothing hidden" rather than "everything hidden".
  const shown = full > 0 ? drawn / full : 1;
  const stats = { drawn, full, maskedTiles, tiles, shown };
  (globalThis as any).__octreeCropMask = stats;
  // ALSO published per cloud. The bare key above is a single slot, so with
  // several scans selected — which the Filter tool supports, and its commit
  // buttons act on all of them — each cloud's pass would overwrite the last and
  // the panel would report whichever rendered most recently. Mirrors the
  // existing per-cacheId `__octreeCropHidden` convention.
  if (cacheId) ((globalThis as any).__octreeMaskByCloud ??= {})[cacheId] = stats;
}
