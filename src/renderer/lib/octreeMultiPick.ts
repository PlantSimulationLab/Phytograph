// The one way to GPU-pick across several octree clouds at once.
//
// Every multi-cloud `Potree.pick` in the app goes through `pickAcrossOctrees`
// rather than calling potree-core directly, because the raw call has two
// defects that only show up once more than one cloud is visible:
//
//   1. It silently drops every cloud but the last. potree clears the pick
//      window ONCE, then issues one `renderer.render()` per cloud into it —
//      which assumes `renderer.autoClear === false` (the Potree viewer sets
//      that; three.js and R3F default it to true). With autoClear on, each
//      render clears the (scissored) pick window first, erasing the colors AND
//      depth the previous clouds wrote. So only the LAST cloud whose nodes
//      cross the ray could ever be picked, and depth between clouds was never
//      compared: with nine co-registered scans, a click on a foreground point
//      scan A captured came back as whatever scan I saw behind it.
//
//   2. It throws past 255 nodes. The pick pass encodes "which node" in the
//      8-bit alpha channel, so once the nodes crossing the ray — summed over
//      ALL clouds — pass 255, `createTempNodes` throws. Callers caught that and
//      reported no hit, so a dense multi-scan scene simply stopped picking.
//      Worse, the throw lands mid-pick, after potree has pointed the renderer
//      at its private render target with a pick-window scissor, and nothing
//      put either back.
//
// The fix for (1) is to hold autoClear off for the duration of the call. For
// (2), the nodes on the ray are split into batches of at most 255, each batch
// is picked separately (by temporarily narrowing each octree's `visibleNodes`
// to its share of the batch — potree reads nothing else to decide what to
// draw), and the batch winners are ranked by depth along the view direction.
// Within a batch occlusion is exact (potree depth-tests); across batches the
// nearest surface wins, which is the same rule the depth test applies.
import * as THREE from 'three';
import { Potree, type PointCloudOctree, type PickParams, type PickPoint } from 'potree-core';

// potree-core's hard limit: node ids 1..255 go in the alpha byte, 0 = empty.
export const MAX_PICK_NODES_PER_PASS = 255;

type OctreeNode = PointCloudOctree['visibleNodes'][number];

export interface PickBatchEntry {
  octree: PointCloudOctree;
  nodes: OctreeNode[];
}

const _sphere = new THREE.Sphere();

// The nodes of `octree` that potree's own `nodesOnRay` would render for this
// ray: visible nodes whose world-space bounding sphere the ray crosses. Must
// stay the same test potree uses, or a batch could be sized under the limit
// and still overflow it.
export function nodesOnRay(octree: PointCloudOctree, ray: THREE.Ray): OctreeNode[] {
  const out: OctreeNode[] = [];
  for (const node of octree.visibleNodes) {
    _sphere.copy(node.boundingSphere).applyMatrix4(octree.matrixWorld);
    if (ray.intersectsSphere(_sphere)) out.push(node);
  }
  return out;
}

// Pack each octree's on-ray nodes into batches of at most `limit` nodes,
// splitting a single octree across batches when it alone exceeds the limit.
// Octrees with nothing on the ray are dropped. Pure — exported for tests.
export function batchPickNodes(
  perOctree: PickBatchEntry[],
  limit = MAX_PICK_NODES_PER_PASS,
): PickBatchEntry[][] {
  const batches: PickBatchEntry[][] = [];
  let current: PickBatchEntry[] = [];
  let room = limit;
  for (const { octree, nodes } of perOctree) {
    let start = 0;
    while (start < nodes.length) {
      if (room === 0) {
        batches.push(current);
        current = [];
        room = limit;
      }
      const take = Math.min(room, nodes.length - start);
      current.push({ octree, nodes: nodes.slice(start, start + take) });
      start += take;
      room -= take;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// GPU-pick the point under `ray` across every octree in `octrees`, nearest
// surface first. Never throws: a batch that fails (a pick against a
// half-streamed octree can) is skipped and the renderer state it left behind
// is restored.
export function pickAcrossOctrees(
  octrees: PointCloudOctree[],
  gl: THREE.WebGLRenderer,
  camera: THREE.Camera,
  ray: THREE.Ray,
  params: Partial<PickParams> = {},
): PickPoint | null {
  if (octrees.length === 0) return null;

  const perOctree: PickBatchEntry[] = [];
  for (const octree of octrees) {
    const nodes = nodesOnRay(octree, ray);
    if (nodes.length > 0) perOctree.push({ octree, nodes });
  }
  if (perOctree.length === 0) return null;
  const batches = batchPickNodes(perOctree);

  const viewDir = camera.getWorldDirection(new THREE.Vector3());
  const prevTarget = gl.getRenderTarget();
  const prevAutoClear = gl.autoClear;
  let best: PickPoint | null = null;
  let bestDepth = Infinity;

  gl.autoClear = false;
  try {
    for (const batch of batches) {
      // Narrow each octree to its share of this batch. Only needed when the
      // scene actually overflowed — a single batch holds every on-ray node,
      // which is exactly what potree would select by itself.
      const saved = batches.length > 1
        ? batch.map(({ octree, nodes }) => {
            const prev = octree.visibleNodes;
            octree.visibleNodes = nodes;
            return { octree, prev };
          })
        : [];
      let hit: PickPoint | null = null;
      try {
        hit = Potree.pick(batch.map((e) => e.octree), gl, camera, ray, params);
      } catch {
        // Undo what an interrupted pick leaves set: potree's render target
        // and its pick-window scissor would otherwise leak into the next frame.
        gl.setScissorTest(false);
        gl.setRenderTarget(prevTarget);
      } finally {
        for (const { octree, prev } of saved) octree.visibleNodes = prev;
      }
      if (!hit?.position) continue;
      const depth = hit.position.clone().sub(camera.position).dot(viewDir);
      if (depth < bestDepth) {
        bestDepth = depth;
        best = hit;
      }
    }
  } finally {
    gl.autoClear = prevAutoClear;
  }
  return best;
}
