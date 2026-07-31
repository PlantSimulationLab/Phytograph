import { useFrame, useThree } from '@react-three/fiber';
import { updateAllPointClouds } from '../potreeManager';

// The single per-frame potree update for the entire scene.
//
// potree's point budget and its node LRU both live on the shared manager, so
// `updatePointClouds` has to see every visible octree in ONE call. When each
// cloud component drove its own update, N clouds each claimed the full budget
// and each call's `lru.freeMemory()` evicted whichever cloud was touched
// longest ago — so with several scans loaded the clouds visibly cycled in and
// out every frame (worst during crop preview, where the reduced budget put
// demand above the eviction threshold on every frame).
//
// Cloud components register their octree with the manager's frame registry
// instead; this component drives them all together. It must be mounted exactly
// once, inside the Canvas. Render order within a frame doesn't matter — the
// registry is keyed by octree, and this is the only caller.
export function PotreeFrameDriver() {
  const { camera, gl } = useThree();
  useFrame(() => {
    updateAllPointClouds(camera, gl);
  });
  return null;
}
