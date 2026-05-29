import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

// Mirrors the active camera and canvas size out to refs held by the
// parent component. Mounted only while a crop polygon is being drawn or
// is already closed (the projection used for the in/out test gets
// snapshotted at close time from these refs).
export function PolygonCameraSnapshotter({ cameraRef, sizeRef }: {
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
  sizeRef: React.MutableRefObject<{ width: number; height: number } | null>;
}) {
  const { camera, size } = useThree();
  useEffect(() => {
    cameraRef.current = camera;
    sizeRef.current = { width: size.width, height: size.height };
  }, [camera, size.width, size.height, cameraRef, sizeRef]);
  return null;
}
