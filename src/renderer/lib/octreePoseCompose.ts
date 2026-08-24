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
}

const ZERO = { x: 0, y: 0, z: 0 } as const;

/** Build the world-frame 4x4 for one (rotation about pivot, then translation). */
function poseToMatrix(
  translation: { x: number; y: number; z: number },
  rotationDeg: { x: number; y: number; z: number },
  pivot: { x: number; y: number; z: number },
): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(rotationDeg.x),
    THREE.MathUtils.degToRad(rotationDeg.y),
    THREE.MathUtils.degToRad(rotationDeg.z),
    'XYZ',
  ));
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  const p = new THREE.Vector3(pivot.x, pivot.y, pivot.z);
  const rp = p.clone().applyMatrix4(m);
  // world_new = R·(world − pivot) + pivot + t, i.e. t_eff = pivot − R·pivot + t.
  return m.setPosition(
    p.x - rp.x + translation.x,
    p.y - rp.y + translation.y,
    p.z - rp.z + translation.z,
  );
}

function isZeroRotation(r: { x: number; y: number; z: number } | null | undefined): boolean {
  return !r || (r.x === 0 && r.y === 0 && r.z === 0);
}

/**
 * Resolve the pose the octree (and its miss shell) should render at.
 *
 * `cacheId` is the cloud's CURRENT octree id; `livePivot` is the pivot the
 * renderer will use (scene origin, else the cloud's bbox centre — see
 * `renderPivot`).
 *
 * Returns the draft unchanged when there is no applicable stored pose, so the
 * overwhelmingly common case costs nothing and behaves exactly as before.
 */
export function composeCloudPose(
  edit: Pick<CloudEditState, 'translation' | 'rotation' | 'storedPose'> | undefined,
  cacheId: string | undefined,
  livePivot: { x: number; y: number; z: number },
): OctreePose {
  const draftT = edit?.translation ?? ZERO;
  const draftR = edit?.rotation ?? ZERO;
  const stored = edit?.storedPose;

  // No stored pose, or it belongs to an octree this cloud no longer has (a
  // rebuild has since folded it into the geometry) → draft only.
  if (!stored || !cacheId || stored.cacheId !== cacheId) {
    return { translation: { ...draftT }, rotation: { ...draftR }, pivot: livePivot };
  }

  const storedM = poseToMatrix(stored.translation, stored.rotation, stored.pivot);

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
 * displayOffset, brush sizing, and skip-optimisations that get safer, not
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
): { min: THREE.Vector3; max: THREE.Vector3 } {
  if (isZeroRotation(rotationDeg)) {
    // Exact: a translated AABB is still an AABB.
    return {
      min: new THREE.Vector3(
        bounds.min.x + translation.x, bounds.min.y + translation.y, bounds.min.z + translation.z),
      max: new THREE.Vector3(
        bounds.max.x + translation.x, bounds.max.y + translation.y, bounds.max.z + translation.z),
    };
  }
  const m = poseToMatrix(translation, rotationDeg, pivot);
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
 * which drops the scene origin metres into the void. So it must be carried
 * through the transform as a POINT, not recomputed from the moved bounding box:
 * `moved.min.z` is the AABB of a rotated OBB of the RAW bounds, and therefore
 * sits below even the un-rotated raw minimum.
 *
 * Transformed at the bbox centre in XY, since a plane's height under a rotation
 * depends on where you sample it and the centre is the honest representative.
 */
export function transformGroundZ(
  groundZ: number,
  boundsCenter: { x: number; y: number },
  translation: { x: number; y: number; z: number },
  rotationDeg: { x: number; y: number; z: number },
  pivot: { x: number; y: number; z: number },
): number {
  if (isZeroRotation(rotationDeg)) return groundZ + translation.z;
  const m = poseToMatrix(translation, rotationDeg, pivot);
  return new THREE.Vector3(boundsCenter.x, boundsCenter.y, groundZ).applyMatrix4(m).z;
}
