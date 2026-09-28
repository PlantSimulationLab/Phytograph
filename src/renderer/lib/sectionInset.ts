/**
 * Geometry for the cross-section inset map: a small top-down view of the cloud
 * with the slab drawn on it, so a user paging through a face-on section can see
 * where in the cloud they are.
 *
 * Pure except for `sampleOctreeFootprint`, which only reads the loaded octree.
 */
import * as THREE from 'three';
import { slabNormal, slabTangent, type SlabRegion, type Vec2 } from './crossSection';

export interface Rect2 { minX: number; minY: number; maxX: number; maxY: number }

/** The slab's four corners in world XY, in drawing order (offset applied). */
export function slabFootprint(s: SlabRegion): Vec2[] {
  const t = slabTangent(s);
  const n = slabNormal(s);
  const lo = s.offset - s.depth / 2;
  const hi = s.offset + s.depth / 2;
  const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  const at = (along: number, across: number): Vec2 => ({
    x: s.a.x + t.x * along + n.x * across,
    y: s.a.y + t.y * along + n.y * across,
  });
  return [at(0, lo), at(len, lo), at(len, hi), at(0, hi)];
}

/**
 * World XY → inset pixels, uniform scale (a map must not stretch), +Y up, the
 * union of `bounds` and every `extra` point centered in a `size` square with
 * `pad` px of margin. The union is what keeps a slab stepped past the edge of
 * the cloud on the map rather than silently off it.
 */
export function insetFrame(
  bounds: Rect2, extra: Vec2[], size: number, pad: number,
): { toPx: (x: number, y: number) => Vec2; scale: number } {
  let { minX, minY, maxX, maxY } = bounds;
  for (const p of extra) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  const scale = (size - 2 * pad) / span;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    scale,
    toPx: (x, y) => ({ x: size / 2 + (x - cx) * scale, y: size / 2 - (y - cy) * scale }),
  };
}

interface FootprintNode {
  sceneNode?: THREE.Points | null;
  children?: ReadonlyArray<FootprintNode | null>;
  isTreeNode?: boolean;
}

/**
 * World-XY sample of an octree's footprint, from its top `maxDepth` levels.
 *
 * The coarse levels of a potree octree are a spatially even subsample of the
 * whole cloud and are always resident, so this costs no request and no
 * streaming — exactly the overview the map needs. Positions are node-local;
 * `matrixWorld` takes them to the display frame and `displayOffset` back to
 * world. Strided down to at most `max` points.
 */
export function sampleOctreeFootprint(
  root: FootprintNode | null | undefined,
  displayOffset: { x: number; y: number } | null | undefined,
  max = 20000,
  maxDepth = 2,
): Float32Array {
  const nodes: THREE.Points[] = [];
  const walk = (n: FootprintNode | null | undefined, depth: number) => {
    if (!n || depth > maxDepth) return;
    if (n.sceneNode?.geometry?.getAttribute?.('position')) nodes.push(n.sceneNode);
    for (const c of n.children ?? []) if (c?.isTreeNode) walk(c, depth + 1);
  };
  walk(root, 0);
  const total = nodes.reduce((k, p) => k + p.geometry.getAttribute('position').count, 0);
  if (!total) return new Float32Array(0);
  const stride = Math.max(1, Math.ceil(total / max));
  const out: number[] = [];
  const v = new THREE.Vector3();
  const ox = displayOffset?.x ?? 0;
  const oy = displayOffset?.y ?? 0;
  let k = 0;
  for (const pts of nodes) {
    const pos = pts.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++, k++) {
      if (k % stride) continue;
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(pts.matrixWorld);
      out.push(v.x + ox, v.y + oy);
    }
  }
  return new Float32Array(out);
}
