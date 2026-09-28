// Where a depth-limited brush sits for one cursor position: the surface of the
// TARGET cloud under the pointer, or nothing.
//
// Pure (no React), so the two properties that went wrong can be tested:
//
//   * The GPU pick used `pickOutsideClipRegion: true`, so it anchored on points
//     the user cannot see: erased, cropped away, or outside the cross-section
//     the stroke is limited to. The stroke then selected nothing visible.
//   * The CPU fallback raycast EVERY point cloud in the scene, so another cloud
//     between the camera and the target captured the anchor, and the sphere sat
//     on the wrong cloud's surface, where the target has no points.

import * as THREE from 'three';

/** The target octree's pick, as potree-core exposes it. */
export interface PickableOctree extends THREE.Object3D {
  pick(
    gl: THREE.WebGLRenderer, camera: THREE.Camera, ray: THREE.Ray,
    opts: { pickWindowSize?: number; pickOutsideClipRegion?: boolean; pixelPosition?: THREE.Vector3 },
  ): { position?: { x: number; y: number; z: number } } | null;
}

export interface BrushAnchorArgs {
  /** The TARGET cloud's octree; the only thing the brush may anchor on. */
  octree: PickableOctree | null;
  gl: THREE.WebGLRenderer;
  camera: THREE.Camera;
  ray: THREE.Ray;
  /** Pick window center in drawing-buffer pixels (see `pickPixelForNdc`). */
  pixelPosition: THREE.Vector3;
  /** Camera-to-cloud distance, which scales the CPU raycast's point threshold. */
  viewDist: number;
  /** The CPU pass is skipped above this many loaded points. */
  cpuPointBudget: number;
  /** Objects that are never anchor targets (the cursor sphere, overlays). */
  isOverlay: (o: THREE.Object3D) => boolean;
}

export function brushAnchorAt(a: BrushAnchorArgs): THREE.Vector3 | null {
  const { octree } = a;
  if (!octree) return null;
  try {
    const hit = octree.pick(a.gl, a.camera, a.ray, {
      pickWindowSize: 17,
      // Visible points only: the clip region is what the user sees (erased and
      // cropped points, and everything outside a cross-section, are clipped).
      pickOutsideClipRegion: false,
      pixelPosition: a.pixelPosition,
    });
    if (hit?.position) return new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z);
  } catch { /* fall through to the CPU pass */ }

  // CPU raycast fallback. The GPU pick can miss a SPARSE cloud entirely, which
  // is the same condition that makes this pass cheap. Only the target's own
  // tiles are candidates.
  const targets: THREE.Object3D[] = [];
  let loaded = 0;
  octree.traverseVisible((o) => {
    const pts = o as THREE.Points;
    if (!pts.isPoints || !pts.geometry || a.isOverlay(o)) return;
    targets.push(o);
    loaded += pts.geometry.getAttribute('position')?.count ?? 0;
  });
  if (targets.length === 0 || loaded > a.cpuPointBudget) return null;
  try {
    const raycaster = new THREE.Raycaster();
    raycaster.ray.copy(a.ray);
    // `camera` is REQUIRED even though the ray is set directly: three's fat
    // lines read raycaster.camera during raycast. Assigned rather than passed to
    // setFromCamera, which would rebuild the ray and break an ortho override.
    raycaster.camera = a.camera;
    for (const frac of [0.02, 0.15]) {
      raycaster.params.Points = { threshold: Math.max(a.viewDist * frac, 1e-9) };
      const hit = raycaster.intersectObjects(targets, false).find((h) => h.object.visible);
      if (hit) return hit.point.clone();
    }
  } catch { /* a raycast failure must not take the renderer down */ }
  // Nothing of the target under the cursor. NULL, not a ray-to-center guess:
  // a guessed depth lands in the gap between surfaces and the stroke silently
  // selects nothing, where refusing to stamp at least hides the cursor.
  return null;
}
