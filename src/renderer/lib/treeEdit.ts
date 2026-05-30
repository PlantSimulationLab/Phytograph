// Pure, in-memory edits to a `tree_instance` scalar field (0 = unassigned,
// 1..N = trees), used by the Tree Segmentation panel's Refine controls to
// correct TreeIso output without re-running it. All functions are stateless and
// return a NEW Float32Array; id 0 (unassigned) is always preserved.

// Renumber labels so the non-zero ids are contiguous 1..K in ascending order of
// first appearance value. Id 0 stays 0. Keeps coloring stable and avoids gaps
// after merges/splits.
export function compactLabels(labels: Float32Array): Float32Array {
  const remap = new Map<number, number>();
  let next = 1;
  // Deterministic: assign new ids in ascending order of old id.
  const uniqueNonZero = Array.from(new Set(Array.from(labels, (v) => Math.round(v))))
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  for (const id of uniqueNonZero) remap.set(id, next++);
  const out = new Float32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    const v = Math.round(labels[i]);
    out[i] = v > 0 ? remap.get(v)! : 0;
  }
  return out;
}

// Merge two or more tree ids into one (the smallest id in the set), then
// compact. Ids not in the set are untouched (beyond compaction). Returns the
// new labels; a merge of fewer than 2 valid ids returns a compacted copy.
export function mergeTrees(labels: Float32Array, ids: number[]): Float32Array {
  const set = new Set(ids.map((v) => Math.round(v)).filter((v) => v > 0));
  if (set.size < 2) return compactLabels(labels);
  const target = Math.min(...set);
  const out = new Float32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    const v = Math.round(labels[i]);
    out[i] = set.has(v) ? target : v;
  }
  return compactLabels(out);
}

// Split a single tree into its spatially-disconnected components: points of
// `treeId` separated by gaps larger than `maxGap` become distinct trees. Uses a
// voxel-grid union-find (voxel size = maxGap) over that tree's points only —
// O(n) and dependency-free. Other trees are untouched. New components are
// appended as fresh ids; result is compacted.
//
// `positions` is the flat [x,y,z,...] array aligned to `labels`.
export function splitTreeByGaps(
  positions: Float32Array,
  labels: Float32Array,
  treeId: number,
  maxGap: number,
): Float32Array {
  const tid = Math.round(treeId);
  const res = Math.max(maxGap, 1e-6);
  const idxs: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (Math.round(labels[i]) === tid) idxs.push(i);
  }
  if (idxs.length === 0) return compactLabels(labels);

  // Map each point to a voxel key; union neighbouring occupied voxels (26-conn).
  const voxelOf = (i: number) => {
    const x = Math.floor(positions[i * 3] / res);
    const y = Math.floor(positions[i * 3 + 1] / res);
    const z = Math.floor(positions[i * 3 + 2] / res);
    return `${x},${y},${z}`;
  };
  // Union-find over voxel keys.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // path-compress
    let c = a;
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const occupied = new Set<string>();
  for (const i of idxs) {
    const k = voxelOf(i);
    if (!parent.has(k)) parent.set(k, k);
    occupied.add(k);
  }
  for (const k of occupied) {
    const [x, y, z] = k.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nk = `${x + dx},${y + dy},${z + dz}`;
          if (occupied.has(nk)) union(k, nk);
        }
  }

  // Assign each component a slot index (0-based, by first appearance).
  const compOfRoot = new Map<string, number>();
  let nComp = 0;
  for (const k of occupied) {
    const r = find(k);
    if (!compOfRoot.has(r)) compOfRoot.set(r, nComp++);
  }

  const out = Float32Array.from(labels, (v) => Math.round(v));
  if (nComp <= 1) return compactLabels(out); // already connected
  // Highest existing id; new components after the first get fresh ids.
  let maxId = 0;
  for (let i = 0; i < out.length; i++) maxId = Math.max(maxId, out[i]);
  // First component keeps `tid`; the rest get maxId+1, maxId+2, ...
  const compToId = new Map<number, number>();
  for (let c = 0; c < nComp; c++) compToId.set(c, c === 0 ? tid : ++maxId);
  for (const i of idxs) {
    const c = compOfRoot.get(find(voxelOf(i)))!;
    out[i] = compToId.get(c)!;
  }
  return compactLabels(out);
}
