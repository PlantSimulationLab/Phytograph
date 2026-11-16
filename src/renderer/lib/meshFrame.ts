/**
 * Which frame a mesh's vertices are in.
 *
 * Vertex positions are Float32. In WORLD coordinates that resolves only ~0.5 m
 * at a UTM northing (~4.2e6 m), so a mesh of a georeferenced cloud stored in
 * world coordinates is snapped onto a lattice coarser than its leaves -- what
 * it draws, and the geometry LAD reuses for G(theta), are both wrong. A mesh
 * that sets `vertexOffset` keeps its vertices relative to that offset instead
 * (world = vertex + offset), small numbers float32 holds to sub-millimetre.
 * A Helios triangulation sets it to the source cloud's worldShift, i.e. its
 * vertices are in the cloud's STORED frame, the frame the cloud itself draws in.
 *
 * Absent offset = the legacy convention: vertices are world coordinates (or,
 * for a DEM, stored -- handled where DEMs are). Every consumer that needs world
 * or stored coordinates goes through these helpers, so the rule lives once.
 */

export type Vec3 = [number, number, number];

const ZERO: Vec3 = [0, 0, 0];

/** World offset of a mesh's vertex frame (world = vertex + offset). */
export function meshVertexOffset(mesh: { vertexOffset?: readonly number[] | null }): Vec3 {
  const o = mesh.vertexOffset;
  return o ? [o[0], o[1], o[2]] : ZERO;
}

/**
 * The translation to SUBTRACT from a mesh's vertices to land in the stored
 * frame of a cloud with shift `worldShift` (stored = world - worldShift). Zero
 * -- an exact pass-through -- when the mesh is already in that frame.
 */
export function shiftToStored(
  mesh: { vertexOffset?: readonly number[] | null },
  worldShift: readonly number[] | null | undefined,
): Vec3 {
  const o = meshVertexOffset(mesh);
  const ws = worldShift ?? ZERO;
  return [ws[0] - o[0], ws[1] - o[1], ws[2] - o[2]];
}

/**
 * The translation the viewer subtracts from a mesh's vertices to draw it in the
 * frame clouds render in (its source cloud's STORED frame). One rule for the
 * render loop, the crop matrix and the Transformation tool, so a mesh is drawn,
 * cut and moved in the same place.
 *  - A DEM is built in the stored frame already: nothing.
 *  - A mesh with a `vertexOffset` (Helios, Open3D triangulation): what is left
 *    between that offset and its source cloud's shift, zero when they agree.
 *    With no source cloud (a Helios mesh of several scans) its own frame is the
 *    scene's, so nothing.
 *  - A legacy world-frame mesh: its source cloud's whole worldShift.
 */
export function meshRenderShift(
  mesh: { method?: string; vertexOffset?: readonly number[] | null },
  sourceWorldShift: readonly number[] | null | undefined,
): Vec3 {
  if (mesh.method === 'dem') return [0, 0, 0];
  if (mesh.vertexOffset) return sourceWorldShift ? shiftToStored(mesh, sourceWorldShift) : [0, 0, 0];
  const ws = sourceWorldShift ?? ZERO;
  return [ws[0], ws[1], ws[2]];
}

/**
 * Float32 xyz triples for `values` -- float64 WORLD coordinates, such as a JSON
 * array from the backend -- relative to `origin`, subtracted in double precision
 * before the cast. `Float32Array.from(world)` snapped a georeferenced mesh to
 * the 0.5 m float32 lattice of a UTM northing.
 */
export function vec3sRelativeTo(values: ArrayLike<number>, origin: readonly number[]): Float32Array {
  const [ox, oy, oz] = origin;
  const out = new Float32Array(values.length);
  for (let i = 0; i + 2 < values.length; i += 3) {
    out[i] = values[i] - ox;
    out[i + 1] = values[i + 1] - oy;
    out[i + 2] = values[i + 2] - oz;
  }
  return out;
}

/**
 * Whole metres near `point`, or zero when every coordinate is small enough that
 * float32 already resolves it to better than 0.1 mm -- the frame to keep a mesh
 * in when it has no cloud frame to borrow. Mirrors the backend's
 * `_helios_local_origin`.
 */
export function nearbyOrigin(point: readonly number[]): Vec3 {
  if (!point.every(Number.isFinite) || Math.max(...point.map(Math.abs)) < 1e3) return [0, 0, 0];
  return [Math.floor(point[0]), Math.floor(point[1]), Math.floor(point[2])];
}

export function isZero(v: readonly number[]): boolean {
  return v[0] === 0 && v[1] === 0 && v[2] === 0;
}

/**
 * Re-express xyz triples given relative to `from` as relative to `to`
 * (v' = v + from - to), in double precision. Returns `values` itself when the
 * two agree, so the common case allocates nothing and is bit-exact.
 */
export function rebaseVec3s(values: Float32Array, from: readonly number[], to: readonly number[]): Float32Array {
  const dx = from[0] - to[0], dy = from[1] - to[1], dz = from[2] - to[2];
  if (dx === 0 && dy === 0 && dz === 0) return values;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 3) {
    out[i] = values[i] + dx;
    out[i + 1] = values[i + 1] + dy;
    out[i + 2] = values[i + 2] + dz;
  }
  return out;
}
