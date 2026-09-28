/**
 * Front-surface limit for the label lasso and rectangle: paint only what the
 * user can SEE inside the outline, not everything behind it.
 *
 * The screen-space lasso extrudes through the whole cloud, so outlining a leaf
 * also paints the branch behind it. This builds a coarse depth grid over the
 * outline from the points actually drawn, at the lasso's frozen camera, and turns
 * each cell into a depth THRESHOLD: the nearest drawn point, plus a tolerance.
 * A point is "on the front surface" when its view depth is within its cell's
 * threshold.
 *
 * The renderer decides the rule and ships the thresholds, and the backend only
 * compares (`_depth_limit_mask`), so the preview and the replay cannot disagree
 * about tolerances. Both are pinned to src/shared/frontSurface.contract.json.
 */
import * as THREE from 'three';

export interface DepthLimit {
  projection: number[];
  view: number[];
  canvas: { width: number; height: number };
  /** Grid origin in canvas pixels, and the cell size in pixels. */
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  /** cols*rows float32 view-depth thresholds, row-major, base64. Infinity = no
   *  surface known in that cell: everything there passes. */
  thresholds: string;
}

/** Largest grid we will ship with one stroke (256 KB of float32). */
export const MAX_DEPTH_CELLS = 1 << 16;

/** View-space depth (distance in front of the camera) of a world point. */
export function viewDepth(view: number[], x: number, y: number, z: number): number {
  return -(view[2] * x + view[6] * y + view[10] * z + view[14]);
}

/** Pixel of a world point under `projection · view`, or null behind the camera. */
function toPixel(
  projection: number[], view: number[], w: number, h: number, x: number, y: number, z: number,
): [number, number] | null {
  const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
  const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
  const vz = view[2] * x + view[6] * y + view[10] * z + view[14];
  const vw = view[3] * x + view[7] * y + view[11] * z + view[15];
  const cx = projection[0] * vx + projection[4] * vy + projection[8] * vz + projection[12] * vw;
  const cy = projection[1] * vx + projection[5] * vy + projection[9] * vz + projection[13] * vw;
  const cw = projection[3] * vx + projection[7] * vy + projection[11] * vz + projection[15] * vw;
  if (cw <= 0) return null;
  return [((cx / cw) + 1) * 0.5 * w, (1 - (cy / cw)) * 0.5 * h];
}

/**
 * World size of one canvas pixel at view depth `d`. Perspective grows with
 * depth (2d / (P[5]·H)); orthographic is constant (2 / (P[5]·H)).
 */
export function pixelWorldSize(projection: number[], height: number, d: number): number {
  const ortho = projection[15] === 1;
  return (ortho ? 2 : 2 * Math.max(d, 0)) / (projection[5] * height);
}

export function encodeFloat32(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function decodeFloat32(b64: string): Float32Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/**
 * Build the limit for an outline.
 *
 * `forEachPoint` visits the WORLD positions of the points on screen (the
 * loaded, visible octree tiles). `tolerance` is extra world depth on top of the
 * automatic allowance of two cells' width at that depth, which lets a surface
 * seen at an angle up to ~60° keep its far side of each cell.
 *
 * Each cell's nearest depth is min-filtered over its 3×3 neighborhood before
 * the threshold is taken: a coarse LOD tile leaves cells between its points
 * empty, and without the filter a back surface would show through those gaps.
 */
export function buildDepthLimit(
  outline: Array<[number, number]>,
  projection: number[], view: number[], canvas: { width: number; height: number },
  forEachPoint: (visit: (x: number, y: number, z: number) => void) => void,
  tolerance = 0,
): DepthLimit | null {
  if (outline.length === 0) return null;
  let bx0 = Infinity; let by0 = Infinity; let bx1 = -Infinity; let by1 = -Infinity;
  for (const [x, y] of outline) {
    bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
  }
  bx0 = Math.max(0, Math.floor(bx0)); by0 = Math.max(0, Math.floor(by0));
  bx1 = Math.min(canvas.width, Math.ceil(bx1)); by1 = Math.min(canvas.height, Math.ceil(by1));
  if (bx1 <= bx0 || by1 <= by0) return null;
  const area = (bx1 - bx0) * (by1 - by0);
  const cell = Math.max(3, Math.ceil(Math.sqrt(area / MAX_DEPTH_CELLS)));
  const cols = Math.ceil((bx1 - bx0) / cell);
  const rows = Math.ceil((by1 - by0) / cell);
  const near = new Float32Array(cols * rows).fill(Infinity);
  const { width: w, height: h } = canvas;
  forEachPoint((x, y, z) => {
    const p = toPixel(projection, view, w, h, x, y, z);
    if (!p) return;
    const c = Math.floor((p[0] - bx0) / cell);
    const r = Math.floor((p[1] - by0) / cell);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return;
    const d = viewDepth(view, x, y, z);
    const k = r * cols + c;
    if (d < near[k]) near[k] = d;
  });
  const thresholds = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let m = Infinity;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          const v = near[rr * cols + cc];
          if (v < m) m = v;
        }
      }
      thresholds[r * cols + c] = Number.isFinite(m)
        ? m + tolerance + 2 * cell * pixelWorldSize(projection, h, m)
        : Infinity;
    }
  }
  return {
    projection, view, canvas: { width: w, height: h },
    x0: bx0, y0: by0, cell, cols, rows, thresholds: encodeFloat32(thresholds),
  };
}

/**
 * Membership test for a built limit — mirrors the backend's
 * `_depth_limit_mask`. Outside the grid, or in a cell with no surface, a
 * point passes: the limit only ever REMOVES points that are behind something.
 */
export function depthLimitPredicate(
  limit: DepthLimit,
): (x: number, y: number, z: number) => boolean {
  const t = decodeFloat32(limit.thresholds);
  const { projection, view, canvas, x0, y0, cell, cols, rows } = limit;
  return (x, y, z) => {
    const p = toPixel(projection, view, canvas.width, canvas.height, x, y, z);
    if (!p) return true;
    const c = Math.floor((p[0] - x0) / cell);
    const r = Math.floor((p[1] - y0) / cell);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return true;
    return viewDepth(view, x, y, z) <= t[r * cols + c];
  };
}

/**
 * Visit the world positions of an octree's DRAWN points: every tile potree has
 * made visible, through its matrixWorld, plus the display offset. Hidden tiles
 * (culled, or evicted from the LOD) are skipped, since they cannot hide
 * anything. `keep` drops points that are not drawn for other reasons — the
 * slab's clip — so they cannot occlude what is.
 */
export function forEachDrawnPoint(
  root: unknown,
  displayOffset: { x: number; y: number; z: number } | null | undefined,
  keep?: (x: number, y: number, z: number) => boolean,
): (visit: (x: number, y: number, z: number) => void) => void {
  return (visit) => {
    const v = new THREE.Vector3();
    const ox = displayOffset?.x ?? 0; const oy = displayOffset?.y ?? 0; const oz = displayOffset?.z ?? 0;
    const walk = (n: any) => {
      if (!n) return;
      const pts: THREE.Points | undefined = n.sceneNode;
      if (pts && pts.visible) {
        const pos = pts.geometry?.getAttribute?.('position');
        if (pos) {
          for (let i = 0; i < pos.count; i++) {
            v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(pts.matrixWorld);
            const x = v.x + ox; const y = v.y + oy; const z = v.z + oz;
            if (!keep || keep(x, y, z)) visit(x, y, z);
          }
        }
      }
      for (const c of n.children ?? []) if (c?.isTreeNode) walk(c);
    };
    walk(root);
  };
}
