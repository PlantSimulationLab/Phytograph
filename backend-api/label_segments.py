"""Over-segmentation for the label tool's click-to-pick (F6).

One click should label a whole leaf or a whole branch, not trace it. This cuts a
cloud into pieces on a sparse voxel grid, and turns "the piece under this point"
into an explicit VOXEL SET that a label stroke carries (region kind
`voxel_set`). The stroke never refers back to a segmentation, so undo/redo and
the renderer's preview (src/renderer/lib/voxelSet.ts) replay exactly, whatever
has been edited since.

Two modes:

- ``connected``: connected components of the occupied voxels (26-neighbour).
  `size` is the voxel edge, so it is the widest gap still bridged.
- ``pieces``: compact supervoxels about `size` across. Voxels are a quarter of
  that (never finer than twice the point spacing, or the voxels themselves
  would not touch), one seed per occupied `size` cell, and each voxel joins its
  geodesically nearest seed THROUGH the voxel graph — so a piece never jumps a
  gap, which is what keeps a leaf separate from the leaf behind it.

Growing (the magic wand): from the picked segment, flood across ADJACENT
segments whose surface normal is within `max_angle` of the picked one.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass, field

import numpy as np

# 13 of the 26 neighbour offsets: every undirected edge is found exactly once.
_HALF_OFFSETS = np.array(
    [(dx, dy, dz)
     for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
     if (dx, dy, dz) > (0, 0, 0)],
    dtype=np.int64,
)
MAX_PICK_VOXELS = 4_000_000


@dataclass
class Segmentation:
    origin: np.ndarray            # (3,) world origin of voxel (0, 0, 0)
    voxel: float                  # voxel edge
    keys: np.ndarray              # (M, 3) int64 voxel keys, sorted by `codes`
    codes: np.ndarray             # (M,) packed keys, ascending
    dims: np.ndarray              # (3,) packing extents
    counts: np.ndarray            # (M,) points per voxel
    sums: np.ndarray              # (M, 3) point coordinate sums per voxel
    segment: np.ndarray           # (M,) segment id per voxel
    n_segments: int
    edges: tuple = field(default=None)  # (i, j) voxel adjacency, i < j
    _normals: dict = field(default_factory=dict)


def _pack(keys: np.ndarray, dims: np.ndarray) -> np.ndarray:
    return (keys[:, 0] * dims[1] + keys[:, 1]) * dims[2] + keys[:, 2]


def median_spacing(points: np.ndarray, sample: int = 5000) -> float:
    """Median nearest-neighbour distance, from an even sample, corrected to the
    full density (sampling thins the cloud, which stretches the spacing)."""
    from scipy.spatial import cKDTree
    n = points.shape[0]
    if n < 2:
        return 1.0
    step = max(1, n // sample)
    s = points[::step]
    if s.shape[0] < 2:
        return 1.0
    d, _ = cKDTree(s).query(s, k=2)
    med = float(np.median(d[:, 1]))
    return max(med * (s.shape[0] / n) ** (1 / 3), 1e-9)


def _voxel_edges(codes: np.ndarray, keys: np.ndarray, dims: np.ndarray):
    """Undirected 26-neighbour edges between occupied voxels, i < j by index."""
    ii, jj = [], []
    for off in _HALF_OFFSETS:
        nb = keys + off
        ok = np.all((nb >= 0) & (nb < dims), axis=1)
        src = np.flatnonzero(ok)
        if src.size == 0:
            continue
        nc = _pack(nb[src], dims)
        pos = np.searchsorted(codes, nc)
        pos = np.minimum(pos, codes.size - 1)
        hit = codes[pos] == nc
        ii.append(src[hit])
        jj.append(pos[hit])
    if not ii:
        z = np.zeros(0, dtype=np.int64)
        return z, z
    return np.concatenate(ii), np.concatenate(jj)


def segment(points: np.ndarray, size: float, mode: str) -> Segmentation:
    """Segment `points` (N, 3). See the module docstring for `size` and `mode`."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components, dijkstra

    if mode not in ("connected", "pieces"):
        raise ValueError(f"mode must be 'connected' or 'pieces', got {mode!r}")
    if points.shape[0] == 0:
        raise ValueError("no points to segment")
    size = float(size)
    voxel = size if mode == "connected" else max(size / 4.0, 2.0 * median_spacing(points))
    origin = points.min(axis=0)
    ijk = np.floor((points - origin) / voxel).astype(np.int64)
    dims = ijk.max(axis=0) + 2   # +1 headroom so a +1 neighbour never wraps
    codes_all = _pack(ijk, dims)
    codes, inverse, counts = np.unique(codes_all, return_inverse=True, return_counts=True)
    keys = np.stack(np.unravel_index(codes, tuple(int(d) for d in dims)), axis=1).astype(np.int64)
    sums = np.stack([np.bincount(inverse, weights=points[:, k], minlength=codes.size)
                     for k in range(3)], axis=1)
    m = codes.size
    ei, ej = _voxel_edges(codes, keys, dims)
    graph = coo_matrix((np.ones(ei.size), (ei, ej)), shape=(m, m)).tocsr()
    n_comp, comp = connected_components(graph, directed=False)

    if mode == "connected":
        seg, n_seg = comp.astype(np.int64), int(n_comp)
    else:
        # One seed per occupied coarse cell: the voxel nearest the cell's mean.
        per = max(1, int(round(size / voxel)))
        cell = keys // per
        cdims = cell.max(axis=0) + 1
        ccode = (cell[:, 0] * cdims[1] + cell[:, 1]) * cdims[2] + cell[:, 2]
        uc, cinv = np.unique(ccode, return_inverse=True)
        mean = np.stack([np.bincount(cinv, weights=keys[:, k].astype(np.float64),
                                     minlength=uc.size) for k in range(3)], axis=1)
        mean /= np.bincount(cinv, minlength=uc.size)[:, None]
        d2 = ((keys - mean[cinv]) ** 2).sum(axis=1)
        order = np.lexsort((d2, cinv))
        first = np.ones(order.size, dtype=bool)
        first[1:] = cinv[order[1:]] != cinv[order[:-1]]
        seeds = order[first]
        w = np.sqrt(((keys[ei] - keys[ej]) ** 2).sum(axis=1).astype(np.float64))
        wgraph = coo_matrix((w, (ei, ej)), shape=(m, m)).tocsr()
        _, _, sources = dijkstra(wgraph, directed=False, indices=seeds,
                                 min_only=True, return_predecessors=True)
        seed_index = np.full(m, -1, dtype=np.int64)
        seed_index[seeds] = np.arange(seeds.size)
        seg = np.where(sources >= 0, seed_index[np.maximum(sources, 0)], -1)
        # A component whose only coarse cells seeded a voxel of ANOTHER
        # component is unreachable: it becomes its own piece.
        lost = seg < 0
        if lost.any():
            _, lost_ids = np.unique(comp[lost], return_inverse=True)
            seg[lost] = seeds.size + lost_ids
        _, seg = np.unique(seg, return_inverse=True)
        n_seg = int(seg.max()) + 1

    return Segmentation(origin=origin, voxel=voxel, keys=keys, codes=codes, dims=dims,
                        counts=counts, sums=sums, segment=seg.astype(np.int64),
                        n_segments=n_seg, edges=(ei, ej))


def _segment_normal(s: Segmentation, seg_id: int) -> np.ndarray | None:
    """Unit normal of a segment: the smallest principal axis of its voxel
    centroids, weighted by point count. None when it is too thin to say."""
    cached = s._normals.get(seg_id)
    if cached is not None or seg_id in s._normals:
        return cached
    v = np.flatnonzero(s.segment == seg_id)
    n = None
    if v.size >= 3:
        c = s.sums[v] / s.counts[v, None]
        w = s.counts[v].astype(np.float64)
        mu = (c * w[:, None]).sum(axis=0) / w.sum()
        d = c - mu
        cov = (d * w[:, None]).T @ d
        vals, vecs = np.linalg.eigh(cov)
        if vals[1] > 1e-12:
            n = vecs[:, 0]
    s._normals[seg_id] = n
    return n


def pick(s: Segmentation, seed_voxel: int, grow: bool, max_angle_deg: float = 20.0,
         max_segments: int = 5000) -> np.ndarray:
    """Voxel indices of the segment holding `seed_voxel`, grown when asked."""
    start = int(s.segment[seed_voxel])
    chosen = {start}
    if grow:
        ei, ej = s.edges
        si, sj = s.segment[ei], s.segment[ej]
        cross = si != sj
        a = np.concatenate([si[cross], sj[cross]])
        b = np.concatenate([sj[cross], si[cross]])
        pairs = np.unique(np.stack([a, b], axis=1), axis=0) if a.size else np.zeros((0, 2), np.int64)
        order = np.argsort(pairs[:, 0], kind="stable")
        pairs = pairs[order]
        starts = np.searchsorted(pairs[:, 0], np.arange(s.n_segments))
        ends = np.searchsorted(pairs[:, 0], np.arange(s.n_segments), side="right")
        ref = _segment_normal(s, start)
        cos_min = np.cos(np.radians(max_angle_deg))
        frontier = [start]
        while frontier and len(chosen) < max_segments:
            cur = frontier.pop()
            for nb in pairs[starts[cur]:ends[cur], 1]:
                nb = int(nb)
                if nb in chosen:
                    continue
                nrm = _segment_normal(s, nb)
                if ref is None or nrm is None or abs(float(ref @ nrm)) < cos_min:
                    continue
                chosen.add(nb)
                frontier.append(nb)
    return np.flatnonzero(np.isin(s.segment, np.fromiter(chosen, dtype=np.int64)))


def encode_keys(keys: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(keys, dtype="<i4").tobytes()).decode("ascii")


def decode_keys(b64: str) -> np.ndarray:
    raw = base64.b64decode(b64, validate=True)
    if len(raw) % 12:
        raise ValueError("voxel keys must be int32 triplets")
    return np.frombuffer(raw, dtype="<i4").reshape(-1, 3).astype(np.int64)


def voxel_set_mask(positions: np.ndarray, origin, voxel: float, keys: np.ndarray) -> np.ndarray:
    """Points whose voxel floor((p - origin) / voxel) is one of `keys`.
    MIRRORS `voxelSetPredicate` in src/renderer/lib/voxelSet.ts."""
    n = positions.shape[0]
    if n == 0 or keys.shape[0] == 0:
        return np.zeros(n, dtype=bool)
    ijk = np.floor((positions - np.asarray(origin, dtype=np.float64)) / float(voxel)).astype(np.int64)
    lo = keys.min(axis=0)
    dims = keys.max(axis=0) - lo + 1
    rel = ijk - lo
    inside = np.all((rel >= 0) & (rel < dims), axis=1)
    out = np.zeros(n, dtype=bool)
    if not inside.any():
        return out
    kc = np.sort(_pack(keys - lo, dims))
    pc = _pack(rel[inside], dims)
    pos = np.minimum(np.searchsorted(kc, pc), kc.size - 1)
    out[inside] = kc[pos] == pc
    return out
