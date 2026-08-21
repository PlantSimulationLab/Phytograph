// Constant-on-screen-size helper for viewport overlays (the scene-origin marker
// and its translation gizmo).
//
// Both need to occupy a FIXED number of pixels no matter where the camera is —
// otherwise an overlay is a giant blob up close and an invisible dot far away.
// The conversion is "how many world units does one screen pixel span at this
// point", which depends on the projection:
//
//   perspective  — the frustum widens with distance, so it's a function of the
//                  vertical FOV and the point's distance from the camera.
//   orthographic — the frustum is fixed, so distance is irrelevant; only the
//                  vertical extent and the zoom matter.
//
// Kept free of three.js *classes* (it only reads plain fields) so it's directly
// unit-testable without a renderer.

import { isOrthographicProjection } from './cameraRay';

/** Minimal camera shape this needs — satisfied by both THREE camera classes. */
export interface ScreenScaleCamera {
  isPerspectiveCamera?: boolean;
  /** Vertical field of view in DEGREES (perspective only). */
  fov?: number;
  /** Frustum top/bottom in world units (orthographic only). */
  top?: number;
  bottom?: number;
  zoom?: number;
  /**
   * The live projection matrix. When present it DECIDES which branch runs, in
   * preference to `isPerspectiveCamera`.
   *
   * The ortho overrides (SectionProjectionOverride, OrthoProjectionOverride)
   * write `camera.projectionMatrix` directly on a camera that remains a
   * PerspectiveCamera instance, so the class flag stays true while the actual
   * projection is orthographic. Trusting the flag took the perspective branch
   * and scaled overlays by distance-from-camera — meaningless under ortho, and
   * visibly wrong in a cross-section, where the camera is pulled well back from
   * the slab and the origin marker inflated with that distance.
   *
   * Same trap `cameraRay.ts` documents for `Raycaster.setFromCamera`.
   */
  projectionMatrix?: { elements: ArrayLike<number> };
}

export interface Vec3Readonly {
  x: number;
  y: number;
  z: number;
}

/**
 * World units spanned by one screen pixel at `point`.
 *
 * @param camera          the active camera (perspective or orthographic)
 * @param cameraPosition  the camera's world position (ignored for ortho)
 * @param viewportHeight  canvas height in pixels
 * @param point           the world point to measure at (ignored for ortho)
 * @returns a positive, finite scale, or 0 when the inputs can't produce one
 *          (zero-height viewport, degenerate frustum, non-finite coordinates).
 */
export function worldPerPixel(
  camera: ScreenScaleCamera,
  cameraPosition: Vec3Readonly,
  viewportHeight: number,
  point: Vec3Readonly,
): number {
  if (!(viewportHeight > 0) || !isFinite(viewportHeight)) return 0;

  // The matrix is authoritative when we have it: an override can make a
  // PerspectiveCamera project orthographically without changing the flag.
  const elements = camera.projectionMatrix?.elements;
  const orthoByMatrix = elements ? isOrthographicProjection(elements) : false;

  if (elements && orthoByMatrix) {
    // Read the frustum height straight off the matrix. P[5] = 2 / (top - bottom)
    // with the zoom already folded in, so this stays correct for an override
    // that never touches camera.top/bottom/zoom — which is exactly the case
    // that made this function wrong.
    const p5 = elements[5];
    if (!(Math.abs(p5) > 0)) return 0;
    const s = 2 / Math.abs(p5) / viewportHeight;
    return isFinite(s) && s > 0 ? s : 0;
  }

  let scale: number;
  if (camera.isPerspectiveCamera && !orthoByMatrix) {
    const fov = camera.fov ?? 0;
    if (!(fov > 0) || fov >= 180) return 0;
    const dx = point.x - cameraPosition.x;
    const dy = point.y - cameraPosition.y;
    const dz = point.z - cameraPosition.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    scale = (2 * Math.tan(((fov * Math.PI) / 180) / 2) * dist) / viewportHeight;
  } else {
    const top = camera.top ?? 0;
    const bottom = camera.bottom ?? 0;
    const zoom = camera.zoom ?? 1;
    if (!(zoom > 0)) return 0;
    scale = (top - bottom) / zoom / viewportHeight;
  }

  return isFinite(scale) && scale > 0 ? scale : 0;
}
