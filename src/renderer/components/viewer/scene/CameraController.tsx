import { useRef, useCallback, useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { PointCloudData } from '../../../lib/pointCloudTypes';

// View direction type
export type ViewDirection = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

// Camera controller
export function CameraController({
  bounds,
  hasContent,
  enabled = true,
}: { bounds: PointCloudData['bounds']; hasContent: boolean; enabled?: boolean }) {
  const { camera } = useThree();
  const controlsRef = useRef<any>(null);
  const initializedRef = useRef(false);
  const boundsRef = useRef(bounds);

  // Keep bounds ref updated for snap functions (but don't trigger camera changes)
  boundsRef.current = bounds;

  const snapToView = useCallback((direction: ViewDirection, target?: { center: THREE.Vector3, size: THREE.Vector3 }) => {
    if (!controlsRef.current) return;

    // Use provided target or fall back to global bounds
    const { center, size } = target || boundsRef.current;
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const distance = maxDim * 2;

    let newPos: THREE.Vector3;

    switch (direction) {
      case 'top':
        newPos = new THREE.Vector3(center.x, center.y, center.z + distance);
        camera.up.set(0, 1, 0);
        break;
      case 'bottom':
        newPos = new THREE.Vector3(center.x, center.y, center.z - distance);
        camera.up.set(0, 1, 0);
        break;
      case 'front':
        newPos = new THREE.Vector3(center.x, center.y - distance, center.z);
        camera.up.set(0, 0, 1);
        break;
      case 'back':
        newPos = new THREE.Vector3(center.x, center.y + distance, center.z);
        camera.up.set(0, 0, 1);
        break;
      case 'left':
        newPos = new THREE.Vector3(center.x - distance, center.y, center.z);
        camera.up.set(0, 0, 1);
        break;
      case 'right':
        newPos = new THREE.Vector3(center.x + distance, center.y, center.z);
        camera.up.set(0, 0, 1);
        break;
      case 'iso':
      default:
        newPos = new THREE.Vector3(
          center.x + distance * 0.6,
          center.y - distance * 0.6,
          center.z + distance * 0.5
        );
        camera.up.set(0, 0, 1);
        break;
    }

    camera.position.copy(newPos);
    controlsRef.current.target.copy(center);
    controlsRef.current.update();
  }, [camera]);

  // Rotate the view to look straight down a world axis WITHOUT reframing.
  // Unlike snapToView (which recomputes distance from bounds and re-zooms),
  // this preserves the current orbit target and the current camera-to-target
  // distance — clicking the viewport gizmo should only change orientation,
  // not zoom. `axis` is a unit world-direction pointing from the target toward
  // where the camera should sit (e.g. (0,0,1) places the camera above for a
  // top-down view). Up is kept Z-up except for top/bottom, where looking along
  // ±Z is degenerate and we fall back to Y-up (matching snapToView).
  const orientToAxis = useCallback((axis: { x: number; y: number; z: number }) => {
    if (!controlsRef.current) return;
    const controls = controlsRef.current;
    const target: THREE.Vector3 = controls.target;
    const radius = camera.position.distanceTo(target) || 1;

    const dir = new THREE.Vector3(axis.x, axis.y, axis.z).normalize();
    camera.position.copy(target).addScaledVector(dir, radius);

    // Looking straight along ±Z makes a Z-up basis degenerate; use Y-up there.
    if (Math.abs(dir.z) > 0.999) {
      camera.up.set(0, 1, 0);
    } else {
      camera.up.set(0, 0, 1);
    }
    controls.update();
  }, [camera]);

  const resetCamera = useCallback(() => {
    snapToView('iso');
  }, [snapToView]);

  // Frame a target (center + size) WITHOUT changing the viewing angle. Unlike
  // snapToView (which moves the camera to a fixed direction and re-zooms),
  // frameSelection keeps the current camera→target direction and up vector and
  // only re-centers + re-zooms so the target fills the viewport. This is the
  // "zoom to selection" / frame-selection (F key) behavior familiar from CAD and
  // DCC tools: it preserves wherever the user has orbited to. With no target it
  // falls back to the global bounds (i.e. "fit everything from here").
  const frameSelection = useCallback((target?: { center: THREE.Vector3; size: THREE.Vector3 }) => {
    if (!controlsRef.current) return;
    const controls = controlsRef.current;
    const { center, size } = target || boundsRef.current;
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const distance = maxDim * 2;

    // Preserve the current orbit direction (camera relative to its target).
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (dir.lengthSq() < 1e-12) dir.set(0.6, -0.6, 0.5); // degenerate: fall back to iso-ish
    dir.normalize();

    camera.position.copy(center).addScaledVector(dir, distance);
    controls.target.copy(center);
    controls.update();
  }, [camera]);

  // Initialize camera once on mount - fixed position, not dependent on bounds
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!initializedRef.current && controlsRef.current) {
        // Set a fixed reasonable camera position (iso view of origin, distance ~20)
        camera.up.set(0, 0, 1);
        camera.position.set(12, -12, 10);
        controlsRef.current.target.set(0, 0, 0);
        controlsRef.current.update();
        initializedRef.current = true;
      }
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - truly only run once on mount

  // Auto-frame on the empty→loaded transition. The mount effect above places
  // the camera at a fixed iso view of origin, which leaves a real cloud out
  // of frame whenever its bounds don't coincide with [-5,5]³. We want to
  // fit on the first content load, but not fight the user every subsequent
  // time they pan or add a second cloud. Latch: reset only when the scene
  // goes empty again, so re-adding a cloud after Clear All re-frames.
  const hasFramedContentRef = useRef(false);
  useEffect(() => {
    if (!hasContent) {
      hasFramedContentRef.current = false;  // re-arm for the next load
      return;
    }
    if (hasFramedContentRef.current) return;
    if (!controlsRef.current) return;
    // Wait one tick so OrbitControls is mounted (the mount effect above
    // schedules its own setTimeout(0), so we don't have a hard ordering).
    const timer = setTimeout(() => {
      if (!controlsRef.current) return;
      snapToView('iso', bounds);
      hasFramedContentRef.current = true;
    }, 0);
    return () => clearTimeout(timer);
  }, [hasContent, bounds, snapToView]);

  useEffect(() => {
    (window as any).__resetPointCloudCamera = resetCamera;
    (window as any).__snapToView = snapToView;
    (window as any).__orientToAxis = orientToAxis;
    (window as any).__frameSelection = frameSelection;
    // Test hook: read live camera + controls + scene state without poking
    // R3F's internal store. Used by the M2 verification smoke test.
    // Test hook for the M2 smoke test: read camera + auto-frame latch + bounds.
    (window as any).__getCameraState = () => ({
      position: [camera.position.x, camera.position.y, camera.position.z],
      up: [camera.up.x, camera.up.y, camera.up.z],
      target: controlsRef.current
        ? [controlsRef.current.target.x, controlsRef.current.target.y, controlsRef.current.target.z]
        : null,
      framedContent: hasFramedContentRef.current,
      bounds: {
        min: [boundsRef.current.min.x, boundsRef.current.min.y, boundsRef.current.min.z],
        max: [boundsRef.current.max.x, boundsRef.current.max.y, boundsRef.current.max.z],
      },
    });
    return () => {
      delete (window as any).__resetPointCloudCamera;
      delete (window as any).__snapToView;
      delete (window as any).__orientToAxis;
      delete (window as any).__frameSelection;
      delete (window as any).__getCameraState;
    };
  }, [resetCamera, snapToView, orientToAxis, frameSelection, camera]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={enabled}
      enableDamping={false}
      screenSpacePanning={true}
      minDistance={0.1}
      maxDistance={10000}
      mouseButtons={{
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.PAN,
      }}
    />
  );
}
