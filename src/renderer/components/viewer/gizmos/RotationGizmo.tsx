import { useRef, useMemo, useState, useCallback, useEffect } from 'react';
import { useThree, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { SCENE_OVERLAY } from '../../../lib/sceneOverlay';
import { ConstantScreenScaler } from './ConstantScreenScaler';

// Rotation gizmo: three colored rings (X red, Y green, Z blue) drawn around the
// pivot. Dragging a ring rotates the cloud about that world axis. The emitted
// value is a signed angle DELTA in DEGREES (accumulated into the draft by the
// parent, exactly like TranslationGizmo's per-axis deltas). This is a render-only
// preview — the parent bakes on OK.
//
// Angle mapping: we measure the cursor's screen-space angle around the pivot's
// projected screen position between frames. The sign is corrected so a visually
// clockwise/counter-clockwise drag matches the right-hand rule about the axis as
// seen from the camera (flip when the axis points away from the viewer).

type Axis = 'x' | 'y' | 'z';

const AXIS_COLOR: Record<Axis, string> = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' };
const AXIS_HOVER: Record<Axis, string> = { x: '#f87171', y: '#4ade80', z: '#60a5fa' };
const AXIS_VEC: Record<Axis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

// A flat ring (torus) lying in the plane perpendicular to `axis`. Drawn around
// the LOCAL origin — the parent group carries the pivot position, so the whole
// glyph can be rescaled as a unit (see ConstantScreenScaler).
function RotationRing({
  axis, radius, onDragStart,
}: {
  axis: Axis;
  radius: number;
  onDragStart: (axis: Axis) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { gl } = useThree();

  // A torus is authored in the XY plane (normal +Z). Rotate so its normal aligns
  // with the ring's axis: X-ring → rotate about Y; Y-ring → rotate about X.
  const rotation = useMemo<[number, number, number]>(() => {
    if (axis === 'x') return [0, Math.PI / 2, 0];
    if (axis === 'y') return [Math.PI / 2, 0, 0];
    return [0, 0, 0];
  }, [axis]);

  const tube = radius * 0.02;
  const color = hovered ? AXIS_HOVER[axis] : AXIS_COLOR[axis];

  return (
    // UI overlay, not content — see lib/sceneOverlay.ts.
    <mesh
      {...SCENE_OVERLAY}
      rotation={rotation}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(true); gl.domElement.style.cursor = 'grab'; }}
      onPointerOut={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(false); gl.domElement.style.cursor = 'auto'; }}
      onPointerDown={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onDragStart(axis); }}
    >
      <torusGeometry args={[radius, tube, 12, 64]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
}

function RotationDragHandler({
  activeAxis, pivot, onRotate, onDragEnd,
}: {
  activeAxis: Axis | null;
  pivot: THREE.Vector3;
  onRotate: (axis: Axis, deltaDeg: number) => void;
  onDragEnd: () => void;
}) {
  const { camera, gl, size } = useThree();
  const lastAngleRef = useRef<number | null>(null);

  useEffect(() => {
    if (!activeAxis) return;

    // Pivot in screen pixels.
    const pivotScreen = () => {
      const p = pivot.clone().project(camera);
      return new THREE.Vector2((p.x + 1) * size.width / 2, (-p.y + 1) * size.height / 2);
    };
    // Sign: dot of the ring axis with the camera view direction. When the axis
    // points toward the camera, a CCW screen drag is a +angle about it; when it
    // points away, flip so the cloud turns the way the cursor moves.
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const axisSign = Math.sign(AXIS_VEC[activeAxis].dot(camDir)) || 1;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      const cur = new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top);
      const c = pivotScreen();
      const angle = Math.atan2(cur.y - c.y, cur.x - c.x); // screen-space angle
      if (lastAngleRef.current === null) { lastAngleRef.current = angle; return; }
      let delta = angle - lastAngleRef.current;
      // Unwrap across the ±π seam.
      if (delta > Math.PI) delta -= 2 * Math.PI;
      else if (delta < -Math.PI) delta += 2 * Math.PI;
      lastAngleRef.current = angle;
      // Screen +y is down, so a screen-CCW drag is mathematically negative; negate
      // to make it read as CCW, then apply the axis-facing sign.
      onRotate(activeAxis, THREE.MathUtils.radToDeg(-delta * axisSign));
    };
    const handleMouseUp = () => { lastAngleRef.current = null; onDragEnd(); };

    gl.domElement.style.cursor = 'grabbing';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      gl.domElement.style.cursor = 'auto';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [activeAxis, camera, gl, pivot, size, onRotate, onDragEnd]);

  return null;
}

export interface RotationGizmoProps {
  // Pivot in DISPLAY space (world − displayOffset), matching the scene.
  center: THREE.Vector3;
  size: number;
  onRotate: (axis: Axis, deltaDeg: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /**
   * When set, the rings are rescaled every frame to span this many screen pixels
   * instead of `size` world units, so they stay grabbable at any zoom on a cloud
   * of any extent. `size` then only fixes the glyph's internal proportions.
   */
  constantScreenSize?: number;
}

export function RotationGizmo({ center, size, onRotate, onDragStart, onDragEnd, constantScreenSize }: RotationGizmoProps) {
  const [activeAxis, setActiveAxis] = useState<Axis | null>(null);
  const visualRef = useRef<THREE.Group>(null);

  const handleAxisDragStart = useCallback((axis: Axis) => {
    setActiveAxis(axis);
    onDragStart();
  }, [onDragStart]);

  const handleDragEnd = useCallback(() => {
    setActiveAxis(null);
    onDragEnd();
  }, [onDragEnd]);

  const radius = size;
  return (
    // UI overlay, not content — see lib/sceneOverlay.ts. On the root group so
    // every ring, handle and the pivot marker below inherit it.
    <group {...SCENE_OVERLAY}>
      {/* Everything visual hangs off one group positioned at the pivot, so the
          constant-size scaler can scale the whole glyph about that point. */}
      <group ref={visualRef} position={center}>
        <RotationRing axis="x" radius={radius} onDragStart={handleAxisDragStart} />
        <RotationRing axis="y" radius={radius} onDragStart={handleAxisDragStart} />
        <RotationRing axis="z" radius={radius} onDragStart={handleAxisDragStart} />
        {/* Small pivot marker so the rotation center is visible. */}
        <mesh>
          <sphereGeometry args={[radius * 0.04, 12, 12]} />
          <meshBasicMaterial color="#a3a3a3" />
        </mesh>
      </group>
      {constantScreenSize !== undefined && (
        <ConstantScreenScaler target={visualRef} pixels={constantScreenSize} size={radius} />
      )}
      {/* Not scaled: the drag handler works off the UNSCALED pivot and measures
          the cursor's screen angle around it, so it's independent of glyph size. */}
      <RotationDragHandler activeAxis={activeAxis} pivot={center} onRotate={onRotate} onDragEnd={handleDragEnd} />
    </group>
  );
}
