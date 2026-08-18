import { useMemo } from 'react';
import * as THREE from 'three';
import { SCENE_OVERLAY } from '../../../lib/sceneOverlay';

// Where the label brush will paint, drawn as a world-space sphere outline.
//
// A wireframe sphere rather than a flat screen-space ring, because the volume
// really IS a sphere: it reaches the same distance behind the hovered surface
// as in front of it, and a flat ring would imply the screen-space extrusion the
// erase brush has and this one deliberately does not.
//
// Carries SCENE_OVERLAY so DepthProbe skips it — without that, zoom-to-cursor
// would anchor on the cursor sphere's own surface instead of the points behind
// it, and every scroll notch would zoom toward the brush rather than the cloud.
export function LabelBrushCursor({
  center,
  radius,
  painting,
  color,
  displayOffset,
}: {
  /** World-space centre of the brush. */
  center: THREE.Vector3;
  /** World-space radius, already converted from the on-screen pixel size. */
  radius: number;
  /** True while the button is held — the cursor fills in to confirm painting. */
  painting: boolean;
  /** The active class colour, so the cursor shows WHAT it will paint. */
  color: string;
  displayOffset?: { x: number; y: number; z: number };
}) {
  const geometry = useMemo(
    // Low segment count: this redraws every mousemove, and a smooth sphere is
    // not worth the vertices for a cursor.
    () => new THREE.SphereGeometry(1, 20, 12),
    [],
  );

  const position = useMemo<[number, number, number]>(() => [
    center.x - (displayOffset?.x ?? 0),
    center.y - (displayOffset?.y ?? 0),
    center.z - (displayOffset?.z ?? 0),
  ], [center.x, center.y, center.z, displayOffset?.x, displayOffset?.y, displayOffset?.z]);

  return (
    <group {...SCENE_OVERLAY} position={position} scale={[radius, radius, radius]}>
      <mesh geometry={geometry} renderOrder={9998}>
        <meshBasicMaterial
          color={color}
          wireframe
          transparent
          opacity={painting ? 0.9 : 0.5}
          depthTest={false}
        />
      </mesh>
      {/* A faint fill while painting, so the user can tell the button is down
          even when the wireframe sits against busy geometry. */}
      {painting && (
        <mesh geometry={geometry} renderOrder={9997}>
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.15}
            depthTest={false}
            side={THREE.BackSide}
          />
        </mesh>
      )}
    </group>
  );
}
