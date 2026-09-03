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
import {
  pointInPolygon,
  projectWorldToCanvasPixel,
  type CropMaskRule,
} from './cropGeometry';
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
 * deleted points. Box → one axis-aligned box. squares_union / spheres_union →
 * one box per stamp. All exact, and all on the GPU.
 *
 * Returns [] for two kinds the clip union cannot state, both of which
 * `pendingDeletesToCropMaskRules` picks up per point instead:
 *
 *   • `invert` regions, whose "keep the complement" semantics don't map to a
 *     CLIP_INSIDE union at all;
 *   • POLYGONS, which a box can only approximate by their screen-space bounding
 *     rect. That approximation used to be defensible — the backend mask was
 *     exact and the bake landed moments later, so the over-hiding was a blink
 *     during an operation the user was already waiting on. A crop's rebuild now
 *     runs in the background, so what a box drew here would be the picture for
 *     as long as that takes: a concave lasso rendered as its bounding box, which
 *     is most of what drawing a lasso was for.
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

  if (region.kind === 'spheres_union') {
    // One axis-aligned box per sphere. The preview clip volume is a box list,
    // so a sphere is approximated by its bounding cube — slightly generous at
    // the corners, but WORLD-space and depth-bounded, unlike the screen-space
    // kinds below. (The label brush previews through the label overlay, not
    // through clip boxes; this branch exists so the shared region vocabulary
    // stays total rather than falling through to the polygon case.)
    return region.centers.map(([x, y, z], i) => {
      const r = region.radii[i] ?? region.radii[0] ?? 1;
      return boxMatrix([x - r, y - r, z - r], [x + r, y + r, z + r]);
    });
  }

  // polygon: not a box. See the note above — the exact shape is applied per
  // point by `pendingDeletesToCropMaskRules`.
  return [];
}

/** Flatten a stack of committed delete regions into one clip-box matrix list. */
export function pendingDeletesToClipBoxes(regions: PendingDeleteRegion[]): THREE.Matrix4[] {
  return regions.flatMap(deleteRegionToClipBoxes);
}

/** Stable identity for one region, so a tile mask is only recomputed when the stack changes. */
function regionKey(region: PendingDeleteRegion, index: number): string {
  if (region.kind === 'box') {
    return `b${index}|${region.min.join(',')}|${region.max.join(',')}`;
  }
  if (region.kind === 'polygon') {
    // The frozen camera is part of the identity: the same pixels under a
    // different view select different points.
    return `p${index}|${region.points.map(pt => `${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join(';')}`
      + `|${region.canvas.width}x${region.canvas.height}|${region.view.map(v => v.toFixed(4)).join(',')}`;
  }
  return `${region.kind}${index}`;
}

/**
 * Per-point mask clauses for the committed deletes that a clip box CANNOT
 * express — i.e. the INVERTED ones.
 *
 * `deleteRegionToClipBoxes` returns [] for those, and that hole is exactly why
 * crop could not use the instant-delete path: a crop is "keep what is inside",
 * which as a delete region is inverted, so the GPU clip union hid nothing and
 * the only way to make the result visible was to rebuild the octree. Running the
 * predicate per point covers it precisely — the same test the backend applied to
 * the session arrays, so the preview matches the committed result by
 * construction rather than by a parallel implementation.
 *
 * Non-inverted regions are deliberately skipped: the clip volume already hides
 * them on the GPU, and testing them again on the CPU would be pure cost.
 *
 * `squares_union` / `spheres_union` (the erase and label brushes) never arrive
 * inverted, so they never reach the predicate branches below.
 */
export function pendingDeletesToCropMaskRules(regions: PendingDeleteRegion[]): CropMaskRule[] {
  const rules: CropMaskRule[] = [];
  regions.forEach((region, index) => {
    // A non-inverted BOX is exactly what the GPU clip volume tests, at frame
    // rate, so leave it there. Everything else that reaches this function is
    // either inverted or a polygon — see deleteRegionToClipBoxes.
    if (!region.invert && region.kind !== 'polygon') return;
    const key = regionKey(region, index);
    // A delete region names the points it REMOVES. As a mask clause the sense
    // flips: `invert: false` keeps what the predicate accepts. So a delete's own
    // `invert` (delete the complement — a crop's keep-inside) becomes a plain
    // keep-inside clause, and a non-inverted delete becomes an inverted clause.
    const maskInvert = !region.invert;
    if (region.kind === 'box') {
      const [minX, minY, minZ] = region.min;
      const [maxX, maxY, maxZ] = region.max;
      rules.push({
        key,
        invert: maskInvert,
        predicate: (wx, wy, wz) =>
          wx >= minX && wx <= maxX && wy >= minY && wy <= maxY && wz >= minZ && wz <= maxZ,
      });
      return;
    }
    if (region.kind === 'polygon') {
      const { projection, view, canvas } = region;
      const canvasSize = { width: canvas.width, height: canvas.height };
      const points = region.points.map(([x, y]) => ({ x, y }));
      const inside = (wx: number, wy: number, wz: number) => {
        const pixel = projectWorldToCanvasPixel({ x: wx, y: wy, z: wz }, projection, view, canvasSize);
        if (!pixel) return false;
        return pointInPolygon(pixel, points);
      };
      // A point BEHIND the camera (or otherwise unprojectable) reads as outside.
      // For a keep-inside crop that is right — it was not in the lasso. For a
      // keep-OUTSIDE crop it is right too, and only by writing the clause this
      // way round: `invert: true` over `inside` keeps it, which matches the
      // backend, whose 2D membership test also excludes it from the delete set.
      rules.push({ key, invert: maskInvert, predicate: inside });
    }
  });
  return rules;
}
