"""Synthetic trees of KNOWN geometry for the tree-inventory tests.

A tree is a tapered, optionally leaning cylinder standing on a sloped planar
terrain, with an ellipsoidal crown shell on top. Every quantity the inventory
measures has an exact answer here, so the tests assert against the truth rather
than against a previous run.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np


@dataclass
class SyntheticTree:
    base_xy: Tuple[float, float] = (0.0, 0.0)
    dbh_m: float = 0.30               # diameter at 1.3 m ALONG the axis
    taper_m_per_m: float = 0.01       # diameter lost per meter along the axis
    lean_deg: float = 0.0
    lean_azimuth_deg: float = 0.0     # clockwise from +y
    stem_length_m: float = 8.0        # along the axis
    crown_base_m: float = 5.0         # height above ground of the crown shell's bottom
    height_m: float = 12.0            # top of the crown above ground
    crown_radius_m: Tuple[float, float] = (2.0, 2.0)  # semi-axes along x, y
    crown_offset_xy: Tuple[float, float] = (0.0, 0.0)
    slope: Tuple[float, float] = (0.0, 0.0)           # terrain dz/dx, dz/dy
    ground_z0: float = 100.0
    arc_deg: float = 360.0            # visible stem arc (facing -y)
    noise_m: float = 0.0
    stem_density: float = 4000.0      # points per m^2 of bark
    crown_points: int = 4000
    low_branch_m: Optional[float] = None  # an isolated branch this high
    seed: int = 1

    def ground(self, x, y):
        return self.ground_z0 + self.slope[0] * x + self.slope[1] * y

    def axis(self) -> np.ndarray:
        lr, az = math.radians(self.lean_deg), math.radians(self.lean_azimuth_deg)
        return np.array([math.sin(lr) * math.sin(az), math.sin(lr) * math.cos(az), math.cos(lr)])

    def base(self) -> np.ndarray:
        x, y = self.base_xy
        return np.array([x, y, self.ground(x, y)])

    def diameter_at(self, s: float) -> float:
        return self.dbh_m - self.taper_m_per_m * (s - 1.3)

    def sample(self) -> Tuple[np.ndarray, np.ndarray]:
        """(points (N,3), height_above_ground (N,))."""
        rng = np.random.default_rng(self.seed)
        a = self.axis()
        helper = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 1.0, 0])
        u = np.cross(a, helper); u /= np.linalg.norm(u)
        v = np.cross(a, u)
        base = self.base()
        parts = []
        # Stem: sample the (tapered) cylinder, s from -0.3 (buried) to its length.
        n_stem = int(self.stem_density * math.pi * self.dbh_m * self.stem_length_m)
        s = rng.uniform(-0.3, self.stem_length_m, n_stem)
        half = math.radians(self.arc_deg) / 2
        th = rng.uniform(-half, half, n_stem) - math.pi / 2  # centered on facing -y
        r = np.maximum(0.01, np.array([self.diameter_at(x) for x in s]) / 2)
        r = r + rng.normal(0, self.noise_m, n_stem) if self.noise_m > 0 else r
        # Express the angle in world x/y so "facing -y" means a real direction.
        cu, cv = np.cos(th), np.sin(th)
        # Rotate (u, v) into (x-ish, y-ish): use world-projected directions.
        ex = np.array([1.0, 0, 0]) - a * a[0]; ex /= np.linalg.norm(ex)
        ey = np.cross(a, ex)
        stem = base + np.outer(s, a) + (r * cu)[:, None] * ex + (r * cv)[:, None] * ey
        parts.append(stem)
        # Crown: an ellipsoid shell from crown_base to height, around the axis
        # top plus the offset.
        n_c = self.crown_points
        top_c = base + a * self.stem_length_m
        cz0 = self.ground(*self.base_xy) + self.crown_base_m
        cz1 = self.ground(*self.base_xy) + self.height_m
        czc, czr = (cz0 + cz1) / 2, (cz1 - cz0) / 2
        cxc = top_c[0] + self.crown_offset_xy[0]
        cyc = top_c[1] + self.crown_offset_xy[1]
        dirs = rng.normal(size=(n_c, 3))
        dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        shell = np.column_stack([
            cxc + self.crown_radius_m[0] * dirs[:, 0],
            cyc + self.crown_radius_m[1] * dirs[:, 1],
            czc + czr * dirs[:, 2],
        ])
        # The very top point is placed exactly, so height is exact.
        shell[np.argmax(shell[:, 2]), 2] = cz1
        parts.append(shell)
        if self.low_branch_m is not None:
            zb = self.ground(*self.base_xy) + self.low_branch_m
            br = np.column_stack([
                np.linspace(base[0] + 0.3, base[0] + 1.5, 150),
                np.full(150, base[1]),
                np.full(150, zb),
            ])
            parts.append(br)
        pts = np.vstack(parts)
        # Drop anything below ground (the buried stem stub).
        g = self.ground(pts[:, 0], pts[:, 1])
        keep = pts[:, 2] >= g - 1e-9
        pts = pts[keep]
        return pts, pts[:, 2] - self.ground(pts[:, 0], pts[:, 1])
