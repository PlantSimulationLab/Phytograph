import { useMemo, useState } from 'react';
import { CanvasTexture, type Vector3Tuple } from 'three';
import { GizmoHelper } from '@react-three/drei';

// Corner-pinned viewport gizmo: shows X/Y/Z orientation and snaps the camera
// to look down an axis when its handle is clicked.
//
// We keep drei's GizmoHelper (its per-frame orientation sync from the main
// camera matrix is up-axis-agnostic and correct), but we DON'T use drei's
// GizmoViewport click behaviour. drei's tweenCamera (a) hardcodes a Y-up basis
// while interpolating, which is wrong for this Z-up app — clicking +X landed
// you in a Y-up view instead of Z-up — and (b) recomputes the orbit radius from
// distance-to-origin rather than distance-to-target, which yanks the zoom.
//
// Instead each axis head calls the app's own __orientToAxis (CameraController),
// which rotates around the current orbit target at the current distance with a
// correct Z-up basis: orientation only, no reframe, no zoom change.

const AXIS_COLORS = {
  x: '#ef4444', // red
  y: '#22c55e', // green
  z: '#3b82f6', // blue
} as const;

// Each head: local position inside the (camera-mirrored) gizmo group maps to a
// world direction; clicking it points the camera along that world axis.
const HEADS: Array<{
  axis: keyof typeof AXIS_COLORS;
  dir: Vector3Tuple;
  label: string | null;
}> = [
  { axis: 'x', dir: [1, 0, 0], label: 'X' },
  { axis: 'y', dir: [0, 1, 0], label: 'Y' },
  { axis: 'z', dir: [0, 0, 1], label: 'Z' },
  { axis: 'x', dir: [-1, 0, 0], label: null },
  { axis: 'y', dir: [0, -1, 0], label: null },
  { axis: 'z', dir: [0, 0, -1], label: null },
];

function makeHeadTexture(color: string, label: string | null, labelColor: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(32, 32, 16, 0, 2 * Math.PI);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  if (label) {
    ctx.font = '24px Inter var, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = labelColor;
    ctx.fillText(label, 32, 41);
  }
  return new CanvasTexture(canvas);
}

function AxisHead({
  color,
  dir,
  label,
  labelColor,
}: {
  color: string;
  dir: Vector3Tuple;
  label: string | null;
  labelColor: string;
}) {
  const texture = useMemo(
    () => makeHeadTexture(color, label, labelColor),
    [color, label, labelColor],
  );
  const [hovered, setHovered] = useState(false);
  // Positive (labelled) heads are solid and a touch larger; negative heads are
  // smaller and semi-transparent — matches drei's GizmoViewport styling.
  const baseScale = label ? 1 : 0.75;
  const scale = baseScale * (hovered ? 1.2 : 1);

  return (
    <sprite
      position={dir}
      scale={scale}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        setHovered(false);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        (window as any).__orientToAxis?.({ x: dir[0], y: dir[1], z: dir[2] });
      }}
    >
      <spriteMaterial
        map={texture}
        opacity={label ? 1 : 0.75}
        alphaTest={0.3}
        toneMapped={false}
      />
    </sprite>
  );
}

function GizmoAxes() {
  return (
    <group scale={40}>
      {/* Axis bars */}
      <mesh position={[0.4, 0, 0]}>
        <boxGeometry args={[0.8, 0.05, 0.05]} />
        <meshBasicMaterial color={AXIS_COLORS.x} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.4, 0]}>
        <boxGeometry args={[0.05, 0.8, 0.05]} />
        <meshBasicMaterial color={AXIS_COLORS.y} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, 0.4]}>
        <boxGeometry args={[0.05, 0.05, 0.8]} />
        <meshBasicMaterial color={AXIS_COLORS.z} toneMapped={false} />
      </mesh>
      {/* Clickable axis heads */}
      {HEADS.map((h, i) => (
        <AxisHead
          key={i}
          color={AXIS_COLORS[h.axis]}
          dir={h.dir}
          label={h.label}
          labelColor="white"
        />
      ))}
    </group>
  );
}

export function ViewportAxesGizmo() {
  return (
    <GizmoHelper alignment="bottom-left" margin={[80, 120]}>
      <GizmoAxes />
    </GizmoHelper>
  );
}
