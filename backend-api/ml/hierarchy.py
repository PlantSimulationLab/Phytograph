"""The multi-resolution neighbour structure one crop is fed through.

PointNeXt downsamples with farthest-point sampling and groups with ball query,
both custom CUDA kernels in openpoints. Here both are replaced by CPU-side
equivalents, computed once per crop before the network runs:

- **Downsampling** is a voxel grid of barycentres, at least ``stride`` (4,
  PointNeXt's) times fewer points per level. The voxel starts at the level's
  nominal size (the base voxel doubled per level; on a surface that alone is
  ~4x fewer points) and grows until the level is that much smaller. The
  growth is not optional. A TLS crop is dense near the scanner and sparse at
  a tree's top, and there a nominal voxel smaller than the point spacing
  removes nothing: measured on a decimated oak, a doubling grid kept
  24000 -> 22600 -> 18254 points, so the coarse levels were neither coarse
  nor cheap. Like FPS, the grid is uniform per unit area, but it costs a few
  O(n) passes where FPS costs O(n*m) (open3d's C++ FPS takes 0.45 s per
  24k-point crop, which is longer than the network's forward pass).
- **Grouping** is k nearest neighbours, clamped to a generous radius. Beyond
  the radius a neighbour is replaced by the query's nearest point, which is
  what openpoints' ball query pads with, so an isolated point is not pooled
  with one across a gap. Unclamped kNN is otherwise density-adaptive, which
  matters for the same sparse-crown reason.

The network then does nothing but index gathers, matmuls and max-pools. That is
why one model runs unchanged on CUDA, Apple MPS and a CPU, and why nothing
native has to be bundled per platform.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial import cKDTree

from .grid import grid_mean, voxel_keys


@dataclass(frozen=True)
class HierarchySpec:
    """Geometry of the hierarchy, stored in the model package: a model is only
    valid on hierarchies built exactly the way it was trained."""

    voxel: float = 0.01          # level-0 spacing, metres
    levels: int = 5              # level 0 plus 4 downsampled levels
    k: int = 16                  # neighbours per group
    radius_factor: float = 2.5   # group radius = factor * level voxel * sqrt(k/8)
    stride: int = 4              # each level has at most 1/stride the points
    clamp_factor: float = 4.0    # neighbours beyond clamp_factor*radius are dropped

    def level_voxel(self, i: int) -> float:
        return self.voxel * (2 ** i)

    def level_radius(self, i: int) -> float:
        # sqrt(k/8) scales the radius with the group size: on a surface, k
        # neighbours at spacing s span about s*sqrt(k/pi), and 8 was chosen so
        # that k=16 gives about 3.5 voxels.
        return self.radius_factor * self.level_voxel(i) * float(np.sqrt(self.k / 8.0))

    def to_dict(self) -> dict:
        return {"voxel": self.voxel, "levels": self.levels, "k": self.k,
                "radius_factor": self.radius_factor, "stride": self.stride,
                "clamp_factor": self.clamp_factor}

    @classmethod
    def from_dict(cls, d: dict) -> "HierarchySpec":
        return cls(**{k: d[k] for k in ("voxel", "levels", "k", "radius_factor", "stride",
                                         "clamp_factor") if k in d})


def _knn(tree: cKDTree, queries: np.ndarray, k: int, radius: float, n_support: int) -> np.ndarray:
    """k nearest neighbours of each query in ``tree``, as an (m, k) int32 array.

    Neighbours beyond ``radius`` are replaced by the query's nearest neighbour,
    and so is any column past the support's size (cKDTree reports those as
    index n with distance inf).
    """
    k_eff = min(k, n_support)
    d, idx = tree.query(queries, k=k_eff, workers=1)
    if k_eff == 1:
        d, idx = d[:, None], idx[:, None]
    far = ~(d <= radius)
    if far.any():
        idx = np.where(far, idx[:, :1], idx)
    if k_eff < k:
        idx = np.concatenate([idx, np.repeat(idx[:, :1], k - k_eff, axis=1)], axis=1)
    return idx.astype(np.int32, copy=False)


def _downsample(prev: np.ndarray, voxel: float, target: int) -> np.ndarray:
    """Barycentres of the coarsest-needed grid: ``voxel`` or larger, grown
    until at most ``target`` voxels are occupied.

    Occupied voxels on a surface scale as 1/v^2, so each step grows ``v`` by
    sqrt(count/target), which converges in two or three passes where a fixed
    1.25x step took up to a dozen on a sparse crown."""
    p = prev.astype(np.float64)
    v = voxel
    for _ in range(16):
        count = len(np.unique(voxel_keys(p, v)))
        if count <= target:
            break
        v *= max(1.05, float(np.sqrt(count / target)) * 1.02)
    centres, _ = grid_mean(p, v)
    return centres.astype(np.float32)


def build(xyz: np.ndarray, spec: HierarchySpec, local0: bool = False) -> dict:
    """Build the hierarchy for one crop.

    ``xyz`` is (n, 3), already centred on the crop and grid-sampled at
    ``spec.voxel``. The result maps names to lists, one entry per level:

    - ``pos[i]``: (n_i, 3) float32 point positions.
    - ``local[i]``: (n_i, k) neighbours of each level-i point within level i.
      ``local[0]`` is None unless ``local0``: it is the single most expensive
      query (every full-resolution point) and only a model with level-0
      blocks uses it.
    - ``down[i]`` (i >= 1): (n_i, k) level-(i-1) points pooled into each level-i
      point. ``down[0]`` is None.
    - ``up_idx[i]``, ``up_w[i]`` (i >= 1): the 3 nearest level-i points of each
      level-(i-1) point, with inverse-distance weights, for the decoder.
    """
    pos = [np.ascontiguousarray(xyz, dtype=np.float32)]
    for i in range(1, spec.levels):
        prev = pos[-1]
        if len(prev) <= 1:
            pos.append(prev.copy())
            continue
        target = max(1, int(np.ceil(len(prev) / spec.stride)))
        pos.append(_downsample(prev, spec.level_voxel(i), target))

    trees = [cKDTree(p) for p in pos]
    local, down, up_idx, up_w = [], [None], [None], [None]
    for i, p in enumerate(pos):
        r = spec.level_radius(i) * spec.clamp_factor
        local.append(_knn(trees[i], p, spec.k, r, len(p)) if (i or local0) else None)
        if i == 0:
            continue
        # Pool the finer level into this one, at this level's radius.
        down.append(_knn(trees[i - 1], p, spec.k, r, len(pos[i - 1])))
        # Decoder: interpolate this level back onto the finer one. No radius
        # clamp: every fine point must receive a value.
        k3 = min(3, len(p))
        d, idx = trees[i].query(pos[i - 1], k=k3, workers=1)
        if k3 == 1:
            d, idx = d[:, None], idx[:, None]
        if k3 < 3:
            d = np.concatenate([d, np.repeat(d[:, :1], 3 - k3, axis=1)], axis=1)
            idx = np.concatenate([idx, np.repeat(idx[:, :1], 3 - k3, axis=1)], axis=1)
        w = 1.0 / np.maximum(d, 1e-8)
        w /= w.sum(axis=1, keepdims=True)
        up_idx.append(idx.astype(np.int32))
        up_w.append(w.astype(np.float32))
    return {"pos": pos, "local": local, "down": down, "up_idx": up_idx, "up_w": up_w}


def collate(items: list[dict]) -> dict:
    """Pack several crops' hierarchies into one batch.

    Points are concatenated rather than padded, so crops of different sizes
    cost nothing extra. Every index array is shifted by its crop's offset into
    the concatenated array of the level it indexes: ``local`` and ``up_idx``
    index their own level, ``down`` indexes the level below. ``extra`` keys
    (features, labels, weights) are concatenated along axis 0.
    """
    levels = len(items[0]["pos"])
    out: dict = {"pos": [], "local": [], "down": [None], "up_idx": [None], "up_w": [None]}
    offsets = [[0] * len(items) for _ in range(levels)]
    for i in range(levels):
        acc = 0
        for j, it in enumerate(items):
            offsets[i][j] = acc
            acc += len(it["pos"][i])
    for i in range(levels):
        out["pos"].append(np.concatenate([it["pos"][i] for it in items]))
        if items[0]["local"][i] is None:
            out["local"].append(None)
        else:
            out["local"].append(np.concatenate(
                [it["local"][i] + offsets[i][j] for j, it in enumerate(items)]))
        if i:
            out["down"].append(np.concatenate(
                [it["down"][i] + offsets[i - 1][j] for j, it in enumerate(items)]))
            out["up_idx"].append(np.concatenate(
                [it["up_idx"][i] + offsets[i][j] for j, it in enumerate(items)]))
            out["up_w"].append(np.concatenate([it["up_w"][i] for it in items]))
    for key in items[0]:
        if key in out:
            continue
        out[key] = np.concatenate([it[key] for it in items])
    out["batch_sizes"] = np.array([len(it["pos"][0]) for it in items], dtype=np.int64)
    return out
