import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Potree, type PointCloudOctree } from 'potree-core';
import { isSceneOverlay } from '../../../lib/sceneOverlay';

// Depth probe for zoom-to-cursor: what is the nearest geometry under this pixel?
//
// The zoom-to-cursor path in CameraController needs a real 3D anchor under the
// pointer, and only the scene knows where the geometry is. This component lives
// inside the R3F canvas (so it has the live camera and renderer), builds the
// probe, and publishes it through a ref the controller reads. It renders nothing.
//
// Two sources, nearest wins:
//   • Octree clouds — potree-core's GPU `pick`, the same call the origin picker
//     and point picker use. A CPU raycast against a streamed multi-million-point
//     octree is not viable per wheel notch; `pick` renders a small window and
//     reads back the hit, which is cheap and exact.
//   • Everything else (meshes, skeletons) — a normal three raycast, accelerated
//     by the BVH already installed on mesh geometries (lib/bvhRaycast.ts).
//
// Returns DISPLAY space (world − displayOffset), which is what the camera and
// OrbitControls target live in, so the caller needs no conversion.

// Pick window in pixels. Matches PointPicker's: wide enough that a sparse cloud
// still registers under the cursor, narrow enough not to grab a neighbour.
const OCTREE_PICK_WINDOW_PX = 13;

// Above this many loaded octree points, the CPU raycast is skipped and the GPU
// pick carries the probe alone. Chosen well below the point at which the walk
// costs a frame (~1 M points measured in the millisecond range), and far above
// the sparse clouds where the GPU pick is unreliable and the CPU pass is needed.
const CPU_RAYCAST_POINT_BUDGET = 400_000;

export function DepthProbe({
  octrees,
  probeRef,
}: {
  // Visible octree clouds to probe. Miss/sky octrees are deliberately absent
  // from the registry the caller draws this from, so a ray into the sky can't
  // anchor zoom on a point projected ~1 km out.
  octrees: PointCloudOctree[];
  // Filled with the probe function while mounted; nulled on unmount.
  probeRef: React.MutableRefObject<((clientX: number, clientY: number) => THREE.Vector3 | null) | null>;
}) {
  // NOTE ON POINT PICKING: potree's GPU `pick` proved unreliable here — measured
  // 0 hits across 30 wheel notches on a sparse cloud, via both the per-instance
  // and static forms. It renders a small window and reads it back, which a
  // sparse cloud simply may not fill. The CPU raycast DOES hit those same points
  // (three renders octree nodes as `Points` objects), so it carries the load and
  // the GPU pick stays as a fast path for dense clouds.
  const { gl, camera, scene, controls } = useThree();

  // Read the octree list through a ref, not the effect's closure. The parent
  // rebuilds this array every render from a registry that OctreePointCloud
  // populates ASYNCHRONOUSLY (onOctreeReady, after the tiles stream in), so the
  // array captured when the effect first ran is typically still empty — the
  // probe would then silently never pick a point cloud, reducing zoom-to-cursor
  // to a plain on-axis dolly. Same pattern as PointPicker's octreesRef.
  const octreesRef = useRef(octrees);
  octreesRef.current = octrees;

  useEffect(() => {
    const raycaster = new THREE.Raycaster();

    // Budget guard. The CPU raycast walks every point of every visible Points
    // object, which is fine on the octree's loaded LOD tiles but would stutter
    // the wheel if a probe ever ran long. Rather than guess a point-count
    // threshold, measure: if a probe overruns, skip the CPU pass on the next few
    // notches and let zoom use the fallback anchor (still smooth, just on-axis)
    // until the pressure passes. Self-tuning, and it degrades rather than janks.
    const PROBE_BUDGET_MS = 8;
    let skipUntil = 0;

    probeRef.current = (clientX: number, clientY: number): THREE.Vector3 | null => {
      const el = gl.domElement;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);

      let best: THREE.Vector3 | null = null;
      let bestDist = Infinity;

      // Octree clouds via potree-core's GPU pick.
      //
      // The STATIC `Potree.pick(octrees, …)` across all clouds at once, not the
      // per-instance `octree.pick(…)` in a loop — the same call PointPicker
      // makes. The per-instance form measurably fails to return hits here
      // (0 hits in 30 wheel notches on a sparse cloud), which silently reduced
      // zoom-to-cursor to a plain on-axis dolly on every point cloud.
      //
      // `pickOutsideClipRegion: true` because this is anchoring camera motion,
      // not selecting data: a point hidden behind a live crop preview is still
      // a real surface in front of the camera, and flying THROUGH it because the
      // pick declined to report it would be worse than anchoring on it.
      const octs = octreesRef.current;
      if (octs.length > 0) {
        try {
          const hit = Potree.pick(octs, gl, camera, raycaster.ray, {
            pickWindowSize: OCTREE_PICK_WINDOW_PX,
            pickOutsideClipRegion: true,
          }) as { position?: { x: number; y: number; z: number } } | null;
          if (hit?.position) {
            const p = new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z);
            const d = p.distanceTo(camera.position);
            if (d < bestDist) { bestDist = d; best = p; }
          }
        } catch {
          // A pick can throw while an octree is mid-load; just skip it. Zoom
          // falls back to the view-ray anchor, which is still usable.
        }
      }

      // CPU raycast: meshes (BVH-accelerated) AND point clouds. three renders
      // potree octree nodes as `Points` objects, so this path picks them too —
      // and in practice it is the path that actually works on clouds, since the
      // GPU pick above returns nothing on sparse data.
      //
      // Points need a generous pick radius: a ray must otherwise strike a
      // mathematical point exactly, which never happens.
      //
      // The radius must clear the SPACING BETWEEN POINTS, not merely subtend a
      // few pixels — that was the mistake that made this return nothing at all.
      // Measured: a radius of 0.012-0.059 world units got ZERO hits on a cloud
      // where three's default of 1.0 got eight, because the gaps between points
      // were simply wider than the radius. So scale with the view distance (a
      // fixed radius is a wide net up close and far too narrow on a wide shot)
      // but keep it generous, and widen once more before giving up.
      //
      // The ground grid excludes itself (`raycast={() => null}` in GroundGrid —
      // it is a reference overlay whose "infinite" extent and transparent gaps
      // are shader-side and invisible to the CPU raycaster, so it would
      // otherwise report hits far outside the lit area). Fully-transparent click
      // targets, such as the origin picker's 100 km plane, are only mounted
      // while their tool is armed, and are skipped below so a zoom during
      // place-mode can't anchor on a surface the user cannot see.
      const ctrlTarget = (controls as unknown as { target?: THREE.Vector3 } | null)?.target;
      const viewDist = (ctrlTarget ? camera.position.distanceTo(ctrlTarget) : 0) || 1;
      const t0 = performance.now();

      // ── Don't run the CPU raycast over a heavy scene ────────────────────────
      //
      // `intersectObjects(scene.children, true)` walks EVERY point of EVERY
      // loaded octree node. That cost tracks how much of the cloud is resident,
      // which is highest exactly when the whole cloud is framed — so the wheel
      // gets slower the further out you are, which is the reported "zooming is
      // laggy when the full cloud is in view, and increasingly responsive as you
      // zoom in".
      //
      // The existing budget guard only reacts AFTER an 8 ms overrun has already
      // been paid, and it re-pays it every 250 ms. Counting the points that are
      // actually loaded lets us skip the pass before spending anything.
      //
      // Skipping is safe precisely where it triggers: the GPU pick above renders
      // a small window and reads it back, so its reliability rises with point
      // DENSITY — the same condition that makes the CPU pass expensive. On the
      // sparse clouds where the GPU pick misses, the point count is low and the
      // CPU pass still runs. Where neither lands, zoom uses the cursor-ray
      // fallback anchor, which is smooth and correctly aimed.
      // Counted off the SCENE GRAPH, not off `octree.visibleNodes`. The raycast
      // walks whatever `Points` objects are actually in the graph, and that is
      // exactly the cost being bounded; `visibleNodes` is potree's own
      // bookkeeping, and it measured EMPTY here even with a cloud on screen and
      // the CPU pass hitting its points — a guard keyed to it would have been
      // silently inert. (`numPoints` is also a getter on PointCloudOctreeNode,
      // not a method; calling it as one yields 0 and disables the guard too.)
      let loadedPoints = 0;
      scene.traverseVisible((o) => {
        if (loadedPoints > CPU_RAYCAST_POINT_BUDGET) return;
        const pts = o as THREE.Points;
        if (pts.isPoints && pts.geometry) {
          loadedPoints += pts.geometry.getAttribute('position')?.count ?? 0;
        }
      });
      if (loadedPoints > CPU_RAYCAST_POINT_BUDGET) return best;
      // A GPU hit is exact and already the nearest — the CPU pass cannot improve
      // on it, so skip the expensive raycast entirely rather than running it to
      // (at best) confirm the same surface. This is also what keeps the budget
      // guard from tripping on dense clouds, where the GPU pick is reliable.
      if (best) return best;
      if (t0 < skipUntil) return best;
      for (const frac of [0.02, 0.15]) {
        raycaster.params.Points = { threshold: Math.max(viewDist * frac, 1e-9) };
        const hits = raycaster.intersectObjects(scene.children, true);
        let found = false;
        for (const h of hits) {
          if (!h.object.visible) continue;
          // Skip UI overlays — gizmo handles, the erase brush, invisible click
          // planes, and above all the crop box's faint full-volume fill. Those
          // are raycastable geometry sitting in front of the data, so anchoring
          // zoom on one converges the camera on an overlay surface instead of on
          // the cloud. Declared via userData rather than inferred from
          // transparency: the crop fill is at opacity 0.05 (visible, so an
          // opacity===0 test misses it) and real content can be transparent too.
          if (isSceneOverlay(h.object)) continue;
          // Sorted near→far, so the first hit that survives the filters is the
          // nearest real surface; nothing later can beat it.
          if (h.distance < bestDist) { bestDist = h.distance; best = h.point.clone(); }
          found = true;
          break;
        }
        if (found) break;  // the tight pass sufficed; don't widen
      }
      // Overran the budget — back off briefly so a heavy scene degrades to the
      // fallback anchor instead of dropping wheel frames.
      if (performance.now() - t0 > PROBE_BUDGET_MS) skipUntil = performance.now() + 250;

      return best;
    };

    return () => { probeRef.current = null; };
  }, [gl, camera, scene, controls, probeRef]);

  return null;
}
