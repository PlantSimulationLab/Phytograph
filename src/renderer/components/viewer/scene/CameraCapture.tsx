import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

// Camera capture component - exposes camera state to parent ref
export interface CameraCaptureProps {
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
}

export function CameraCapture({ cameraRef }: CameraCaptureProps) {
  const { camera } = useThree();

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera, cameraRef]);

  return null;
}
