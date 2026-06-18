import { useEffect, useRef, useState } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { PointCloudOctree, PointColorType, PointSizeType } from 'potree-core';
import * as THREE from 'three';
import { MISS_COLOR } from '../../../lib/classification';
import { getPotreeManager, OctreeRequestManager } from '../potreeManager';

// =====================================================================
// Miss-point octree overlay
// =====================================================================
// Sky/miss points (laser pulses that returned nothing) get their OWN potree
// octree on the backend — built from the projected (or true-coord, when the
// scan has no origin) miss positions alongside the hits octree at create / bake
// / backfill. This component streams that second octree exactly like
// OctreePointCloud streams the hits, but renders it as a flat orange shell.
//
// This replaces the former flat-Float32Array overlay (one THREE.Points holding
// every miss, stride-subsampled to a 200k cap), which bogged the whole machine
// on a heavy cloud and aliased the periodic scan grid into visible Moiré bands.
// LOD streaming makes the count irrelevant and the thinning adaptive (no cap,
// no aliasing). LAD still consumes the FULL miss set via a separate backend
// path, so accuracy is untouched.

export interface MissOctreeProps {
  // sha1 of the projected-miss octree (data.octree.missOctreeCacheId). Served by
  // the same app://octree/<id>/ protocol as the hits octree — no special-casing.
  missCacheId: string;
  // Point size in screen pixels (FIXED, matching the hits octree's material).
  pointSize?: number;
  // The Translate-tool offset and render-only display offset applied to the HITS
  // octree for this cloud. The miss shell MUST use the same values or it drifts
  // off the tree (it attaches to the scene root, like the hits octree).
  translation?: { x: number; y: number; z: number } | null;
  displayOffset?: { x: number; y: number; z: number };
}

/**
 * Stream a scan's projected sky/miss points as a flat-orange potree octree.
 * Gated by the parent behind `showMisses` + `hasMisses`, so the load cost is
 * paid only when the user wants the shell shown.
 */
export function MissOctree({
  missCacheId,
  pointSize = 2,
  translation = null,
  displayOffset,
}: MissOctreeProps) {
  const { scene, camera, gl } = useThree();
  const manager = getPotreeManager();
  const [octree, setOctree] = useState<PointCloudOctree | null>(null);

  // Latest translation / display offset in refs so the cacheId-keyed loader can
  // seed the initial position without reloading the octree on every drag tick
  // (mirrors OctreePointCloud).
  const translationRef = useRef(translation);
  translationRef.current = translation;
  const displayOffsetRef = useRef(displayOffset);
  displayOffsetRef.current = displayOffset;

  // potree-core bakes a per-cloud loader offset into pco.position; our Translate
  // offset is ADDED on top of it, never replaces it.
  const basePositionRef = useRef<THREE.Vector3>(new THREE.Vector3());

  // Load on missCacheId change; attach to the scene root and apply the flat
  // material once. Re-mounts cleanly when the id changes (e.g. after backfill).
  useEffect(() => {
    if (!missCacheId) return;
    const url = `app://octree/${missCacheId}/metadata.json`;
    let cancelled = false;
    let pcoForCleanup: PointCloudOctree | null = null;
    manager
      .loadPointCloud(url, OctreeRequestManager)
      .then((pco) => {
        if (cancelled) {
          pco.dispose();
          return;
        }
        basePositionRef.current.copy(pco.position);
        const t = translationRef.current;
        const o = displayOffsetRef.current;
        if (t || o) {
          pco.position.set(
            basePositionRef.current.x + (t?.x ?? 0) - (o?.x ?? 0),
            basePositionRef.current.y + (t?.y ?? 0) - (o?.y ?? 0),
            basePositionRef.current.z + (t?.z ?? 0) - (o?.z ?? 0),
          );
        }

        scene.add(pco);
        pcoForCleanup = pco;
        setOctree(pco);

        // E2E hook: expose the loaded miss octree keyed by its cache id so a test
        // can assert the shell actually streamed in (toggle on → present, off →
        // gone). Set in the per-frame loop only once tiles are actually VISIBLE,
        // so the hook proves the shell rendered — not merely that the metadata
        // loaded. Mirrors OctreePointCloud's __octreePositions registry.
      })
      .catch((err) => {
        console.error(`Miss octree load failed for ${missCacheId}:`, err);
      });
    return () => {
      cancelled = true;
      if (pcoForCleanup) {
        scene.remove(pcoForCleanup);
        pcoForCleanup.dispose();
      }
      const reg = (window as unknown as { __missOctrees?: Record<string, boolean> }).__missOctrees;
      if (reg) delete reg[missCacheId];
    };
  }, [missCacheId, manager, scene, pointSize]);

  // Flat-orange material. Mirrors OctreePointCloud's 'single' colour path
  // EXACTLY — the subtle parts are load-bearing: potree-core's COLOR mode only
  // activates with `newFormat=false`, the framebuffer write bypasses three.js's
  // outputColorSpace conversion (RawShaderMaterial) so the colour is pre-encoded
  // sRGB and the encoding flags are zeroed, and the shader source must be rebuilt
  // (newFormat/pointColorType are plain fields with no auto-recompile). Without
  // the recompile the cloud loads but renders nothing/garbage.
  useEffect(() => {
    if (!octree) return;
    const m = octree.material;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mm = m as any;
    mm.newFormat = false;                 // COLOR mode is gated on newFormat off
    mm.inputColorEncoding = 0;
    mm.outputColorEncoding = 0;
    m.pointColorType = PointColorType.COLOR;
    m.color = new THREE.Color(MISS_COLOR[0], MISS_COLOR[1], MISS_COLOR[2]).convertLinearToSRGB();
    m.pointSizeType = PointSizeType.FIXED;
    m.size = Math.max(pointSize, 1) * 2;  // pixels — read as deliberate markers
    // Display aid — visible against the cloud, don't occlude the real points.
    m.depthWrite = false;
    if (typeof mm.updateShaderSource === 'function') mm.updateShaderSource();
    m.needsUpdate = true;
    // Propagate the (possibly rebuilt) material to already-loaded tiles; tiles
    // that stream in later capture it at construction. New arrivals are also
    // synced per-frame below.
    const visible = (octree as unknown as { visibleNodes?: unknown[] }).visibleNodes;
    if (Array.isArray(visible)) {
      for (const node of visible) {
        const sn = (node as { sceneNode?: { material?: unknown } }).sceneNode;
        if (sn) sn.material = m;
      }
    }
  }, [octree, pointSize]);

  // Keep the shell's world offset in sync with the Translate tool + display
  // offset (it's on the scene root, so the parent group doesn't reach it).
  useEffect(() => {
    if (!octree) return;
    const base = basePositionRef.current;
    octree.position.set(
      base.x + (translation?.x ?? 0) - (displayOffset?.x ?? 0),
      base.y + (translation?.y ?? 0) - (displayOffset?.y ?? 0),
      base.z + (translation?.z ?? 0) - (displayOffset?.z ?? 0),
    );
  }, [octree, translation?.x, translation?.y, translation?.z, displayOffset?.x, displayOffset?.y, displayOffset?.z]);

  // Per-frame LOD/budget streaming — the whole point of the octree path.
  useFrame(() => {
    if (!octree) return;
    manager.updatePointClouds([octree], camera, gl);
    // Keep newly-streamed tiles on the cloud's current (flat) material.
    const cur = octree.material;
    const visible = (octree as unknown as { visibleNodes?: unknown[] }).visibleNodes;
    if (Array.isArray(visible)) {
      for (const node of visible) {
        const sn = (node as { sceneNode?: { material?: unknown } }).sceneNode;
        if (sn && sn.material !== cur) sn.material = cur;
      }
      // Register the E2E hook the first frame tiles are actually visible, so the
      // hook means "the shell rendered", not "the metadata loaded".
      if (visible.length > 0) {
        const reg = ((window as unknown as { __missOctrees?: Record<string, boolean> }).__missOctrees ??= {});
        reg[missCacheId] = true;
      }
    }
  });

  // The cloud lives on the scene root, not a React `<primitive>`, so render
  // nothing — but stay mounted so useFrame runs.
  return null;
}
