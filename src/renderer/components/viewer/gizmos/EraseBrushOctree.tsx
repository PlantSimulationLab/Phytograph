import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { PointCloudOctree } from 'potree-core';
import { rayForNdc, worldPerPixelAt } from '../../../lib/cameraRay';

// Frozen camera + the painted square stamps for one erase session, in the
// exact shape crop_octree's `squares_union` region wants on Apply. `centers`
// and the matching brush half-size are in canvas pixels; the projection/view
// matrices + canvas size let the backend project every point to a pixel and
// test it against the squares (depth-independent — the square extrudes through
// the whole cloud).
export interface EraseSquareFrame {
  centers: { cx: number; cy: number }[];
  projection: number[];
  view: number[];
  canvas: { width: number; height: number };
}

// Erase-brush gizmo for octree-backed clouds — screen-space square stamps.
//
// UX: the parent toggles erase mode (toolbar button or `E`), which FREEZES the
// viewport camera. While in erase mode the brush square follows the cursor; the
// user CLICKS (or click-drags) to stamp squares, each cutting straight through
// the cloud along the view direction. The live GPU preview clips the points
// behind each stamp; Apply removes the union on the backend.
//
// Because the camera is frozen by the parent for the whole session, every stamp
// shares one camera — captured once on mount — so no orbit-reset bookkeeping is
// needed.
export interface EraseBrushOctreeProps {
  octree: PointCloudOctree | null;
  // Brush half-size in CANVAS PIXELS (screen-space, constant on screen).
  brushHalfPx: number;
  cloudCenter: { x: number; y: number; z: number };
  cloudDiagonal: number;
  // The frame painted so far (persisted in the parent across erase-mode
  // toggles). On mount we resume from it IF the camera still matches, so
  // toggling erase mode off and on in place keeps accumulating stamps rather
  // than discarding them. If the user reframed while mode was off, the camera
  // won't match and we start a fresh frame (old preview is replaced).
  initialFrame: EraseSquareFrame | null;
  // Replace the painted frame (centers + frozen camera) and the per-stamp
  // preview box transforms. Called as the user stamps.
  onFrameChange: (frame: EraseSquareFrame | null, previewBoxes: THREE.Matrix4[]) => void;
  // Move the visible brush indicator (a square facing the camera) to this
  // world transform, or null when off-canvas.
  onBrushTransformChange: (matrix: THREE.Matrix4 | null) => void;
  // True while the mouse button is held down stamping — drives the indicator
  // colour (red) and the gizmo-dragging flag in the parent.
  onErasingChange: (erasing: boolean) => void;
}

export function EraseBrushOctree({
  octree,
  brushHalfPx,
  cloudCenter,
  cloudDiagonal,
  initialFrame,
  onFrameChange,
  onBrushTransformChange,
  onErasingChange,
}: EraseBrushOctreeProps) {
  const { camera, gl } = useThree();

  // Accumulated stamp centers (pixels). The camera is frozen while erase mode
  // is active. Seeded from the parent's persisted frame on mount when the camera
  // matches (resume after a mode-toggle); see initialFrame.
  const centersRef = useRef<{ cx: number; cy: number }[]>([]);
  const lastStampRef = useRef<{ cx: number; cy: number } | null>(null);
  const mouseDownRef = useRef(false);

  useEffect(() => {
    // Resume the parent's painted frame on first interaction if the camera still
    // matches (an in-place erase-mode toggle). Done lazily — not at mount —
    // because the orthographic projection override applies over the next frames,
    // so the camera matrix isn't final at mount. If the camera differs (the user
    // reframed while mode was off), start fresh so we don't mix stamps from two
    // views into one frozen frame.
    let seeded = false;
    const matrixMatches = (a: number[], b: Float32Array | number[]): boolean => {
      for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-5) return false;
      return true;
    };
    const ensureSeeded = () => {
      if (seeded) return;
      seeded = true;
      if (
        initialFrame &&
        matrixMatches(initialFrame.view, camera.matrixWorldInverse.elements) &&
        matrixMatches(initialFrame.projection, camera.projectionMatrix.elements)
      ) {
        centersRef.current = initialFrame.centers.map(c => ({ ...c }));
      }
    };

    // Camera-aligned box transform for a square stamp: rotate to the camera
    // basis, translate to `worldCenter`, scale to (sidePx-in-world,
    // sidePx-in-world, deep). Depth spans well beyond the cloud so the box
    // punches all the way through (the GPU preview approximates the backend's
    // infinite screen-space extrusion). The cross-section is sized to match the
    // on-screen square AT THE ANCHOR DEPTH (the hovered surface) — under
    // perspective a fixed-pixel square is a fixed *angle*, so the matching world
    // size grows with distance from the camera; we evaluate it at the anchor so
    // the box lines up with the outline where the user is actually painting. The
    // backend's screen-space square test is the exact source of truth.
    const worldHalfXYAt = (worldPoint: THREE.Vector3): { hx: number; hy: number } => {
      const rect = gl.domElement.getBoundingClientRect();
      // Branches on the projection MATRIX, not the camera instance — erase mode
      // overrides a PerspectiveCamera's matrix to orthographic, so
      // isPerspectiveCamera stays true while the matrix is ortho. See
      // lib/cameraRay.ts.
      const wpp = worldPerPixelAt(camera, worldPoint, rect.width, rect.height);
      return { hx: brushHalfPx * wpp.x, hy: brushHalfPx * wpp.y };
    };

    const boxMatrix = (worldCenter: THREE.Vector3): THREE.Matrix4 => {
      const { hx, hy } = worldHalfXYAt(worldCenter);
      const rot = new THREE.Matrix4().extractRotation(camera.matrixWorld);
      const depth = Math.max(cloudDiagonal * 4, Math.max(hx, hy) * 8) || 1;
      const scale = new THREE.Matrix4().makeScale(hx * 2, hy * 2, depth);
      const trans = new THREE.Matrix4().makeTranslation(worldCenter.x, worldCenter.y, worldCenter.z);
      return trans.multiply(rot).multiply(scale);
    };

    // Anchor for the preview/indicator depth: the hovered surface point, else
    // the cursor ray projected to the cloud-center distance.
    //
    // `rayForNdc` (lib/cameraRay.ts) is used rather than
    // THREE.Raycaster.setFromCamera because erase mode runs under an
    // orthographic projection override while the camera is still a
    // PerspectiveCamera instance — setFromCamera would apply perspective ray
    // math and collapse every pick toward the view center.
    const anchorAt = (mouseNdc: THREE.Vector2): THREE.Vector3 => {
      const ray = rayForNdc(camera, mouseNdc);
      if (octree) {
        try {
          const hit = octree.pick(gl, camera, ray, {
            pickWindowSize: 17, pickOutsideClipRegion: true,
          });
          if (hit?.position) {
            return new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z);
          }
        } catch { /* fall through */ }
      }
      // No surface hit: drop the anchor onto the plane through the cloud center
      // facing the camera, at the cursor ray. closestPointToPoint gives the ray
      // point nearest the center — a stable depth for the preview box.
      const center = new THREE.Vector3(cloudCenter.x, cloudCenter.y, cloudCenter.z);
      return ray.closestPointToPoint(center, new THREE.Vector3());
    };

    const cameraMatrices = () => ({
      projection: Array.from(camera.projectionMatrix.elements),
      view: Array.from(camera.matrixWorldInverse.elements),
    });

    const emitFrame = () => {
      const rect = gl.domElement.getBoundingClientRect();
      const centers = centersRef.current;
      if (centers.length === 0) {
        onFrameChange(null, []);
        return;
      }
      const cam = cameraMatrices();
      onFrameChange(
        {
          centers: [...centers],
          projection: cam.projection,
          view: cam.view,
          canvas: { width: rect.width, height: rect.height },
        },
        centers.map(({ cx, cy }) => {
          const ndc = new THREE.Vector2(
            (cx / rect.width) * 2 - 1, -((cy / rect.height) * 2 - 1),
          );
          const world = anchorAt(ndc);
          return boxMatrix(world);
        }),
      );
    };

    const pixelOf = (e: MouseEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      return { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
    };

    const stampAt = (cx: number, cy: number) => {
      ensureSeeded();
      centersRef.current.push({ cx, cy });
      lastStampRef.current = { cx, cy };
      emitFrame();
    };

    const updateIndicator = (cx: number, cy: number) => {
      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2((cx / rect.width) * 2 - 1, -((cy / rect.height) * 2 - 1));
      const anchor = anchorAt(ndc);
      onBrushTransformChange(boxMatrix(anchor));
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // left button only
      mouseDownRef.current = true;
      onErasingChange(true);
      const { cx, cy } = pixelOf(e);
      updateIndicator(cx, cy);
      stampAt(cx, cy); // a single click stamps one square
    };

    const handleMouseMove = (e: MouseEvent) => {
      const { cx, cy } = pixelOf(e);
      updateIndicator(cx, cy);
      if (!mouseDownRef.current) return;
      // While dragging, stamp at ~half-brush spacing so a drag lays a
      // continuous overlapping strip (use the full brush half-size as the
      // pitch; squares are 2*half wide so consecutive stamps overlap ~50%).
      const last = lastStampRef.current;
      const pitch = Math.max(brushHalfPx, 6);
      if (!last || Math.hypot(cx - last.cx, cy - last.cy) >= pitch) {
        stampAt(cx, cy);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (mouseDownRef.current) {
        mouseDownRef.current = false;
        onErasingChange(false);
      }
    };

    gl.domElement.addEventListener('mousedown', handleMouseDown);
    gl.domElement.addEventListener('mousemove', handleMouseMove);
    // mouseup on window so releasing off-canvas still ends the stroke.
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      gl.domElement.removeEventListener('mousedown', handleMouseDown);
      gl.domElement.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (mouseDownRef.current) {
        mouseDownRef.current = false;
        onErasingChange(false);
      }
    };
  }, [camera, gl, octree, brushHalfPx, cloudCenter.x, cloudCenter.y, cloudCenter.z,
      cloudDiagonal, onFrameChange, onBrushTransformChange, onErasingChange]);

  return null;
}
