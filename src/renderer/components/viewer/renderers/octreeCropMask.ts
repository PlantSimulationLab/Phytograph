// Exact per-point crop preview for octree clouds.
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
// Cost: bounded by the crop preview point budget (CROP_PREVIEW_POINT_BUDGET,
// 150k) rather than by the cloud size, and it only re-runs when the closed
// polygon changes — a closed polygon is static, unlike a dragging box gizmo —
// so a 100 M-point cloud costs the same as a 1 M-point one.
//
// The tradeoff this inherits: CROP_PREVIEW_MAX_LEVEL caps the LOD while a
// preview is active, so the preview is SPARSE. The silhouette is exact; the
// density is not the full cloud. The apply still goes through the backend at
// full resolution.

import * as THREE from 'three';

// Marks an index buffer as ours, so restore only ever removes an index this
// module added and never one that legitimately belongs to a geometry.
const CROP_MASK_FLAG = '__phytographCropMask';

// Scratch for composing a tile's world transform. Reused across the masking
// loop — this runs per tile, per re-mask.
const _tileWorld = new THREE.Matrix4();

/** A world-space inclusion test. Matches PointCloudViewer's buildCropPredicate. */
export type CropPredicate = (wx: number, wy: number, wz: number) => boolean;

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
 * `invert` flips the test, matching the Crop tool's Keep-Outside checkbox.
 */
export function applyCropMaskToGeometry(
  geometry: any,
  matrixWorld: THREE.Matrix4,
  displayOffset: { x: number; y: number; z: number } | undefined,
  predicate: CropPredicate,
  invert: boolean,
): void {
  const position = geometry?.attributes?.position;
  if (!position) return;

  const count = position.count;
  const ox = displayOffset?.x ?? 0;
  const oy = displayOffset?.y ?? 0;
  const oz = displayOffset?.z ?? 0;

  // Reused across the loop — allocating per point would dominate the cost.
  const v = new THREE.Vector3();
  const kept: number[] = [];
  for (let i = 0; i < count; i++) {
    v.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(matrixWorld);
    // matrixWorld lands the point in the DISPLAY frame (world − offset);
    // add the offset back to get the world coords the predicate expects.
    const inside = predicate(v.x + ox, v.y + oy, v.z + oz);
    if (invert ? !inside : inside) kept.push(i);
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
  predicate: CropPredicate,
  invert: boolean,
  maskKey: string,
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
    // Compose this tile's world transform WITHOUT touching its matrices.
    //
    // potree sets `matrixAutoUpdate = false` on every tile and writes
    // `sceneNode.matrix` itself (the node-local re-origin baked at tiling
    // time); `position`/`quaternion` are never populated to match. So
    // `updateMatrix()` would overwrite potree's matrix with an identity built
    // from that empty TRS, and `updateWorldMatrix()` refreshes ancestors but
    // leaves `matrixWorld` stale for a tile potree just repositioned —
    // measured 93 world-units off in X on an ALS scan, which is ~70px on
    // screen. Points then tested at the wrong place, passed the polygon test,
    // and drew as a band of "uncropped" cloud outside the lasso.
    //
    // Multiplying the octree's own (correct, live) world matrix by the tile's
    // own (potree-authored) matrix reproduces exactly the transform three.js
    // will compose at render time, and mutates nothing.
    _tileWorld.multiplyMatrices(octree.matrixWorld, sn.matrix);
    applyCropMaskToGeometry(geom, _tileWorld, displayOffset, predicate, invert);
    geom[CROP_MASK_FLAG + 'Key'] = maskKey;
  }
  publishCropMaskStats(octree);
}

/**
 * Remove crop masks from every loaded tile and forget the mask key, so the
 * cloud renders at full density again. Called when the crop region clears,
 * the tool exits, or the component unmounts.
 */
export function clearCropMaskFromVisibleNodes(octree: any): void {
  const visible = octree?.visibleNodes;
  if (!Array.isArray(visible)) return;
  for (const node of visible) {
    const geom = node?.sceneNode?.geometry;
    if (!geom) continue;
    clearCropMaskFromGeometry(geom);
    delete geom[CROP_MASK_FLAG + 'Key'];
  }
  publishCropMaskStats(octree);
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
export function publishCropMaskStats(octree: any): void {
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
  (globalThis as any).__octreeCropMask = { drawn, full, maskedTiles, tiles };
}
