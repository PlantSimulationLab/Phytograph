import { useEffect } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { visibleContentDepth } from '../../../lib/visibleDepth';

// While mounted, force the (perspective) main camera to *project*
// orthographically without replacing the camera object. The erase brush stamps
// screen-space squares whose camera is frozen into the saved region; under a
// perspective projection a screen square extrudes as a frustum, so its world
// footprint is a trapezoid (narrow near, wide far) that does not match the
// brush outline. Projecting orthographically while painting makes the
// extrusion a straight prism.
//
// (The crop Rect and Polygon tools used this too. They no longer do: they cut
// exactly what is on screen under the ordinary perspective view.)
//
// We override `projectionMatrix` in place rather than swapping in an
// OrthographicCamera so everything that reads the camera as a
// PerspectiveCamera (gizmo overlay, GIF capture, minimap — all access
// `.fov`/`.aspect`) keeps working untouched. OrbitControls only writes
// position/target, so it's unaffected too.
//
// The ortho frustum is sized to match the perspective view at the orbit
// target plane: half-height = tan(fov/2) · distance-to-target. That keeps
// the on-screen framing (and the brush the user paints over the data)
// visually consistent at the focal distance, only flattening the depth
// foreshortening that caused the trapezoid.
//
// "At the focal distance" is the catch: a parallel projection can match the
// perspective view at ONE depth only, and content at any other depth slides
// toward or away from the screen center by the ratio of the two. The orbit
// target is wherever the last zoom probe, pan or auto-frame left it, which is
// routinely several times nearer or farther than what the user has just lined
// up — so entering the tool threw the view. On mount we therefore re-seat the
// target, ALONG THE VIEW AXIS, at the depth of the content actually on screen
// (lib/visibleDepth.ts). The camera neither moves nor turns, so nothing changes
// until the projection flattens, and then what was being looked at stays put.
// Moving the target rather than scaling the frustum by a correction factor is
// deliberate: OrbitControls derives pan speed from |camera − target|, so the
// frustum and the pan stay in step and a drag still tracks the cursor 1:1. It
// is the same re-seat the zoom handler already performs after every dolly.

// Samples taken per drawn object. The estimate is a per-screen-cell nearest
// depth, so a few thousand per potree tile / mesh saturates the grid.
const SAMPLES_PER_OBJECT = 4096;

/**
 * Visit world positions of what the scene is drawing: visible point tiles and
 * meshes, through their matrixWorld. Lines, sprites and instanced meshes are
 * skipped (gizmo furniture, or geometry whose vertices are not where it draws).
 * Small helpers that do get through claim only the screen cells they cover.
 */
function forEachDrawnSample(scene: THREE.Object3D) {
  return (visit: (x: number, y: number, z: number) => void) => {
    const v = new THREE.Vector3();
    scene.traverseVisible((o) => {
      const obj = o as THREE.Points | THREE.Mesh;
      const isPoints = (obj as THREE.Points).isPoints;
      const isMesh = (obj as THREE.Mesh).isMesh && !(obj as THREE.InstancedMesh).isInstancedMesh;
      if (!isPoints && !isMesh) return;
      const pos = obj.geometry?.getAttribute?.('position');
      if (!pos || pos.count === 0) return;
      const stride = Math.max(1, Math.ceil(pos.count / SAMPLES_PER_OBJECT));
      for (let i = 0; i < pos.count; i += stride) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(obj.matrixWorld);
        visit(v.x, v.y, v.z);
      }
    });
  };
}

export function OrthoProjectionOverride() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const scene = useThree((s) => s.scene);
  const controls = useThree((s) => s.controls) as {
    target?: THREE.Vector3;
    minDistance?: number;
    maxDistance?: number;
    update?: () => void;
  } | null;

  // Put the orbit target at the depth of the visible content, keeping it on the
  // view axis so the camera's position and orientation are untouched.
  const reseatTargetOnContent = () => {
    const target = controls?.target;
    if (!target) return;
    camera.updateMatrixWorld();
    const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
    const depth = visibleContentDepth(
      forEachDrawnSample(scene),
      camera.matrixWorldInverse.elements,
      tanHalfFov,
      camera.aspect,
      camera.near,
    );
    if (depth === null) return;
    // Inside the controls' own range, or update() would shove the camera back
    // out along the target ray (see the zoom handler's re-seat).
    const clamped = Math.min(
      Math.max(depth, controls?.minDistance ?? 0),
      controls?.maxDistance ?? Infinity,
    );
    const forward = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
    target.copy(camera.position).addScaledVector(forward, clamped);
    controls?.update?.();
  };

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
    reseatTargetOnContent();
    apply();
    return () => {
      camera.updateProjectionMatrix();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
