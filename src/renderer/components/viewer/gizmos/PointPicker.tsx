import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Potree, PointSizeType, type PointCloudOctree } from 'potree-core';
import { MISS_ATTRIBUTE } from '../../../lib/classification';
import type { PointCloudData } from '../../../lib/pointCloudTypes';
import {
  ORIG_INTENSITY_ATTRIBUTE,
  worldPerPixel,
  nearSurfaceDistance,
  pickProbeOffsets,
  chooseNearestCandidate,
  type PickCandidate,
} from '../../../lib/pointPick';

// A raw pick, before any frame conversion or formatting (that all happens in
// lib/pointPick.ts). `position` is in DISPLAY space — the frame the scene
// renders in, i.e. world − displayOffset.
export interface PointPickHit {
  cloudId: string;
  position: THREE.Vector3;
  // Attribute name → value, straight off the tile buffer (octree) or the
  // cloud's own arrays (flat). Potree's bookkeeping keys are left in; the
  // formatter drops them.
  values: Record<string, unknown>;
  // Original row index. Flat clouds only — a Potree octree reorders by morton
  // code and carries no original-index column.
  sourceIndex?: number;
}

export interface PointPickerProps {
  // Live octrees of every VISIBLE octree-backed cloud, keyed by cloud id. The
  // projected-miss octree is deliberately absent from this list, which is what
  // makes sky/miss points unpickable without any extra filtering.
  octrees: Array<{ cloudId: string; octree: PointCloudOctree }>;
  // Resolves a cloud's in-memory data, for reading a flat cloud's scalar
  // arrays at the hit index (and for its miss mask).
  getCloudData: (cloudId: string) => PointCloudData | undefined;
  onPick: (hit: PointPickHit) => void;
}

// How close to the cursor a point has to be to count as "clicked", in CANVAS
// PIXELS. The flat-cloud path resolves ties by depth, so this is a tolerance
// around the ray, not a search radius: a point this many pixels off-cursor can
// still win if it is the nearest thing along the ray.
const PICK_RADIUS_PX = 10;
// Potree's GPU pick reads back a square window of the index buffer. Its own
// search widens outward from the centre pixel, so this is a maximum reach
// rather than a tolerance.
const OCTREE_PICK_WINDOW_PX = 13;
// Pixel diameter each point is rasterised at DURING THE PICK PASS ONLY.
//
// This is the whole reason sparse clouds used to be nearly unclickable.
// `Potree.pick` re-renders the visible nodes into an index buffer and then
// scans the readback window for a pixel that was actually written
// (`findHit`) — so a point is only pickable where its splat covered a pixel.
// potree's `updatePickMaterial` copies the DISPLAY material's sizing verbatim
// (`size`/`minSize`/`maxSize`/`pointSizeType`), and the viewer renders
// PointSizeType.FIXED at `pointSize`, which defaults to 1. That meant the pick
// pass drew 1-pixel splats: in a solid-looking region every pixel is covered
// so any click lands, but in a region with visible background you had to hit
// an individual dot dead-on. Density, not aim, decided whether a click worked.
//
// Inflating the splat here decouples the CLICK TARGET from the DISPLAY size —
// the cloud still draws crisp at `pointSize`, but for the one off-screen pick
// render each point covers a ~9 px disc, which is what CloudCompare
// effectively does. Kept below OCTREE_PICK_WINDOW_PX so a splat cannot fill
// the entire readback window: `findHit` breaks ties by distance-to-centre in
// 2D with no depth test, so an over-large splat would let a point far from the
// cursor blanket the window and win.
//
// In CSS pixels. Both this and OCTREE_PICK_WINDOW_PX are scaled by the device
// pixel ratio before use — potree multiplies `pickWindowSize` by the ratio
// itself, but `size` lands in the shader as a raw `gl_PointSize` in DEVICE
// pixels, so on a Retina canvas (R3F defaults `dpr` to the device ratio; the
// viewer's <Canvas> does not override it) an unscaled value would cover half
// the intended area relative to the window.
const OCTREE_PICK_POINT_SIZE_PX = 9;
// Radius, in CSS pixels, of the ring of extra pick probes fired when the
// cursor itself lands on nothing. Sized to about half the inflated splat so
// the ring samples the surfaces flanking the cursor — the ones that compete to
// win a near-miss click — rather than reaching out past them into unrelated
// geometry. Only ever costs anything on a click that misses outright.
const PROBE_RING_RADIUS_PX = 5;
// A click that travels further than this between press and release was an
// orbit, not a pick. Mirrors the 4 px drag guard the viewport's mesh selection
// uses.
const DRAG_SLOP_PX = 4;

// World units per canvas pixel at `distance` from the camera. The maths lives
// in lib/pointPick.ts so it can be unit-tested without a GL context; this just
// narrows a THREE.Camera down to the shape that helper takes.
function worldPerPixelAt(camera: THREE.Camera, viewportHeight: number, distance: number): number {
  const persp = camera as THREE.PerspectiveCamera;
  const ortho = camera as THREE.OrthographicCamera;
  return worldPerPixel(
    persp.isPerspectiveCamera
      ? { isPerspectiveCamera: true, fov: persp.fov }
      : { top: ortho.top, bottom: ortho.bottom, zoom: ortho.zoom },
    viewportHeight,
    distance,
  );
}

// Grow every point to a fat fixed-size splat for the pick render pass.
//
// potree hands us its internal pick material AFTER it has copied the display
// material's sizing onto it, and re-copies on every pick, so mutating it here
// is safe and self-resetting — the material is private to the picker and never
// reaches the visible scene.
//
// The shader does `pointSize = clamp(pointSize, minSize, maxSize)`, so setting
// `size` alone is not enough: the display material's `maxSize` would clamp the
// inflation straight back down. All three move together, and `pointSizeType`
// is pinned to FIXED so `size` is read as a literal pixel count rather than
// being scaled by node spacing / camera distance.
function makeInflatePickSplat(pixelRatio: number) {
  const px = OCTREE_PICK_POINT_SIZE_PX * Math.max(pixelRatio, 1);
  return (material: {
    size: number;
    minSize: number;
    maxSize: number;
    pointSizeType: PointSizeType;
  }): void => {
    material.pointSizeType = PointSizeType.FIXED;
    material.size = px;
    material.minSize = px;
    material.maxSize = Math.max(material.maxSize, px);
  };
}

// CloudCompare-style point picker.
//
// Mounted only while the Pick Point tool is armed. Listens on the canvas
// directly (rather than mounting an R3F click target like OriginPicker's giant
// plane) so a pick works in every view direction — a finite catcher plane
// misses when the camera looks along or away from it — with an explicit drag
// guard so an orbit never drops a label.
//
// Both cloud kinds are picked and the nearest hit along the ray wins:
//
//   * octree clouds go through potree-core's GPU pick, which renders a
//     POINT_INDEX pass and hands back the hit point's position PLUS every
//     attribute on the tile's geometry, and
//   * flat clouds go through a plain THREE.Points raycast, whose
//     `intersection.index` is the original point index (PointCloud.tsx shares
//     `data.positions` uncopied and expresses crop/erase/filter through the
//     geometry index buffer, whose entries are source indices).
export function PointPicker({ octrees, getCloudData, onPick }: PointPickerProps) {
  const { gl, camera, scene, size } = useThree();

  // Latest props in refs so the listener effect binds once per canvas rather
  // than re-binding on every octree-registry or callback identity change.
  const octreesRef = useRef(octrees);
  octreesRef.current = octrees;
  const getCloudDataRef = useRef(getCloudData);
  getCloudDataRef.current = getCloudData;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    gl.domElement.style.cursor = 'crosshair';
    return () => { gl.domElement.style.cursor = 'auto'; };
  }, [gl]);

  useEffect(() => {
    const canvas = gl.domElement;
    const pressRef = { x: 0, y: 0, active: false };
    // Refreshed once per pick in doPick, before anything reads it.
    const viewDir = new THREE.Vector3();

    // One GPU pick at one ray. Occlusion within the probe is potree's job and
    // it does it correctly (the pick pass depth-tests against a cleared depth
    // buffer); choosing BETWEEN probes is the caller's, in pickOctrees.
    const probeOctrees = (ray: THREE.Ray): PointPickHit | null => {
      const entries = octreesRef.current;
      if (entries.length === 0) return null;
      let hit: Record<string, unknown> | null = null;
      try {
        hit = Potree.pick(
          entries.map((e) => e.octree),
          gl,
          camera,
          ray,
          // `pickOutsideClipRegion` is left at its default (false) on purpose:
          // the other pick call sites in this app pass true because they are
          // anchoring a brush, but a picker must not return a point the user
          // cannot see — points hidden by a live crop preview or an unbaked
          // delete are clipped in the shader and must stay unpickable.
          {
            pickWindowSize: OCTREE_PICK_WINDOW_PX,
            onBeforePickRender: makeInflatePickSplat(gl.getPixelRatio()),
          },
        ) as Record<string, unknown> | null;
      } catch {
        return null; // a pick against a half-streamed octree can throw; ignore
      }
      const position = hit?.position as THREE.Vector3 | undefined;
      if (!hit || !position) return null;
      const owner = entries.find((e) => e.octree === hit!.pointCloud);
      if (!owner) return null;

      const values: Record<string, unknown> = { ...hit };
      delete values.pointCloud;
      delete values.position;
      // Undo the scalar-colour alias: while `colorMode === 'scalar'` the tile's
      // `intensity` slot points at the selected scalar's buffer, so the pick's
      // `intensity` would be that scalar's value under the wrong name. The real
      // buffer was stashed alongside it (see OctreePointCloud), and the aliased
      // scalar is still present under its own slug, so nothing is lost.
      if (ORIG_INTENSITY_ATTRIBUTE in values) {
        values.intensity = values[ORIG_INTENSITY_ATTRIBUTE];
        delete values[ORIG_INTENSITY_ATTRIBUTE];
      }
      return { cloudId: owner.cloudId, position: position.clone(), values };
    };

    // Depth-aware octree pick.
    //
    // Probes the cursor plus a ring around it and keeps the hit NEAREST THE
    // CAMERA, not the one nearest the cursor on screen. This is the half of
    // occlusion potree cannot do for us: its `findHit` ranks the pixels of a
    // single readback window by 2D distance with no depth term (the readback
    // is all index bytes — there is no depth to rank by), so clicking just off
    // a foreground twig could return a trunk far behind it, purely because the
    // trunk's splat covered a pixel one step closer to the cursor.
    //
    // The centre probe is a CANDIDATE, not a short-circuit. Returning early on
    // it was the obvious optimisation and it is wrong: potree's centre probe
    // has already searched its own 13 px window by 2D distance, so a click that
    // misses the foreground can come back holding the background — the exact
    // hit this function exists to overrule. It has to be ranked against the
    // ring like any other probe.
    const pickOctrees = (
      clientX: number,
      clientY: number,
      rect: DOMRect,
      centerHit: PointPickHit | null,
    ): PointPickHit | null => {
      const offsets = pickProbeOffsets(PROBE_RING_RADIUS_PX);
      const hits: Array<PointPickHit | null> = [centerHit];
      const candidates: Array<PickCandidate | null> = [
        centerHit
          ? {
              depth: centerHit.position.clone().sub(camera.position).dot(viewDir),
              offsetPx: 0,
            }
          : null,
      ];
      const probeRay = new THREE.Raycaster();
      const ndc = new THREE.Vector2();

      for (const off of offsets.slice(1)) { // centre already probed by the caller
        const x = clientX + off.dx;
        const y = clientY + off.dy;
        // A probe pushed outside the canvas would clamp back onto the edge and
        // report a hit for a pixel the user did not click.
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
          hits.push(null);
          candidates.push(null);
          continue;
        }
        ndc.set(
          ((x - rect.left) / rect.width) * 2 - 1,
          -((y - rect.top) / rect.height) * 2 + 1,
        );
        probeRay.setFromCamera(ndc, camera);
        const h = probeOctrees(probeRay.ray);
        hits.push(h);
        candidates.push(
          h
            ? {
                // Depth along the VIEW direction, not distance to the camera:
                // an off-axis probe is inherently further from the eye, and
                // ranking by raw distance would bias against the ring.
                depth: h.position.clone().sub(camera.position).dot(viewDir),
                offsetPx: Math.hypot(off.dx, off.dy),
              }
            : null,
        );
      }

      const winner = chooseNearestCandidate(candidates);
      return winner < 0 ? null : hits[winner];
    };

    const pickFlatClouds = (raycaster: THREE.Raycaster): PointPickHit | null => {
      // Collect the flat point clouds in the scene. The tag is set by
      // renderers/PointCloud.tsx, so skeleton/overlay THREE.Points objects —
      // which are not pick targets — are skipped.
      const targets: THREE.Points[] = [];
      scene.traverse((obj) => {
        const id = (obj as THREE.Points).userData?.pointCloudId;
        if (typeof id === 'string' && (obj as THREE.Points).isPoints && obj.visible) {
          targets.push(obj as THREE.Points);
        }
      });
      if (targets.length === 0) return null;

      let best: { hit: PointPickHit; distance: number } | null = null;
      const center = new THREE.Vector3();
      for (const target of targets) {
        const cloudId = target.userData.pointCloudId as string;
        const data = getCloudDataRef.current(cloudId);
        if (!data) continue;

        // A fixed world-space threshold would make picking impossible on a
        // 100 m scan and hair-trigger on a 10 cm one. Size it from the cloud's
        // distance so the tolerance is a constant number of PIXELS, the same
        // reasoning the erase brush spells out.
        //
        // three.js tests this threshold as a world-space radius around the ray
        // and, under a perspective camera, applies it UNSCALED at every depth.
        // So the distance it is sized from decides which part of the cloud is
        // clickable. Sizing it from the bounding-sphere CENTRE — as this did —
        // is wrong for any cloud that is deep along the view axis: a 100 m scan
        // viewed end-on got a tolerance computed for its midpoint, leaving the
        // near half under-tolerant (too tight to click) and the far half
        // over-tolerant. Size it from the NEAR surface of the bounding sphere
        // instead, so the tolerance is never smaller than PICK_RADIUS_PX at the
        // closest thing the user can see; points deeper in get a tolerance that
        // is generous in pixel terms, which is the harmless direction — the
        // depth sort below still awards the pick to the nearest point.
        //
        // PointCloud.tsx computes the bounding sphere when it builds the
        // geometry, so this is a read, not an O(N) pass — recompute only if a
        // geometry somehow arrived without one.
        if (!target.geometry.boundingSphere) target.geometry.computeBoundingSphere();
        const sphere = target.geometry.boundingSphere;
        let dist: number;
        if (sphere) {
          center.copy(sphere.center).applyMatrix4(target.matrixWorld);
          // Radius has to travel through the same matrix as the centre: a
          // scaled cloud's world-space radius is not its local one.
          dist = nearSurfaceDistance(
            camera.position.distanceTo(center),
            sphere.radius,
            target.matrixWorld.getMaxScaleOnAxis(),
          );
        } else {
          center.setFromMatrixPosition(target.matrixWorld);
          dist = nearSurfaceDistance(camera.position.distanceTo(center), 0);
        }
        raycaster.params.Points = {
          threshold: PICK_RADIUS_PX * worldPerPixelAt(camera, sizeRef.current.height, dist),
        };

        const missField = data.scalarFields?.[MISS_ATTRIBUTE];
        // Only trust the miss mask when it spans the whole cloud — a
        // mismatched length means the arrays are out of step and every index
        // would be suspect.
        const missTrusted = !!missField && missField.values.length === data.pointCount;

        for (const isect of raycaster.intersectObject(target, false)) {
          const index = isect.index;
          if (index === undefined) continue;
          // Sky/miss points are ~1 km out along the beam and are not real
          // geometry; they are never a pick target. Skipping one has to
          // CONTINUE to the next intersection — an unconditional `break` at the
          // foot of this loop (what used to be here) meant a miss point in
          // front only ever let the ONE next intersection be considered, and
          // any run of two or more misses swallowed the pick entirely.
          if (missTrusted && missField!.values[index] !== 0) continue;
          if (!best || isect.distance < best.distance) {
            best = {
              distance: isect.distance,
              hit: {
                cloudId,
                position: isect.point.clone(),
                values: {},
                sourceIndex: index,
              },
            };
          }
          // Intersections are distance-sorted, so the first non-miss is this
          // target's nearest hit; later ones cannot beat it. Cross-target
          // comparison still happens via `best`.
          break;
        }
      }
      return best?.hit ?? null;
    };

    const doPick = (clientX: number, clientY: number) => {
      const rect = gl.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);

      // Unit view direction, for measuring depth along the axis the user is
      // looking down. Used to rank probes against each other and to compare
      // the two cloud kinds; distance-to-camera would penalise any hit that is
      // merely off to the side.
      camera.getWorldDirection(viewDir);

      const centerHit = probeOctrees(raycaster.ray);
      const octreeHit = pickOctrees(clientX, clientY, rect, centerHit);
      const flatHit = pickFlatClouds(raycaster);
      if (!octreeHit && !flatHit) return;

      let winner: PointPickHit;
      if (octreeHit && flatHit) {
        // Both kinds are in the scene — the one nearer along the view axis is
        // the one the user can actually see there.
        const dOct = octreeHit.position.clone().sub(camera.position).dot(viewDir);
        const dFlat = flatHit.position.clone().sub(camera.position).dot(viewDir);
        winner = dOct <= dFlat ? octreeHit : flatHit;
      } else {
        winner = (octreeHit ?? flatHit) as PointPickHit;
      }
      onPickRef.current(winner);
    };

    const handlePointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pressRef.active = true;
      pressRef.x = e.clientX;
      pressRef.y = e.clientY;
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (e.button !== 0 || !pressRef.active) return;
      pressRef.active = false;
      // Drag guard: a press that travelled was an orbit, not a pick.
      if (Math.hypot(e.clientX - pressRef.x, e.clientY - pressRef.y) > DRAG_SLOP_PX) return;
      doPick(e.clientX, e.clientY);
    };

    canvas.addEventListener('pointerdown', handlePointerDown);
    // pointerup on the window so a release that drifted off-canvas still
    // cancels cleanly instead of leaving the press armed.
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [gl, camera, scene]);

  return null;
}
