// Convert committed (unbaked) delete regions into GPU clip-box matrices for the
// persistent OctreePointCloud preview. Each delete region selects the points it
// removes; feeding the union of these volumes to the material under CLIP_INSIDE
// hides exactly the deleted points at frame rate — the instant-delete preview
// that persists across multiple deletes until bake.
//
// The matrices are world→box transforms (OctreePointCloud derives the inverse
// the shader needs). A point is "inside" a box iff, after applying the box's
// inverse, it lands in the unit cube [-0.5, 0.5]^3.
//
// These are derived purely from the region data (the frozen camera matrices for
// screen-space regions), so a committed delete renders identically on any later
// frame regardless of the live camera — unlike the live gizmo preview which
// tracks the current camera.

import * as THREE from 'three';
import type { PendingDeleteRegion } from './pointCloudTypes';

// A large extrusion depth so screen-space (polygon / squares) deletes remove
// points at every depth behind the stamp — matching the backend's purely-2D
// membership test (a stamp extrudes through the whole cloud).
const EXTRUDE_DEPTH = 1e6;

/** Axis-aligned box → world→box matrix (translate to center, scale to size). */
function boxMatrix(
  min: [number, number, number],
  max: [number, number, number],
): THREE.Matrix4 {
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const sx = Math.max(max[0] - min[0], 1e-9);
  const sy = Math.max(max[1] - min[1], 1e-9);
  const sz = Math.max(max[2] - min[2], 1e-9);
  return new THREE.Matrix4()
    .makeTranslation(cx, cy, cz)
    .multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
}

// Build the world→view-box transform for one screen-space pixel rectangle under
// frozen projection/view matrices. The box is the camera frustum slab covering
// [px0,px1]×[py0,py1] in canvas pixels, extruded deep along the view axis.
function screenRectMatrix(
  projection: number[],
  view: number[],
  canvas: { width: number; height: number },
  px0: number,
  py0: number,
  px1: number,
  py1: number,
): THREE.Matrix4 {
  const P = new THREE.Matrix4().fromArray(projection);
  const V = new THREE.Matrix4().fromArray(view);
  const invVP = new THREE.Matrix4().multiplyMatrices(P, V).invert();

  // Canvas pixels → NDC. Canvas Y is flipped vs NDC.
  const toNdc = (px: number, py: number) =>
    new THREE.Vector2((px / canvas.width) * 2 - 1, 1 - (py / canvas.height) * 2);
  const n0 = toNdc(px0, py0);
  const n1 = toNdc(px1, py1);
  const ndcMinX = Math.min(n0.x, n1.x), ndcMaxX = Math.max(n0.x, n1.x);
  const ndcMinY = Math.min(n0.y, n1.y), ndcMaxY = Math.max(n0.y, n1.y);
  const cxNdc = (ndcMinX + ndcMaxX) / 2;
  const cyNdc = (ndcMinY + ndcMaxY) / 2;

  // Unproject the rect center at the near plane to anchor the box; build a
  // camera-aligned box there sized to span the rect in world units at that
  // depth and extruded deep along view-Z.
  const center = new THREE.Vector3(cxNdc, cyNdc, 0).applyMatrix4(invVP);
  const cornerX = new THREE.Vector3(ndcMaxX, cyNdc, 0).applyMatrix4(invVP);
  const cornerY = new THREE.Vector3(cxNdc, ndcMaxY, 0).applyMatrix4(invVP);
  const halfW = Math.max(center.distanceTo(cornerX), 1e-6);
  const halfH = Math.max(center.distanceTo(cornerY), 1e-6);

  // Camera basis (rotation) from the inverse view matrix.
  const rot = new THREE.Matrix4().extractRotation(new THREE.Matrix4().copy(V).invert());
  const scale = new THREE.Matrix4().makeScale(halfW * 2, halfH * 2, EXTRUDE_DEPTH);
  const trans = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
  return trans.multiply(rot).multiply(scale);
}

/**
 * Convert one committed delete region into the clip-box matrices that hide its
 * deleted points. Box → one axis-aligned box. squares_union → one box per
 * square stamp. polygon → the polygon's screen-space bounding rect as a single
 * box (a conservative preview: it may hide a few extra points at the corners,
 * but the BACKEND mask is exact per-point, so the committed result is correct;
 * the bake reflects the true polygon). Returns [] for `invert` regions, whose
 * "keep the complement" semantics don't map to a simple CLIP_INSIDE union — the
 * caller falls back to a one-shot octree refresh for those (rare for deletes).
 */
export function deleteRegionToClipBoxes(region: PendingDeleteRegion): THREE.Matrix4[] {
  if (region.invert) return [];

  if (region.kind === 'box') {
    return [boxMatrix(region.min, region.max)];
  }

  if (region.kind === 'squares_union') {
    const { projection, view, canvas, centers, half_sizes } = region;
    return centers.map((c, i) => {
      const h = half_sizes[i] ?? half_sizes[0] ?? 1;
      return screenRectMatrix(projection, view, canvas, c[0] - h, c[1] - h, c[0] + h, c[1] + h);
    });
  }

  // polygon: use the screen-space bounding rect of the polygon points.
  const xs = region.points.map(p => p[0]);
  const ys = region.points.map(p => p[1]);
  return [screenRectMatrix(
    region.projection, region.view, region.canvas,
    Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys),
  )];
}

/** Flatten a stack of committed delete regions into one clip-box matrix list. */
export function pendingDeletesToClipBoxes(regions: PendingDeleteRegion[]): THREE.Matrix4[] {
  return regions.flatMap(deleteRegionToClipBoxes);
}
