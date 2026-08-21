import type * as THREE from 'three';

// Marks an in-scene object as a UI OVERLAY rather than scene content.
//
// Overlays are things drawn to help the user manipulate the scene — the crop
// box's faint fill, transform gizmo handles, the erase brush, the origin
// marker, invisible click-target planes. They are real raycastable geometry, so
// anything that asks "what is under the cursor?" will hit them, but they are
// not data and must not be treated as such.
//
// The concrete bug this exists for: the crop box renders a full-volume mesh at
// `opacity 0.05` around the crop region. Zoom-to-cursor's depth probe raycast
// the scene, hit that nearly-invisible face before reaching the points inside
// it, and anchored the camera there — so zooming inside the crop preview
// converged on a flat plane instead of on the cloud, which felt exactly like
// the old pre-zoom-to-cursor behavior. Filtering on transparency alone doesn't
// work (0.05 is visible, and content can be transparent too); the distinction
// is intent, so it is declared rather than inferred.
//
// Spread onto the mesh/group: `<mesh {...SCENE_OVERLAY}>`.
export const SCENE_OVERLAY = { userData: { sceneOverlay: true } } as const;

/**
 * True when `obj` — or any ancestor — is marked as a UI overlay.
 *
 * Walks up the parent chain because overlays are usually a `<group>` wrapping
 * several meshes (gizmo shaft + head + hitbox), and the marker belongs on the
 * group rather than repeated on every child.
 */
export function isSceneOverlay(obj: THREE.Object3D | null | undefined): boolean {
  for (let o = obj; o; o = o.parent) {
    if (o.userData?.sceneOverlay) return true;
  }
  return false;
}
