"""The correspondence primitive: resample a QSM into discretization-independent
samples so two cylinder sets with different tessellation compare fairly.

The ground-truth model (PyHelios internode tubes) and a reconstructed QSM
describe the same tree but chop it into cylinders at unrelated places. Comparing
cylinder-to-cylinder is therefore meaningless. Instead we walk every cylinder
axis at a *fixed* arc-length step ``ds`` and emit:

- **centerline samples**: points on the axes, each tagged with the local radius,
  rank, shoot_id, cumulative arc length along its shoot, and geodesic distance
  from the tree base. Fixed ``ds`` => a finely-tessellated GT and a coarse
  reconstruction yield the same sample *density*, which is what defuses the
  discretization mismatch.
- **surface samples**: a ring of points at the local radius around each
  centerline sample (used for cloud-anchored checks and coverage).

All distances/coordinates in meters. Deterministic: no RNG.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..model import NO_PARENT, QSM, Cylinder

# Default axial step. ~half the smallest branch radius we target (~5 mm), so a
# thin branch still gets several samples along its length.
DEFAULT_DS = 0.002  # meters
# Default number of points per surface ring.
DEFAULT_RING_K = 16


@dataclass
class CenterlineSamples:
    """Arc-length-uniform samples along a QSM's cylinder axes.

    All arrays are parallel (same length N). This is the canonical form every
    metric consumes.
    """

    xyz: np.ndarray  # (N, 3) sample positions
    radius: np.ndarray  # (N,) local cylinder radius at each sample
    rank: np.ndarray  # (N,) int shoot rank
    shoot_id: np.ndarray  # (N,) int shoot id
    cyl_id: np.ndarray  # (N,) int source cylinder id
    arc_s: np.ndarray  # (N,) arc length from this sample's shoot base
    geodesic: np.ndarray  # (N,) geodesic distance from the tree base
    ds: float  # the nominal step requested
    # (N,) TRUE arc length each sample owns = its source cylinder's length / its
    # sample count. This is ds for cylinders longer than ds, but SMALLER for a
    # cylinder shorter than ds (which still emits exactly one sample). Weighting
    # by seg_len -- not by the nominal ds or by sample count -- is what makes the
    # volume / per-rank-arc / radius-RMSE metrics exactly tessellation-invariant:
    # a sub-ds cylinder must not be counted as a full ds of wood. (Without this a
    # GT chopped entirely below ds doubles its measured volume vs a coarse recon
    # of identical geometry.)
    seg_len: np.ndarray = None  # type: ignore[assignment]

    def __len__(self) -> int:
        return int(self.xyz.shape[0])

    @property
    def weights(self) -> np.ndarray:
        """Per-sample TRUE arc-length weight (each sample's owned cylinder length).
        Use this -- not raw sample counts -- wherever an arc-length integral or
        average is needed, so the result is tessellation-invariant."""
        if self.seg_len is None:
            return np.full(len(self), self.ds, dtype=np.float64)
        return self.seg_len


def _perp_frame(axis: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return two orthonormal vectors spanning the plane perpendicular to
    ``axis`` (unit). Deterministic choice of seed vector."""
    a = axis / (np.linalg.norm(axis) or 1.0)
    # Pick the world axis least aligned with `a` as the seed (deterministic).
    seed = np.array([1.0, 0.0, 0.0])
    if abs(a[0]) > 0.9:
        seed = np.array([0.0, 1.0, 0.0])
    u = seed - a * float(np.dot(seed, a))
    u /= np.linalg.norm(u) or 1.0
    v = np.cross(a, u)
    return u, v


def _geodesic_base_distance(qsm: QSM) -> dict[int, float]:
    """Geodesic distance from the tree base to the START of each cylinder,
    summing cylinder lengths along the parent chain. Iterative (no recursion)
    and memoized so deep trees don't overflow and we stay O(N)."""
    by_id = qsm.cylinder_by_id()
    start_dist: dict[int, float] = {}

    def dist_to_start(cid: int) -> float:
        # Walk up to the root building a stack, then fill distances downward.
        stack: list[int] = []
        cur = cid
        while cur not in start_dist and cur != NO_PARENT and cur in by_id:
            stack.append(cur)
            cur = by_id[cur].parent_id
        # Unwind: each cylinder's start distance = parent's start dist + parent length.
        for c2 in reversed(stack):
            parent = by_id[c2].parent_id
            if parent == NO_PARENT or parent not in by_id:
                start_dist[c2] = 0.0
            else:
                start_dist[c2] = start_dist[parent] + by_id[parent].length
        return start_dist.get(cid, 0.0)

    for c in qsm.cylinders:
        dist_to_start(c.cyl_id)
    return start_dist


def _shoot_base_arc(qsm: QSM) -> dict[int, float]:
    """Arc length from each shoot's base to the START of each cylinder, summing
    lengths of preceding cylinders within the same shoot (using the shoot's
    ordered cylinder list when available, else the parent chain restricted to
    the same shoot id)."""
    by_id = qsm.cylinder_by_id()
    arc: dict[int, float] = {}
    if qsm.shoots:
        for s in qsm.shoots:
            acc = 0.0
            for cid in s.cylinder_ids:
                if cid not in by_id:
                    continue
                arc[cid] = acc
                acc += by_id[cid].length
    # Fill any cylinders not covered by a shoot list (defensive): walk parent
    # chain within the same shoot.
    for c in qsm.cylinders:
        if c.cyl_id in arc:
            continue
        acc = 0.0
        cur = c.parent_id
        guard = 0
        while cur != NO_PARENT and cur in by_id and by_id[cur].shoot_id == c.shoot_id:
            acc += by_id[cur].length
            cur = by_id[cur].parent_id
            guard += 1
            if guard > len(qsm.cylinders):  # cycle guard
                break
        arc[c.cyl_id] = acc
    return arc


def centerline_samples(qsm: QSM, ds: float = DEFAULT_DS) -> CenterlineSamples:
    """Sample every cylinder axis at fixed arc-length step ``ds``.

    A cylinder of length L contributes ``max(1, round(L/ds))`` samples spread
    along its axis (always at least one so short cylinders aren't dropped).
    """
    start_geo = _geodesic_base_distance(qsm)
    shoot_arc = _shoot_base_arc(qsm)

    xyz_l: list[np.ndarray] = []
    rad_l: list[np.ndarray] = []
    rank_l: list[np.ndarray] = []
    shoot_l: list[np.ndarray] = []
    cyl_l: list[np.ndarray] = []
    arc_l: list[np.ndarray] = []
    geo_l: list[np.ndarray] = []
    seglen_l: list[np.ndarray] = []

    for c in qsm.cylinders:
        L = c.length
        n = max(1, int(round(L / ds))) if L > 0 else 1
        # Parameter midpoints of n equal sub-segments: (i+0.5)/n, i=0..n-1.
        # Using midpoints (not endpoints) avoids double-counting shared vertices
        # between adjacent cylinders.
        ts = (np.arange(n) + 0.5) / n
        pts = c.start[None, :] + ts[:, None] * (c.end - c.start)[None, :]
        base_arc = shoot_arc.get(c.cyl_id, 0.0)
        base_geo = start_geo.get(c.cyl_id, 0.0)
        seg = L / n  # true arc length each of this cylinder's samples owns
        xyz_l.append(pts)
        rad_l.append(np.full(n, c.radius))
        rank_l.append(np.full(n, c.rank, dtype=np.int64))
        shoot_l.append(np.full(n, c.shoot_id, dtype=np.int64))
        cyl_l.append(np.full(n, c.cyl_id, dtype=np.int64))
        arc_l.append(base_arc + ts * L)
        geo_l.append(base_geo + ts * L)
        seglen_l.append(np.full(n, seg))

    if not xyz_l:
        empty_f = np.zeros((0,), dtype=np.float64)
        return CenterlineSamples(
            xyz=np.zeros((0, 3), dtype=np.float64),
            radius=empty_f,
            rank=np.zeros((0,), dtype=np.int64),
            shoot_id=np.zeros((0,), dtype=np.int64),
            cyl_id=np.zeros((0,), dtype=np.int64),
            arc_s=empty_f,
            geodesic=empty_f,
            ds=ds,
            seg_len=empty_f,
        )

    return CenterlineSamples(
        xyz=np.concatenate(xyz_l, axis=0).astype(np.float64),
        radius=np.concatenate(rad_l).astype(np.float64),
        rank=np.concatenate(rank_l),
        shoot_id=np.concatenate(shoot_l),
        cyl_id=np.concatenate(cyl_l),
        arc_s=np.concatenate(arc_l).astype(np.float64),
        geodesic=np.concatenate(geo_l).astype(np.float64),
        ds=ds,
        seg_len=np.concatenate(seglen_l).astype(np.float64),
    )


def skeleton_centerline_samples(graph, ds: float = DEFAULT_DS) -> np.ndarray:
    """Resample a ``SkeletonGraph`` (nodes + parent edges) into arc-length-uniform
    points along its edges. Returns (N, 3). Used to compare a Phase-B skeleton
    centerline against the ground-truth centerline before cylinders exist.

    Imported lazily to avoid a hard dependency cycle with the skeleton module.
    """
    nodes = np.asarray(graph.nodes, dtype=np.float64)
    out: list[np.ndarray] = []
    for parent, child in graph.edges():
        a, b = nodes[parent], nodes[child]
        L = float(np.linalg.norm(b - a))
        if L <= 0:
            out.append(a[None, :])
            continue
        n = max(1, int(round(L / ds)))
        ts = (np.arange(n) + 0.5) / n
        out.append(a[None, :] + ts[:, None] * (b - a)[None, :])
    if not out:
        return nodes.copy() if nodes.size else np.zeros((0, 3))
    return np.concatenate(out, axis=0)


def surface_samples(
    qsm: QSM, ds: float = DEFAULT_DS, ring_k: int = DEFAULT_RING_K
) -> np.ndarray:
    """Points on the cylinder *surfaces*: a ring of ``ring_k`` points at the
    local radius around each centerline sample. Returns (M, 3). Used for
    cloud-anchored centerline checks and coverage, not for topology.
    """
    cl = centerline_samples(qsm, ds=ds)
    if len(cl) == 0:
        return np.zeros((0, 3), dtype=np.float64)

    by_id = qsm.cylinder_by_id()
    angles = np.arange(ring_k) * (2.0 * np.pi / ring_k)
    cos_a = np.cos(angles)
    sin_a = np.sin(angles)

    out: list[np.ndarray] = []
    for i in range(len(cl)):
        c: Cylinder = by_id[int(cl.cyl_id[i])]
        u, v = _perp_frame(c.axis if c.length > 0 else np.array([0.0, 0.0, 1.0]))
        center = cl.xyz[i]
        r = cl.radius[i]
        ring = center[None, :] + r * (cos_a[:, None] * u[None, :] + sin_a[:, None] * v[None, :])
        out.append(ring)
    return np.concatenate(out, axis=0)
