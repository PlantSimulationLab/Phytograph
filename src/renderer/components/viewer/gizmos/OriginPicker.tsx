import { useEffect, useRef } from 'react';
import { useFrame, useThree, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { PointCloudOctree } from 'potree-core';
import { pickAcrossOctrees } from '../../../lib/octreeMultiPick';
import { SCENE_OVERLAY } from '../../../lib/sceneOverlay';
import { nearestSnapSurfaceHit } from '../../../lib/originSnapSurface';
import { OCTREE_PICK_WINDOW_PX, makeInflatePickSplat } from '../../../lib/octreePickSplat';

// Click target for placing the scene origin (the CloudCompare-style pivot).
// While mounted (origin place-mode armed), a left-click prefers a SURFACE hit on
// the nearest visible octree cloud (potree-core `Potree.pick`, so the origin
// snaps to a real point like CloudCompare's point-pick) or on a mesh / QSM
// surface, whichever is nearer the camera, falling back to a ground-plane
// intersection when the ray misses both. The hit is
// converted from DISPLAY space (the scene renders at world − displayOffset; the
// octrees are attached to the scene root at that offset, so picks come back in
// display coords) to WORLD and reported via onPick. Only mounted while placing —
// otherwise it would intercept every click.
//
// The origin is scene-wide, so this picks across every visible cloud rather
// than only the selected one. Scoping it to the selection meant that with
// nothing selected there was no surface to snap to AND no floor to fall back
// on, so every click landed on z = 0 — tens of meters below a georeferenced
// scan whose ground sits at +60 m.
export function OriginPicker({
  octrees,
  groundZ,
  displayOffset,
  onPick,
}: {
  // Live octrees of the visible clouds. Projected-miss octrees are never
  // registered, so a sky point ~1 km out can't win the pick. Flat clouds have
  // no octree and are reached only through the ground plane.
  octrees: PointCloudOctree[];
  // Ground-plane Z in DISPLAY space (fallback when no surface is hit).
  groundZ: number;
  displayOffset: { x: number; y: number; z: number };
  // Reports the picked point in WORLD coordinates.
  onPick: (world: [number, number, number]) => void;
}) {
  const { gl, camera } = useThree();

  useEffect(() => {
    gl.domElement.style.cursor = 'crosshair';
    return () => { gl.domElement.style.cursor = 'auto'; };
  }, [gl]);

  // The click target is a camera-facing plane held just in front of the
  // camera, so EVERY viewport ray crosses it. A plane lying on the ground is
  // missed by any ray at or above the horizon — exactly the rays that reach a
  // canopy mesh seen from a low viewpoint.
  const targetRef = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const target = targetRef.current;
    if (!target) return;
    camera.getWorldDirection(target.position).add(camera.position);
    target.quaternion.copy(camera.quaternion);
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    // Orbit-drag that ended over the viewport is not a pick.
    if (e.delta > 4) return;
    const report = (p: { x: number; y: number; z: number }) => {
      e.stopPropagation();
      onPick([p.x + displayOffset.x, p.y + displayOffset.y, p.z + displayOffset.z]);
    };
    // Mesh / QSM surface under the cursor. Their groups carry click handlers,
    // so R3F already raycast them for this event (display space, like the
    // octree picks).
    const meshHit = nearestSnapSurfaceHit(e.intersections);
    // Surface snap: pick against the octrees along the event ray.
    if (octrees.length > 0) {
      try {
        const hit = pickAcrossOctrees(octrees, gl, camera, e.ray, {
          pickWindowSize: OCTREE_PICK_WINDOW_PX,
          pickOutsideClipRegion: true,
          // Without this a point is only pickable where its 1-px splat covered
          // a pixel, so density rather than aim decided whether the click
          // snapped. See lib/octreePickSplat.
          onBeforePickRender: makeInflatePickSplat(gl.getPixelRatio()),
        }) as { position?: { x: number; y: number; z: number } } | null;
        if (hit?.position) {
          // A mesh in front of the cloud point is what the user clicked on.
          const cloudDistance = new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z)
            .sub(e.ray.origin).dot(e.ray.direction);
          report(meshHit && meshHit.distance < cloudDistance ? meshHit.point : hit.position);
          return;
        }
      } catch { /* fall through to the mesh hit / ground plane */ }
    }
    if (meshHit) {
      report(meshHit.point);
      return;
    }
    // Ground-plane fallback: intersect the ray with z = groundZ (display space).
    const ray = e.ray;
    if (Math.abs(ray.direction.z) < 1e-6) return;
    const t = (groundZ - ray.origin.z) / ray.direction.z;
    if (!isFinite(t)) return;
    e.stopPropagation();
    onPick([
      ray.origin.x + t * ray.direction.x + displayOffset.x,
      ray.origin.y + t * ray.direction.y + displayOffset.y,
      groundZ + displayOffset.z,
    ]);
  };

  return (
    // UI overlay, not content — see lib/sceneOverlay.ts.
    <mesh ref={targetRef} {...SCENE_OVERLAY} onClick={handleClick} renderOrder={9999}>
      <planeGeometry args={[100000, 100000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}
