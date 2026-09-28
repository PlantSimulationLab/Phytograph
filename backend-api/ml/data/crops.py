"""Training crops: what one training example is.

A crop is built the way inference builds one (``ml.infer``): the k nearest
base-voxel points of a seed, centred on the seed. On top of that it applies
augmentations aimed at the two gaps this corpus has.

**Synthetic vs real.** The realism reports under SyntheticLiDAR_Organs/reports
separate synthetic from real with AUC 0.90-0.98, and point density and
curvature are the features that do it. So besides rotation, scale and jitter,
crops are thinned in two density-changing ways:

- a random coarser grid, to mimic farther or fewer scans;
- 1/r^2 dropout from a random virtual scanner position, to mimic the TLS
  falloff within one crop.

**Noisy real labels.** Hand labels are least reliable where wood meets leaf,
so points of a noisy source that have a differently labelled neighbour
within ``boundary_radius`` are down-weighted (``boundary_weight``) rather
than trusted fully. Synthetic labels are exact and keep weight 1.

A task maps unified semantic codes to network output indices through its
class map, and every unmapped code is ignored (label -1). The cache is
therefore shared by every task.

**Partial labels.** A code may instead map to a SET of output classes, when
the source labels a region without drawing the line the task needs (Sugar4D's
leaf is blade and petiole undivided). Each crop carries ``allowed``, an
(n, C) mask, and the loss maximises the probability of the set. A singleton
set is ordinary cross-entropy, so ``label`` (the index, or -1 for anything
that is not a single class) stays the scoring truth.

**Instances.** When the task names ``instance_codes`` and the item has an
``inst`` array, each such point also carries ``offset``: the metric vector to
its instance's centroid over the WHOLE item, not the crop, rotated and scaled
with the crop, and ``log_radius``, the log of the instance's RMS radius. A centroid vote is crop-independent, which is what lets
sliding-crop inference average it (``ml.infer``) where an embedding could not
be compared across crops.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree

from .. import hierarchy as H
from ..grid import grid_sample
from ..infer import crop_features, normalize_reflectance
from .cache import CachedItem

IGNORE = -1


@dataclass
class AugConfig:
    rotate_z: bool = True
    tilt_deg: float = 4.0
    scale: tuple[float, float] = (0.9, 1.1)
    jitter: float = 0.002
    mirror: bool = True
    coarse_grid_prob: float = 0.4
    coarse_grid: tuple[float, float] = (1.2, 3.0)   # multiples of the base voxel
    scanner_dropout_prob: float = 0.4
    scanner_distance: tuple[float, float] = (3.0, 25.0)


@dataclass
class CropConfig:
    max_points: int = 24000
    fetch_radius: float = 1.0      # first ball fetched from the cache, grown if sparse
    fetch_radius_max: float = 5.0
    minority_codes: tuple[int, ...] = (1,)    # seeds drawn from these codes...
    minority_seed_prob: float = 0.5           # ...this often
    # Seeds at least `clear_min_dist` from any minority-class point, this
    # often. Minority seeding alone means almost no training crop is free of
    # wood (3.6 % of real-tree crops had < 1 % wood, 0 % of synthetic ones), so
    # the model learned that every neighbourhood holds some and, in a dense
    # crown with no visible wood, called its most wood-like leaf clumps wood
    # (eastern redbud: wood precision 0.06). This only helps where the data
    # HAS crop-sized pure foliage: the public trees are sparse enough that a
    # 24k-voxel crop seeded 1 m from any wood is still < 1 % wood only 8.5 %
    # of the time. Dense-crown trees supply it. Off by default so existing
    # configs train exactly as before.
    clear_seed_prob: float = 0.0
    clear_min_dist: float = 0.3
    boundary_radius: float = 0.02
    boundary_weight: float = 0.3


@dataclass
class Source:
    item: CachedItem
    weight: float
    noisy: bool                   # hand-labelled: apply boundary down-weighting
    group: str = ""


@dataclass
class TaskMap:
    """Unified SEM code -> output index, plus which organ ids (if any) override
    it. Built from a task config's ``class_map``."""
    sem_to_index: dict[int, int]
    num_classes: int
    sem_to_allowed: dict[int, tuple[int, ...]] = field(default_factory=dict)
    instance_codes: tuple[int, ...] = ()

    def lut(self) -> np.ndarray:
        """Code -> output index for single-class codes, else IGNORE. This is
        the truth every score is computed against."""
        t = np.full(256, IGNORE, np.int64)
        for code, idx in self.sem_to_index.items():
            t[code] = idx
        return t

    def allowed_lut(self) -> np.ndarray:
        """(256, C) bool: the classes each code is consistent with. A row of
        all False is an ignored code."""
        t = np.zeros((256, self.num_classes), bool)
        for code, idx in self.sem_to_index.items():
            t[code, idx] = True
        for code, idxs in self.sem_to_allowed.items():
            t[code, list(idxs)] = True
        return t

    def trains(self, code: int) -> bool:
        return code in self.sem_to_index or code in self.sem_to_allowed


def _rotation(rng: np.random.Generator, aug: AugConfig) -> np.ndarray:
    a = rng.uniform(0, 2 * np.pi) if aug.rotate_z else 0.0
    c, s = np.cos(a), np.sin(a)
    rz = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    t = np.deg2rad(aug.tilt_deg)
    ax, ay = rng.uniform(-t, t, size=2)
    rx = np.array([[1, 0, 0], [0, np.cos(ax), -np.sin(ax)], [0, np.sin(ax), np.cos(ax)]])
    ry = np.array([[np.cos(ay), 0, np.sin(ay)], [0, 1, 0], [-np.sin(ay), 0, np.cos(ay)]])
    r = rz @ rx @ ry
    if aug.mirror and rng.random() < 0.5:
        r = r @ np.diag([-1.0, 1.0, 1.0])
    return r


class CropSampler:
    """Draws random training crops from weighted sources. Picklable, so each
    DataLoader worker gets its own copy and seeds its own generator."""

    def __init__(self, sources: list[Source], task: TaskMap, spec: H.HierarchySpec,
                 channels: list[str], crop: CropConfig | None = None,
                 aug: AugConfig | None = None, augment: bool = True):
        self.sources = sources
        w = np.array([s.weight for s in sources], dtype=np.float64)
        self.p = w / w.sum()
        self.lut = task.lut()
        self.allowed_lut = task.allowed_lut()
        self.inst_codes = np.array(task.instance_codes, np.int64)
        self.spec = spec
        self.channels = channels
        self.crop = crop or CropConfig()
        self.aug = aug or AugConfig()
        self.augment = augment

    def sample(self, rng: np.random.Generator) -> dict:
        for _ in range(20):
            out = self._try(rng)
            if out is not None:
                return out
        raise RuntimeError("20 consecutive empty crops; check the sources' labels")

    def _try(self, rng: np.random.Generator) -> dict | None:
        src = self.sources[rng.choice(len(self.sources), p=self.p)]
        it = src.item
        cfg = self.crop
        # Seed: a minority-class point this often, so wood (~20% of plant
        # points, far less once ground is counted) is not starved; a point
        # clear of it this often, so pure foliage is not starved either.
        rows = None
        r = rng.random()
        if r < cfg.clear_seed_prob:
            others = tuple(c for c in range(255) if self.allowed_lut[c].any()
                           and c not in cfg.minority_codes)
            rows = it.rows_clear_of(tuple(cfg.minority_codes), cfg.clear_min_dist, others)
        elif r < cfg.clear_seed_prob + cfg.minority_seed_prob:
            rows = it.rows_of(tuple(cfg.minority_codes))
        if rows is None or len(rows) == 0:
            labelled = [c for c in range(255) if self.allowed_lut[c].any()]
            rows = it.rows_of(tuple(labelled))
        if len(rows) == 0:
            return None
        seed_row = int(rows[rng.integers(len(rows))])
        centre = np.asarray(it.xyz[seed_row], dtype=np.float32)

        # Fetch a ball big enough to hold max_points base voxels, growing it
        # where the cloud is sparse (the same crop inference would make there).
        radius = cfg.fetch_radius
        while True:
            ball = it.ball(centre, radius)
            if len(ball) >= cfg.max_points * 3 or radius >= cfg.fetch_radius_max:
                break
            radius = min(radius * 1.8, cfg.fetch_radius_max)
        if len(ball) < 64:
            return None
        pts = np.asarray(it.xyz[ball], dtype=np.float64) - centre
        sem = np.asarray(it.sem[ball])
        # Offset to the instance centroid (item frame), zero and unused where
        # there is no instance. Carried through every thinning below.
        off = None
        if len(self.inst_codes) and it.inst is not None:
            inst = np.asarray(it.inst[ball])
            has = (inst >= 0) & np.isin(sem, self.inst_codes)
            off = np.zeros((len(ball), 5), np.float64)
            if has.any():
                cents, radii = it.instance_centroids(), it.instance_radii()
                off[has, :3] = cents[inst[has]] - (pts[has] + centre)
                off[has, 3] = 1.0
                off[has, 4] = np.log(np.maximum(radii[inst[has]], 1e-4))
        refl = None
        if "reflectance" in self.channels:
            if it.reflectance is None:
                return None
            refl = normalize_reflectance(np.asarray(it.reflectance[ball]))

        if self.augment:
            a = self.aug
            rot, scale = _rotation(rng, a), rng.uniform(*a.scale)
            pts = pts @ rot.T * scale
            if off is not None:
                off[:, :3] = off[:, :3] @ rot.T * scale
                off[:, 4] += np.log(scale)
            if rng.random() < a.scanner_dropout_prob:
                ang = rng.uniform(0, 2 * np.pi)
                dist = rng.uniform(*a.scanner_distance)
                scanner = np.array([np.cos(ang) * dist, np.sin(ang) * dist,
                                    rng.uniform(-1.5, 1.5)])
                r = np.linalg.norm(pts - scanner, axis=1)
                keep = rng.random(len(pts)) < np.clip((r.min() / r) ** 2, 0.15, 1.0)
                keep[np.argmin(np.linalg.norm(pts, axis=1))] = True
                pts, sem = pts[keep], sem[keep]
                refl = None if refl is None else refl[keep]
                off = None if off is None else off[keep]
            if a.jitter > 0:
                pts = pts + np.clip(rng.normal(0, a.jitter, pts.shape), -2.5 * a.jitter, 2.5 * a.jitter)
            voxel = self.spec.voxel
            if rng.random() < a.coarse_grid_prob:
                voxel *= rng.uniform(*a.coarse_grid)
            keep, _ = grid_sample(pts, voxel, rng=rng, offset=rng.uniform(0, voxel, 3))
        else:
            keep, _ = grid_sample(pts, self.spec.voxel)
        pts, sem = pts[keep], sem[keep]
        refl = None if refl is None else refl[keep]
        off = None if off is None else off[keep]

        # k nearest to the seed, re-centred on the nearest surviving point.
        tree = cKDTree(pts)
        k = min(cfg.max_points, len(pts))
        _, idx = tree.query(np.zeros(3), k=k)
        idx = np.atleast_1d(idx)
        pts = pts[idx] - pts[idx[0]]
        sem = sem[idx]
        refl = None if refl is None else refl[idx]
        off = None if off is None else off[idx]

        label = self.lut[sem]
        allowed = self.allowed_lut[sem]
        if allowed.any(axis=1).sum() < 16:
            return None
        weight = np.ones(len(pts), np.float32)
        if src.noisy and cfg.boundary_weight < 1.0:
            nb_tree = cKDTree(pts)
            d, nb = nb_tree.query(pts, k=min(9, len(pts)), distance_upper_bound=cfg.boundary_radius)
            valid = nb < len(pts)
            # On the source codes, not the task's classes, so a partial code's
            # edge counts as a boundary too.
            code = sem.astype(np.int64)
            nb_lab = np.where(valid, code[np.minimum(nb, len(pts) - 1)], code[:, None])
            boundary = (nb_lab != code[:, None]).any(axis=1)
            weight[boundary] = cfg.boundary_weight

        pts32 = pts.astype(np.float32)
        item = H.build(pts32, self.spec)
        item["feat"] = crop_features(pts32, refl, self.channels)
        item["label"] = label
        item["weight"] = weight
        if len(self.inst_codes):
            # Present (zeros) even for items without instances, so a batch can
            # always be collated.
            o = off if off is not None else np.zeros((len(pts), 5))
            item["allowed"] = allowed
            item["offset"] = o[:, :3].astype(np.float32)
            item["has_offset"] = o[:, 3] > 0
            item["log_radius"] = o[:, 4].astype(np.float32)
        elif self.allowed_lut.sum(axis=1).max() > 1:
            item["allowed"] = allowed
        return item
