import { useRef, useCallback, useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { PointCloudData } from '../../../lib/pointCloudTypes';
import { zoomLimits, clampDollyToSurface } from '../../../lib/cameraScale';

// View direction type
export type ViewDirection = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

// How long the scene must stay empty before the auto-frame latch re-arms.
// Multi-cloud rebuilds (a crop applying across several selected scans) pass
// through frames with nothing visible; anything shorter than this is treated as
// such a gap rather than a cleared scene. Generous enough to span a slow
// backend round-trip between two clouds, short enough that a real Clear All
// followed by an immediate import still re-frames.
const EMPTY_SCENE_REARM_MS = 1000;

// Camera controller
export function CameraController({
  bounds,
  hasContent,
  enabled = true,
  displayOffset,
  orbitPivot,
  pickDepth,
}: {
  // Scene bounds, plus the robust ground level when the caller has one
  // (combinedBounds does). `groundZ` feeds the outlier-resistant scene scale
  // that the zoom limits derive from.
  bounds: PointCloudData['bounds'] & {
    groundZ?: number;
    robustExtent?: [number, number, number];
    // WORLD-space centre of the actual content (outlier-resistant). Defaults to
    // `center` when the scene carries no percentile box.
    contentCenter?: [number, number, number];
  };
  hasContent: boolean;
  enabled?: boolean;
  // Render-only display offset (Layer 2). `bounds` is in WORLD space (it is also
  // the gizmo/crop source of truth and must stay world); the camera and orbit
  // target live in DISPLAY space (world − offset) so they're small near huge UTM
  // coordinates. We convert world bounds centers to display space only at the
  // points where we write camera.position / controls.target. Defaults to origin.
  displayOffset?: { x: number; y: number; z: number };
  // WORLD-space point the view turns about (the scene origin — what the 3D-cursor
  // marker shows). When set, left-drag orbits about THIS point instead of the
  // OrbitControls target, so panning no longer moves the rotation center. Null
  // falls back to stock OrbitControls rotation about its target.
  //
  // The origin is the ROTATION PIVOT and the transform cursor — Blender's 3D
  // cursor — and deliberately NOT a zoom attractor. Zoom is driven by
  // zoom-to-cursor (see the wheel handler below), which is what makes every part
  // of the scene reachable regardless of where the origin sits.
  orbitPivot?: [number, number, number] | null;
  // Depth probe for zoom-to-cursor: returns the DISPLAY-space point of the
  // nearest geometry under the given viewport pixel, or null on a miss (empty
  // sky). Supplied by the viewer, which owns the octree registry.
  pickDepth?: (clientX: number, clientY: number) => THREE.Vector3 | null;
}) {
  const { camera, gl, scene } = useThree();
  const controlsRef = useRef<any>(null);
  const initializedRef = useRef(false);
  const boundsRef = useRef(bounds);

  // Keep bounds ref updated for snap functions (but don't trigger camera changes)
  boundsRef.current = bounds;

  // Live display offset in a ref so the memoized snap/frame callbacks read the
  // current value without being torn down each time it recomputes.
  const offsetRef = useRef(displayOffset);
  offsetRef.current = displayOffset;
  const displayCenter = useCallback((c: THREE.Vector3): THREE.Vector3 => {
    const o = offsetRef.current;
    return o ? new THREE.Vector3(c.x - o.x, c.y - o.y, c.z - o.z) : c.clone();
  }, []);

  // Live copies for the pivot-orbit listeners (installed once; reading refs keeps
  // them from being torn down and re-added on every pivot/enable change).
  const orbitPivotRef = useRef(orbitPivot);
  orbitPivotRef.current = orbitPivot;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Depth probe for zoom-to-cursor, in a ref so the wheel listener (installed
  // once) always calls the current one without being torn down.
  const pickDepthRef = useRef(pickDepth);
  pickDepthRef.current = pickDepth;

  // ── Zoom limits, scaled to the scene ──────────────────────────────────────
  //
  // Fixed limits (the old minDistance 0.1 / maxDistance 10000) are wrong at both
  // ends of the range this app spans: 0.1 m is a tenth of a potted plant but a
  // rounding error on a UTM plot, and 10000 can sit INSIDE a scene whose bounds
  // are inflated by a far outlier. Both are derived from a robust scene scale
  // that ignores outlier-inflated axes — see lib/cameraScale.ts.
  const limits = useMemo(
    () => zoomLimits({
      min: bounds.min,
      max: bounds.max,
      groundZ: bounds.groundZ,
      robustExtent: bounds.robustExtent,
    }),
    [bounds],
  );
  const limitsRef = useRef(limits);
  limitsRef.current = limits;

  // WORLD-space content centre, for the zoom fallback anchor (see the wheel
  // handler). Falls back to the raw bounds centre on a scene with no percentile
  // box; that is the pre-existing behavior and is correct when there are no
  // outliers to reject.
  const contentCentreRef = useRef<[number, number, number]>([0, 0, 0]);
  contentCentreRef.current = bounds.contentCenter
    ?? [bounds.center.x, bounds.center.y, bounds.center.z];

  // What "fit everything" should actually fit: the CONTENT, not the raw bounding
  // box. Framing the raw box on a scene with far outliers aims the camera at
  // empty space between the strays and pulls it back far enough to hold them,
  // so the data lands as a speck well off the view axis. Zoom cannot rescue
  // that — a dolly moves along the view ray and never corrects a lateral offset
  // — so the fix has to be here, at the framing step.
  //
  // Built from the robust centre + extent when the scene has them, else the raw
  // bounds unchanged (the pre-existing behavior, correct with no outliers).
  const framingBounds = useMemo(() => {
    const e = bounds.robustExtent;
    const c = bounds.contentCenter;
    if (!e || !c) return { center: bounds.center, size: bounds.size };
    return {
      center: new THREE.Vector3(c[0], c[1], c[2]),
      size: new THREE.Vector3(e[0], e[1], e[2]),
    };
  }, [bounds]);
  const framingBoundsRef = useRef(framingBounds);
  framingBoundsRef.current = framingBounds;

  const snapToView = useCallback((direction: ViewDirection, target?: { center: THREE.Vector3, size: THREE.Vector3 }) => {
    if (!controlsRef.current) return;

    // Use provided target or fall back to global bounds. Both are WORLD-space;
    // convert the center to DISPLAY space (world − offset) since the camera and
    // orbit target render in display space.
    // No explicit target means "fit everything" — which means the CONTENT, so
    // far outliers can't aim the camera at empty space (see `framingBounds`).
    const { center: worldCenter, size } = target || framingBoundsRef.current;
    const center = displayCenter(worldCenter);
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

    // Aim at exactly what was framed. The scene origin deliberately does NOT
    // override the look-at height any more: zoom no longer converges on the
    // target alone (zoom-to-cursor walks toward whatever is under the pointer),
    // so bending framing toward the origin would only mis-centre the view
    // without buying the reachability it used to be there for.
    camera.position.copy(newPos);
    controlsRef.current.target.copy(center);
    controlsRef.current.update();
  }, [camera, displayCenter]);

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
    // As in snapToView: the no-target "fit everything" form fits the CONTENT.
    const { center: worldCenter, size } = target || framingBoundsRef.current;
    const center = displayCenter(worldCenter);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const distance = maxDim * 2;

    // Preserve the current orbit direction (camera relative to its target).
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (dir.lengthSq() < 1e-12) dir.set(0.6, -0.6, 0.5); // degenerate: fall back to iso-ish
    dir.normalize();

    // Aim at exactly what was framed, explicit target or whole-scene fit alike.
    camera.position.copy(center).addScaledVector(dir, distance);
    controls.target.copy(center);
    controls.update();
  }, [camera, displayCenter]);

  // Frame the scene origin explicitly: keep the current viewing angle, but
  // re-centre on the origin at a comfortable distance. This is the deliberate
  // "take me to the pivot" command (Blender's numpad-`.`), and it replaces the
  // implicit origin-anchoring that framing used to do — the reachability is now
  // a command the user invokes, not a rule that silently bends every reframe.
  const frameSceneOrigin = useCallback(() => {
    const pivotWorld = orbitPivotRef.current;
    if (!controlsRef.current || !pivotWorld) return;
    // Zero size: frameSelection would divide by a degenerate maxDim, so give it
    // a box scaled to the scene — a fraction of the robust scale, which puts the
    // camera near the origin without burying it inside the geometry.
    const s = limitsRef.current.scale * 0.15;
    frameSelection({
      center: new THREE.Vector3(pivotWorld[0], pivotWorld[1], pivotWorld[2]),
      size: new THREE.Vector3(s, s, s),
    });
  }, [frameSelection]);

  // ── Zoom to cursor ────────────────────────────────────────────────────────
  //
  // THE fix for "I can't get to that part of the scene". Stock OrbitControls
  // dollies along camera→`controls.target`, so zoom only ever converges on the
  // target — and no gesture moves the target toward what you are looking at:
  // pan slides the view sideways (screen-space, perpendicular to the view
  // direction) and never shortens camera→target. On a big scene with far
  // outliers the target sits at the inflated bounds centre, possibly hundreds of
  // metres from the content, and the region you want is simply unreachable.
  //
  // Here the wheel instead moves BOTH camera and target toward the point under
  // the pointer, the way CloudCompare, Potree, MeshLab and Blender all do it.
  // The anchor comes from a real depth pick against the octree (`pickDepth`), so
  // it is the actual surface you are pointing at, not a plane through the target.
  // Whatever you can see, you can fly to — which also makes the scene origin's
  // position irrelevant to zoom, as it should be.
  //
  // On a miss (pointing at empty sky) we fall back to a plain dolly along the
  // view direction, keeping the target ahead of the camera. That still gets you
  // somewhere sane, unlike the stock behaviour, because the target follows.
  useEffect(() => {
    const el = gl.domElement;

    // ── The anchor is LATCHED for the duration of a scroll gesture ───────────
    //
    // Re-picking per notch is what broke this. `clampDollyToSurface` only bounds
    // a step against the anchor IT WAS GIVEN, so it cannot prevent overshoot when
    // the anchor changes underneath it: the depth probe legitimately misses on
    // some notches (sparse data at the pointer, or its 8 ms budget guard backing
    // off for 250 ms under octree streaming load), and a miss substitutes a
    // far-away fallback anchor. One notch computed against that distant anchor
    // takes a step large enough to fly the camera PAST the near surface the
    // previous notches were converging on. From there camera→anchor points
    // backward, `anchorDist` is effectively negative, and every further "zoom in"
    // notch dollies the camera AWAY — the scroll direction silently inverts and
    // zoom appears frozen. (Rotating "fixed" it only because orbiting rebuilds
    // the camera/target relationship from scratch.)
    //
    // So the anchor is captured once, on the first notch of a gesture, and reused
    // until the gesture ends. Every notch in a burst then measures against the
    // SAME world point, which is what makes the asymptotic near clamp actually
    // asymptotic and makes a run of notches converge instead of diverge.
    //
    // The latch is invalidated by: an idle gap (a new gesture), the pointer
    // moving far enough to be aiming at something else, or a reversal of scroll
    // direction. Anything else — including a probe miss mid-burst — keeps flying
    // at the point the user originally aimed at, which is also what they meant.
    // Idle gap that ends a gesture. Measured wheel-to-wheel spacing on an idle
    // machine is 23-75 ms, but that is the best case: while the octree streams,
    // or the app is otherwise busy, the main thread stalls and notches from one
    // continuous flick arrive much further apart. A threshold near the idle
    // spacing therefore expires the latch BETWEEN notches of a single gesture
    // exactly when the machine is under load — every notch then re-probes, the
    // gesture never coheres, and zoom degenerates into the lurching that the
    // latch exists to prevent (reproduced under two parallel E2E workers: a
    // burst that made no progress at all, and a step 75x its predecessor).
    // Sized well above the worst observed spacing; the cost of being generous is
    // only that a deliberate pause under ~0.4 s keeps flying at the old anchor.
    const GESTURE_IDLE_MS = 400;
    const GESTURE_MOVE_PX = 40;      // beyond this the cursor is on a new subject
    // Closest the camera may get to the content centre, as a fraction of the
    // scene scale. Keeps a deep zoom inspecting the subject rather than passing
    // through the middle of it — see the clamp in the wheel handler.
    const CONTENT_APPROACH_FLOOR = 0.02;
    // Largest single-notch step, as a fraction of the scene scale. Bounds the
    // zoom-out feedback loop (speed ∝ distance, and zooming out grows distance).
    const PACE_CEILING = 2;
    // Farthest the camera may get from the content centre, as a fraction of the
    // scene scale. The auto-frame sits at ~2x the scene size, so this leaves
    // ample room to pull back and see everything while keeping the scene from
    // receding to a dot that no further notch can recover from.
    const CONTENT_RETREAT_CEILING = 12;
    let latch: {
      anchor: THREE.Vector3;
      x: number;
      y: number;
      time: number;
      zoomIn: boolean;
    } | null = null;

    const onWheel = (e: WheelEvent) => {
      if (!enabledRef.current) return;
      const controls = controlsRef.current;
      if (!controls) return;
      // Only take over plain scroll. Modifier+wheel is left to whatever else
      // wants it (and to OrbitControls' own handling).
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

      e.preventDefault();
      e.stopPropagation();

      const { minDistance, maxDistance } = limitsRef.current;

      // ── Notches: never DISCARD scroll input ─────────────────────────────────
      //
      // Fraction of the remaining gap to close, compounding at 0.82 per notch.
      // deltaY is normalised per notch (~100px on most mice; a trackpad sends
      // many small deltas, which compose to the same rate).
      //
      // The clamp used to be ±4, which silently turned the frame rate into a
      // zoom gain — the cause of "zoom gets more sensitive the further in you
      // go, and I shoot past the ground". Zoom advances per EVENT, not per
      // second, and when the scene is heavy the main thread stalls so the OS
      // COALESCES wheel events: ten physical notches arrive as a couple of
      // events carrying a large deltaY. Clamping at 4 threw the surplus away, so
      // a flick over the full cloud travelled less than it was asked to. Zoomed
      // in the scene is cheap, nothing coalesces, every notch arrives as its own
      // event and all of it counts — the identical flick then delivers its full
      // travel and overshoots.
      //
      // The compounding is ASSOCIATIVE — 0.82^a * 0.82^b == 0.82^(a+b) — so a
      // coalesced event carrying N notches produces exactly the same travel as N
      // separate one-notch events, PROVIDED none of it is discarded. Verified:
      // ten notches spent as 10x1 or as 4+4+2 both close 0.8626 of the gap,
      // while 4+4 with the remainder dropped closes only 0.7956.
      //
      // So the clamp only has to be high enough never to bite on real input. A
      // physical wheel emits at most a handful of notches per frame even when
      // coalesced; 40 is far beyond that, while still bounding a pathological
      // deltaY (some drivers report pixel deltas in the thousands) so one event
      // cannot swallow the whole scene.
      const notches = Math.max(-40, Math.min(40, e.deltaY / 100));
      if (notches === 0) return;
      const zoomIn = notches < 0;
      const fraction = 1 - Math.pow(0.82, Math.abs(notches));

      const camPos = camera.position;
      const target: THREE.Vector3 = controls.target;

      // ── Pace: how far one notch travels, set by the CONTENT distance ────────
      //
      // Deliberately NOT derived from the anchor gap, and not from
      // `|camera − target|` either. The target is re-seated onto the anchor gap
      // after the dolly (it has to be, so pan sensitivity stays right), so
      // reading speed back off either one creates a feedback loop: gap sets
      // speed, the near clamp shrinks the gap, speed decays to nothing. Measured
      // doing exactly that — steps fell from 17.3 to 0.026 across one burst,
      // which is the "it gets laggy then momentarily freezes" report.
      //
      // Distance to the content centre is the one quantity here that does NOT
      // collapse as the camera closes on a surface: fly onto a leaf and you are
      // still a real distance from the middle of the tree. Floored near the
      // scene scale so sitting at the centre (or a degenerate scene) still gives
      // a usable step. Scale-free, continuous across a re-probe, never decays.
      // The anchor steers; this sets the pace.
      //
      // CEILED as well as floored, which is not optional for zoom-OUT. Speed is
      // proportional to the content distance, and zooming out increases that
      // distance — so without a ceiling the two feed each other and the camera
      // escapes exponentially. Measured on the 13 M-point cloud: successive
      // zoom-out notches stepped 84 → 102 → 124 → 150 → 182 world units and the
      // camera ended ~1000 units from a 41 m tree, where the scene is a
      // sub-pixel dot and every further notch is a no-op. That reads exactly
      // like a freeze, and it is reached by the reported gesture — fast in,
      // then straight back out. `maxDistance` could not catch it because the
      // outer clamp below is written against the ANCHOR distance, not against
      // how far the camera is from the scene.
      const oPace = offsetRef.current;
      const ccPace = contentCentreRef.current;
      const contentDist = camPos.distanceTo(new THREE.Vector3(
        ccPace[0] - (oPace?.x ?? 0),
        ccPace[1] - (oPace?.y ?? 0),
        ccPace[2] - (oPace?.z ?? 0),
      ));
      const pace = Math.min(
        Math.max(contentDist, limitsRef.current.scale * 0.02),
        limitsRef.current.scale * PACE_CEILING,
      );

      // Reuse the latched anchor when this notch continues the same gesture.
      //
      // The latch keeps the DIRECTION stable; step size no longer depends on it.
      // But it must still be released once the camera has arrived, or the near
      // clamp pins the camera against it and zoom hits a hard wall — measured
      // stopping dead at 0.004 from a consumed anchor and never moving again,
      // however long the user kept scrolling.
      //
      // "Arrived" is defined by the clamp that actually stops the motion rather
      // than by a tuned distance: `clampDollyToSurface` lets a step close at most
      // (1 − stopFraction) of the gap, so once the requested step exceeds the gap
      // the clamp is what governs, the camera is as close as this anchor will
      // ever allow, and the anchor has nothing left to give. Re-probing then
      // finds the surface now under the pointer and the approach continues.
      const now = performance.now();
      const arrived = latch
        ? camera.position.distanceTo(latch.anchor) <= pace * fraction
        : false;
      const reuse = latch
        && !arrived
        && now - latch.time < GESTURE_IDLE_MS
        && latch.zoomIn === zoomIn
        && Math.abs(e.clientX - latch.x) < GESTURE_MOVE_PX
        && Math.abs(e.clientY - latch.y) < GESTURE_MOVE_PX;

      // The anchor this gesture was flying at before a re-probe, kept so a
      // zoom-in can refuse a receding replacement (see below). Only meaningful
      // while the gesture continues — an idle gap means a genuinely new aim.
      const prevAnchor = latch && now - latch.time < GESTURE_IDLE_MS && latch.zoomIn === zoomIn
        ? latch.anchor
        : null;

      let anchor: THREE.Vector3;
      if (reuse && latch) {
        anchor = latch.anchor;
      } else {
        // Anchor: the surface under the pointer, else a point on the CURSOR ray.
        const picked = pickDepthRef.current?.(e.clientX, e.clientY) ?? null;
        if (picked) {
          anchor = picked;
        } else {
          // Fallback for a probe miss. It must lie along the ray THROUGH THE
          // CURSOR, not along camera→target: the whole promise of zoom-to-cursor
          // is that the thing under the pointer stays put while everything else
          // expands around it, and an anchor on the view axis moves the camera
          // straight ahead instead. That is why zooming near the edge of the
          // viewport used to drift and stall — the probe misses most often out
          // there (fewer points under the pointer), and the fallback quietly
          // degraded every one of those notches to an on-axis dolly.
          //
          // The old form also decelerated to a standstill: it projected the
          // content centre onto the view ray, and that projection shrinks as the
          // camera approaches the centre plane, so `step` (a fraction of the
          // remaining gap) shrank toward zero while the user kept scrolling.
          //
          // Distance along the cursor ray comes from the content centre's depth
          // measured along the VIEW direction — "how far away is the subject" —
          // which stays finite and stable as the camera closes in. The centre
          // must be the CONTENT's, not the raw bounding box's: with far outliers
          // the box centre sits in empty space among the strays.
          const o = offsetRef.current;
          const cc = contentCentreRef.current;
          const sceneCentre = new THREE.Vector3(
            cc[0] - (o?.x ?? 0),
            cc[1] - (o?.y ?? 0),
            cc[2] - (o?.z ?? 0),
          );
          const viewDir = new THREE.Vector3().subVectors(target, camPos);
          if (viewDir.lengthSq() < 1e-18) return;
          viewDir.normalize();

          // Depth of the subject ahead of the camera. Behind us (already flown
          // past the scene) or degenerate: fall back to the current look-at
          // distance so a zoom still does something sane instead of reversing.
          let depth = sceneCentre.clone().sub(camPos).dot(viewDir);
          if (!(depth > 1e-6)) depth = camPos.distanceTo(target);
          if (!(depth > 1e-6)) return;

          // Ray through the cursor, in world space.
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          const ndc = new THREE.Vector3(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
            0.5,
          );
          const cursorDir = ndc.unproject(camera).sub(camPos);
          if (cursorDir.lengthSq() < 1e-18) return;
          cursorDir.normalize();

          // Place the anchor at the subject's depth along the cursor ray. Divide
          // by cos(angle to the view axis) so the anchor sits on the same depth
          // PLANE as the subject rather than on a sphere around the camera —
          // otherwise an off-centre cursor would anchor short of the content.
          const cosA = cursorDir.dot(viewDir);
          const alongCursor = cosA > 1e-3 ? depth / cosA : depth;
          anchor = camPos.clone().addScaledVector(cursorDir, alongCursor);
        }
        // A zoom-IN must never adopt an anchor farther away than the one it just
        // arrived at. Once the camera reaches a surface the latch is released and
        // the next probe reports whatever is now under the pointer — which, from
        // right on top of a leaf, is routinely something well BEHIND it (measured
        // at the periphery: 0.87 → 29.05). Flying at that carries the camera back
        // out through the canopy while the user is still scrolling inward, so the
        // view recedes on a zoom-in. Keeping the old anchor makes the motion
        // simply stop at the surface, which is the honest outcome: there is
        // nothing closer under the cursor to fly to.
        // Only ever a defence against a real PICK receding. Applying it to the
        // fallback deadlocks: pointing at empty sky near the edge of a small scene
        // misses every time, the fallback legitimately sits at content depth
        // (farther than a surface the camera reached earlier in the gesture),
        // and substituting that consumed anchor pins the camera against it via
        // clampDollyToSurface — measured frozen at 11.819 for 20 straight
        // notches with the approach floor nowhere near engaging.
        if (
          zoomIn && picked && prevAnchor
          && camPos.distanceTo(anchor) > camPos.distanceTo(prevAnchor) + 1e-6
        ) {
          anchor = prevAnchor;
        }
        latch = { anchor: anchor.clone(), x: e.clientX, y: e.clientY, time: now, zoomIn };
      }
      if (latch) latch.time = now;

      // Move along camera→anchor (not camera→target): that is what makes the
      // pointed-at point stay put on screen while everything else expands around
      // it, and what lets the target migrate toward the region of interest.
      const toAnchor = new THREE.Vector3().subVectors(anchor, camPos);
      const anchorDist = toAnchor.length();
      if (anchorDist < 1e-9) return;
      toAnchor.normalize();

      // ── Speed comes from the SUBJECT DISTANCE, not from the anchor gap ──────
      //
      // The anchor's job is to set the DIRECTION (that is what makes the point
      // under the cursor stay put). Deriving the step size from it as well is
      // what produced every remaining artefact, because the anchor gap is not a
      // stable quantity:
      //
      //   • Latched, it shrinks geometrically. A 25-notch burst decayed from 9.9
      //     world units per notch to 0.03 and parked 34.9 from the content — the
      //     "momentary freeze" where scrolling visibly does nothing.
      //   • Re-probed, it jumps discontinuously. A fresh pick can be nearer than
      //     the old anchor (one notch then teleports the camera into the
      //     geometry — the over-zoom) or FARTHER, when the camera has already
      //     passed the near surface and the probe returns something beyond it
      //     (measured: 17.2 → 20.8, after which the camera flew away from the
      //     content while still "zooming in").
      //
      // Speed comes from `pace` (see above), not from this gap.
      let step = pace * fraction * (zoomIn ? 1 : -1);

      // ── Don't fly INTO the content ──────────────────────────────────────────
      //
      // `clampDollyToSurface` below stops the camera short of the surface it is
      // flying at, which is the right guard in open space but provides no
      // protection once the camera is inside the cloud: from in there the
      // nearest surface is millimetres away in every direction, the probe keeps
      // returning it (measured: an anchor 0.004 out, notch after notch), and
      // "stop 2% short of 4 mm" still lets the camera sit buried in the canopy
      // with nothing on screen. That is the "over-zooms until no points are in
      // view" half of the report, and it is why the scene-scaled `minDistance`
      // (scale/1e4 = 4 mm here) never caught it either.
      //
      // So bound the approach by distance to the CONTENT as well. The floor is a
      // fraction of the content's own size rather than of the derived scene
      // scale: 2% of a 41 m tree is ~0.8 m, which puts the camera close enough
      // to inspect an individual branch while still leaving the subject in
      // frame. (A floor keyed to the scale alone came out at 0.165 m — still
      // buried inside the canopy, with the tree filling the entire frustum.)
      if (step > 0) {
        const floor = limitsRef.current.scale * CONTENT_APPROACH_FLOOR;
        const room = contentDist - floor;
        step = room <= 0 ? 0 : Math.min(step, room);
      } else if (step < 0) {
        // Symmetric outward bound. The ceiling on `pace` slows the runaway but
        // does not stop it — the camera would still crawl outward forever, and
        // once the scene is a distant speck the view is unrecoverable by
        // scrolling. This is the clamp `maxDistance` was meant to be, expressed
        // against the thing that actually matters: how far the camera is from
        // the CONTENT (maxDistance is applied to the anchor gap, which under a
        // rigid camera+target move says nothing about that).
        const ceiling = limitsRef.current.scale * CONTENT_RETREAT_CEILING;
        const room = ceiling - contentDist;
        step = room <= 0 ? 0 : -Math.min(-step, room);
      }

      // Near clamp — never tunnel through what you are flying at. Asymptotic, so
      // a surface can be approached arbitrarily closely but never crossed.
      //
      // This applies to the FALLBACK anchor too, not just a real depth pick.
      // Without it, a zoom into empty sky walks the camera up to (and then past)
      // the fallback anchor; once the camera crosses it, camera→anchor flips
      // direction and every further "zoom in" notch drives the camera BACKWARD,
      // accelerating away from the scene. The scale clamps below cannot catch
      // that, because camera and target translate rigidly and their separation
      // never changes. `clampDollyToSurface` keeps the camera on its own side of
      // the anchor, which makes the direction flip unreachable.
      step = clampDollyToSurface(step, anchorDist);

      // Outer clamps from the scene scale, applied to the resulting distance to
      // the ANCHOR — the point the motion is actually relative to. (Clamping
      // camera→target instead is a no-op here: the rigid camera+target move keeps
      // that distance constant by construction.)
      //
      // Each clamp only ever restrains motion in ITS OWN direction. Applying them
      // unconditionally is a trap: the camera can legitimately START beyond
      // maxDistance — the initial auto-frame sits outside the robust extent
      // whenever the raw bounds are outlier-inflated — and a blanket
      // `next > maxDistance` test then claws back every inbound step, so zooming
      // in from a wide view crawls and never arrives. Same in reverse for
      // minDistance once you are already very close.
      const nextAnchorDist = anchorDist - step;
      if (step > 0 && nextAnchorDist < minDistance) step = anchorDist - minDistance;
      if (step < 0 && nextAnchorDist > maxDistance) step = Math.min(0, anchorDist - maxDistance);
      if (Math.abs(step) < 1e-12) return;

      // Move camera AND target together — a rigid translation along the anchor
      // ray. The target ending up near what you zoomed into is the point: the
      // next orbit/pan/zoom all operate about the region you chose.
      const delta = toAnchor.multiplyScalar(step);
      camPos.add(delta);
      target.add(delta);

      // ── Keep |camera − target| meaning "distance to what I'm looking at" ──
      //
      // OrbitControls derives its PAN step from that distance:
      //   pan_world_per_pixel = 2 * |camera − target| * tan(fov/2) / clientHeight
      // (see panLeft/panUp in three-stdlib), which is the correct formula — it
      // makes a full-height drag move the view by one screen-height of world
      // space at the target's depth, so panning tracks the cursor 1:1 at any
      // zoom. But it only works if the distance actually tracks how far away the
      // subject is.
      //
      // The rigid translation above breaks exactly that: it moves camera and
      // target by the same vector, so their separation is INVARIANT under zoom.
      // Measured before this fix, |camera − target| sat at 11.82 through every
      // zoom level, so a 100 px pan threw the view 1.89 world units whether the
      // camera was 12 m out or 2 m from the plants — which reads as wildly
      // oversensitive panning once you are close in.
      //
      // So after the dolly, re-seat the target at the distance of whatever we
      // zoomed toward. The camera keeps the position the dolly gave it; only the
      // look-at DISTANCE is corrected, to the thing we actually flew at. Pan
      // speed then falls out of the standard formula with no extra tuning
      // constant, and is automatically right at every scale — which is what
      // makes this robust rather than a hand-fitted sensitivity curve.
      //
      // The anchor serves for this whether or not the GPU pick landed. A real
      // depth pick is the exact surface under the cursor; the fallback sits at
      // the subject's depth along the cursor ray, which is still a sound
      // estimate of "how far away is the subject" — and it is the case that
      // matters most in practice, because potree's `pick` renders a small window
      // and reads it back, so it legitimately misses on sparse clouds (measured:
      // 0 hits in 30 notches on a 209-point fixture). Keying the correction to a
      // successful pick would have left pan sensitivity unfixed exactly there.
      //
      // CLAMPED INTO THE CONTROLS' OWN RANGE, which is not optional. The
      // `controls.update()` below re-derives the camera position from the
      // spherical radius |camera − target| after clamping it into
      // [minDistance, maxDistance] (three-stdlib OrbitControls, `update()`).
      // Re-seating the target closer than minDistance therefore had the update
      // immediately shove the camera back out along the target ray, cancelling
      // the dolly — zoom died permanently, and only an orbit (which rebuilds the
      // offset) revived it. Keeping the re-seat inside the range means the
      // clamp is a no-op and the dolly always survives the update.
      const anchorDistAfter = Math.min(
        Math.max(anchorDist - step, minDistance),
        maxDistance,
      );
      {
        // Preserve the VIEW DIRECTION — re-seating must not rotate the camera.
        // Move the target along the existing camera→target ray, NOT onto the
        // anchor point itself (which is off-axis whenever the cursor isn't
        // dead-centre; putting the target there would swing the view and turn
        // every zoom into an orbit).
        const dir = new THREE.Vector3().subVectors(target, camPos);
        if (dir.lengthSq() > 1e-18) {
          target.copy(camPos).addScaledVector(dir.normalize(), anchorDistAfter);
        }
      }

      controls.update();
    };

    // Capture phase + non-passive so we win over both OrbitControls' own wheel
    // listener and R3F's, and can preventDefault to stop the page from scrolling.
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => el.removeEventListener('wheel', onWheel, { capture: true } as any);
  }, [camera, gl]);

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
  // Whether the framing we already performed was based on the robust content box
  // rather than the raw bounds. The two arrive at different times: a cloud's
  // bounds are known as soon as the octree metadata lands, but `robustExtent`
  // comes from the same response and is threaded through `combinedBounds`, so on
  // the empty→loaded transition this effect can fire once with only the raw box
  // available. Framing the raw box on an outlier-heavy scene parks the camera
  // hundreds of metres out, aimed at empty space between the strays — and the
  // plain latch would then never correct it. So we re-frame exactly once more,
  // when the robust box first becomes available.
  const framedRobustRef = useRef(false);
  // Re-arming is DEFERRED, because "no content this render" does not mean the
  // scene was cleared. Multi-cloud operations rebuild their clouds one at a
  // time (crop applies per selected scan, hiding the source before its
  // replacement mounts, with a setTimeout(0) yield between iterations), so
  // React commits real frames in which every scan is hidden. Re-arming
  // immediately made the NEXT cloud to appear look like a first load, so the
  // camera re-framed once per cloud produced — the view visibly jumping around
  // as a crop applied. Only a scene that STAYS empty (File → New, Clear All,
  // deleting the last cloud) should re-arm.
  const rearmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (rearmTimerRef.current !== null) clearTimeout(rearmTimerRef.current);
  }, []);
  useEffect(() => {
    if (!hasContent) {
      // Wait out the transient gap; a genuine clear leaves this to fire.
      if (rearmTimerRef.current === null) {
        rearmTimerRef.current = setTimeout(() => {
          rearmTimerRef.current = null;
          hasFramedContentRef.current = false;
          framedRobustRef.current = false;
        }, EMPTY_SCENE_REARM_MS);
      }
      return;
    }
    // Content came back before the timer fired — this was a rebuild, not a
    // clear. Cancel the re-arm so the existing framing is kept.
    if (rearmTimerRef.current !== null) {
      clearTimeout(rearmTimerRef.current);
      rearmTimerRef.current = null;
    }
    const haveRobust = !!(bounds.robustExtent && bounds.contentCenter);
    // Already framed, and either we used the robust box or there is none to
    // upgrade to — nothing to do. (Without the second clause a scene that never
    // gets a robust box would re-frame on every bounds change, fighting the user.)
    if (hasFramedContentRef.current && (framedRobustRef.current || !haveRobust)) return;
    if (!controlsRef.current) return;
    // Wait one tick so OrbitControls is mounted (the mount effect above
    // schedules its own setTimeout(0), so we don't have a hard ordering).
    const timer = setTimeout(() => {
      if (!controlsRef.current) return;
      // Frame the CONTENT, not the outlier-inflated raw bounds.
      snapToView('iso', framingBoundsRef.current);
      hasFramedContentRef.current = true;
      framedRobustRef.current = haveRobust;
    }, 0);
    return () => clearTimeout(timer);
  }, [hasContent, bounds, snapToView]);

  // NOTE: there is deliberately NO effect here that re-centers the view when the
  // scene origin moves. The origin tracks the scene bounds by default, so it
  // changes whenever content is added — and an effect on it would fight the
  // explicit framing paths (frameMeshInViewport / frameScanInViewport, which
  // frame a newly added mesh or an off-frame scan on its own bounds) by yanking
  // the camera back to the origin right after they ran. Re-anchoring happens
  // only through the framing calls themselves (see `anchorCenter`).

  // Adapt the perspective near/far planes for depth precision AND to keep the
  // infinite ground grid from clipping. The Canvas seeds a fixed near=0.01 /
  // far=10000, wrong at both extremes: a large scene clips at the far plane, and
  // (worse) a tiny near against a far that dwarfs the content wastes depth-buffer
  // precision near the origin, so coplanar geometry — the ground grid, or two
  // synthetic scans sampling the same z=0 plane — z-fights and flickers.
  //
  // Both planes track the LIVE camera→target distance on every move (depth
  // precision is governed by the far/near *ratio*, not the absolute planes, and
  // tracking dist holds that ratio ≈ constant ~4000 at any zoom):
  //
  // - NEAR = clamp(dist/1000, 1e-6, minDistance): pushed as far out as it can go
  //   without clipping (never beyond the scene-scaled minDistance, so the orbit
  //   target is never clipped), pulled in as you dolly toward a surface. A near
  //   pinned at 0.01 is 100x closer than needed when orbiting a metre-scale scene
  //   metres out, and that tiny near is what crushes precision near z=0. The
  //   ceiling tracks minDistance rather than a hardcoded 0.1 because zoom limits
  //   are now scene-scaled — on a small scene a 0.1 near would clip the content
  //   the user zoomed in to inspect.
  // - FAR = max(diag*4, dist*4): the infinite grid fades out by ~fadeDistance =
  //   dist*1.5 (see GroundGrid), so the farthest visible grid fragment sits ~dist*2.5
  //   from the camera; dist*4 clears that with margin so the grid always *fades* and
  //   never hits a hard far-plane cut. Floored at diag*4 (diag = scene diagonal) so a
  //   camera parked close to a large scene still renders the whole scene. The old FAR
  //   was bounds-only (max(100, diag*4)) and never tracked the camera, so on a small
  //   scene the camera could orbit past far=100 (maxDistance is 10000) and the grid
  //   culled abruptly.
  //
  // Event-driven (OrbitControls 'change'), so it costs nothing while idle; both
  // planes share one updateProjectionMatrix() per move. Pure projection-matrix
  // change — no per-fragment cost. (We deliberately do NOT use a logarithmic depth
  // buffer: it fixes precision globally but forces every fragment to write
  // gl_FragDepth, disabling early-Z and collapsing heavy point clouds to single-digit fps.)
  useEffect(() => {
    const persp = camera as THREE.PerspectiveCamera;
    if (!persp.isPerspectiveCamera) return;
    let controls: any = null;
    const updatePlanes = () => {
      if (!controls) return;
      const diag = boundsRef.current.size.length() || 1;
      const dist = persp.position.distanceTo(controls.target);
      const near = Math.min(limitsRef.current.minDistance, Math.max(1e-6, dist / 1000));
      const far = Math.max(diag * 4, dist * 4);
      let dirty = false;
      if (persp.near !== near) { persp.near = near; dirty = true; }
      if (persp.far !== far) { persp.far = far; dirty = true; }
      if (dirty) persp.updateProjectionMatrix();
    };
    // Defer one tick so OrbitControls is mounted (mirrors the framing effect above,
    // which has no hard ordering guarantee against the controls' own setTimeout(0)).
    const timer = setTimeout(() => {
      controls = controlsRef.current;
      if (!controls) return;
      updatePlanes();
      controls.addEventListener('change', updatePlanes);
    }, 0);
    return () => {
      clearTimeout(timer);
      if (controls) controls.removeEventListener('change', updatePlanes);
    };
  }, [bounds, camera, hasContent]);

  // ── Pivot orbit: turn the view about the scene origin, not the pan target ──
  //
  // Stock OrbitControls always rotates about `controls.target`, and panning
  // TRANSLATES that target — so every pan silently moved the rotation center,
  // and the 3D-cursor marker (which is the Transform tool's pivot) disagreed
  // with what the view actually turned about. Here a left-drag instead applies
  // ONE rigid rotation about the pivot to both `camera.position` and
  // `controls.target`, so the whole view swings around that fixed world point
  // even when it sits off-center after a pan. Panning still moves the view
  // freely; it just no longer decides what you rotate around.
  //
  // The deltas mirror three-stdlib's own rotate math so the feel is unchanged
  // (and so pivot == target reduces exactly to the stock behavior):
  //   Δθ = −2π·dx/clientHeight about camera.up      (its rotateLeft)
  //   Δφ = −2π·dy/clientHeight about the camera right axis (its rotateUp)
  // In three's spherical convention, adding Δθ to `theta` IS a right-handed
  // rotation about the up axis, and adding Δφ to `phi` is a right-handed
  // rotation about cross(up, position − target) — i.e. the camera's right
  // vector — which is why these two axes reproduce OrbitControls exactly.
  //
  // Rotation is disabled on the controls themselves (`enableRotate={false}`)
  // whenever a pivot is supplied, so the two can never both run. Zoom, and pan
  // on middle/right (and shift+left, which three-stdlib routes to pan), are
  // untouched and still owned by OrbitControls.
  useEffect(() => {
    const el = gl.domElement;
    const EPS = 1e-4;
    let dragging = false;
    let last = { x: 0, y: 0 };

    const rotateAboutPivot = (dx: number, dy: number) => {
      const controls = controlsRef.current;
      const pivotWorld = orbitPivotRef.current;
      if (!controls || !pivotWorld) return;
      const height = el.clientHeight || 1;

      const o = offsetRef.current;
      const P = new THREE.Vector3(
        pivotWorld[0] - (o?.x ?? 0),
        pivotWorld[1] - (o?.y ?? 0),
        pivotWorld[2] - (o?.z ?? 0),
      );

      const up = camera.up.clone().normalize();
      const offset = camera.position.clone().sub(controls.target);
      if (offset.lengthSq() < 1e-12) return;

      // Clamp the vertical drag exactly like OrbitControls clamps `phi` — the
      // view must never tip past the poles, where lookAt's up vector flips.
      const phi = offset.angleTo(up);
      let dPhi = (-2 * Math.PI * dy) / height;
      dPhi = Math.max(EPS - phi, Math.min(Math.PI - EPS - phi, dPhi));
      const dTheta = (-2 * Math.PI * dx) / height;

      // Camera right = cross(up, position − target); degenerate only if the view
      // is dead-on the up axis, which the phi clamp already prevents.
      const right = new THREE.Vector3().crossVectors(up, offset);
      if (right.lengthSq() < 1e-12) return;
      right.normalize();

      const qTheta = new THREE.Quaternion().setFromAxisAngle(up, dTheta);
      // Tilt about the right axis AFTER the azimuth turn, so the two compose
      // like OrbitControls' simultaneous spherical update.
      const qPhi = new THREE.Quaternion().setFromAxisAngle(
        right.applyQuaternion(qTheta), dPhi,
      );
      const q = qPhi.multiply(qTheta);

      camera.position.sub(P).applyQuaternion(q).add(P);
      controls.target.sub(P).applyQuaternion(q).add(P);
      controls.update();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!enabledRef.current) return;
      if (!orbitPivotRef.current) return;
      // Left button only, and never with a modifier: shift/ctrl/meta+left is
      // OrbitControls' pan, and alt+left is reserved.
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      if (!enabledRef.current) { dragging = false; return; }
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      if (dx === 0 && dy === 0) return;
      last = { x: e.clientX, y: e.clientY };
      rotateAboutPivot(dx, dy);
    };
    const onPointerUp = () => { dragging = false; };

    // Down on the canvas only (so a click on a floating panel never orbits), but
    // move/up on the window so a drag that leaves the canvas still tracks —
    // matching OrbitControls' own pointer-capture behavior.
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [camera, gl]);

  useEffect(() => {
    (window as any).__resetPointCloudCamera = resetCamera;
    (window as any).__snapToView = snapToView;
    (window as any).__orientToAxis = orientToAxis;
    (window as any).__frameSelection = frameSelection;
    (window as any).__frameSceneOrigin = frameSceneOrigin;
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
      // WORLD-space centre of the content (outlier-resistant); the zoom fallback
      // anchor converges here when the pointer misses geometry.
      contentCenter: [...contentCentreRef.current],
      // What "fit everything" fits — the content box when the scene has one.
      framingBounds: {
        center: [
          framingBoundsRef.current.center.x,
          framingBoundsRef.current.center.y,
          framingBoundsRef.current.center.z,
        ],
        size: [
          framingBoundsRef.current.size.x,
          framingBoundsRef.current.size.y,
          framingBoundsRef.current.size.z,
        ],
      },
      // Scene-scaled zoom clamps in effect (lib/cameraScale.ts).
      zoomLimits: {
        scale: limitsRef.current.scale,
        minDistance: limitsRef.current.minDistance,
        maxDistance: limitsRef.current.maxDistance,
      },
      bounds: {
        min: [boundsRef.current.min.x, boundsRef.current.min.y, boundsRef.current.min.z],
        max: [boundsRef.current.max.x, boundsRef.current.max.y, boundsRef.current.max.z],
      },
      // Render-only display offset in effect (world − offset = display). camera
      // position/target above are in DISPLAY space; bounds is WORLD space. A test
      // reconciles them via this offset. Zero for small-coord scenes.
      displayOffset: offsetRef.current
        ? [offsetRef.current.x, offsetRef.current.y, offsetRef.current.z]
        : [0, 0, 0],
    });
    // Test hook: is there any scene geometry under this viewport pixel?
    //
    // Scan markers load their body from an OBJ via useLoader, wrapped in
    // <Suspense fallback={null}> — so until that asset resolves the marker
    // renders as NOTHING and there is literally nothing to click. A test that
    // clicks the marker's projected position before then hits empty space, and
    // the failure reads "clicked and nothing was selected", which looks like a
    // picking regression rather than an asset that had not loaded yet. Locally
    // the OBJ is warm and this never shows up; on CI it is slower.
    //
    // Returns a description of what the ray hits, nearest first — not just a
    // count. A bare count is useless here: the sphere's POINTS are also
    // raycastable, so a pixel over the cloud reports well over a hundred hits
    // whether or not the marker's mesh has loaded.
    (window as any).__hitInfoAt = (clientX: number, clientY: number) => {
      const el = gl.domElement;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - r.left) / r.width) * 2 - 1,
        -((clientY - r.top) / r.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      return ray.intersectObjects(scene.children, true).slice(0, 8).map((i) => ({
        type: i.object.type,
        name: i.object.name || null,
        dist: Number(i.distance.toFixed(3)),
        // Walk up for a named ancestor — that is what identifies a scan marker
        // vs. the point cloud vs. the grid box.
        parents: (() => {
          const out: string[] = [];
          let o: any = i.object;
          for (let k = 0; k < 4 && o; k++, o = o.parent) {
            if (o.name) out.push(o.name);
          }
          return out;
        })(),
      }));
    };
    // Test hook: project a WORLD point to viewport pixels through the REAL
    // camera, so a test can click exactly where the renderer draws something.
    // Mirrors __gizmoHeadScreenPos. Tests used to re-implement this projection
    // (rebuilding the view basis and hardcoding fov=60 / the aspect ratio),
    // which silently drifts from the renderer whenever the camera setup changes
    // and produces an off-target click that reads as "clicked, nothing selected".
    // camera.project() uses the live projection + view matrices, so it cannot
    // drift. Applies the render-only displayOffset (world → display) first.
    (window as any).__worldToScreen = (world: [number, number, number]) => {
      const el = gl.domElement;
      const r = el.getBoundingClientRect();
      const off = offsetRef.current;
      const v = new THREE.Vector3(
        world[0] - (off?.x ?? 0),
        world[1] - (off?.y ?? 0),
        world[2] - (off?.z ?? 0),
      );
      camera.updateMatrixWorld();
      v.project(camera);
      return {
        x: r.left + ((v.x + 1) / 2) * r.width,
        y: r.top + ((1 - v.y) / 2) * r.height,
        // Behind the camera (or outside the frustum) — a test must not click it.
        visible: v.z < 1 && v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1,
      };
    };
    return () => {
      delete (window as any).__resetPointCloudCamera;
      delete (window as any).__snapToView;
      delete (window as any).__orientToAxis;
      delete (window as any).__frameSelection;
      delete (window as any).__frameSceneOrigin;
      delete (window as any).__getCameraState;
      delete (window as any).__worldToScreen;
      delete (window as any).__hitInfoAt;
    };
  }, [resetCamera, snapToView, orientToAxis, frameSelection, frameSceneOrigin, camera, gl, scene]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={enabled}
      enableDamping={false}
      // Rotation is ours whenever a pivot is supplied (see the pivot-orbit effect
      // above): stock rotation would fight it and would still turn about the
      // pan-following target. Left-drag PAN (shift/ctrl/meta+left) is unaffected —
      // three-stdlib routes that through its pan path, not enableRotate.
      enableRotate={!orbitPivot}
      // Zoom is ours (see the zoom-to-cursor effect above). OrbitControls' own
      // wheel handler would dolly along camera→target in parallel, fighting the
      // anchor-directed move and double-counting every notch.
      enableZoom={false}
      screenSpacePanning={true}
      // Scene-scaled, outlier-robust (lib/cameraScale.ts). The old fixed
      // 0.1 / 10000 pair made the near limit unusable on a small scene and put
      // the far limit INSIDE a large one.
      minDistance={limits.minDistance}
      maxDistance={limits.maxDistance}
      mouseButtons={{
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.PAN,
      }}
    />
  );
}
