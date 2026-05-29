import { Potree } from 'potree-core';
import type { PotreeRequestManager } from '../../lib/pointCloudTypes';

// =====================================================================
// Octree streaming (0.3.0+)
// =====================================================================
// Shared across all OctreePointCloud instances. potree-core's Potree
// class owns the LRU node cache + load worker pool — having one per
// component would fragment those. Keeping it in its own module makes the
// single-instance guarantee unambiguous.
let _sharedPotreeManager: Potree | null = null;
export function getPotreeManager(): Potree {
  if (!_sharedPotreeManager) {
    _sharedPotreeManager = new Potree();
    // 2M visible points ≈ 24 MB position data on GPU. The renderer is
    // free to render fewer than the budget if the camera doesn't see
    // that many.
    _sharedPotreeManager.pointBudget = 2_000_000;
  }
  return _sharedPotreeManager;
}

// potree-core's RequestManager just wraps fetch + URL resolution. With
// the `app://` scheme registered as supportFetchAPI, the global fetch
// works transparently.
export const OctreeRequestManager: PotreeRequestManager = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  getUrl: async (url: string) => url,
};
