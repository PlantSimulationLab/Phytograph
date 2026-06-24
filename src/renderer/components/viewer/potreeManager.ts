import { Potree } from 'potree-core';
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

// potree-core's RequestManager just wraps fetch + URL resolution. With
// the `app://` scheme registered as supportFetchAPI, the global fetch
// works transparently.
export const OctreeRequestManager: PotreeRequestManager = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  getUrl: async (url: string) => url,
};
