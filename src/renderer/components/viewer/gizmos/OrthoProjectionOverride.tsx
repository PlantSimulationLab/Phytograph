import { useEffect } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// While mounted, force the (perspective) main camera to *project*
// orthographically without replacing the camera object. The crop Rect and
// Polygon tools snapshot the camera's projectionMatrix at commit time and
// freeze it into the saved region; under a perspective projection a screen
// rectangle extrudes as a frustum, so its world footprint is a trapezoid
// (narrow near, wide far). Projecting orthographically while drawing makes
// the extrusion a straight prism — a true rectangle from any later view.
//
// We override `projectionMatrix` in place rather than swapping in an
// OrthographicCamera so everything that reads the camera as a
// PerspectiveCamera (gizmo overlay, GIF capture, minimap — all access
// `.fov`/`.aspect`) keeps working untouched. OrbitControls only writes
// position/target, so it's unaffected too.
//
// The ortho frustum is sized to match the perspective view at the orbit
// target plane: half-height = tan(fov/2) · distance-to-target. That keeps
// the on-screen framing (and the rectangle the user drags over the data)
// visually consistent at the focal distance, only flattening the depth
// foreshortening that caused the trapezoid.
export function OrthoProjectionOverride() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as { target?: THREE.Vector3 } | null;

  const apply = () => {
    const target = controls?.target;
    const distance = target ? camera.position.distanceTo(target) : camera.position.length();
    const fovRad = (camera.fov * Math.PI) / 180;
    const halfH = Math.tan(fovRad / 2) * Math.max(distance, 1e-3);
    const halfW = halfH * camera.aspect;
    camera.projectionMatrix.makeOrthographic(
      -halfW, halfW,
      halfH, -halfH,
      camera.near, camera.far,
    );
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  };

  // Re-apply every frame: OrbitControls (zoom/orbit) and any other code may
  // call camera.updateProjectionMatrix(), which would restore perspective.
  useFrame(apply);

  // Restore a correct perspective matrix on unmount so the rest of the app
  // (and the next perspective render) isn't left with a stale ortho matrix.
  useEffect(() => {
    apply();
    return () => {
      camera.updateProjectionMatrix();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
