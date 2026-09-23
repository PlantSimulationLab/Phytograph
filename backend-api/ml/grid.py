"""Voxel grid sampling.

Training crops and inference both pass their points through :func:`grid_sample`
at the model's base voxel size, so the network always sees the same point
spacing. That spacing is what lets one model handle TLS scans whose raw density
falls off as 1/r^2 with range. The only difference between the two callers is
which point represents a voxel: a random one in training (a free augmentation)
and the first one at inference (deterministic).
"""

from __future__ import annotations

import numpy as np


def voxel_keys(xyz: np.ndarray, voxel: float, offset: np.ndarray | None = None) -> np.ndarray:
    """One int64 key per point naming its voxel.

    Coordinates are packed 21 bits per axis after shifting to the cloud's own
    minimum, which gives 2 M voxels per axis: 20 km at 1 cm. That is well beyond
    any cloud that fits in memory. ``offset`` shifts the grid, so each training
    crop is gridded differently.
    """
    p = np.asarray(xyz, dtype=np.float64)
    if offset is not None:
        p = p + offset
    q = np.floor((p - p.min(axis=0)) / float(voxel)).astype(np.int64)
    if q.size and q.max() >= (1 << 21):
        raise ValueError(
            f"cloud extent {np.ptp(p, axis=0).max():.1f} m is too large for a "
            f"{voxel} m voxel grid"
        )
    return (q[:, 0] << 42) | (q[:, 1] << 21) | q[:, 2]


def grid_sample(
    xyz: np.ndarray,
    voxel: float,
    rng: np.random.Generator | None = None,
    offset: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Keep one point per voxel.

    Returns ``(keep, inverse)``:

    - ``keep`` indexes ``xyz`` with the kept points, one per occupied voxel.
    - ``inverse`` maps every input point to its voxel's position in ``keep``,
      which is how per-voxel predictions are scattered back to full resolution.

    With ``rng`` the representative is a random point of its voxel; without it,
    the lowest index is kept.
    """
    n = len(xyz)
    if n == 0:
        return np.empty(0, np.int64), np.empty(0, np.int64)
    keys = voxel_keys(xyz, voxel, offset)
    if rng is not None:
        perm = rng.permutation(n)
        _, first, inv_perm = np.unique(keys[perm], return_index=True, return_inverse=True)
        keep = perm[first]
        inverse = np.empty(n, np.int64)
        inverse[perm] = inv_perm
        return keep, inverse
    _, keep, inverse = np.unique(keys, return_index=True, return_inverse=True)
    return keep.astype(np.int64), inverse.astype(np.int64)


def grid_mean(xyz: np.ndarray, voxel: float) -> tuple[np.ndarray, np.ndarray]:
    """Voxel barycentres, used for the network's coarser levels.

    Returns ``(centres, inverse)``. Barycentres rather than representative
    points: a coarse level summarises a region, and the mean sits on the
    surface's medial line where a single chosen point could sit on its edge.
    """
    keys = voxel_keys(xyz, voxel)
    _, inverse, counts = np.unique(keys, return_inverse=True, return_counts=True)
    m = len(counts)
    centres = np.empty((m, 3), dtype=np.float64)
    for d in range(3):  # bincount, not np.add.at: the latter is ~20x slower
        centres[:, d] = np.bincount(inverse, weights=xyz[:, d], minlength=m)
    centres /= counts[:, None]
    return centres.astype(xyz.dtype, copy=False), inverse
