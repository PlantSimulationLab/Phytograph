"""Make exact synthetic labels look like hand labels.

A Helios scene labels every scanned shoot as wood, down to a 3 mm current-year
shoot glimpsed for a few points between two leaves. A person labelling a real
dense crown cannot see those as wood, so they are labelled leaf, and only
clearly visible, continuous wood is marked. The mismatch was measured: across
8 library species and 20 synthetic scans, no leaf point was more than 30 cm
from labelled wood, while a hand-labelled dense redbud had 78 % of its leaf
that far from any. A model trained on the synthetic convention learns that
every crown neighbourhood contains wood, and in a dense real crown it calls
its most wood-like leaf clumps wood.

:func:`human_visible_wood` keeps a wood point only when it belongs to a
connected run of scanned wood whose extent is at least ``min_length``: the
trunk and branches a labeller can follow. Shorter, disconnected fragments
become leaf. Connectivity is on the scanned points, so what counts is what the
scanner (and so the labeller) actually saw, not the plant's true topology.
"""

from __future__ import annotations

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from ..grid import grid_sample


def human_visible_wood(xyz: np.ndarray, sem: np.ndarray, wood_code: int, leaf_code: int,
                       min_length: float, link: float = 0.02, voxel: float = 0.01) -> np.ndarray:
    """Return a copy of ``sem`` with wood outside long visible runs relabelled leaf.

    Wood points are grid-sampled at ``voxel`` (so dense near-range scanning does
    not bridge gaps a coarser far-range scan would leave), linked within
    ``link``, and each connected component is kept as wood if its bounding-box
    diagonal is at least ``min_length``.
    """
    sem = np.asarray(sem).copy()
    wood = np.flatnonzero(sem == wood_code)
    if len(wood) == 0 or min_length <= 0:
        return sem
    keep, inverse = grid_sample(xyz[wood], voxel)
    v = xyz[wood][keep]
    pairs = cKDTree(v).query_pairs(link, output_type="ndarray")
    n = len(v)
    graph = coo_matrix((np.ones(len(pairs), np.int8), (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    _, comp = connected_components(graph, directed=False)
    lo = np.full((comp.max() + 1, 3), np.inf)
    hi = np.full((comp.max() + 1, 3), -np.inf)
    np.minimum.at(lo, comp, v)
    np.maximum.at(hi, comp, v)
    long_enough = np.linalg.norm(hi - lo, axis=1) >= min_length
    visible = long_enough[comp][inverse]
    sem[wood[~visible]] = leaf_code
    return sem
