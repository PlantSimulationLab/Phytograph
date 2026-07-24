import * as THREE from 'three';
import type { PointCloudOctree } from 'potree-core';

// Apply the render-only Transformation-tool pose to a PointCloudOctree that is
// attached to the scene root. `base` is the loader's per-cloud world offset (the
// octree stores points relative to it, so the object matrix maps local → world =
// base + local). The rendered result is:
//     R·(world − pivot) + pivot + translation − displayOffset
// A pure translation collapses to a position write, but a rotation about a pivot
// can't — so we compose the full 4x4 and set it with matrixAutoUpdate = false.
// Shared by the hits octree (OctreePointCloud) and the miss shell (MissOctree) so
// the two stay locked together under the tool. The scratch objects are
// module-level to avoid per-frame allocation on drags.
const _poseM = new THREE.Matrix4();
const _poseTmp = new THREE.Matrix4();
const _poseQuat = new THREE.Quaternion();
const _poseEuler = new THREE.Euler();

export function applyOctreePose(
  pco: PointCloudOctree,
  base: THREE.Vector3,
  translation?: { x: number; y: number; z: number } | null,
  rotation?: { x: number; y: number; z: number } | null,
  pivot?: { x: number; y: number; z: number } | null,
  displayOffset?: { x: number; y: number; z: number } | null,
) {
  const t = translation ?? { x: 0, y: 0, z: 0 };
  const o = displayOffset ?? { x: 0, y: 0, z: 0 };
  const hasRotation = !!rotation && (rotation.x !== 0 || rotation.y !== 0 || rotation.z !== 0);
  if (!hasRotation) {
    // Fast path: pure translation is a position write (matrixAutoUpdate stays on).
    pco.matrixAutoUpdate = true;
    pco.position.set(base.x + t.x - o.x, base.y + t.y - o.y, base.z + t.z - o.z);
    pco.updateMatrix();
    return;
  }
  const p = pivot ?? { x: 0, y: 0, z: 0 };
  // M = T(pivot + t − offset) · R · T(−pivot) · T(base)
  _poseEuler.set(
    THREE.MathUtils.degToRad(rotation!.x),
    THREE.MathUtils.degToRad(rotation!.y),
    THREE.MathUtils.degToRad(rotation!.z),
    'XYZ',
  );
  _poseQuat.setFromEuler(_poseEuler);
  _poseM.makeTranslation(p.x + t.x - o.x, p.y + t.y - o.y, p.z + t.z - o.z);
  _poseM.multiply(_poseTmp.makeRotationFromQuaternion(_poseQuat));
  _poseM.multiply(_poseTmp.makeTranslation(-p.x, -p.y, -p.z));
  _poseM.multiply(_poseTmp.makeTranslation(base.x, base.y, base.z));
  pco.matrixAutoUpdate = false;
  pco.matrix.copy(_poseM);
  // Keep position/quaternion in sync (some potree read paths use them for
  // culling/pick).
  pco.matrix.decompose(pco.position, pco.quaternion, pco.scale);
}
