import * as THREE from 'three';

import { poseFromMatrix } from './octreePoseDecompose';
import type { CloudEditState } from './pointCloudTypes';

/**
 * Combine a cloud's live DRAFT pose with any COMMITTED-but-unrefreshed pose into
 * the single (translation, rotation, pivot) triple the octree renderer takes.
 *
 * Two independent poses can be in play at once:
 *
 *   - `translation` / `rotation` — the Transformation tool's live draft, which
 *     the user is still adjusting and which has NOT been written anywhere.
 *   - `storedPose` — a transform that WAS committed: the session geometry moved,
 *     but the octree was left in its old frame because reindexing it costs a full
 *     PotreeConverter run (~83 s on a 10 M-point scan for a rotation).
 *
 * Both are render-only offsets on the same object, so the drawn result must be
 * draft applied ON TOP OF stored:  M = M_draft · M_stored.
 *
 * ── Why this can't just add the two Eulers ────────────────────────────────
 * Rotations don't commute, and each pose carries its own pivot. Composing as
 * matrices in world space and re-decomposing is the only correct route. The
 * decomposition reuses `poseFromMatrix`, which is already tested against the REAL
 * `applyOctreePose` — do not re-derive that algebra here.
 *
 * ── Why the pivot is re-resolved ──────────────────────────────────────────
 * `storedPose.pivot` is frozen at commit time, but the scene origin can move
 * afterwards (it re-derives when the loaded object set changes). Composing in
 * world space makes the frozen pivot irrelevant to the result: it only ever
 * described how that matrix was built. The output is expressed against
 * `livePivot`, which is the pivot the renderer will actually use.
 *
 * ── The cacheId gate ──────────────────────────────────────────────────────
 * The stored pose is applied ONLY while it matches the cloud's current octree.
 * Any rebuild produces a new id from arrays that already contain the transform,
 * so a mismatch means "already baked in" and the pose must be dropped — which is
 * what keeps every rebuild path (filter, split, segment, bake, refresh...) from
 * having to know this feature exists.
 */
export interface OctreePose {
  translation: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  pivot: { x: number; y: number; z: number };
  /**
   * The full drawn matrix, present ONLY when the pose is not rigid (a scale is
   * in play, from the draft or from a committed stored pose). A scale composed
   * onto a rotation is not expressible as (translation, rotation, pivot), so
   * whenever this is set it is authoritative and the triple above is just the
   * nearest rigid description (kept for keys and readouts). Read it through
   * `poseMatrixOf` rather than branching on it.
   */
  matrix?: THREE.Matrix4;
}

type Vec3 = { x: number; y: number; z: number };

const ZERO = { x: 0, y: 0, z: 0 } as const;

/** True when `s` is absent or exactly (1, 1, 1). */
export function isUnitScale(s: Vec3 | null | undefined): boolean {
  return !s || (s.x === 1 && s.y === 1 && s.z === 1);
}

/**
 * Build the world-frame 4x4 for one draft pose:
 *
 *     M = T(pivot + t) · R_xyz(r) · S(s) · T(−pivot)
 *
 * i.e. scale along the world axes about `pivot`, then rotate about `pivot`,
 * then translate. With `scale` omitted (or unit) this is exactly the rigid
 * "rotation about pivot, then translation" the tool has always drawn.
 */
export function poseToMatrix(
  translation: Vec3,
  rotationDeg: Vec3,
  pivot: Vec3,
  scale?: Vec3 | null,
): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(rotationDeg.x),
    THREE.MathUtils.degToRad(rotationDeg.y),
    THREE.MathUtils.degToRad(rotationDeg.z),
    'XYZ',
  ));
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  if (!isUnitScale(scale)) m.scale(new THREE.Vector3(scale!.x, scale!.y, scale!.z));
  const p = new THREE.Vector3(pivot.x, pivot.y, pivot.z);
  const lp = p.clone().applyMatrix4(m);
  // world_new = L·(world − pivot) + pivot + t, i.e. t_eff = pivot − L·pivot + t.
  return m.setPosition(
    p.x - lp.x + translation.x,
    p.y - lp.y + translation.y,
    p.z - lp.z + translation.z,
  );
}

function isZeroRotation(r: { x: number; y: number; z: number } | null | undefined): boolean {
  return !r || (r.x === 0 && r.y === 0 && r.z === 0);
}

/** The matrix a resolved pose draws at — its affine `matrix` when it has one. */
export function poseMatrixOf(pose: OctreePose): THREE.Matrix4 {
  return pose.matrix
    ? pose.matrix.clone()
    : poseToMatrix(pose.translation, pose.rotation, pose.pivot);
}

/** A committed stored pose as a matrix (its affine `matrix` wins when present). */
function storedPoseMatrix(stored: NonNullable<CloudEditState['storedPose']>): THREE.Matrix4 {
  return stored.matrix
    ? new THREE.Matrix4().fromArray(stored.matrix)
    : poseToMatrix(stored.translation, stored.rotation, stored.pivot);
}

/**
 * Apply one draft pose (rotation about `pivot`, then translation) to a single
 * WORLD point.
 *
 * Same matrix as `transformBoundsAabb` uses on a cloud's corners, so a point
 * that rides along with a cloud (its scanner origin, say) lands exactly where
 * the rendered cloud puts it. Shares `poseToMatrix` rather than re-deriving the
 * rotation-about-a-pivot composition, which is the part that is easy to get
 * subtly wrong.
 */
export function transformPoint(
  point: readonly [number, number, number],
  translation: { x: number; y: number; z: number },
  rotationDeg: { x: number; y: number; z: number },
  pivot: { x: number; y: number; z: number },
  scale?: Vec3 | null,
): [number, number, number] {
  if (isZeroRotation(rotationDeg) && isUnitScale(scale)) {
    return [point[0] + translation.x, point[1] + translation.y, point[2] + translation.z];
  }
  const v = new THREE.Vector3(point[0], point[1], point[2])
    .applyMatrix4(poseToMatrix(translation, rotationDeg, pivot, scale));
  return [v.x, v.y, v.z];
}

/**
 * The exact inverse of `transformPoint`: take a point that is currently drawn
 * under (rotation about `pivot`, then translation) back to its pose-free
 * position.
 *
 * ── Why this cannot negate the Euler angles ───────────────────────────────
 * `R_XYZ(−rx, −ry, −rz)` is the inverse of `R_XYZ(rx, ry, rz)` ONLY when at
 * most one axis is non-zero — negating the angles undoes each rotation but
 * leaves them applied in the SAME order, whereas an inverse must also reverse
 * the order (the inverse of X·Y·Z is Z⁻¹·Y⁻¹·X⁻¹). For r = (30°, 40°, 50°) the
 * naive version round-trips (1, 2, 3) to (−1.44, 1.05, 3.29).
 *
 * Inverting the matrix sidesteps the ordering question entirely, and reuses the
 * same `poseToMatrix` the forward direction uses, so the two cannot drift.
 */
export function unposePoint(
  point: readonly [number, number, number],
  translation: { x: number; y: number; z: number },
  rotationDeg: { x: number; y: number; z: number },
  pivot: { x: number; y: number; z: number },
  scale?: Vec3 | null,
): [number, number, number] {
  if (isZeroRotation(rotationDeg) && isUnitScale(scale)) {
    return [point[0] - translation.x, point[1] - translation.y, point[2] - translation.z];
  }
  const inv = poseToMatrix(translation, rotationDeg, pivot, scale).invert();
  const v = new THREE.Vector3(point[0], point[1], point[2]).applyMatrix4(inv);
  return [v.x, v.y, v.z];
}

/**
 * Resolve the pose the octree (and its miss shell) should render at.
 *
 * `cacheId` is the cloud's CURRENT octree id; `livePivot` is the pivot the
 * renderer will use (scene origin, else the cloud's bbox center — see
 * `renderPivot`).
 *
 * Returns the draft unchanged when there is no applicable stored pose, so the
 * overwhelmingly common case costs nothing and behaves exactly as before.
 */
export function composeCloudPose(
  edit: Pick<CloudEditState, 'translation' | 'rotation' | 'scale' | 'storedPose'> | undefined,
  cacheId: string | undefined,
  livePivot: { x: number; y: number; z: number },
): OctreePose {
  const draftT = edit?.translation ?? ZERO;
  const draftR = edit?.rotation ?? ZERO;
  const draftS = edit?.scale;
  const stored = edit?.storedPose;
  const storedApplies = !!stored && !!cacheId && stored.cacheId === cacheId;

  // A SCALE anywhere (draft or committed) makes the pose affine, which the
  // (translation, rotation, pivot) triple cannot describe — so compose as
  // matrices and hand the renderer the matrix itself.
  if (!isUnitScale(draftS) || (storedApplies && !!stored!.matrix)) {
    const draftM = poseToMatrix(draftT, draftR, livePivot, draftS);
    const composed = storedApplies ? draftM.multiply(storedPoseMatrix(stored!)) : draftM;
    const p = poseFromMatrix(composed, livePivot);
    return { translation: p.translation, rotation: p.rotation, pivot: livePivot, matrix: composed };
  }

  // No stored pose, or it belongs to an octree this cloud no longer has (a
  // rebuild has since folded it into the geometry) → draft only.
  if (!storedApplies) {
    return { translation: { ...draftT }, rotation: { ...draftR }, pivot: livePivot };
  }

  const storedM = storedPoseMatrix(stored!);

  // Draft is identity → the stored pose is the whole answer, but it still has to
  // be re-expressed against the live pivot.
  if (!isZeroRotation(draftR) || draftT.x !== 0 || draftT.y !== 0 || draftT.z !== 0) {
    const draftM = poseToMatrix(draftT, draftR, livePivot);
    // Draft applied AFTER stored.
    const composed = draftM.multiply(storedM);
    const p = poseFromMatrix(composed, livePivot);
    return { translation: p.translation, rotation: p.rotation, pivot: livePivot };
  }

  const p = poseFromMatrix(storedM, livePivot);
  return { translation: p.translation, rotation: p.rotation, pivot: livePivot };
}

/**
 * The `storedPose` to record after committing a draft on top of whatever pose
 * already stands in for the octree: the TOTAL displacement from the octree's
 * frame. Rigid results keep the (translation, rotation, pivot) form every older
 * reader understands; an affine one also carries its `matrix`, which then wins.
 */
export function commitStoredPose(
  edit: Pick<CloudEditState, 'translation' | 'rotation' | 'scale' | 'storedPose'>,
  cacheId: string,
  pivot: { x: number; y: number; z: number },
): NonNullable<CloudEditState['storedPose']> {
  const pose = composeCloudPose(edit, cacheId, pivot);
  return {
    translation: pose.translation,
    rotation: pose.rotation,
    pivot: { ...pivot },
    cacheId,
    ...(pose.matrix ? { matrix: pose.matrix.toArray() } : {}),
  };
}

/**
 * True when this cloud is currently being drawn through a stored pose — i.e. its
 * octree is behind its geometry.
 *
 * Drives the "display is behind" affordance and the region-edit chokepoint.
 */
export function hasStoredPose(
  edit: Pick<CloudEditState, 'storedPose'> | undefined,
  cacheId: string | undefined,
): boolean {
  const s = edit?.storedPose;
  return !!s && !!cacheId && s.cacheId === cacheId;
}

/**
 * The world-space AABB of `bounds` after a rigid transform.
 *
 * Rotates the box's 8 corners about `pivot` and re-bounds them. The result is a
 * LOOSE box for a rotated input (an AABB of an OBB) — that is inherent, and it is
 * why the consumers are all "roughly where is this thing" readers: framing, zoom,
 * displayOffset, brush sizing, and skip-optimizations that get safer, not
 * riskier, as the box grows.
 *
 * Shared by the committed-bounds update and the `data-scan-bounds` E2E attribute
 * so the two can never disagree about what a transformed extent is.
 */
export function transformBoundsAabb(
  bounds: { min: THREE.Vector3; max: THREE.Vector3 },
  translation: { x: number; y: number; z: number },
  rotationDeg: { x: number; y: number; z: number },
  pivot: { x: number; y: number; z: number },
  scale?: Vec3 | null,
): { min: THREE.Vector3; max: THREE.Vector3 } {
  if (isZeroRotation(rotationDeg) && isUnitScale(scale)) {
    // Exact: a translated AABB is still an AABB.
    return {
      min: new THREE.Vector3(
        bounds.min.x + translation.x, bounds.min.y + translation.y, bounds.min.z + translation.z),
      max: new THREE.Vector3(
        bounds.max.x + translation.x, bounds.max.y + translation.y, bounds.max.z + translation.z),
    };
  }
  return transformAabbByMatrix(bounds, poseToMatrix(translation, rotationDeg, pivot, scale));
}

/** The AABB of `bounds`' 8 corners pushed through an arbitrary affine `m`. */
export function transformAabbByMatrix(
  bounds: { min: THREE.Vector3; max: THREE.Vector3 },
  m: THREE.Matrix4,
): { min: THREE.Vector3; max: THREE.Vector3 } {
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
  const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const v = new THREE.Vector3();
  for (const cx of [bounds.min.x, bounds.max.x]) {
    for (const cy of [bounds.min.y, bounds.max.y]) {
      for (const cz of [bounds.min.z, bounds.max.z]) {
        v.set(cx, cy, cz).applyMatrix4(m);
        lo.min(v);
        hi.max(v);
      }
    }
  }
  return { min: lo, max: hi };
}

/**
 * Where a cloud's `groundZ` ends up after a rigid transform.
 *
 * `groundZ` is an outlier-RESISTANT low-Z percentile, not a minimum — its whole
 * reason for existing is that the raw minimum is set by a single stray return,
 * which drops the scene origin meters into the void. So it must be carried
 * through the transform as a POINT, not recomputed from the moved bounding box:
 * `moved.min.z` is the AABB of a rotated OBB of the RAW bounds, and therefore
 * sits below even the un-rotated raw minimum.
 *
 * Transformed at the bbox center in XY, since a plane's height under a rotation
 * depends on where you sample it and the center is the honest representative.
 */
export function transformGroundZ(
  groundZ: number,
  boundsCenter: { x: number; y: number },
  translation: { x: number; y: number; z: number },
  rotationDeg: { x: number; y: number; z: number },
  pivot: { x: number; y: number; z: number },
  scale?: Vec3 | null,
): number {
  if (isZeroRotation(rotationDeg) && isUnitScale(scale)) return groundZ + translation.z;
  const m = poseToMatrix(translation, rotationDeg, pivot, scale);
  return new THREE.Vector3(boundsCenter.x, boundsCenter.y, groundZ).applyMatrix4(m).z;
}
