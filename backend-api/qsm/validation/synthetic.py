"""Hand-built synthetic cylinder trees with exactly-known geometry (Layer 1).

These need NO external data -- they are authored directly as QSMs, so the
ground-truth shoot membership, rank, topology, and radii are known by
construction. They drive the harness self-test and the unit-level stage tests
(Phases A-E) before the PyHelios fixtures (Layer 2) are wired in.

Also provides a point-cloud sampler that draws points on a QSM's cylinder
surfaces with controllable occlusion / noise / gaps / outliers, so the same
known tree can produce a realistic-ish cloud for the early pipeline tests.

Deterministic given a seed (uses an explicit ``np.random.default_rng``).
"""

from __future__ import annotations

import numpy as np

from ..model import NO_PARENT, QSM, Cylinder, Shoot


class _Builder:
    """Incrementally assemble a QSM, auto-assigning cylinder ids and splitting
    cylinders along a polyline into uniform segments."""

    def __init__(self) -> None:
        self.cylinders: list[Cylinder] = []
        self.shoots: list[Shoot] = []
        self._next_cyl = 0
        self._next_shoot = 0

    def add_shoot(
        self,
        start: np.ndarray,
        direction: np.ndarray,
        length: float,
        radius_base: float,
        radius_tip: float,
        rank: int,
        n_seg: int,
        parent_shoot_id: int = NO_PARENT,
        parent_cyl_id: int = NO_PARENT,
    ) -> Shoot:
        """Append a straight shoot of ``length`` split into ``n_seg`` cylinders,
        tapering linearly from ``radius_base`` to ``radius_tip``."""
        direction = np.asarray(direction, dtype=np.float64)
        direction = direction / (np.linalg.norm(direction) or 1.0)
        start = np.asarray(start, dtype=np.float64)
        shoot_id = self._next_shoot
        self._next_shoot += 1

        cyl_ids: list[int] = []
        prev = parent_cyl_id
        for i in range(n_seg):
            s = start + direction * (length * i / n_seg)
            e = start + direction * (length * (i + 1) / n_seg)
            r = radius_base + (radius_tip - radius_base) * ((i + 0.5) / n_seg)
            cid = self._next_cyl
            self._next_cyl += 1
            self.cylinders.append(
                Cylinder(cyl_id=cid, start=s, end=e, radius=r,
                         parent_id=prev, shoot_id=shoot_id, rank=rank)
            )
            cyl_ids.append(cid)
            prev = cid

        shoot = Shoot(
            shoot_id=shoot_id, rank=rank, cylinder_ids=cyl_ids,
            parent_shoot_id=parent_shoot_id, parent_cyl_id=parent_cyl_id,
        )
        self.shoots.append(shoot)
        return shoot

    def link_child(self, parent: Shoot, child: Shoot) -> None:
        parent.child_shoot_ids.append(child.shoot_id)

    def build(self, meta: dict | None = None) -> QSM:
        return QSM(cylinders=list(self.cylinders), shoots=list(self.shoots),
                   units="meters", meta=meta or {})

    def tip_of(self, shoot: Shoot) -> np.ndarray:
        by_id = {c.cyl_id: c for c in self.cylinders}
        return by_id[shoot.cylinder_ids[-1]].end

    def cyl_at_fraction(self, shoot: Shoot, frac: float) -> int:
        """cyl_id at fractional position along the shoot (for attaching a child)."""
        idx = min(len(shoot.cylinder_ids) - 1, int(frac * len(shoot.cylinder_ids)))
        return shoot.cylinder_ids[idx]


def simple_tree() -> QSM:
    """Trunk (rank 0) + 3 scaffolds (rank 1), each with one sub-branch (rank 2).

    Geometry is gentle and unambiguous: the trunk is by far the longest axis, so
    continuation-by-subtree-size has the obvious right answer.
    """
    b = _Builder()
    trunk = b.add_shoot(
        start=[0, 0, 0], direction=[0, 0, 1], length=2.0,
        radius_base=0.05, radius_tip=0.03, rank=0, n_seg=10,
    )
    # Scaffolds branch off the trunk at increasing heights, outward + upward.
    scaffolds = []
    for k, (frac, az) in enumerate([(0.4, 0.0), (0.6, 2.1), (0.8, 4.2)]):
        attach = b.cyl_at_fraction(trunk, frac)
        base = next(c for c in b.cylinders if c.cyl_id == attach).end
        d = [np.cos(az), np.sin(az), 0.8]
        sc = b.add_shoot(
            start=base, direction=d, length=0.9,
            radius_base=0.025, radius_tip=0.012, rank=1, n_seg=6,
            parent_shoot_id=trunk.shoot_id, parent_cyl_id=attach,
        )
        b.link_child(trunk, sc)
        scaffolds.append(sc)
        # one rank-2 sub-branch near the scaffold tip
        sub_attach = b.cyl_at_fraction(sc, 0.7)
        sub_base = next(c for c in b.cylinders if c.cyl_id == sub_attach).end
        sd = [np.cos(az + 0.9), np.sin(az + 0.9), 0.6]
        sub = b.add_shoot(
            start=sub_base, direction=sd, length=0.35,
            radius_base=0.01, radius_tip=0.005, rank=2, n_seg=3,
            parent_shoot_id=sc.shoot_id, parent_cyl_id=sub_attach,
        )
        b.link_child(sc, sub)
    return b.build(meta={"name": "simple_tree"})


def tricky_fork_tree() -> QSM:
    """A trunk where, at one fork, a lateral (rank 1) is THICKER and STRAIGHTER
    than the true continuation of the trunk. The continuation-by-subtree-size
    rule must still keep the trunk as one rank-0 axis (the trunk supports more
    total length beyond the fork). This is the adversarial case for shoot rank.
    """
    b = _Builder()
    # Lower trunk.
    lower = b.add_shoot(
        start=[0, 0, 0], direction=[0, 0, 1], length=1.0,
        radius_base=0.05, radius_tip=0.042, rank=0, n_seg=6,
    )
    fork = b.tip_of(lower)
    fork_cyl = lower.cylinder_ids[-1]
    # The true trunk continuation: bends slightly, but carries a LONG subtree.
    upper = b.add_shoot(
        start=fork, direction=[0.25, 0.0, 1.0], length=1.6,
        radius_base=0.040, radius_tip=0.020, rank=0, n_seg=10,
        parent_shoot_id=lower.shoot_id, parent_cyl_id=fork_cyl,
    )
    # Stitch lower+upper into ONE rank-0 shoot conceptually: model as the same
    # shoot_id chain by re-parenting upper's cylinders onto the lower shoot.
    # (For the GT here we keep them as one logical trunk: same rank 0, and we
    # merge the shoot records so there is exactly one rank-0 shoot.)
    for cid in upper.cylinder_ids:
        c = next(cc for cc in b.cylinders if cc.cyl_id == cid)
        c.shoot_id = lower.shoot_id
    lower.cylinder_ids += upper.cylinder_ids
    b.shoots.remove(upper)
    b._next_shoot -= 1  # reclaim id so the lateral gets shoot_id 1

    # The decoy lateral: THICKER and perfectly straight, but SHORT (small subtree).
    decoy = b.add_shoot(
        start=fork, direction=[0.0, 0.0, 1.0], length=0.5,
        radius_base=0.045, radius_tip=0.030, rank=1, n_seg=4,
        parent_shoot_id=lower.shoot_id, parent_cyl_id=fork_cyl,
    )
    b.link_child(lower, decoy)
    return b.build(meta={"name": "tricky_fork_tree", "fork_cyl": fork_cyl})


def sample_cloud(
    qsm: QSM,
    seed: int = 0,
    points_per_m2: float = 4000.0,
    noise_sigma: float = 0.0,
    occlusion_arc: float | None = None,
    occlusion_dir_az: float = 0.0,
    n_outliers: int = 0,
    bounds_pad: float = 0.5,
) -> np.ndarray:
    """Sample points on the QSM cylinder surfaces.

    Parameters mirror the realism knobs:
    - ``noise_sigma``: Gaussian position noise (m).
    - ``occlusion_arc``: if set, only keep points whose surface normal azimuth is
      within +/- this many radians of ``occlusion_dir_az`` (a one-sided scan).
    - ``n_outliers``: stray points scattered in the bounding box.
    Deterministic given ``seed``.
    """
    rng = np.random.default_rng(seed)
    out: list[np.ndarray] = []

    for c in qsm.cylinders:
        L = c.length
        if L <= 0:
            continue
        area = 2.0 * np.pi * c.radius * L
        n = max(8, int(area * points_per_m2))
        axis = c.axis
        # perpendicular frame
        seed_v = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        u = seed_v - axis * float(np.dot(seed_v, axis))
        u /= np.linalg.norm(u) or 1.0
        v = np.cross(axis, u)

        t = rng.uniform(0.0, 1.0, n)
        theta = rng.uniform(0.0, 2.0 * np.pi, n)
        if occlusion_arc is not None:
            keep = np.abs(_wrap(theta - occlusion_dir_az)) <= occlusion_arc
            t, theta = t[keep], theta[keep]
        centers = c.start[None, :] + t[:, None] * (c.end - c.start)[None, :]
        radial = np.cos(theta)[:, None] * u[None, :] + np.sin(theta)[:, None] * v[None, :]
        pts = centers + c.radius * radial
        out.append(pts)

    cloud = np.concatenate(out, axis=0) if out else np.zeros((0, 3))
    if noise_sigma > 0 and len(cloud):
        cloud = cloud + rng.normal(0.0, noise_sigma, cloud.shape)

    if n_outliers > 0 and len(cloud):
        mins, maxs = cloud.min(axis=0) - bounds_pad, cloud.max(axis=0) + bounds_pad
        outliers = rng.uniform(mins, maxs, (n_outliers, 3))
        cloud = np.concatenate([cloud, outliers], axis=0)

    # Deterministic order (sorted) so downstream is reproducible.
    if len(cloud):
        order = np.lexsort((cloud[:, 2], cloud[:, 1], cloud[:, 0]))
        cloud = cloud[order]
    return cloud


def _wrap(a: np.ndarray) -> np.ndarray:
    """Wrap angles to [-pi, pi]."""
    return (a + np.pi) % (2.0 * np.pi) - np.pi
