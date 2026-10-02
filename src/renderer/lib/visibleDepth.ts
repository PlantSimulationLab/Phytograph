/**
 * How far away is what the user is LOOKING AT?
 *
 * The erase brush flattens the view to an orthographic projection
 * (OrthoProjectionOverride). A parallel projection can agree with
 * the perspective view it replaces at exactly ONE depth: a point at view depth
 * `d` that was drawn at screen position `p` lands at `p · d / D`, where `D` is
 * the depth the frustum was sized for. Everything at `D` stays put; everything
 * else slides toward the screen center (nearer) or away from it (farther), in
 * proportion to how wrong `D` is for it.
 *
 * So `D` has to be the depth of the content on screen. The orbit target is not
 * that: it is wherever the last zoom gesture's cursor probe, pan or auto-frame
 * left it, and it is routinely several times nearer or farther than the thing
 * the user has just lined up — which is what made entering the tool throw the
 * view.
 *
 * This measures it directly. The viewport is divided into a coarse grid, each
 * cell keeps the NEAREST drawn sample that projects into it (the surface the
 * user can actually see there, not whatever lies behind it), and the answer is
 * a median over the occupied cells. Working per cell means the estimate goes by
 * SCREEN AREA rather than by point count, so a dense patch near a scanner
 * cannot outvote the rest of the view, and a stray near point or a ~1 km miss
 * shell only ever claims the few cells it lands in.
 *
 * The median is WEIGHTED TOWARD THE SCREEN CENTER, and that is not a nicety.
 * The flattening scales the picture about the center by `d / D`, so the one
 * thing a choice of `D` can hold perfectly still — position AND size — is
 * whatever sits mid-screen, and that is where a user aims the thing they are
 * about to cut. A plain median over the whole viewport answers a different
 * question ("how far is the typical pixel?"): with a tree centered against
 * ground running to the horizon it lands on the ground, and the tree visibly
 * changes size on entering the tool. The weight falls off smoothly rather than
 * cutting to a central window, so an empty center degrades to the nearest
 * content around it instead of to nothing.
 *
 * Pure: takes raw matrix elements and a visitor, so it is unit-testable without
 * a GL context (same convention as cameraRay.ts / frontSurface.ts).
 */

/** Grid columns; rows follow from the aspect ratio. */
const GRID_COLS = 32;

/**
 * Falloff of a cell's weight with its distance from the screen center, in NDC
 * units (the viewport spans -1..1). 0.25 puts most of the weight in the middle
 * quarter of the view.
 */
const CENTER_SIGMA = 0.25;

/**
 * Center-weighted median view depth of the front surface visible in a
 * perspective viewport, or null when nothing drawn falls inside it.
 *
 * `view` is the camera's column-major matrixWorldInverse. `tanHalfFov` and
 * `aspect` describe the PERSPECTIVE frustum the user was looking through — pass
 * them rather than a projection matrix, since the live matrix may already have
 * been overridden to orthographic.
 */
export function visibleContentDepth(
  forEachPoint: (visit: (x: number, y: number, z: number) => void) => void,
  view: ArrayLike<number>,
  tanHalfFov: number,
  aspect: number,
  near = 0,
): number | null {
  if (!(tanHalfFov > 0) || !(aspect > 0)) return null;
  const cols = GRID_COLS;
  const rows = Math.max(1, Math.round(cols / aspect));
  const nearest = new Float64Array(cols * rows).fill(Infinity);
  forEachPoint((x, y, z) => {
    const d = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
    if (!(d > near)) return;
    const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
    const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
    const nx = vx / (d * tanHalfFov * aspect);
    const ny = vy / (d * tanHalfFov);
    if (nx < -1 || nx >= 1 || ny < -1 || ny >= 1) return;
    const k = Math.floor((ny + 1) * 0.5 * rows) * cols + Math.floor((nx + 1) * 0.5 * cols);
    if (d < nearest[k]) nearest[k] = d;
  });
  // Weighted median: sort the occupied cells by depth and walk to half the
  // total weight.
  const cells: Array<{ d: number; w: number }> = [];
  let total = 0;
  for (let r = 0; r < rows; r++) {
    const ny = ((r + 0.5) / rows) * 2 - 1;
    for (let c = 0; c < cols; c++) {
      const d = nearest[r * cols + c];
      if (!Number.isFinite(d)) continue;
      const nx = ((c + 0.5) / cols) * 2 - 1;
      const w = Math.exp(-(nx * nx + ny * ny) / (2 * CENTER_SIGMA * CENTER_SIGMA));
      cells.push({ d, w });
      total += w;
    }
  }
  if (cells.length === 0) return null;
  cells.sort((a, b) => a.d - b.d);
  let acc = 0;
  for (const cell of cells) {
    acc += cell.w;
    if (acc >= total / 2) return cell.d;
  }
  return cells[cells.length - 1].d;
}
