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

    def lut(self) -> np.ndarray:
        t = np.full(256, IGNORE, np.int64)
        for code, idx in self.sem_to_index.items():
            t[code] = idx
        return t


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
        # points, far less once ground is counted) is not starved.
        rows = None
        if rng.random() < cfg.minority_seed_prob:
            rows = it.rows_of(tuple(cfg.minority_codes))
        if rows is None or len(rows) == 0:
            labelled = [c for c in range(255) if self.lut[c] != IGNORE]
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
        refl = None
        if "reflectance" in self.channels:
            if it.reflectance is None:
                return None
            refl = normalize_reflectance(np.asarray(it.reflectance[ball]))

        if self.augment:
            a = self.aug
            pts = pts @ _rotation(rng, a).T * rng.uniform(*a.scale)
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

        # k nearest to the seed, re-centred on the nearest surviving point.
        tree = cKDTree(pts)
        k = min(cfg.max_points, len(pts))
        _, idx = tree.query(np.zeros(3), k=k)
        idx = np.atleast_1d(idx)
        pts = pts[idx] - pts[idx[0]]
        sem = sem[idx]
        refl = None if refl is None else refl[idx]

        label = self.lut[sem]
        if (label != IGNORE).sum() < 16:
            return None
        weight = np.ones(len(pts), np.float32)
        if src.noisy and cfg.boundary_weight < 1.0:
            nb_tree = cKDTree(pts)
            d, nb = nb_tree.query(pts, k=min(9, len(pts)), distance_upper_bound=cfg.boundary_radius)
            valid = nb < len(pts)
            nb_lab = np.where(valid, label[np.minimum(nb, len(pts) - 1)], label[:, None])
            boundary = (nb_lab != label[:, None]).any(axis=1)
            weight[boundary] = cfg.boundary_weight

        pts32 = pts.astype(np.float32)
        item = H.build(pts32, self.spec)
        item["feat"] = crop_features(pts32, refl, self.channels)
        item["label"] = label
        item["weight"] = weight
        return item
