import { useEffect } from 'react';
import { useThree, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';

// Invisible click target that fills the canvas. While active (mounted),
// every left-click is raycast against a horizontal plane at z=groundZ
// and the world XY hit point is reported to the parent. Used for the
// two-click in-viewport box draw and only mounted while the user is
// actively placing corners — otherwise it would intercept every click
// in the scene.
export function BoxDrawRaycaster({ groundZ, onPick }: { groundZ: number; onPick: (x: number, y: number) => void }) {
  const { gl } = useThree();

  useEffect(() => {
    gl.domElement.style.cursor = 'crosshair';
    return () => {
      gl.domElement.style.cursor = 'auto';
    };
  }, [gl]);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    // Raycaster gives us the world-space ray; intersect it with the
    // ground plane z = groundZ.
    const ray = e.ray;
    if (Math.abs(ray.direction.z) < 1e-6) return;
    const t = (groundZ - ray.origin.z) / ray.direction.z;
    if (!isFinite(t)) return;
    const hitX = ray.origin.x + t * ray.direction.x;
    const hitY = ray.origin.y + t * ray.direction.y;
    e.stopPropagation();
    onPick(hitX, hitY);
  };

  // Render a huge transparent plane at the ground level so the click
  // target exists in the scene graph. We orient it so its normal points
  // +Z (the default), and set side=DoubleSide so picks register from
  // either side of the plane.
  return (
    <mesh
      position={[0, 0, groundZ]}
      onClick={handleClick}
      renderOrder={9999}
    >
      <planeGeometry args={[100000, 100000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}
