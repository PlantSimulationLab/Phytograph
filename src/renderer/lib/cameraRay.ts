// Camera ray + projection-kind helpers shared by every screen-space gizmo.
//
// Both of these exist because of one fact about this app: **the projection
// matrix and the camera INSTANCE can disagree.** `OrthoProjectionOverride`
// (and its section-view sibling) overwrite a `PerspectiveCamera`'s
// `projectionMatrix` in place rather than swapping the camera class, so
// `camera.isPerspectiveCamera` stays true while the matrix is orthographic.
//
// Anything that branches on the camera instance — including
// `THREE.Raycaster.setFromCamera` — is therefore wrong under the override.
// Branch on the MATRIX instead, via the two functions here.
//
// Pure + stateless apart from the THREE math types, following cropGeometry.ts's
// precedent, so this is unit-testable without a GL context.
import * as THREE from 'three';

export type ProjectionKind = 'orthographic' | 'perspective';

// Tolerance for the matrix probe. The two projections differ by ~1 in these
// slots, so anything this side of a rounding error is unambiguous.
const PROJECTION_EPSILON = 1e-6;

/**
 * Which projection a 16-element column-major projection matrix encodes.
 *
 * Orthographic keeps the bottom row (0,0,0,1), so m[15] ≈ 1 and m[11] ≈ 0.
 * Perspective puts the w-divide there: m[15] ≈ 0 and m[11] ≈ -1.
 *
 * Takes raw elements (not a camera) so it works equally on a live
 * `camera.projectionMatrix.elements` and on the frozen `projection` array
 * captured into a crop/erase region — which is exactly what the
 * `data-*-projection-kind` E2E diagnostics assert on.
 */
export function projectionKindOf(elements: ArrayLike<number>): ProjectionKind {
  const isOrtho =
    Math.abs(elements[15] - 1) < PROJECTION_EPSILON &&
    Math.abs(elements[11]) < PROJECTION_EPSILON;
  return isOrtho ? 'orthographic' : 'perspective';
}

/** True when the matrix encodes an orthographic projection. */
export function isOrthographicProjection(elements: ArrayLike<number>): boolean {
  return projectionKindOf(elements) === 'orthographic';
}

/**
 * Build the pick ray through a normalized-device-coordinate point.
 *
 * MUST be used instead of `THREE.Raycaster.setFromCamera` anywhere the ortho
 * override may be active. `setFromCamera` dispatches on
 * `camera.isPerspectiveCamera`, which the override leaves true — so it applies
 * perspective ray math (all rays through the eye) to an orthographic matrix and
 * every pick collapses toward the view center.
 *
 * Construction, straight from the (possibly overridden) matrices:
 *   origin    = unproject (ndc.x, ndc.y, -1) through projectionMatrixInverse
 *               then the camera world matrix — the near-plane point under the
 *               cursor.
 *   direction = the camera's forward (-Z) in world space.
 *
 * Under ortho this is the correct parallel ray. Under a genuine perspective
 * matrix it still picks correctly: the origin lands on the near plane under the
 * cursor and the direction points into the scene.
 *
 * NOTE `projectionMatrixInverse` must be current. `OrthoProjectionOverride`
 * updates it alongside `projectionMatrix` for exactly this reason; a new
 * override component must do the same or every ray here is stale.
 */
export function rayForNdc(
  camera: THREE.Camera,
  ndc: { x: number; y: number },
  target?: THREE.Ray,
): THREE.Ray {
  const ray = target ?? new THREE.Ray();
  ray.origin
    .set(ndc.x, ndc.y, -1)
    .applyMatrix4(camera.projectionMatrixInverse)
    .applyMatrix4(camera.matrixWorld);
  ray.direction.set(0, 0, -1).transformDirection(camera.matrixWorld).normalize();
  return ray;
}

/**
 * World units per canvas pixel, in X and Y, at `worldPoint`.
 *
 * Orthographic is constant (P[0] = 2/(r-l), P[5] = 2/(t-b)); perspective grows
 * with distance from the eye (P[5] = 1/tan(fov/2), so the world height at
 * distance d is 2d/P[5]). Branches on the MATRIX, per this module's premise.
 *
 * `worldPoint` is ignored in the orthographic case and may be anything.
 */
export function worldPerPixelAt(
  camera: THREE.Camera,
  worldPoint: THREE.Vector3,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  const P = camera.projectionMatrix.elements;
  if (canvasWidth <= 0 || canvasHeight <= 0) return { x: 0, y: 0 };
  if (isOrthographicProjection(P)) {
    return {
      x: P[0] !== 0 ? 2 / P[0] / canvasWidth : 0,
      y: P[5] !== 0 ? 2 / P[5] / canvasHeight : 0,
    };
  }
  const dist = Math.max(worldPoint.distanceTo(camera.position), 1e-3);
  return {
    x: P[0] !== 0 ? (2 * dist) / P[0] / canvasWidth : 0,
    y: P[5] !== 0 ? (2 * dist) / P[5] / canvasHeight : 0,
  };
}
