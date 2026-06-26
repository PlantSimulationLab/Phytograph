import { useMemo, useState, useRef, useEffect } from 'react';
import { CanvasTexture, Vector2, Vector3, type Vector3Tuple, type Object3D } from 'three';
import { useThree, useStore } from '@react-three/fiber';
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
  hovered,
}: {
  color: string;
  dir: Vector3Tuple;
  label: string | null;
  labelColor: string;
  hovered: boolean;
}) {
  const texture = useMemo(
    () => makeHeadTexture(color, label, labelColor),
    [color, label, labelColor],
  );
  // Positive (labelled) heads are solid and a touch larger; negative heads are
  // smaller and semi-transparent — matches drei's GizmoViewport styling.
  const baseScale = label ? 1 : 0.75;
  const scale = baseScale * (hovered ? 1.2 : 1);

  // The world direction this head points the camera along is stamped into
  // userData so GizmoPicker (which hit-tests these heads) can read it off the
  // matched object without needing a parallel data structure. We do NOT use
  // R3F's onPointer* handlers here: the gizmo lives in drei's Hud portal, whose
  // R3F event compartment is non-functional on this stack once JFAOutline owns
  // the render loop — clicks never reach the sprite. GizmoPicker does the
  // hit-testing instead, against the Hud's own ortho camera.
  return (
    <sprite position={dir} scale={scale} userData={{ axisDir: dir }}>
      <spriteMaterial
        map={texture}
        opacity={label ? 1 : 0.75}
        alphaTest={0.3}
        toneMapped={false}
      />
    </sprite>
  );
}

// Self-contained click/hover for the gizmo heads. Renders inside drei's Hud
// portal, so the R3F store here (useStore) is the HUD compartment's — its
// camera is the virtual ortho camera the gizmo is actually drawn with. We
// attach a capture-phase pointer listener to the shared canvas and hit-test the
// heads ourselves (by projecting their world positions into screen space),
// because drei's portal R3F events are dead on this stack (see AxisHead).
function GizmoPicker({
  groupRef,
  onHover,
}: {
  groupRef: React.RefObject<Object3D | null>;
  onHover: (dir: Vector3Tuple | null) => void;
}) {
  // The R3F store for THIS compartment (the Hud portal). We read camera live
  // from it inside each handler rather than capturing it: drei swaps in the
  // gizmo's ortho camera (makeDefault) AFTER our first render, so any captured
  // camera reference is the stale main PerspectiveCamera. store.getState().camera
  // is always the current portal camera.
  const store = useStore();
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const el = gl.domElement;
    const ndc = new Vector2();

    const toNdc = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      ndc.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
    };

    // Hit-test by projecting each head's world position into NDC and measuring
    // pixel distance to the cursor, rather than three's Sprite.raycast — sprite
    // raycasting against drei's corner-offset ortho gizmo silently missed (it
    // returned no intersections even with the cursor dead on a head). Projection
    // is exact and lets us size the clickable radius in real screen pixels.
    const HEAD_PX_RADIUS = 22; // generous; heads render ~30px across
    const projected = new Vector3();
    const hit = (): Vector3Tuple | null => {
      const group = groupRef.current;
      if (!group) return null;
      const cam = store.getState().camera;
      const r = el.getBoundingClientRect();
      group.updateWorldMatrix(true, true);
      let best: Vector3Tuple | null = null;
      let bestPx = HEAD_PX_RADIUS;
      group.traverse((o) => {
        const d = (o as { userData?: { axisDir?: Vector3Tuple } }).userData?.axisDir;
        if (!d) return;
        o.getWorldPosition(projected).project(cam);
        // NDC → pixel distance from the cursor (ndc is the click point).
        const dxPx = ((projected.x - ndc.x) / 2) * r.width;
        const dyPx = ((projected.y - ndc.y) / 2) * r.height;
        const px = Math.hypot(dxPx, dyPx);
        // Prefer the nearest head, and (tie-break) the front-most so a labelled
        // +axis head wins over the −axis head directly behind it.
        if (px < bestPx) {
          bestPx = px;
          best = d;
        }
      });
      return best;
    };

    const onMove = (e: PointerEvent) => {
      toNdc(e);
      const d = hit();
      onHover(d);
      el.style.cursor = d ? 'pointer' : '';
    };

    // Capture phase + stopImmediatePropagation so a head click never also
    // reaches OrbitControls (which would start an orbit drag on the same press).
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      toNdc(e);
      const d = hit();
      if (!d) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      (window as any).__orientToAxis?.({ x: d[0], y: d[1], z: d[2] });
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown, true);

    // Test hook: viewport-pixel center of an axis head, so E2E can dispatch a
    // real click at the head and exercise the full hit-test → __orientToAxis
    // path (not just call __orientToAxis directly). Returns null if the head
    // can't be found. Mirrors the __getCameraState/__orientToAxis hooks.
    (window as any).__gizmoHeadScreenPos = (dir: Vector3Tuple): { x: number; y: number } | null => {
      const group = groupRef.current;
      if (!group) return null;
      const cam = store.getState().camera;
      const r = el.getBoundingClientRect();
      group.updateWorldMatrix(true, true);
      let found: { x: number; y: number } | null = null;
      group.traverse((o) => {
        const d = (o as { userData?: { axisDir?: Vector3Tuple } }).userData?.axisDir;
        if (!d || d[0] !== dir[0] || d[1] !== dir[1] || d[2] !== dir[2]) return;
        o.getWorldPosition(projected).project(cam);
        found = {
          x: r.left + ((projected.x + 1) / 2) * r.width,
          y: r.top + ((1 - projected.y) / 2) * r.height,
        };
      });
      return found;
    };

    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown, true);
      el.style.cursor = '';
      delete (window as any).__gizmoHeadScreenPos;
    };
  }, [gl, store, groupRef, onHover]);

  return null;
}

function sameDir(a: Vector3Tuple, b: Vector3Tuple | null): boolean {
  return !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function GizmoAxes({ groupRef }: { groupRef: React.RefObject<Object3D | null> }) {
  const [hoveredDir, setHoveredDir] = useState<Vector3Tuple | null>(null);

  return (
    <group ref={groupRef} scale={40}>
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
          hovered={sameDir(h.dir, hoveredDir)}
        />
      ))}
      <GizmoPicker groupRef={groupRef} onHover={setHoveredDir} />
    </group>
  );
}

export function ViewportAxesGizmo() {
  // renderPriority MUST be > 1. JFAOutline owns the render loop at priority 1
  // (it renders the main scene to the screen, then composites the selection
  // outline). drei's GizmoHelper draws through an <Hud>, and an Hud at
  // renderPriority === 1 re-renders the main scene with autoClear=true — which,
  // running at the same priority as JFAOutline, wiped the whole frame (gizmo
  // included) every tick, so the gizmo never showed. At renderPriority 2 the Hud
  // runs AFTER JFAOutline and only clearDepth()s + draws the gizmo scene on top
  // (autoClear=false), overlaying it without touching the main render or outline.
  //
  // That same off-by-default render loop also kills drei's portal R3F events, so
  // axis-head clicks never fired. GizmoPicker (inside GizmoAxes) hit-tests the
  // heads itself against the Hud's ortho camera and routes hits to
  // __orientToAxis — see the comments there.
  // Left margin clears the left toolbar column (a full-height, left-anchored
  // scroll panel ~150px wide). At the old 80px the gizmo sat in the toolbar's
  // lane: invisible on a tall window (the toolbar's cards are top-anchored, so
  // its lower region is empty there) but on a short window (min height 600) the
  // cards reach down over the gizmo and intercept its clicks. 200px puts the
  // whole widget to the right of the toolbar at any window height.
  const groupRef = useRef<Object3D | null>(null);
  return (
    <GizmoHelper alignment="bottom-left" margin={[200, 120]} renderPriority={2}>
      <GizmoAxes groupRef={groupRef} />
    </GizmoHelper>
  );
}
