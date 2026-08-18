import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { PointCloudOctree } from 'potree-core';
import { rayForNdc, worldPerPixelAt } from '../../../lib/cameraRay';
import { isSceneOverlay } from '../../../lib/sceneOverlay';

// Same bound DepthProbe uses: above this the CPU raycast is too slow, and a
// cloud this dense is one where the GPU pick works anyway.
const CPU_RAYCAST_POINT_BUDGET = 400_000;

// Which listener set currently owns the pointer.
//
// This effect re-registers whenever three-fiber hands back a new camera/gl/
// scene identity, which happens repeatedly while a cloud streams. React runs
// the new effect BEFORE the old one's cleanup, so for a moment two listener
// sets are attached to the same canvas and both receive every event. The
// outgoing set — which had never resolved a surface — kept clearing the cursor
// the incoming one had just set, and the brush sat dead with a valid octree
// directly under the pointer.
//
// A monotonic generation makes the ordering explicit rather than hoping the
// teardown wins the race: the newest registration claims ownership, and every
// handler drops out if it no longer holds it.
let brushGeneration = 0;

/** One brush stroke: the world-space spheres stamped while the button was down. */
export interface BrushSphereStroke {
  centers: Array<[number, number, number]>;
  radii: number[];
}

// Label brush — a union of WORLD-SPACE spheres.
//
// Deliberately not the erase brush's screen-space squares, and the difference
// is the whole point. A square stamp is a 2-D test against canvas pixels, so it
// extrudes through the cloud: aim at a leaf and you also paint the trunk behind
// it. A sphere is bounded in every direction, so it is depth-limited by its own
// geometry.
//
// Three consequences fall out of that, all of which make this SIMPLER than the
// erase brush rather than harder:
//
//   * No frozen camera. The erase brush freezes the viewport for a whole
//     session because its stamps only mean anything under the camera that made
//     them. A sphere is the same volume from any angle, so the user can orbit
//     mid-stroke and keep painting.
//   * No projection/view/canvas in the payload. The backend replay is
//     `‖p − c‖² ≤ r²` — the same closed form this file's preview predicate
//     evaluates, so preview and apply agree by construction rather than by two
//     projection implementations happening to match.
//   * An exact AABB, so the label overlay can reject tiles a stamp cannot
//     touch instead of replaying every loaded point.
//
// The RADIUS is chosen on screen (pixels) and converted to world units at the
// stamp's own depth, because a brush that stayed a fixed world size would be a
// speck when zoomed out and swallow the cloud when zoomed in.
export interface LabelBrushOctreeProps {
  /**
   * The octree to pick against, resolved WHEN CALLED rather than passed as a
   * value. The parent holds octrees in a ref that registration mutates without
   * re-rendering, so a value prop is null on the mounting render and may never
   * be refreshed.
   */
  getOctree: () => PointCloudOctree | null;
  /** Brush radius in CANVAS PIXELS — constant on screen, as a brush should be. */
  brushRadiusPx: number;
  cloudCenter: { x: number; y: number; z: number };
  /** Called once per completed stroke (mouse up), with everything stamped. */
  onStroke: (stroke: BrushSphereStroke) => void;
  /** Live cursor sphere, or null when off-canvas. World centre + world radius. */
  onCursorChange: (cursor: { center: THREE.Vector3; radius: number } | null) => void;
  /** True while the button is held — drives the cursor colour and orbit suppression. */
  onPaintingChange: (painting: boolean) => void;
}

export function LabelBrushOctree({
  getOctree,
  brushRadiusPx,
  cloudCenter,
  onStroke,
  onCursorChange,
  onPaintingChange,
}: LabelBrushOctreeProps) {
  const { camera, gl, scene } = useThree();

  // Props the DOM handlers need at event time. The listeners are registered
  // once (re-registering per radius change would drop an in-flight drag), so
  // reading these from the closure would freeze them at their first-render
  // values — the stale-closure trap that has bitten this file's neighbours
  // repeatedly.
  const radiusPxRef = useRef(brushRadiusPx);
  radiusPxRef.current = brushRadiusPx;
  const getOctreeRef = useRef(getOctree);
  getOctreeRef.current = getOctree;
  const onStrokeRef = useRef(onStroke);
  onStrokeRef.current = onStroke;
  const onCursorRef = useRef(onCursorChange);
  onCursorRef.current = onCursorChange;
  const onPaintingRef = useRef(onPaintingChange);
  onPaintingRef.current = onPaintingChange;
  const centerRef = useRef(cloudCenter);
  centerRef.current = cloudCenter;

  const paintingRef = useRef(false);
  const strokeRef = useRef<BrushSphereStroke>({ centers: [], radii: [] });
  const lastStampRef = useRef<THREE.Vector3 | null>(null);

  useEffect(() => {
    const myGeneration = ++brushGeneration;
    const owns = () => brushGeneration === myGeneration;
    const el = gl.domElement;

    const ndcOf = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -(((e.clientY - rect.top) / rect.height) * 2 - 1),
      );
    };

    /**
     * Where the brush sphere sits for this cursor position.
     *
     * The anchor is the hovered SURFACE, so the sphere sits on the geometry the
     * user is pointing at rather than at an arbitrary depth. potree's GPU pick
     * can miss entirely on sparse clouds — measured at 0 hits across 30 wheel
     * notches (see scene/DepthProbe.tsx) — so a miss must have a DEFINED
     * answer. Two fallbacks, in order: a CPU raycast (cheap exactly when the
     * GPU pick is unreliable, i.e. on sparse clouds), then null.
     *
     * Null, and not a ray-to-cloud-centre guess. EraseBrushOctree can guess
     * because its stamp extrudes through the whole cloud, so depth barely
     * matters; a sphere is depth-limited, and a guessed depth lands in the GAP
     * between surfaces — the stroke then succeeds while selecting nothing.
     *
     * rayForNdc rather than Raycaster.setFromCamera: under an ortho override
     * (a cross-section) the camera is still a PerspectiveCamera instance, and
     * setFromCamera would collapse every pick toward the view centre.
     */
    const anchorAt = (ndc: THREE.Vector2): THREE.Vector3 | null => {
      const ray = rayForNdc(camera, ndc);
      const oct = getOctreeRef.current();
      if (oct) {
        try {
          const hit = oct.pick(gl, camera, ray, {
            pickWindowSize: 17, pickOutsideClipRegion: true,
          });
          if (hit?.position) {
            return new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z);
          }
        } catch { /* fall through to the CPU pass */ }
      }

      // CPU raycast fallback, bounded by point count exactly as DepthProbe does.
      // The GPU pick renders a small window and reads it back, and on a SPARSE
      // cloud it can simply not land on anything — measured at 0 hits across 30
      // wheel notches. That is the same condition that makes this CPU pass
      // cheap, so the two cover each other.
      let loadedPoints = 0;
      scene.traverseVisible((o) => {
        if (loadedPoints > CPU_RAYCAST_POINT_BUDGET) return;
        const pts = o as THREE.Points;
        if (pts.isPoints && pts.geometry) {
          loadedPoints += pts.geometry.getAttribute('position')?.count ?? 0;
        }
      });
      if (loadedPoints <= CPU_RAYCAST_POINT_BUDGET) {
        const raycaster = new THREE.Raycaster();
        raycaster.ray.copy(ray);
        const viewDist = camera.position.distanceTo(
          new THREE.Vector3(centerRef.current.x, centerRef.current.y, centerRef.current.z),
        );
        for (const frac of [0.02, 0.15]) {
          raycaster.params.Points = { threshold: Math.max(viewDist * frac, 1e-9) };
          const hits = raycaster.intersectObjects(scene.children, true);
          for (const h of hits) {
            if (!h.object.visible) continue;
            // Skip our own cursor sphere and every other overlay, or the brush
            // would anchor on its own indicator.
            if (isSceneOverlay(h.object)) continue;
            if (!(h.object as THREE.Points).isPoints) continue;
            return h.point.clone();
          }
        }
      }

      // Nothing under the cursor at all — empty sky.
      //
      // Returning NULL rather than a ray-to-centre guess is deliberate. That
      // guess lands halfway between whatever surfaces happen to be in view: on
      // a two-layer canopy it sits in the gap BETWEEN the layers, so the stroke
      // succeeds, reports zero points, and leaves the user with a brush that
      // silently does nothing. Refusing to stamp is honest — the cursor
      // disappears, which says "there is nothing here to paint".
      return null;
    };

    /** Pixel radius → world radius AT THE STAMP'S DEPTH. */
    const worldRadiusAt = (world: THREE.Vector3): number => {
      const rect = el.getBoundingClientRect();
      // Branches on the projection MATRIX, so it stays correct under the
      // cross-section's ortho override (which leaves isPerspectiveCamera true).
      const wpp = worldPerPixelAt(camera, world, rect.width, rect.height);
      // The larger axis, so the sphere covers the on-screen circle rather than
      // inscribing it.
      return Math.max(wpp.x, wpp.y) * radiusPxRef.current;
    };

    const stamp = (world: THREE.Vector3, radius: number) => {
      strokeRef.current.centers.push([world.x, world.y, world.z]);
      strokeRef.current.radii.push(radius);
      lastStampRef.current = world.clone();
    };

    const onMove = (e: MouseEvent) => {
      if (!owns()) return;
      const world = anchorAt(ndcOf(e));
      if (!world) {
        // Nothing under the cursor: hide the indicator rather than parking it
        // at a guessed depth, and stamp nothing.
        //
        onCursorRef.current(null);
        return;
      }
      const radius = worldRadiusAt(world);
      onCursorRef.current({ center: world, radius });

      if (!paintingRef.current) return;
      // Space the stamps along the drag. Without this a slow drag emits one
      // sphere per mousemove — thousands of near-identical spheres, each a full
      // pass over the cloud on the backend. Half a radius keeps the swept tube
      // gap-free while bounding the count.
      const last = lastStampRef.current;
      if (last && last.distanceTo(world) < radius * 0.5) return;
      stamp(world, radius);
    };

    const onDown = (e: MouseEvent) => {
      if (!owns()) return;
      // Left button only: right/middle stay available for orbit and pan.
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      paintingRef.current = true;
      strokeRef.current = { centers: [], radii: [] };
      lastStampRef.current = null;
      onPaintingRef.current(true);
      const world = anchorAt(ndcOf(e));
      if (world) stamp(world, worldRadiusAt(world));
    };

    const onUp = () => {
      if (!owns()) return;
      if (!paintingRef.current) return;
      paintingRef.current = false;
      onPaintingRef.current(false);
      const stroke = strokeRef.current;
      strokeRef.current = { centers: [], radii: [] };
      lastStampRef.current = null;
      if (stroke.centers.length > 0) onStrokeRef.current(stroke);
    };

    const onLeave = (e: MouseEvent) => {
      if (!owns()) return;
      // Ignore a leave whose relatedTarget is still inside the canvas.
      //
      // The canvas gets a mouseleave whenever the pointer crosses onto a child
      // or an overlay stacked above it — not only when it leaves for real. That
      // fired once as the scene settled and blanked the cursor, and because the
      // pointer had not actually MOVED afterwards no further mousemove arrived
      // to restore it: the brush sat dead with a valid octree under the cursor.
      const to = e.relatedTarget as Node | null;
      if (to && el.contains(to)) return;
      onCursorRef.current(null);
      onUp();   // a drag that leaves the canvas still commits what it painted
    };

    // Capture phase on pointerdown so the stroke starts before OrbitControls
    // claims the drag; the rest can ride the normal bubble phase.
    el.addEventListener('mousedown', onDown, { capture: true });
    el.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('mousedown', onDown, { capture: true } as any);
      el.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      el.removeEventListener('mouseleave', onLeave);
      // Deliberately does NOT clear the cursor.
      //
      // This effect re-runs whenever three-fiber hands back a new camera/gl/
      // scene identity, which happens while the cloud is still streaming — and
      // the cursor callback itself sets React state, so a cursor update can
      // trigger the very re-render that tears this down. Clearing here blanked
      // a perfectly good cursor a frame after it resolved, leaving the brush
      // looking dead: the pick was succeeding the whole time.
      //
      // The cursor is owned by onMove (which nulls it on a genuine miss) and by
      // the mouseleave handler. A real unmount removes the whole gizmo, and the
      // parent stops rendering the indicator with it.
    };
  }, [camera, gl, scene]);

  return null;
}
