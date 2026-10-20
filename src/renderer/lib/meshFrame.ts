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
