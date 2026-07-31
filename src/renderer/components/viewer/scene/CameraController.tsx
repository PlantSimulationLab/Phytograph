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
  displayOffset,
  orbitPivot,
}: {
  bounds: PointCloudData['bounds'];
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
  // It is ALSO the camera's default look-at: framing aims `controls.target` at
  // this point (see `anchorCenter`), so zoom — which OrbitControls dollies along
  // camera→target — converges on the scene origin too, not on the bounds
  // mid-height. Panning deliberately breaks that link (see `pannedRef`).
  orbitPivot?: [number, number, number] | null;
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

  // ── Zoom anchor: the scene origin, until the user pans ────────────────────
  //
  // OrbitControls dollies along camera→`controls.target`, so whatever the target
  // is IS what zoom converges on. We aim framing at the scene origin (below) so
  // zoom lands there by default. But a pan is an explicit "I want to look over
  // HERE" — after one, forcing zoom back to the origin would make it impossible
  // to zoom into an off-origin detail you just panned to. So a pan latches this
  // flag and hands the target back to stock OrbitControls behavior; any
  // re-framing (reset view, frame selection, axis snap, a moved origin, new
  // content) clears it and re-anchors on the origin.
  const pannedRef = useRef(false);

  // Where framing should aim `controls.target`: the caller's centre laterally,
  // but the scene origin's HEIGHT — so the view looks at the ground-anchored
  // origin plane and zoom converges there rather than on the bounds mid-height.
  //
  // Only Z is taken from the origin, deliberately. Each caller has already
  // decided WHAT it is framing, and that choice lives in X/Y: `frameSelection`
  // with an explicit target frames a newly added mesh or an off-frame scan on
  // its own bounds (frameMeshInViewport / frameScanInViewport), which can sit
  // far from the scene centre. Overriding X/Y with the origin's would drag the
  // view off whatever the caller meant to frame — and since the default origin
  // tracks the whole-scene bounds (scan markers included), that is a large
  // lateral swing on exactly the scenes where framing matters most. Height is
  // the axis the user asked to change, and it is the axis that is common to
  // every framing.
  //
  // Takes and returns DISPLAY space; `orbitPivot` is WORLD, so its Z is
  // offset-converted here.
  const anchorCenter = useCallback((displayFallback: THREE.Vector3): THREE.Vector3 => {
    const pivotWorld = orbitPivotRef.current;
    if (!pivotWorld || pannedRef.current) return displayFallback;
    const o = offsetRef.current;
    return new THREE.Vector3(
      displayFallback.x,
      displayFallback.y,
      pivotWorld[2] - (o?.z ?? 0),
    );
  }, []);

  const snapToView = useCallback((direction: ViewDirection, target?: { center: THREE.Vector3, size: THREE.Vector3 }) => {
    if (!controlsRef.current) return;

    // Use provided target or fall back to global bounds. Both are WORLD-space;
    // convert the center to DISPLAY space (world − offset) since the camera and
    // orbit target render in display space.
    const { center: worldCenter, size } = target || boundsRef.current;
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

    // A deliberate re-frame re-anchors zoom on the scene origin.
    pannedRef.current = false;

    // The LOOK-AT takes the scene origin's HEIGHT (when there is one) rather than
    // the bounds mid-height — that is what makes zoom converge on the origin,
    // since OrbitControls dollies along camera→target. Applied on both the
    // no-target and explicit-target forms, unlike frameSelection: snapToView's
    // caller passes whole-scene bounds (the auto-frame, the view-snap menu), not
    // a single object to centre on, so the ground anchor is always right here.
    //
    // The camera is then placed at `distance` from THAT point, along the same
    // direction the switch above chose — i.e. the whole camera/target pair is
    // translated by (lookAt − center). Leaving the camera at `newPos` (measured
    // from the bounds centre) while anchoring the target lower would shorten
    // camera→target by that offset and silently zoom the view in.
    const lookAt = anchorCenter(center);
    camera.position.copy(newPos).add(lookAt).sub(center);
    controlsRef.current.target.copy(lookAt);
    controlsRef.current.update();
  }, [camera, displayCenter, anchorCenter]);

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
    const { center: worldCenter, size } = target || boundsRef.current;
    const center = displayCenter(worldCenter);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const distance = maxDim * 2;

    // Preserve the current orbit direction (camera relative to its target).
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (dir.lengthSq() < 1e-12) dir.set(0.6, -0.6, 0.5); // degenerate: fall back to iso-ish
    dir.normalize();

    // Framing an EXPLICIT target (zoom-to-selection, or a newly added mesh/scan
    // via frameMeshInViewport / frameScanInViewport) aims at exactly that target,
    // including its height — the caller framed a specific object, and dropping
    // the look-at to the whole-scene floor would push that object up out of the
    // view. Only the no-argument "fit everything" form takes the ground anchor,
    // and it is also the only form that counts as a deliberate re-frame and so
    // re-anchors zoom on the origin.
    const lookAt = target ? center : anchorCenter(center);
    if (!target) pannedRef.current = false;

    camera.position.copy(lookAt).addScaledVector(dir, distance);
    controls.target.copy(lookAt);
    controls.update();
  }, [camera, displayCenter, anchorCenter]);

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
  // - NEAR = clamp(dist/1000, 1e-4, 0.1): pushed as far out as it can go without
  //   clipping (well inside minDistance 0.1, so the orbit target is never clipped),
  //   pulled in as you dolly toward a surface. A near pinned at 0.01 is 100x closer
  //   than needed when orbiting a metre-scale scene metres out, and that tiny near
  //   is what crushes precision near z=0.
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
      const near = Math.min(0.1, Math.max(1e-4, dist / 1000));
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
      // A PAN detaches zoom from the scene origin (see `pannedRef`). Pan is
      // middle/right drag, or modifier+left — exactly the gestures three-stdlib
      // routes to its pan path, mirrored here because OrbitControls emits no
      // event that distinguishes a pan from a dolly. Latched on pointerdown
      // rather than on movement: a click that turns out not to drag re-frames
      // nothing, and re-anchoring on the next zoom would be just as surprising.
      const isPanGesture = e.button === 1 || e.button === 2
        || (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey));
      if (isPanGesture) pannedRef.current = true;

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
      delete (window as any).__getCameraState;
      delete (window as any).__worldToScreen;
      delete (window as any).__hitInfoAt;
    };
  }, [resetCamera, snapToView, orientToAxis, frameSelection, camera, gl, scene]);

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
