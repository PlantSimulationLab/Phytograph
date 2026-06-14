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
  // Render-only display offset (Layer 2). The brush works entirely in DISPLAY
  // space (the scene + camera live there): points are reconstructed at
  // (position + translation − displayOffset) so the display-camera ray and the
  // brush indicator line up. The erased INDICES are offset-invariant, so the
  // output is unchanged. Defaults to origin.
  displayOffset?: { x: number; y: number; z: number };
  alreadyErasedIndices: Set<number>;
  onErase: (indicesToErase: Set<number>) => void;
  onBrushPositionChange: (position: THREE.Vector3 | null) => void;
  onEraseStart: () => void;
  onEraseEnd: () => void;
  setIsErasing: (value: boolean) => void;
}

export function EraseBrush({ brushSize, brushPosition, isErasing, cloudData, cloudTranslation, displayOffset, alreadyErasedIndices, onErase, onBrushPositionChange, onEraseStart, onEraseEnd, setIsErasing }: EraseBrushProps) {
  const { camera, gl, size, raycaster } = useThree();
  const offX = displayOffset?.x ?? 0;
  const offY = displayOffset?.y ?? 0;
  const offZ = displayOffset?.z ?? 0;

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

      // Anchor the brush to the cloud point under the cursor: the one whose
      // perpendicular distance to the ray is smallest. We accept it within an
      // *angular* tolerance (perpendicular distance scaled by how far the point
      // is from the camera) rather than a fixed world distance, so picking is
      // resolution-independent and works at any cloud scale — what reads as
      // "under the cursor" on screen is an angle, not a fixed number of meters.
      // The brush radius also counts, so a large brush grabs points the way the
      // visible sphere suggests it should.
      const ANGULAR_TOLERANCE = 0.03; // ~radius of the pick cone, in radians
      let closestDistance = Infinity;
      let closestPoint: THREE.Vector3 | null = null;

      const tmp = new THREE.Vector3();
      for (let i = 0; i < cloudData.pointCount; i++) {
        // Skip already-erased points
        if (alreadyErasedIndices.has(i)) continue;

        const point = new THREE.Vector3(
          cloudData.positions[i * 3] + cloudTranslation.x - offX,
          cloudData.positions[i * 3 + 1] + cloudTranslation.y - offY,
          cloudData.positions[i * 3 + 2] + cloudTranslation.z - offZ
        );

        // Perpendicular distance from the point to the ray.
        const closestOnRay = raycaster.ray.closestPointToPoint(point, tmp);
        const distance = point.distanceTo(closestOnRay);

        // Screen-space pick tolerance: a cone around the ray. A point also
        // counts if it falls inside the world-space brush radius.
        const camDistance = point.distanceTo(camera.position);
        const pickTolerance = Math.max(brushSize, camDistance * ANGULAR_TOLERANCE);

        if (distance < pickTolerance && distance < closestDistance) {
          closestDistance = distance;
          closestPoint = point;
        }
      }

      // Where the brush indicator sits. When the cursor is over points, snap to
      // the nearest one; otherwise keep the indicator following the cursor by
      // projecting the ray out to the cloud's center distance, so the brush is
      // always visible while the tool is open (not just while erasing).
      let brushAnchor = closestPoint;
      if (!brushAnchor) {
        const center = new THREE.Vector3(
          cloudData.bounds.center.x + cloudTranslation.x - offX,
          cloudData.bounds.center.y + cloudTranslation.y - offY,
          cloudData.bounds.center.z + cloudTranslation.z - offZ
        );
        const camToCenter = center.distanceTo(camera.position);
        brushAnchor = raycaster.ray.at(camToCenter, new THREE.Vector3());
      }

      onBrushPositionChange(brushAnchor);

      // Erase points within the brush radius, but only when a real point is
      // under the cursor (anchored to closestPoint) and the user is holding E.
      if (isErasing && closestPoint) {
        const indicesToErase = new Set<number>();
        for (let i = 0; i < cloudData.pointCount; i++) {
          // Skip already-erased points
          if (alreadyErasedIndices.has(i)) continue;

          const point = new THREE.Vector3(
            cloudData.positions[i * 3] + cloudTranslation.x - offX,
            cloudData.positions[i * 3 + 1] + cloudTranslation.y - offY,
            cloudData.positions[i * 3 + 2] + cloudTranslation.z - offZ
          );
          if (point.distanceTo(closestPoint) < brushSize) {
            indicesToErase.add(i);
          }
        }
        if (indicesToErase.size > 0) {
          onErase(indicesToErase);
        }
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
  }, [camera, gl, size, raycaster, cloudData, cloudTranslation, offX, offY, offZ, brushSize, isErasing, alreadyErasedIndices, onErase, onBrushPositionChange, onEraseStart, onEraseEnd, setIsErasing]);

  if (!brushPosition) return null;

  const brushColor = isErasing ? '#ef4444' : '#f97316';

  return (
    <group position={brushPosition}>
      {/* Translucent fill showing the erase volume */}
      <mesh>
        <sphereGeometry args={[brushSize, 32, 32]} />
        <meshBasicMaterial
          color={brushColor}
          transparent
          opacity={isErasing ? 0.4 : 0.25}
          depthWrite={false}
        />
      </mesh>
      {/* Bright wireframe outline so the brush boundary reads clearly even
          against dense points (renders on top via depthTest=false) */}
      <mesh>
        <sphereGeometry args={[brushSize, 24, 16]} />
        <meshBasicMaterial
          color={brushColor}
          wireframe
          transparent
          opacity={0.8}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
