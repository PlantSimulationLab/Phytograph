import type * as THREE from 'three';
import { isSceneOverlay } from './sceneOverlay';

// Marks a group whose meshes the scene-origin picker may snap to (imported /
// reconstructed meshes, QSMs). Declared rather than inferred, for the same
// reason as SCENE_OVERLAY: the click ray also crosses gizmo handles, scan
// markers and the translucent voxel-grid box, none of which are a surface the
// user is aiming at.
//
// Spread onto the group: `<group {...ORIGIN_SNAP_SURFACE}>`.
export const ORIGIN_SNAP_SURFACE = { userData: { originSnapSurface: true } } as const;

function isOriginSnapSurface(obj: THREE.Object3D | null | undefined): boolean {
  for (let o = obj; o; o = o.parent) {
    if (o.userData?.originSnapSurface) return true;
  }
  return false;
}

/**
 * The nearest snappable mesh hit among a click's raycast intersections, or
 * null. Only solid triangles count — a mesh's wireframe/edge lines raycast
 * with a world-unit tolerance, so they would win clicks that visibly missed.
 */
export function nearestSnapSurfaceHit<T extends { object: THREE.Object3D; distance: number }>(
  intersections: readonly T[],
): T | null {
  let best: T | null = null;
  for (const hit of intersections) {
    if (!(hit.object as THREE.Mesh).isMesh) continue;
    if (!hit.object.visible) continue;
    if (isSceneOverlay(hit.object) || !isOriginSnapSurface(hit.object)) continue;
    if (!best || hit.distance < best.distance) best = hit;
  }
  return best;
}
