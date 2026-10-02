// What a mesh merge does where its sources OVERLAP (the two options on the
// Meshes side of the Stitch tool). Scans of one object from different angles
// cover some of the same surface, each with its own lighting, so a plain
// concatenation leaves two near-coincident surfaces of slightly different
// color that interleave on screen, and a hard step where one scan's coverage
// ends. Three things fix that, all driven by one overlap analysis:
//
//   1. Equalize   — one per-channel gain per mesh, solved jointly so the meshes
//                   agree on average across their overlaps (exposure / white
//                   balance). No mesh is the reference: each moves part way.
//   2. Blend      — inside an overlap each vertex moves toward the weighted
//                   mean of the surfaces there. A surface's weight is its
//                   distance from its own border, so a scan fades out toward
//                   the edge of its coverage instead of stepping.
//   3. Deduplicate — draw the surfaces together across the overlap, then of the
//                   surfaces covering one place keep the one that is farthest
//                   from its border and drop the others' triangles.
//
// Everything works on WELDED vertices (identical positions collapsed), because
// a triangle-soup mesh would otherwise read every edge as a border.
//
// Limits worth knowing before changing this:
//   - Correspondence is nearest VERTEX within a tolerance, not closest point on
//     a triangle. The tolerance is 0.75 of the larger median edge length of the
//     pair, the scale at which two samplings of one surface can disagree,
//     widened to the alignment gap measured between the pair (pairTolerance).
//     A vertex past its partner's border can therefore pair with that border;
//     that is harmless by construction, because a border vertex has the lowest
//     weight: it neither wins a blend nor takes a triangle.
//   - Surfaces facing opposite ways are never paired, so the two sides of a
//     thin leaf are not treated as one surface. A mesh whose winding is flipped
//     relative to its partner therefore reports no overlap.
//   - Deduplication trims; it does not zipper. A strip about one triangle wide
//     stays doubled along the seam (a triangle goes only when ALL its vertices
//     lose), so there are no gaps but the result is not watertight.

import type { MeshData } from './pointCloudTypes';

/** Hop count for a vertex that no border reaches (a closed surface). */
const UNREACHED = 0x3fffffff;
/** Weight, in hops, of a vertex ON the border: small, so it yields, but not zero. */
const BORDER_WEIGHT_HOPS = 0.1;
/** Pull of each gain toward 1, relative to the overlap evidence. Sets the gauge. */
const GAIN_PRIOR = 0.01;
const MIN_GAIN = 0.25;
const MAX_GAIN = 4;
/** Passes of smoothing over the blend correction, so each mesh keeps its own detail. */
const CORRECTION_SMOOTHING_PASSES = 3;
const BLEND_ROUNDS = 3;
const EDGE_SAMPLE_TRIANGLES = 20000;
/**
 * Overlap distance, in median edge lengths. Two samplings of one surface put a
 * vertex at most ~0.6-0.7 of an edge from the other's nearest vertex; a full
 * edge would also pair the first ring of vertices BEYOND the shared surface.
 */
const OVERLAP_TOLERANCE_EDGES = 0.75;
/**
 * Registered scans are rarely aligned to better than an edge length, so the
 * tolerance also has to cover the gap that registration left. That gap is
 * MEASURED per pair: the median distance from a sample of each mesh's vertices
 * to the other mesh, searched out to ALIGNMENT_SEARCH_EDGES, times
 * ALIGNMENT_TOLERANCE_FACTOR. On a real pair of scans (edge 0.19, median gap
 * 0.30) the edge-based tolerance alone paired 17 % of the vertices and the
 * measured one 87 %, which is the difference between the options doing nothing
 * visible and doing their job.
 */
/** How far past the overlap distance a paired region may grow into a flap (see matchVertices). */
const OVERLAP_GROWTH_FACTOR = 4;
const ALIGNMENT_SEARCH_EDGES = 8;
const ALIGNMENT_TOLERANCE_FACTOR = 2.5;
const ALIGNMENT_SAMPLE_VERTICES = 20000;
const ALIGNMENT_MIN_SAMPLES = 20;

interface PartTopology {
  /** vertex → welded id */
  weld: Uint32Array;
  weldCount: number;
  /** welded id → one of its vertices */
  rep: Uint32Array;
  /** welded id → position */
  positions: Float32Array;
  /** welded id → area-weighted unit normal from the triangles (not the stored normals) */
  normals: Float32Array;
  /** welded adjacency, CSR */
  adjStart: Uint32Array;
  adj: Uint32Array;
  /** welded id → blend/keep weight: distance from the mesh border, in length units */
  weight: Float64Array;
  medianEdge: number;
  min: [number, number, number];
  max: [number, number, number];
}

function buildTopology(d: MeshData): PartTopology {
  const n = d.vertexCount, v = d.vertices;

  // Weld: sort vertices by position, then number each run of equal positions.
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => v[a * 3] - v[b * 3] || v[a * 3 + 1] - v[b * 3 + 1] || v[a * 3 + 2] - v[b * 3 + 2]);
  const weld = new Uint32Array(n);
  let weldCount = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k], p = k > 0 ? order[k - 1] : 0;
    if (k > 0 && (v[i * 3] !== v[p * 3] || v[i * 3 + 1] !== v[p * 3 + 1] || v[i * 3 + 2] !== v[p * 3 + 2])) weldCount++;
    weld[i] = weldCount;
  }
  if (n > 0) weldCount++;
  const rep = new Uint32Array(weldCount);
  const positions = new Float32Array(weldCount * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = n - 1; i >= 0; i--) {
    const w = weld[i];
    rep[w] = i;
    for (let c = 0; c < 3; c++) {
      const x = v[i * 3 + c];
      positions[w * 3 + c] = x;
      if (x < min[c]) min[c] = x;
      if (x > max[c]) max[c] = x;
    }
  }

  // Normals, edges and adjacency from the triangles, in welded ids.
  const T = d.triangleCount, idx = d.indices;
  const normals = new Float32Array(weldCount * 3);
  const edgeKeys = new Float64Array(T * 3);
  const degree = new Uint32Array(weldCount + 1);
  let edges = 0;
  for (let t = 0; t < T; t++) {
    const a = weld[idx[t * 3]], b = weld[idx[t * 3 + 1]], c = weld[idx[t * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const wx = positions[c * 3] - positions[a * 3], wy = positions[c * 3 + 1] - positions[a * 3 + 1], wz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    for (const w of [a, b, c]) {
      normals[w * 3] += nx; normals[w * 3 + 1] += ny; normals[w * 3 + 2] += nz;
      degree[w] += 2;
    }
    edgeKeys[edges++] = Math.min(a, b) * weldCount + Math.max(a, b);
    edgeKeys[edges++] = Math.min(b, c) * weldCount + Math.max(b, c);
    edgeKeys[edges++] = Math.min(a, c) * weldCount + Math.max(a, c);
  }
  for (let w = 0; w < weldCount; w++) {
    const l = Math.hypot(normals[w * 3], normals[w * 3 + 1], normals[w * 3 + 2]);
    if (l > 0) { normals[w * 3] /= l; normals[w * 3 + 1] /= l; normals[w * 3 + 2] /= l; }
  }

  const adjStart = new Uint32Array(weldCount + 1);
  for (let w = 0; w < weldCount; w++) adjStart[w + 1] = adjStart[w] + degree[w];
  const adj = new Uint32Array(adjStart[weldCount]);
  const fill = adjStart.slice(0, weldCount);
  for (let t = 0; t < T; t++) {
    const a = weld[idx[t * 3]], b = weld[idx[t * 3 + 1]], c = weld[idx[t * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    adj[fill[a]++] = b; adj[fill[a]++] = c;
    adj[fill[b]++] = a; adj[fill[b]++] = c;
    adj[fill[c]++] = a; adj[fill[c]++] = b;
  }

  // Border = edges used by exactly one triangle. Hops from it by BFS.
  const keys = edgeKeys.subarray(0, edges).sort();
  const hops = new Int32Array(weldCount).fill(UNREACHED);
  const queue = new Uint32Array(weldCount);
  let head = 0, tail = 0;
  for (let k = 0; k < edges;) {
    let e = k + 1;
    while (e < edges && keys[e] === keys[k]) e++;
    if (e - k === 1) {
      const a = Math.floor(keys[k] / weldCount), b = keys[k] - a * weldCount;
      for (const w of [a, b]) if (hops[w] !== 0) { hops[w] = 0; queue[tail++] = w; }
    }
    k = e;
  }
  while (head < tail) {
    const w = queue[head++];
    for (let k = adjStart[w]; k < adjStart[w + 1]; k++) {
      const u = adj[k];
      if (hops[u] === UNREACHED) { hops[u] = hops[w] + 1; queue[tail++] = u; }
    }
  }

  // Median edge length, from a stride sample of the triangles.
  const stride = Math.max(1, Math.floor(T / EDGE_SAMPLE_TRIANGLES));
  const lengths: number[] = [];
  for (let t = 0; t < T; t += stride) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t * 3 + e] * 3, b = idx[t * 3 + (e + 1) % 3] * 3;
      const l = Math.hypot(v[a] - v[b], v[a + 1] - v[b + 1], v[a + 2] - v[b + 2]);
      if (l > 0) lengths.push(l);
    }
  }
  lengths.sort((a, b) => a - b);
  const medianEdge = lengths.length ? lengths[lengths.length >> 1] : 0;

  // Hops are per-mesh units; scale by edge length so a fine mesh and a coarse
  // one compare by distance.
  const weight = new Float64Array(weldCount);
  for (let w = 0; w < weldCount; w++) weight[w] = (hops[w] + BORDER_WEIGHT_HOPS) * medianEdge;

  return { weld, weldCount, rep, positions, normals, adjStart, adj, weight, medianEdge, min, max };
}

/**
 * A lookup from a welded vertex of `from` to the nearest welded vertex of `to`
 * within `tol` that faces the same way (or -1).
 */
function vertexFinder(from: PartTopology, to: PartTopology, tol: number): (w: number) => number {
  for (let c = 0; c < 3; c++) {
    if (from.min[c] > to.max[c] + tol || to.min[c] > from.max[c] + tol) return () => -1;
  }
  // Hash grid over `to`, cell = tol, so a query reads the 27 cells around it.
  const nx = Math.floor((to.max[0] - to.min[0]) / tol) + 1;
  const ny = Math.floor((to.max[1] - to.min[1]) / tol) + 1;
  const nz = Math.floor((to.max[2] - to.min[2]) / tol) + 1;
  const cellHead = new Map<number, number>();
  const next = new Int32Array(to.weldCount);
  const P = to.positions;
  for (let u = 0; u < to.weldCount; u++) {
    const key = Math.floor((P[u * 3] - to.min[0]) / tol)
      + nx * (Math.floor((P[u * 3 + 1] - to.min[1]) / tol) + ny * Math.floor((P[u * 3 + 2] - to.min[2]) / tol));
    next[u] = cellHead.get(key) ?? -1;
    cellHead.set(key, u);
  }
  const Q = from.positions, tol2 = tol * tol;
  return (w: number) => {
    const x = Q[w * 3], y = Q[w * 3 + 1], z = Q[w * 3 + 2];
    const ix = Math.floor((x - to.min[0]) / tol), iy = Math.floor((y - to.min[1]) / tol), iz = Math.floor((z - to.min[2]) / tol);
    let best = -1, bestD = tol2;
    for (let dz = -1; dz <= 1; dz++) {
      const cz = iz + dz;
      if (cz < 0 || cz >= nz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const cy = iy + dy;
        if (cy < 0 || cy >= ny) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx;
          if (cx < 0 || cx >= nx) continue;
          for (let u = cellHead.get(cx + nx * (cy + ny * cz)) ?? -1; u >= 0; u = next[u]) {
            const ex = P[u * 3] - x, ey = P[u * 3 + 1] - y, ez = P[u * 3 + 2] - z;
            const dist = ex * ex + ey * ey + ez * ez;
            if (dist > bestD) continue;
            const facing = from.normals[w * 3] * to.normals[u * 3] + from.normals[w * 3 + 1] * to.normals[u * 3 + 1]
              + from.normals[w * 3 + 2] * to.normals[u * 3 + 2];
            if (facing > 0) { best = u; bestD = dist; }
          }
        }
      }
    }
    return best;
  };
}

/**
 * For each welded vertex of `from` (every `stride`-th), its counterpart on `to`
 * within `tol`, or -1.
 *
 * With `grow` > 1 the paired region is then GROWN: an unpaired vertex next to a
 * paired one is paired too if `to` is within `grow * tol` of it, and so on
 * outward. Registration error is not uniform — two scans agree in the middle of
 * their shared surface and peel apart toward a scan's edge — so one distance
 * either misses those flaps (they stay as a second skin hanging over the
 * surface, in their own colors) or is loose enough to pair separate surfaces.
 * Growing reaches a flap because it is attached to surface that does agree,
 * and never starts from a surface that agrees nowhere.
 */
function matchVertices(from: PartTopology, to: PartTopology, tol: number, stride = 1, grow = 1): Int32Array {
  const match = new Int32Array(from.weldCount).fill(-1);
  const find = vertexFinder(from, to, tol);
  for (let w = 0; w < from.weldCount; w += stride) match[w] = find(w);
  if (!(grow > 1)) return match;

  const findWide = vertexFinder(from, to, grow * tol);
  const tried = new Uint8Array(from.weldCount);
  const queue = new Uint32Array(from.weldCount);
  let head = 0, tail = 0;
  for (let w = 0; w < from.weldCount; w++) if (match[w] >= 0) { tried[w] = 1; queue[tail++] = w; }
  while (head < tail) {
    const w = queue[head++];
    for (let k = from.adjStart[w]; k < from.adjStart[w + 1]; k++) {
      const x = from.adj[k];
      if (tried[x]) continue;
      tried[x] = 1;
      const u = findWide(x);
      if (u >= 0) { match[x] = u; queue[tail++] = x; }
    }
  }
  return match;
}

/** The overlap distance for one pair: the edge-based floor, widened to the measured alignment gap. */
function pairTolerance(a: PartTopology, b: PartTopology): number {
  const edge = Math.max(a.medianEdge, b.medianEdge);
  const floor = OVERLAP_TOLERANCE_EDGES * edge, reach = ALIGNMENT_SEARCH_EDGES * edge;
  if (!(edge > 0)) return 0;
  const gaps: number[] = [];
  for (const [from, to] of [[a, b], [b, a]]) {
    const stride = Math.max(1, Math.floor(from.weldCount / ALIGNMENT_SAMPLE_VERTICES));
    const m = matchVertices(from, to, reach, stride);
    for (let w = 0; w < from.weldCount; w += stride) {
      const u = m[w];
      if (u < 0) continue;
      gaps.push(Math.hypot(from.positions[w * 3] - to.positions[u * 3], from.positions[w * 3 + 1] - to.positions[u * 3 + 1],
        from.positions[w * 3 + 2] - to.positions[u * 3 + 2]));
    }
  }
  if (gaps.length < ALIGNMENT_MIN_SAMPLES) return floor;
  gaps.sort((x, y) => x - y);
  // A gap too wide for the search to have measured is not a registration
  // residual: those are two different surfaces, and they stay two.
  const measured = ALIGNMENT_TOLERANCE_FACTOR * gaps[gaps.length >> 1];
  return measured > reach ? floor : Math.max(floor, measured);
}

export interface MeshOverlap {
  parts: PartTopology[];
  /** The largest overlap distance used between any pair. */
  tolerance: number;
  /** match[i][j]: welded vertex of part i → its counterpart in part j, or -1. Null on the diagonal. */
  match: (Int32Array | null)[][];
  /** Welded vertices that have a counterpart in some other part. */
  overlapVertices: number;
}

/**
 * Find where `parts` (already in one frame) cover the same surface.
 * `tolerance` overrides the per-pair default (see `pairTolerance`).
 */
export function analyzeMeshOverlap(parts: MeshData[], tolerance?: number, grow = OVERLAP_GROWTH_FACTOR): MeshOverlap {
  const topo = parts.map(buildTopology);
  const match: (Int32Array | null)[][] = topo.map(() => topo.map(() => null));
  let used = 0;
  for (let i = 0; i < topo.length; i++) {
    for (let j = i + 1; j < topo.length; j++) {
      const tol = tolerance ?? pairTolerance(topo[i], topo[j]);
      used = Math.max(used, tol);
      match[i][j] = tol > 0 ? matchVertices(topo[i], topo[j], tol, 1, grow) : new Int32Array(topo[i].weldCount).fill(-1);
      match[j][i] = tol > 0 ? matchVertices(topo[j], topo[i], tol, 1, grow) : new Int32Array(topo[j].weldCount).fill(-1);
    }
  }
  let overlapVertices = 0;
  for (let i = 0; i < topo.length; i++) {
    for (let w = 0; w < topo[i].weldCount; w++) {
      if (match[i].some(m => m && m[w] >= 0)) overlapVertices++;
    }
  }
  return { parts: topo, tolerance: used, match, overlapVertices };
}

/** Solve the small dense system A x = b in place (Gaussian elimination, partial pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    if (A[c][c] === 0) continue;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = A[r][r] !== 0 ? s / A[r][r] : 0;
  }
  return x;
}

export interface OverlapColorResult {
  /** Per part: its corrected vertex colors, or null where the part was left alone. */
  colors: (Float32Array | null)[];
  /** Per part: the [r, g, b] gain applied ([1, 1, 1] where none was). */
  gains: [number, number, number][];
}

/**
 * Equalize, then blend, the vertex colors of the parts across their overlaps.
 * Only parts flagged in `colored` take part: a part painted with one solid
 * display color is an object of a different color, not a lighting variation.
 * Colors are the linear-space vertex colors; the inputs are not modified.
 */
export function matchOverlapColors(parts: MeshData[], overlap: MeshOverlap, colored: boolean[]): OverlapColorResult {
  const n = parts.length, topo = overlap.parts;

  // Mean color per welded vertex.
  const mean: (Float32Array | null)[] = parts.map((d, i) => {
    if (!colored[i]) return null;
    const t = topo[i], out = new Float32Array(t.weldCount * 3), count = new Uint32Array(t.weldCount);
    for (let v = 0; v < d.vertexCount; v++) {
      const w = t.weld[v];
      count[w]++;
      for (let c = 0; c < 3; c++) out[w * 3 + c] += d.vertexColors![v * 3 + c];
    }
    for (let w = 0; w < t.weldCount; w++) for (let c = 0; c < 3; c++) out[w * 3 + c] /= count[w];
    return out;
  });

  // 1. Gains. Per channel, in log space: minimize over the pairs
  //    N_ij (l_i - l_j + log(mean_i / mean_j))^2, with a weak pull of every l to 0.
  const gains: [number, number, number][] = parts.map(() => [1, 1, 1]);
  for (let c = 0; c < 3; c++) {
    const A = parts.map(() => new Array<number>(n).fill(0)), b = new Array<number>(n).fill(0);
    let total = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const m = overlap.match[i][j];
        if (!m || !mean[i] || !mean[j]) continue;
        let si = 0, sj = 0, count = 0;
        for (let w = 0; w < m.length; w++) {
          if (m[w] < 0) continue;
          si += mean[i]![w * 3 + c]; sj += mean[j]![m[w] * 3 + c]; count++;
        }
        if (count === 0) continue;
        const r = Math.log(Math.max(si / count, 1e-4) / Math.max(sj / count, 1e-4));
        A[i][i] += count; A[j][j] += count; A[i][j] -= count; A[j][i] -= count;
        b[i] -= count * r; b[j] += count * r;
        total += count;
      }
    }
    if (total === 0) continue;
    for (let i = 0; i < n; i++) A[i][i] += GAIN_PRIOR * total;
    const l = solve(A, b);
    for (let i = 0; i < n; i++) gains[i][c] = Math.min(MAX_GAIN, Math.max(MIN_GAIN, Math.exp(l[i])));
  }
  for (let i = 0; i < n; i++) {
    const m = mean[i];
    if (m) for (let k = 0; k < m.length; k++) m[k] *= gains[i][k % 3];
  }

  // 2. Blend. Each overlap vertex gets a correction toward the border-distance
  //    weighted mean of the surfaces there; the correction is smoothed over the
  //    overlap so it carries the lighting difference and not vertex-level noise.
  //    Smoothing leaves a residual where the correction varies quickly, so the
  //    whole step runs BLEND_ROUNDS times, each from the last round's colors.
  const total: (Float32Array | null)[] = mean.map(m => (m ? new Float32Array(m.length) : null));
  for (let round = 0; round < BLEND_ROUNDS; round++) {
    const deltas = parts.map((_, i) => {
      if (!colored[i]) return null;
      const t = topo[i], own = mean[i]!;
      let delta = new Float32Array(t.weldCount * 3);
      const inOverlap = new Uint8Array(t.weldCount);
      for (let w = 0; w < t.weldCount; w++) {
        let sum = t.weight[w];
        let r = sum * own[w * 3], g = sum * own[w * 3 + 1], bl = sum * own[w * 3 + 2];
        for (let j = 0; j < n; j++) {
          const m = overlap.match[i][j];
          if (!m || m[w] < 0 || !mean[j]) continue;
          const u = m[w], wt = topo[j].weight[u];
          r += wt * mean[j]![u * 3]; g += wt * mean[j]![u * 3 + 1]; bl += wt * mean[j]![u * 3 + 2];
          sum += wt;
          inOverlap[w] = 1;
        }
        if (!inOverlap[w] || sum <= 0) continue;
        delta[w * 3] = r / sum - own[w * 3];
        delta[w * 3 + 1] = g / sum - own[w * 3 + 1];
        delta[w * 3 + 2] = bl / sum - own[w * 3 + 2];
      }
      for (let pass = 0; pass < CORRECTION_SMOOTHING_PASSES; pass++) {
        const smoothed = new Float32Array(delta.length);
        for (let w = 0; w < t.weldCount; w++) {
          if (!inOverlap[w]) continue;
          let r = delta[w * 3], g = delta[w * 3 + 1], bl = delta[w * 3 + 2], count = 1;
          for (let k = t.adjStart[w]; k < t.adjStart[w + 1]; k++) {
            const u = t.adj[k];
            if (!inOverlap[u]) continue;
            r += delta[u * 3]; g += delta[u * 3 + 1]; bl += delta[u * 3 + 2]; count++;
          }
          smoothed[w * 3] = r / count; smoothed[w * 3 + 1] = g / count; smoothed[w * 3 + 2] = bl / count;
        }
        delta = smoothed;
      }
      return delta;
    });
    // Apply only once every part's correction is computed, so no part blends
    // toward a partner that has already moved this round.
    deltas.forEach((delta, i) => {
      if (!delta) return;
      for (let k = 0; k < delta.length; k++) { mean[i]![k] += delta[k]; total[i]![k] += delta[k]; }
    });
  }
  const colors: (Float32Array | null)[] = parts.map((d, i) => {
    if (!colored[i]) return null;
    const t = topo[i], delta = total[i]!;
    const out = new Float32Array(d.vertexCount * 3);
    for (let v = 0; v < d.vertexCount; v++) {
      const w = t.weld[v];
      for (let c = 0; c < 3; c++) {
        out[v * 3 + c] = Math.min(1, Math.max(0, d.vertexColors![v * 3 + c] * gains[i][c] + delta[w * 3 + c]));
      }
    }
    return out;
  });

  return { colors, gains };
}

/**
 * Close the gap between the surfaces across each overlap, so that trimming one
 * of them leaves no lip. Two registered scans sit a little apart; cut one away
 * and the cut edge overhangs the surface that is left. Each paired vertex moves
 * ALONG ITS OWN NORMAL toward the border-distance weighted mean of the surfaces
 * there — the same weights the trim uses, so the two meet halfway exactly where
 * the seam falls, and each keeps its own shape away from it. Only the normal
 * component is used: the partner is a nearby vertex, not the same surface
 * point, and following it sideways would shear the triangles.
 *
 * Returns, per part, its moved vertices (or null where nothing is paired). The
 * inputs are not modified.
 */
export function blendOverlapPositions(parts: MeshData[], overlap: MeshOverlap): (Float32Array | null)[] {
  const n = parts.length, topo = overlap.parts;
  const pos = topo.map(t => Float32Array.from(t.positions));
  const total = topo.map(t => new Float32Array(t.weldCount * 3));
  const paired = topo.map((t, i) => {
    const flags = new Uint8Array(t.weldCount);
    for (let j = 0; j < n; j++) {
      const m = overlap.match[i][j];
      if (m) for (let w = 0; w < t.weldCount; w++) if (m[w] >= 0) flags[w] = 1;
    }
    return flags;
  });
  for (let round = 0; round < BLEND_ROUNDS; round++) {
    const deltas = topo.map((t, i) => {
      // The offset along the normal, one number per vertex.
      let offset = new Float32Array(t.weldCount);
      const N = t.normals, P = pos[i];
      for (let w = 0; w < t.weldCount; w++) {
        if (!paired[i][w]) continue;
        let sum = t.weight[w], along = 0;
        for (let j = 0; j < n; j++) {
          const m = overlap.match[i][j];
          if (!m || m[w] < 0) continue;
          const u = m[w], wt = topo[j].weight[u], Q = pos[j];
          along += wt * ((Q[u * 3] - P[w * 3]) * N[w * 3] + (Q[u * 3 + 1] - P[w * 3 + 1]) * N[w * 3 + 1] + (Q[u * 3 + 2] - P[w * 3 + 2]) * N[w * 3 + 2]);
          sum += wt;
        }
        if (sum > 0) offset[w] = along / sum;
      }
      for (let pass = 0; pass < CORRECTION_SMOOTHING_PASSES; pass++) {
        const smoothed = new Float32Array(t.weldCount);
        for (let w = 0; w < t.weldCount; w++) {
          if (!paired[i][w]) continue;
          let acc = offset[w], count = 1;
          for (let k = t.adjStart[w]; k < t.adjStart[w + 1]; k++) {
            if (paired[i][t.adj[k]]) { acc += offset[t.adj[k]]; count++; }
          }
          smoothed[w] = acc / count;
        }
        offset = smoothed;
      }
      return offset;
    });
    deltas.forEach((offset, i) => {
      const N = topo[i].normals;
      for (let w = 0; w < offset.length; w++) {
        for (let c = 0; c < 3; c++) {
          pos[i][w * 3 + c] += offset[w] * N[w * 3 + c];
          total[i][w * 3 + c] += offset[w] * N[w * 3 + c];
        }
      }
    });
  }
  return parts.map((d, i) => {
    if (!paired[i].some(Boolean)) return null;
    const out = Float32Array.from(d.vertices.subarray(0, d.vertexCount * 3));
    for (let v = 0; v < d.vertexCount; v++) {
      const w = topo[i].weld[v];
      for (let c = 0; c < 3; c++) out[v * 3 + c] += total[i][w * 3 + c];
    }
    return out;
  });
}

/**
 * Per part, a mask over its triangles: 1 = keep, 0 = a duplicate of surface
 * another part covers better. A vertex loses to a counterpart that is farther
 * from its own border (ties go to the earlier part); a triangle goes only when
 * all three of its vertices lose.
 */
export function overlapTriangleKeepMasks(parts: MeshData[], overlap: MeshOverlap): Uint8Array[] {
  const topo = overlap.parts;
  return parts.map((d, i) => {
    const t = topo[i];
    const loses = new Uint8Array(t.weldCount);
    for (let j = 0; j < parts.length; j++) {
      const m = overlap.match[i][j];
      if (!m) continue;
      for (let w = 0; w < t.weldCount; w++) {
        if (m[w] < 0) continue;
        const theirs = topo[j].weight[m[w]], mine = t.weight[w];
        if (theirs > mine || (theirs === mine && j < i)) loses[w] = 1;
      }
    }
    const keep = new Uint8Array(d.triangleCount);
    for (let k = 0; k < d.triangleCount; k++) {
      keep[k] = loses[t.weld[d.indices[k * 3]]] && loses[t.weld[d.indices[k * 3 + 1]]] && loses[t.weld[d.indices[k * 3 + 2]]] ? 0 : 1;
    }
    return keep;
  });
}
