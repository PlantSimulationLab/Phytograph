import { useEffect } from 'react';
import { useThree, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { Potree, type PointCloudOctree } from 'potree-core';
import { SCENE_OVERLAY } from '../../../lib/sceneOverlay';
import { OCTREE_PICK_WINDOW_PX, makeInflatePickSplat } from '../../../lib/octreePickSplat';

// Invisible click target that fills the canvas. While active (mounted),
// every left-click is resolved to a world XY and reported to the parent.
// Pointer moves are reported the same way via onMove so the parent can render
// a live box preview between the two corner clicks. Used for the two-click
// in-viewport box draw and only mounted while the user is actively placing
// corners — otherwise it would intercept every click in the scene.
//
// How a click becomes an XY, in order:
//
//   1. If `octrees` is non-empty, a potree GPU pick along the event ray — the
//      corner lands on the SURFACE actually under the cursor.
//   2. Otherwise (or on a miss), the analytic ray x plane at `groundZ`.
//
// Step 1 exists because step 2 alone is only correct from a near-top-down
// view. Projecting every click onto one flat plane at the scene floor means
// that from an orbited view a click aimed at a tree crown carries on past it
// to the ground, landing the corner metres from what the user clicked; the
// more oblique the camera, the further it slides, and a near-grazing ray is
// ill-conditioned enough that a one-pixel move sweeps a large world distance.
// That "it won't go where I put it" is what the ground-only version felt like.
//
// Only X and Y are consumed by either path — the caller sets the box's Z span
// from the scene bounds, so a surface pick changes where the corner lands
// laterally and nothing about the box's height.
export function BoxDrawRaycaster({
  groundZ,
  octrees,
  onPick,
  onMove,
}: {
  groundZ: number;
  // Live octrees to surface-pick against. `Potree.pick` returns the nearest
  // hit across all of them, so no distance comparison is needed here.
  // Omitted or empty ⇒ ground-plane only, which is what the cross-section
  // centreline wants: picking mid-canopy there put the line metres from the
  // intended geometry, so that call site deliberately stays flat.
  //
  // Both hit paths report DISPLAY-space coordinates (potree hits come back in
  // the same frame the plane does, since the octrees are attached to the scene
  // root at the display offset), so the caller adds the offset back once and
  // does not need to know which path answered.
  octrees?: PointCloudOctree[];
  onPick: (x: number, y: number) => void;
  onMove?: (x: number, y: number) => void;
}) {
  const { gl, camera } = useThree();

  useEffect(() => {
    gl.domElement.style.cursor = 'crosshair';
    return () => {
      gl.domElement.style.cursor = 'auto';
    };
  }, [gl]);

  // Surface pick: the nearest visible point along the ray, in DISPLAY space.
  //
  // `pickOutsideClipRegion` is left at its default (false) deliberately, for
  // the same reason PointPicker does: a corner must not land on a point the
  // user cannot see. The caller suspends the crop clip while corners are being
  // placed, so what is pickable and what is visible agree.
  const surfacePoint = (ray: THREE.Ray): { x: number; y: number } | null => {
    if (!octrees || octrees.length === 0) return null;
    try {
      const hit = Potree.pick(octrees, gl, camera, ray, {
        pickWindowSize: OCTREE_PICK_WINDOW_PX,
        // Without this, a point is only pickable where its 1-px splat happened
        // to cover a pixel — density rather than aim would decide whether the
        // corner landed. See lib/octreePickSplat.
        onBeforePickRender: makeInflatePickSplat(gl.getPixelRatio()),
      }) as { position?: { x: number; y: number; z: number } } | null;
      if (hit?.position) return { x: hit.position.x, y: hit.position.y };
    } catch {
      // A pick against a half-streamed octree can throw; fall through to the
      // ground plane rather than dropping the click.
    }
    return null;
  };

  // Intersect the event's world-space ray with the ground plane z = groundZ.
  // Returns null if the ray is parallel to the plane.
  const planePoint = (ray: THREE.Ray): { x: number; y: number } | null => {
    if (Math.abs(ray.direction.z) < 1e-6) return null;
    const t = (groundZ - ray.origin.z) / ray.direction.z;
    if (!isFinite(t)) return null;
    return {
      x: ray.origin.x + t * ray.direction.x,
      y: ray.origin.y + t * ray.direction.y,
    };
  };

  const hitPoint = (e: ThreeEvent<MouseEvent>): { x: number; y: number } | null =>
    surfacePoint(e.ray) ?? planePoint(e.ray);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    const hit = hitPoint(e);
    if (!hit) return;
    e.stopPropagation();
    onPick(hit.x, hit.y);
  };

  // The live preview follows the GROUND PLANE only, never the surface pick.
  // A GPU pick renders the visible nodes into an off-screen index buffer and
  // reads them back; doing that on every pointermove would stall the frame
  // loop. The plane is analytic and free, so the rubber-band stays smooth and
  // the click itself pays for the accurate answer. The preview can therefore
  // sit slightly off the committed corner on an oblique view — acceptable,
  // since the marker at corner 1 is drawn from the COMMITTED value.
  const handleMove = (e: ThreeEvent<MouseEvent>) => {
    if (!onMove) return;
    const hit = planePoint(e.ray);
    if (!hit) return;
    onMove(hit.x, hit.y);
  };

  // Render a huge transparent plane at the ground level so the click
  // target exists in the scene graph. We orient it so its normal points
  // +Z (the default), and set side=DoubleSide so picks register from
  // either side of the plane. Still mounted even when surface picking is
  // available: it is the fallback target, and it is what makes
  // onPointerMove fire over empty space.
  return (
    // UI overlay, not content — see lib/sceneOverlay.ts.
    <mesh
      {...SCENE_OVERLAY}
      position={[0, 0, groundZ]}
      onClick={handleClick}
      onPointerMove={handleMove}
      renderOrder={9999}
    >
      <planeGeometry args={[100000, 100000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}
