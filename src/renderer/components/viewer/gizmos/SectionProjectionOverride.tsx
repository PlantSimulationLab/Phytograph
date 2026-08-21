import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { slabOrthoFrustum, type SlabRegion } from '../../../lib/crossSection';

// Orthographic projection for a cross-section view, sized from the SLAB.
//
// Deliberately NOT a reuse of OrthoProjectionOverride. That one derives its
// half-height from the distance to the orbit target, which is correct for a
// two-second crop-rect drag but wrong for a section: the custom zoom-to-cursor
// handler re-seats the orbit target from the depth probe, so the frustum — and
// therefore the on-screen scale of the section — would drift with whatever the
// probe happened to return. A section's zoom should mean "this slab, framed",
// and should stay put while the user steps through the cloud.
//
// Orthographic matters beyond taste here: under perspective, points deeper in
// the slab are drawn smaller and offset, so a 2-D lasso does not select what it
// visually encloses. Flattening the projection is what makes painting in a
// section honest.
export function SectionProjectionOverride({
  slab,
  zoom = 1,
}: {
  slab: SlabRegion;
  /** User zoom multiplier; 1 = the slab exactly framed. */
  zoom?: number;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;

  const apply = () => {
    const { halfW, halfH } = slabOrthoFrustum(slab, camera.aspect || 1, 0.05);
    const z = Math.max(zoom, 1e-3);
    camera.projectionMatrix.makeOrthographic(
      -halfW / z, halfW / z,
      halfH / z, -halfH / z,
      camera.near, camera.far,
    );
    // MUST stay in step: rayForNdc (lib/cameraRay.ts) unprojects through this
    // inverse, and every lasso vertex and pick in the section depends on it.
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  };

  // Re-apply every frame — OrbitControls and anything else calling
  // updateProjectionMatrix() would otherwise restore perspective mid-session.
  useFrame(apply);

  useEffect(() => {
    apply();
    // Restore a real perspective matrix on unmount, so leaving the section (or
    // unlocking the camera to orbit) does not strand the app in a stale ortho.
    return () => { camera.updateProjectionMatrix(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
