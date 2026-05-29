import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { PointCloudData } from '../../../lib/pointCloudTypes';

// Erase brush component for erasing points
export interface EraseBrushProps {
  brushSize: number;
  brushPosition: THREE.Vector3 | null;
  isErasing: boolean;
  cloudData: PointCloudData;
  cloudTranslation: { x: number; y: number; z: number };
  alreadyErasedIndices: Set<number>;
  onErase: (indicesToErase: Set<number>) => void;
  onBrushPositionChange: (position: THREE.Vector3 | null) => void;
  onEraseStart: () => void;
  onEraseEnd: () => void;
  setIsErasing: (value: boolean) => void;
}

export function EraseBrush({ brushSize, brushPosition, isErasing, cloudData, cloudTranslation, alreadyErasedIndices, onErase, onBrushPositionChange, onEraseStart, onEraseEnd, setIsErasing }: EraseBrushProps) {
  const { camera, gl, size, raycaster } = useThree();

  // Update brush position based on mouse movement
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Convert mouse to normalized device coordinates
      const rect = gl.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );

      // Cast ray from camera
      raycaster.setFromCamera(mouse, camera);

      // Find the closest point in the cloud to the ray
      let closestDistance = Infinity;
      let closestPoint: THREE.Vector3 | null = null;

      for (let i = 0; i < cloudData.pointCount; i++) {
        // Skip already-erased points
        if (alreadyErasedIndices.has(i)) continue;

        const point = new THREE.Vector3(
          cloudData.positions[i * 3] + cloudTranslation.x,
          cloudData.positions[i * 3 + 1] + cloudTranslation.y,
          cloudData.positions[i * 3 + 2] + cloudTranslation.z
        );

        // Find distance from point to ray
        const closestOnRay = raycaster.ray.closestPointToPoint(point, new THREE.Vector3());
        const distance = point.distanceTo(closestOnRay);

        // Check if this point is within a screen-space threshold
        if (distance < brushSize * 2 && distance < closestDistance) {
          closestDistance = distance;
          closestPoint = point;
        }
      }

      if (closestPoint) {
        onBrushPositionChange(closestPoint);

        // If erasing, find all points within brush radius
        if (isErasing) {
          const indicesToErase = new Set<number>();
          for (let i = 0; i < cloudData.pointCount; i++) {
            // Skip already-erased points
            if (alreadyErasedIndices.has(i)) continue;

            const point = new THREE.Vector3(
              cloudData.positions[i * 3] + cloudTranslation.x,
              cloudData.positions[i * 3 + 1] + cloudTranslation.y,
              cloudData.positions[i * 3 + 2] + cloudTranslation.z
            );
            if (point.distanceTo(closestPoint!) < brushSize) {
              indicesToErase.add(i);
            }
          }
          if (indicesToErase.size > 0) {
            onErase(indicesToErase);
          }
        }
      } else {
        onBrushPositionChange(null);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'e' || e.key === 'E') {
        if (!isErasing) {
          onEraseStart();
          setIsErasing(true);
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'e' || e.key === 'E') {
        if (isErasing) {
          setIsErasing(false);
          onEraseEnd();
        }
      }
    };

    gl.domElement.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      gl.domElement.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [camera, gl, size, raycaster, cloudData, cloudTranslation, brushSize, isErasing, alreadyErasedIndices, onErase, onBrushPositionChange, onEraseStart, onEraseEnd, setIsErasing]);

  if (!brushPosition) return null;

  return (
    <mesh position={brushPosition}>
      <sphereGeometry args={[brushSize, 32, 32]} />
      <meshBasicMaterial
        color={isErasing ? '#ef4444' : '#f97316'}
        transparent
        opacity={isErasing ? 0.4 : 0.25}
        depthWrite={false}
      />
    </mesh>
  );
}
