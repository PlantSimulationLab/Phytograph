import * as THREE from 'three';

/**
 * Express a rigid world-frame matrix as the (translation, rotation) pair the
 * octree render path consumes.
 *
 * ── The problem ───────────────────────────────────────────────────────────
 * `applyOctreePose` does not take a matrix. It takes a Euler rotation in
 * DEGREES applied about a PIVOT, plus a translation, and renders
 *
 *     world_rendered = R·(world − pivot) + pivot + translation
 *
 * A deferred bake needs the drawn cloud to sit exactly where the queued matrix
 * will put it, so the matrix has to be re-expressed in that form. Expanding the
 * matrix form `world_new = R·world + t` and matching terms gives
 *
 *     translation = t − (pivot − R·pivot)
 *
 * with the same R in both. The pivot term is NOT optional: it is what the render
 * path adds back after rotating, so omitting it displaces the cloud by
 * `pivot − R·pivot` — zero only when the rotation is identity or the pivot is
 * the origin. On a UTM-scale scene, where the pivot is thousands of metres from
 * the origin, that error is enormous.
 *
 * The pivot MUST therefore be the one the renderer will actually use (the scene
 * origin, else the cloud's bbox centre) — see the `pivot` prop in
 * PointCloudViewer's octree branch. Passing a different pivot here silently
 * draws the cloud in the wrong place until the bake lands and snaps it.
 *
 * Composition note: this replaces any existing draft rather than adding to it.
 * Callers fold the prior draft translation into the matrix first (ICP does), so
 * re-applying it here would double it.
 */
export function poseFromMatrix(
  matrix: THREE.Matrix4,
  pivot: { x: number; y: number; z: number },
): { translation: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } } {
  const t = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  matrix.decompose(t, q, s);

  // R·pivot, rotation only — the translation column is already in `t`.
  const p = new THREE.Vector3(pivot.x, pivot.y, pivot.z);
  const rotatedPivot = p.clone().applyQuaternion(q);
  const translation = t.clone().add(rotatedPivot).sub(p);

  // applyOctreePose builds its Euler with the default 'XYZ' order, so read it
  // back the same way or a composed rotation comes out mirrored.
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return {
    translation: { x: translation.x, y: translation.y, z: translation.z },
    rotation: {
      x: THREE.MathUtils.radToDeg(e.x),
      y: THREE.MathUtils.radToDeg(e.y),
      z: THREE.MathUtils.radToDeg(e.z),
    },
  };
}

/**
 * The world-space pivot the octree renderer will use for `cloudId`.
 *
 * Mirrors the `pivot` prop in PointCloudViewer's octree branch. Kept next to
 * `poseFromMatrix` because the two MUST agree — a decomposition against a
 * different pivot than the renderer uses puts the cloud in the wrong place.
 */
export function renderPivot(
  sceneOrigin: [number, number, number] | null | undefined,
  boundsCenter: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return sceneOrigin
    ? { x: sceneOrigin[0], y: sceneOrigin[1], z: sceneOrigin[2] }
    : { x: boundsCenter.x, y: boundsCenter.y, z: boundsCenter.z };
}
