import { Potree } from 'potree-core';
import type { PointCloudOctree } from 'potree-core';
import type * as THREE from 'three';
import type { PotreeRequestManager } from '../../lib/pointCloudTypes';

// =====================================================================
// Octree streaming (0.3.0+)
// =====================================================================
// Shared across all OctreePointCloud instances. potree-core's Potree
// class owns the LRU node cache + load worker pool — having one per
// component would fragment those. Keeping it in its own module makes the
// single-instance guarantee unambiguous.
// Normal-viewing point budget. 2M visible points ≈ 24 MB position data on GPU.
// The renderer is free to render fewer than the budget if the camera doesn't
// see that many.
export const DEFAULT_POINT_BUDGET = 2_000_000;

// Reduced budget used WHILE a crop box is being previewed. potree clips points
// with a fragment-shader `discard`, which disables early-Z; the GPU then can no
// longer cull occluded points, so overdraw is driven by depth complexity
// (points stacked per pixel). Shrinking the crop box concentrates the survivors
// into a small screen area and the frame becomes GPU-bound (measured: ~600K
// points at ~6 fps on a large cloud while a full uncropped 2M view stays at
// 60 fps because early-Z culls the occluded points). Fragment invocations scale
// with point COUNT, so a smaller preview budget restores responsiveness. The
// preview is approximate anyway — Apply re-converts at full resolution. Value
// chosen from measured frame times: ~520K rendered points ≈ 125 ms/frame on the
// reporting machine when concentrated, so ~150K targets ~30 fps in the worst
// (most concentrated) case while staying detailed enough to aim the crop box.
//
// This is a budget for the WHOLE SCENE, not per cloud — the shared manager
// divides it across every registered octree in one pass (see updateAllPointClouds).
export const CROP_PREVIEW_POINT_BUDGET = 150_000;

let _sharedPotreeManager: Potree | null = null;
export function getPotreeManager(): Potree {
  if (!_sharedPotreeManager) {
    _sharedPotreeManager = new Potree();
    _sharedPotreeManager.pointBudget = DEFAULT_POINT_BUDGET;
  }
  return _sharedPotreeManager;
}

// Set the shared manager's point budget (e.g. lowered during crop preview,
// restored after). No-op if the manager hasn't been created yet.
export function setPointBudget(budget: number): void {
  if (_sharedPotreeManager) _sharedPotreeManager.pointBudget = budget;
}

// =====================================================================
// Per-frame update registry
// =====================================================================
// Why this exists (the "disco flicker" bug): potree's point budget and its
// node LRU are BOTH global to the manager, so `updatePointClouds` must be
// called ONCE PER FRAME WITH EVERY VISIBLE OCTREE. When each cloud component
// called it with just its own octree, two things broke with >1 cloud:
//
//  1. Budget multiplication. `updateVisibility` starts its point accumulator at
//     zero on every call and fills until `pointBudget`, so N separately-updated
//     clouds each claimed the FULL budget — N× the intended points resident.
//  2. LRU thrash. Each call ends in `lru.freeMemory()`, which evicts from the
//     head (least-recently-touched) while the just-updated cloud's nodes were
//     refreshed to the tail. With N clouds the head is always a DIFFERENT
//     cloud, so every frame disposed one cloud's subtree and reloaded it next
//     frame — clouds visibly cycling in and out, worst during crop preview
//     where the budget drops to CROP_PREVIEW_POINT_BUDGET and demand exceeds
//     the `2 × pointBudget` eviction threshold every frame.
//
// Passing the whole array instead lets potree interleave one priority queue
// across all clouds (each node carries its `pointCloudIndex`), so the budget is
// shared by node priority rather than claimed N times, and `freeMemory` runs
// once against a set that was touched as a unit.
//
// Components register their octree here on load and unregister on unmount;
// `updateAllPointClouds` is driven by exactly one useFrame in the viewer.
export interface OctreeFrameEntry {
  octree: PointCloudOctree;
  // Return true to exclude this octree from this frame's update (e.g. a crop
  // box that provably clips the whole cloud — see cropClipsEverything).
  // Skipped clouds don't consume budget and aren't touched in the LRU.
  shouldSkip?: () => boolean;
  // Runs after the shared update, for per-cloud work that depends on the
  // freshly-computed visibleNodes (material sync, scalar buffer swaps, E2E hooks).
  afterUpdate?: () => void;
}

const _frameEntries = new Map<PointCloudOctree, OctreeFrameEntry>();

// Register an octree for the shared per-frame update. Returns an unregister
// function suitable for a useEffect cleanup.
export function registerOctreeForFrame(entry: OctreeFrameEntry): () => void {
  _frameEntries.set(entry.octree, entry);
  return () => {
    _frameEntries.delete(entry.octree);
  };
}

// The single per-frame potree update for the whole scene. Call from exactly one
// useFrame — calling it per cloud reintroduces the budget/LRU bug above.
export function updateAllPointClouds(camera: THREE.Camera, renderer: THREE.WebGLRenderer): void {
  if (_frameEntries.size === 0) return;
  const manager = getPotreeManager();

  const active: OctreeFrameEntry[] = [];
  for (const entry of _frameEntries.values()) {
    // `disposed` clouds linger for a frame between potree's dispose and our
    // unregister; passing one to updatePointClouds would touch freed geometry.
    if ((entry.octree as unknown as { disposed?: boolean }).disposed) continue;
    if (entry.shouldSkip?.()) continue;
    active.push(entry);
  }
  if (active.length > 0) {
    manager.updatePointClouds(active.map((e) => e.octree), camera, renderer);
  }
  // After the shared pass, so every callback sees final visibleNodes.
  for (const entry of active) entry.afterUpdate?.();
}

// potree-core's RequestManager just wraps fetch + URL resolution. With
// the `app://` scheme registered as supportFetchAPI, the global fetch
// works transparently.
export const OctreeRequestManager: PotreeRequestManager = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  getUrl: async (url: string) => url,
};
