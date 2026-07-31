// Camera zoom limits derived from the scene's ROBUST extent.
//
// Why not the raw AABB: a LiDAR scene routinely carries a handful of far
// outliers — a stray return a kilometre out, a mis-registered scan, a scanner
// marker parked far from the data. The raw bounding box is set by exactly those
// points, so limits scaled from it are wrong for the 99.9% of the scene the user
// is actually looking at: `maxDistance` lands inside the real content and
// `minDistance` never gets small enough to inspect a leaf.
//
// The real answer is a per-axis PERCENTILE span, which needs the points and so
// can only be computed backend-side at import: that is `robustExtent`
// (`_robust_extent` in main.py), and it is what this uses whenever it is
// present. It handles the case nothing derived from an AABB can — strays on all
// three axes at once, which inflate every extent and leave no clean axis behind.
//
// Without it (mesh-only scene, renderer-side synthetic data, an older cloud) we
// fall back to a heuristic over the AABB: take the MEDIAN axis rather than the
// diagonal or the max. An outlier typically inflates one or two axes — a distant
// point in XY leaves Z alone; a sky point blows up Z and leaves the footprint
// alone — so the median discards the worst offender. `groundZ` (a backend-side
// low-Z percentile) tightens the Z axis further. This is strictly worse than the
// percentile extent and is only a floor under the degenerate cases.
//
// The result is only ever used for zoom CLAMPS, so being off by a factor of two
// is harmless; being off by the factor of 1000 a sky point introduces is not.

import * as THREE from 'three';

export interface SceneScaleInput {
  min: THREE.Vector3;
  max: THREE.Vector3;
  // Robust ground level (low Z percentile) when the scene has one. Used in place
  // of min.z so a sub-terrain noise point doesn't inflate the vertical axis.
  groundZ?: number;
  // Per-axis percentile extent [dx, dy, dz] from the backend, when available.
  // Preferred over anything derivable from min/max — see the module comment.
  robustExtent?: [number, number, number];
}

export interface ZoomLimits {
  /** Representative scene size, in world units. */
  scale: number;
  /** OrbitControls minDistance — how close the camera may get to its target. */
  minDistance: number;
  /** OrbitControls maxDistance — how far it may pull back. */
  maxDistance: number;
}

// Below this the scene is degenerate (empty, or a single point) and any derived
// limit is meaningless; fall back to a 1-unit scene so the camera still works.
const MIN_SCALE = 1e-6;

/**
 * Representative scene size that a few far outliers can't dominate.
 *
 * Uses the backend's per-axis percentile extent when the scene has one. Falls
 * back to the median of the three AABB axis extents: with one inflated axis the
 * median is the larger of the two clean axes, and with two inflated axes it
 * still discards the worst one. On a clean scene all three axes agree, so the
 * median is simply the scene size.
 */
export function robustSceneScale({ min, max, groundZ, robustExtent }: SceneScaleInput): number {
  // Preferred path: a real percentile span, immune to outliers on every axis.
  // Take the largest axis of it — unlike the AABB fallback there is nothing left
  // to be defensive about, and the biggest real dimension is the scale the
  // camera has to cover.
  if (robustExtent) {
    const largest = Math.max(...robustExtent.filter((e) => isFinite(e) && e > 0));
    if (isFinite(largest) && largest > MIN_SCALE) return largest;
  }

  // Prefer the robust floor over the raw minimum, but only when it is actually
  // inside the box — a groundZ above max.z (mesh-only scene, stale value) would
  // produce a negative extent.
  const lowZ = (typeof groundZ === 'number' && isFinite(groundZ) && groundZ < max.z)
    ? Math.max(groundZ, min.z)
    : min.z;

  const extents = [max.x - min.x, max.y - min.y, max.z - lowZ]
    .map((e) => (isFinite(e) && e > 0 ? e : 0))
    .sort((a, b) => a - b);

  // Median axis. If the two smaller axes are degenerate (a planar or linear
  // scene — a single scan line, a flat DEM), fall back to the largest non-zero
  // axis rather than reporting zero.
  const median = extents[1];
  const scale = median > MIN_SCALE ? median : extents[2];
  return scale > MIN_SCALE ? scale : 1;
}

/**
 * Zoom clamps scaled to the scene.
 *
 * The constants are ratios, not absolutes, which is the whole point: a
 * 0.3 m potted plant and a 400 m UTM plot both get limits that let the user
 * inspect fine detail and pull back to see everything.
 *
 * - minDistance = scale/1e4 — far below any feature the user could resolve, so
 *   the near limit is effectively never the thing that stops a zoom. The real
 *   near-field protection is the surface-aware clamp in the zoom-to-cursor path
 *   (`clampDollyToSurface`), which knows where the geometry actually is; this is
 *   only the backstop that keeps the camera from reaching its target exactly
 *   (where OrbitControls' orbit basis degenerates).
 * - maxDistance = scale*40 — comfortably outside the content (the auto-frame sits
 *   at roughly 2x the scene size) while still bounded, so a fast scroll-out can't
 *   fling the camera into deep space where the scene is a sub-pixel dot.
 */
export function zoomLimits(bounds: SceneScaleInput): ZoomLimits {
  const scale = robustSceneScale(bounds);
  return {
    scale,
    minDistance: scale / 1e4,
    maxDistance: scale * 40,
  };
}

/**
 * Limit a dolly step so the camera stops short of the surface it is flying at
 * instead of tunnelling through it.
 *
 * `distanceToSurface` is the distance from the camera to the geometry under the
 * cursor along the view ray; `step` is the requested forward movement (positive
 * = toward the surface). The camera is allowed to close all but `stopFraction`
 * of the remaining gap, so approach is asymptotic: every scroll gets closer, and
 * you can inspect a surface arbitrarily closely, but you never pop through to
 * the far side. Backward steps pass through untouched — pulling away is always
 * safe.
 */
export function clampDollyToSurface(
  step: number,
  distanceToSurface: number,
  stopFraction = 0.02,
): number {
  if (step <= 0) return step;
  if (!isFinite(distanceToSurface) || distanceToSurface <= 0) return step;
  return Math.min(step, distanceToSurface * (1 - stopFraction));
}
