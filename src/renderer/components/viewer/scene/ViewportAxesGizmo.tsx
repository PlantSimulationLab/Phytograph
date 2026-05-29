import { GizmoHelper, GizmoViewport } from '@react-three/drei';

// Corner-pinned viewport gizmo: shows X/Y/Z orientation and snaps the
// camera to look down an axis when its handle is clicked. Replaces the
// world-origin axesHelper, which drifted in screen space as the user moved.
export function ViewportAxesGizmo() {
  return (
    <GizmoHelper alignment="bottom-left" margin={[80, 120]}>
      <GizmoViewport
        axisColors={['#ef4444', '#22c55e', '#3b82f6']}
        labelColor="white"
      />
    </GizmoHelper>
  );
}
