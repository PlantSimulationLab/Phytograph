import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { worldPerPixel } from '../../../lib/screenScale';

// Radius of the first-corner dot, in PIXELS. Matches the scene-origin marker's
// visual weight — big enough to aim with, small enough to never occlude the
// scene behind it.
const PIXEL_RADIUS = 6;

interface CropCornerMarkerProps {
  /** Marker position in the parent group's (display-space) coordinates. */
  position: [number, number, number];
  color: string;
}

// The "first corner" dot placed while drawing a crop box in the viewport.
//
// Sized in SCREEN space, not world space. The original sized it as 1% of the
// combined scene bounds, which is fine for one scan but scales with the number
// and spread of loaded scans — across a multi-scan survey site the diagonal is
// hundreds of metres, so the dot grew into a sphere that swallowed the view.
// Pinning it to a pixel radius makes it read identically whether one small
// scan or a whole plot is loaded, and it can never occlude the points the user
// is trying to aim at.
export function CropCornerMarker({ position, color }: CropCornerMarkerProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const { camera, size } = useThree();
  const worldPos = useRef(new THREE.Vector3()).current;

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // Use the WORLD position: the parent group cancels displayOffset, so on a
    // georeferenced scene the local position is a UTM coordinate while the
    // camera lives in display space — measuring there gives a wild scale.
    mesh.getWorldPosition(worldPos);
    const scale = PIXEL_RADIUS * worldPerPixel(camera, camera.position, size.height, worldPos);
    if (scale > 0) mesh.scale.setScalar(scale);
  });

  return (
    // Unit sphere; the frame loop scales it to the pixel radius. renderOrder +
    // depthTest:false keep the dot visible against dense points at the far side
    // of the box, matching how the crop box wireframe draws.
    <mesh ref={meshRef} position={position} renderOrder={999}>
      <sphereGeometry args={[1, 16, 16]} />
      <meshBasicMaterial color={color} depthTest={false} depthWrite={false} transparent />
    </mesh>
  );
}
