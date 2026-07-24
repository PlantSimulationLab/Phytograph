import { useEffect } from 'react';
import { useThree, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';

// Click target for placing the scene origin (the CloudCompare-style pivot).
// While mounted (origin place-mode armed), a left-click prefers a SURFACE hit on
// the selected octree cloud (potree-core `octree.pick`, so the origin snaps to a
// real point like CloudCompare's point-pick), falling back to a ground-plane
// intersection when the ray misses the cloud. The hit is converted from DISPLAY
// space (the scene renders at world − displayOffset; the octree is attached to
// the scene root at that offset, so picks come back in display coords) to WORLD
// and reported via onPick. Only mounted while placing — otherwise it would
// intercept every click.
export function OriginPicker({
  octree,
  groundZ,
  displayOffset,
  onPick,
}: {
  // Live PointCloudOctree of the selected cloud (from OctreePointCloud's
  // onOctreeReady handoff), or null for a flat cloud / none. Typed loosely to
  // avoid importing potree-core's class here.
  octree: { pick: (...args: unknown[]) => unknown } | null;
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
    // Surface snap first: pick against the octree along the event ray.
    if (octree) {
      try {
        const hit = octree.pick(gl, camera, e.ray, { pickWindowSize: 17, pickOutsideClipRegion: true }) as
          | { position?: { x: number; y: number; z: number } }
          | null;
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
    <mesh position={[0, 0, groundZ]} onClick={handleClick} renderOrder={9999}>
      <planeGeometry args={[100000, 100000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}
