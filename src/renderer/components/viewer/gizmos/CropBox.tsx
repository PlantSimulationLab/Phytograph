import { useMemo } from 'react';
import * as THREE from 'three';

// World-space crop box visualization. Purely a wireframe + faint fill — the
// box is resized/repositioned through the numeric Center/Dimensions inputs in
// the crop panel (which write cropBox.min/max via setCropBox), so no in-scene
// drag handles are drawn.
export interface CropBoxProps {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  keepInside: boolean;
}

export function CropBox({ min, max, keepInside }: CropBoxProps) {
  const center = useMemo(() => new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2), [min, max]);
  const dimensions = useMemo(() => new THREE.Vector3(max.x - min.x, max.y - min.y, max.z - min.z), [min, max]);

  const boxColor = keepInside ? '#22c55e' : '#ef4444';

  return (
    <group>
      <lineSegments position={center}>
        <edgesGeometry args={[new THREE.BoxGeometry(dimensions.x, dimensions.y, dimensions.z)]} />
        <lineBasicMaterial color={boxColor} linewidth={2} transparent opacity={0.8} />
      </lineSegments>
      <mesh position={center}>
        <boxGeometry args={[dimensions.x, dimensions.y, dimensions.z]} />
        <meshBasicMaterial color={boxColor} transparent opacity={0.05} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
