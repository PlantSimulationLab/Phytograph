import { useEffect } from 'react';
import { useThree, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { Potree, type PointCloudOctree } from 'potree-core';
import { SCENE_OVERLAY } from '../../../lib/sceneOverlay';
import { OCTREE_PICK_WINDOW_PX, makeInflatePickSplat } from '../../../lib/octreePickSplat';

// Click target for placing the scene origin (the CloudCompare-style pivot).
// While mounted (origin place-mode armed), a left-click prefers a SURFACE hit on
// the nearest visible octree cloud (potree-core `Potree.pick`, so the origin
// snaps to a real point like CloudCompare's point-pick), falling back to a
// ground-plane intersection when the ray misses every cloud. The hit is
// converted from DISPLAY space (the scene renders at world − displayOffset; the
// octrees are attached to the scene root at that offset, so picks come back in
// display coords) to WORLD and reported via onPick. Only mounted while placing —
// otherwise it would intercept every click.
//
// The origin is scene-wide, so this picks across every visible cloud rather
// than only the selected one. Scoping it to the selection meant that with
// nothing selected there was no surface to snap to AND no floor to fall back
// on, so every click landed on z = 0 — tens of metres below a georeferenced
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

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    // Surface snap first: pick against the octrees along the event ray.
    if (octrees.length > 0) {
      try {
        const hit = Potree.pick(octrees, gl, camera, e.ray, {
          pickWindowSize: OCTREE_PICK_WINDOW_PX,
          pickOutsideClipRegion: true,
          // Without this a point is only pickable where its 1-px splat covered
          // a pixel, so density rather than aim decided whether the click
          // snapped. See lib/octreePickSplat.
          onBeforePickRender: makeInflatePickSplat(gl.getPixelRatio()),
        }) as { position?: { x: number; y: number; z: number } } | null;
        if (hit?.position) {
          e.stopPropagation();
          onPick([
            hit.position.x + displayOffset.x,
            hit.position.y + displayOffset.y,
            hit.position.z + displayOffset.z,
          ]);
          return;
        }
      } catch { /* fall through to the ground plane */ }
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
    <mesh {...SCENE_OVERLAY} position={[0, 0, groundZ]} onClick={handleClick} renderOrder={9999}>
      <planeGeometry args={[100000, 100000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}
