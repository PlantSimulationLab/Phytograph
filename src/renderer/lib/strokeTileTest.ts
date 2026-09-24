// Tile rejection for a SCREEN-space label stroke (a lasso polygon, stamped
// squares). Such a stroke has no world AABB, so without this every lasso stroke
// was replayed over every loaded tile.
//
// A box in front of the camera projects inside the hull of its eight projected
// corners, so a tile whose corners all land outside the stroke's pixel
// rectangle cannot hold a selected point. A corner behind the camera keeps the
// tile: there is no safe answer then.

import type * as THREE from 'three';
import { projectWorldToCanvasPixel } from './cropGeometry';
import type { PendingDeleteRegion } from './pointCloudTypes';

export function screenStrokeTileTest(
  region: PendingDeleteRegion,
): ((worldBox: THREE.Box3) => boolean) | undefined {
  if (region.kind !== 'polygon' && region.kind !== 'squares_union') return undefined;
  const { projection, view, canvas } = region;
  const size = { width: canvas.width, height: canvas.height };
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  if (region.kind === 'polygon') {
    for (const [x, y] of region.points) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  } else {
    region.centers.forEach(([x, y], i) => {
      const h = region.half_sizes[i];
      x0 = Math.min(x0, x - h); x1 = Math.max(x1, x + h);
      y0 = Math.min(y0, y - h); y1 = Math.max(y1, y + h);
    });
  }
  if (!Number.isFinite(x0)) return undefined;
  return (box: THREE.Box3) => {
    let bx0 = Infinity; let by0 = Infinity; let bx1 = -Infinity; let by1 = -Infinity;
    for (let c = 0; c < 8; c++) {
      const p = projectWorldToCanvasPixel({
        x: c & 1 ? box.max.x : box.min.x,
        y: c & 2 ? box.max.y : box.min.y,
        z: c & 4 ? box.max.z : box.min.z,
      }, projection, view, size);
      if (!p) return true;
      bx0 = Math.min(bx0, p.x); bx1 = Math.max(bx1, p.x);
      by0 = Math.min(by0, p.y); by1 = Math.max(by1, p.y);
    }
    return bx1 >= x0 && bx0 <= x1 && by1 >= y0 && by0 <= y1;
  };
}
