/**
 * "Above / below / near a line drawn in a cross-section" — TerraScan's
 * Above/Below Line, for cutting a stem from its crown or a trunk from the
 * ground in one stroke.
 *
 * The line lives in the SLAB FRAME: [along, z], `along` measured from the
 * section's `a` along a→b, `z` world height — the two axes a face-on section
 * shows on screen. It is camera-free once built, so the live preview here and
 * the backend's `_polyline_halfspace_mask` evaluate the same closed form; both
 * are pinned to src/shared/profileLine.contract.json.
 */
import * as THREE from 'three';
import { slabNormal, slabTangent, type SlabRegion } from './crossSection';

export type ProfileLineSide = 'above' | 'below' | 'near';

export interface PolylineHalfspaceRegion {
  kind: 'polyline_halfspace';
  a: [number, number];
  b: [number, number];
  /** [along, z] vertices in the a→b frame, in any order. */
  line: Array<[number, number]>;
  side: ProfileLineSide;
  /** Bounds the selection to within `band` of the line; required for 'near'. */
  band?: number;
  invert?: boolean;
}

/**
 * World-space membership test — the exact predicate the backend mirrors.
 *
 * A point's height is compared with the line's at the point's own `along`,
 * interpolated between vertices and held flat past either end (np.interp's
 * clamping), so a line stopped a few pixels short of the section's edge still
 * covers it.
 */
export function profileLinePredicate(
  r: PolylineHalfspaceRegion,
): (wx: number, wy: number, wz: number) => boolean {
  const [ax, ay] = r.a;
  const len = Math.hypot(r.b[0] - ax, r.b[1] - ay);
  const tx = (r.b[0] - ax) / len;
  const ty = (r.b[1] - ay) / len;
  const line = r.line.map((v, i) => [v[0], v[1], i] as const)
    .sort((p, q) => p[0] - q[0] || p[2] - q[2]);
  const us = line.map((v) => v[0]);
  const zs = line.map((v) => v[1]);
  const n = us.length;
  const heightAt = (u: number): number => {
    if (u <= us[0]) return zs[0];
    if (u >= us[n - 1]) return zs[n - 1];
    // Right-most vertex with us[i] <= u — np.interp's choice on ties.
    let lo = 0; let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (us[mid] <= u) lo = mid; else hi = mid;
    }
    const du = us[hi] - us[lo];
    return du > 0 ? zs[lo] + (zs[hi] - zs[lo]) * (u - us[lo]) / du : zs[hi];
  };
  const band = r.band;
  const invert = !!r.invert;
  const test = (dz: number): boolean => {
    if (r.side === 'near') return Math.abs(dz) <= (band ?? 0);
    const side = r.side === 'above' ? dz >= 0 : dz <= 0;
    return band == null ? side : side && Math.abs(dz) <= band;
  };
  return (wx, wy, wz) => {
    const u = (wx - ax) * tx + (wy - ay) * ty;
    return test(wz - heightAt(u)) !== invert;
  };
}

/**
 * Where a screen pixel lands in the section: the ray through it, from the
 * frozen camera, meets the slab's center plane, and that point is expressed as
 * [along, z]. Null when the ray runs parallel to the plane (an edge-on view)
 * or the plane is behind the camera.
 *
 * `projection` / `view` are the column-major matrices a lasso region carries
 * (view already includes the display offset, so this returns WORLD heights).
 */
export function screenToProfile(
  px: number, py: number,
  projection: number[], view: number[], canvas: { width: number; height: number },
  slab: SlabRegion,
): [number, number] | null {
  const inv = new THREE.Matrix4().fromArray(projection)
    .multiply(new THREE.Matrix4().fromArray(view)).invert();
  const ndcX = (px / canvas.width) * 2 - 1;
  const ndcY = 1 - (py / canvas.height) * 2;
  const near = new THREE.Vector3(ndcX, ndcY, -1).applyMatrix4(inv);
  const far = new THREE.Vector3(ndcX, ndcY, 1).applyMatrix4(inv);
  const dir = far.clone().sub(near);
  const n = slabNormal(slab);
  const t = slabTangent(slab);
  // Plane: (p.xy - a)·n = offset.
  const denom = dir.x * n.x + dir.y * n.y;
  if (Math.abs(denom) < 1e-12 * Math.max(dir.length(), 1)) return null;
  const s = (slab.offset - ((near.x - slab.a.x) * n.x + (near.y - slab.a.y) * n.y)) / denom;
  if (s < 0) return null;
  const p = near.addScaledVector(dir, s);
  return [(p.x - slab.a.x) * t.x + (p.y - slab.a.y) * t.y, p.z];
}

/** The region for a line drawn in `slab`, in the frame the backend expects. */
export function profileLineRegion(
  slab: SlabRegion, line: Array<[number, number]>, side: ProfileLineSide, band: number | null,
): PolylineHalfspaceRegion {
  return {
    kind: 'polyline_halfspace',
    a: [slab.a.x, slab.a.y],
    b: [slab.b.x, slab.b.y],
    line,
    side,
    ...(band != null && band > 0 ? { band } : {}),
  };
}
