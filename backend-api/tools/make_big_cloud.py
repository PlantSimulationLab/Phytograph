#!/usr/bin/env python3
"""Generate a large synthetic LAS/LAZ point cloud for scaling benchmarks.

Nothing in `example-datasets/` is near 100 M points (the largest single file is
~25 M cells), and the large-cloud work needs inputs at 30 M, 100 M and beyond
that are cheap to make and identical from one run to the next. This writes one
in CHUNKS (never holding the whole cloud in RAM - the generator must not be
the thing that OOMs), shaped like a terrestrial scan rather than a uniform
cube, because the pathologies the plan targets come from real density
structure:

  * a terrestrial scanner samples in ANGLE, so areal density falls as 1/r^2 -
    the near field decides everything sampled by stride (see the registration
    notes in CLAUDE.md);
  * a flat ground plane with mm-scale noise plus tree crowns as ellipsoidal
    clusters, so ground segmentation, DEM and tree segmentation all have
    something to find;
  * optional sky/miss returns projected ~1 km out (`--misses`), the extent
    poison every compute tool must exclude;
  * intensity, RGB, gps_time and a `target_index`/`target_count` pair so the
    session carries the attribute set a RIEGL import would.

Usage:
    venv/bin/python tools/make_big_cloud.py --points 100000000 --out /tmp/big100m.laz
    venv/bin/python tools/make_big_cloud.py --points 30e6 --extent 120 --misses 0.2 --out big.las

`--format` follows the output extension (.las or .laz). Deterministic for a
given --seed. Throughput is ~5-10 M points/s for LAS, ~1-2 M/s for LAZ.
"""
from __future__ import annotations

import argparse
import math
import sys
import time
from pathlib import Path

import numpy as np

CHUNK = 2_000_000
MISS_RANGE_M = 1001.0     # Helios's LIDAR_RAYTRACE_MISS_T
SCANNER_HEIGHT_M = 1.6


def _parse_points(text: str) -> int:
    return int(float(text.replace("_", "")))


def _tree_centres(rng: np.random.Generator, extent: float, n_trees: int) -> np.ndarray:
    """Orchard-like grid of trees with a little jitter."""
    per_side = max(1, int(round(math.sqrt(n_trees))))
    xs = np.linspace(extent * 0.1, extent * 0.9, per_side)
    ys = np.linspace(extent * 0.1, extent * 0.9, per_side)
    gx, gy = np.meshgrid(xs, ys)
    centres = np.column_stack([gx.ravel(), gy.ravel()])
    centres += rng.normal(0, extent * 0.01, size=centres.shape)
    return centres[:n_trees]


def _sample_ranges(rng: np.random.Generator, n: int, r_min: float, r_max: float) -> np.ndarray:
    """Ranges whose AREAL density falls as 1/r^2: uniform in log r gives
    dN/dr ~ 1/r, and the annulus area grows as r, so density ~ 1/r^2."""
    u = rng.random(n)
    return r_min * (r_max / r_min) ** u


def generate_chunk(rng: np.random.Generator, n: int, extent: float, centres: np.ndarray,
                   ground_fraction: float, miss_fraction: float, scanner: np.ndarray):
    """One chunk of points with attributes. Returns a dict of column arrays."""
    n_miss = int(round(n * miss_fraction))
    n_hit = n - n_miss
    n_ground = int(round(n_hit * ground_fraction))
    n_veg = n_hit - n_ground

    # Ground: ranges from the scanner with 1/r^2 areal density, random azimuth,
    # clipped to the extent; z = gentle undulation + mm noise.
    r = _sample_ranges(rng, n_ground, 0.5, extent * 0.75)
    az = rng.uniform(0, 2 * math.pi, n_ground)
    gx = np.clip(scanner[0] + r * np.cos(az), 0, extent)
    gy = np.clip(scanner[1] + r * np.sin(az), 0, extent)
    gz = (0.15 * np.sin(gx / (extent / 6.0)) * np.cos(gy / (extent / 8.0))
          + rng.normal(0, 0.004, n_ground))
    ground = np.column_stack([gx, gy, gz])

    # Vegetation: pick a tree per point, sample an ellipsoidal crown, weight the
    # tree choice by proximity to the scanner (nearer trees get more returns).
    d = np.linalg.norm(centres - scanner[:2], axis=1)
    w = 1.0 / np.maximum(d, 1.0) ** 2
    w /= w.sum()
    which = rng.choice(len(centres), size=n_veg, p=w)
    crown_r = 1.6
    crown_h = 3.2
    # Rejection-free ellipsoid sampling: direction on a sphere, radius ~ cbrt(u).
    v = rng.normal(size=(n_veg, 3))
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    rad = np.cbrt(rng.random(n_veg))
    vx = centres[which, 0] + v[:, 0] * rad * crown_r
    vy = centres[which, 1] + v[:, 1] * rad * crown_r
    vz = 1.2 + crown_h / 2 + v[:, 2] * rad * crown_h / 2
    # Trunk points for a fraction of the vegetation.
    trunk = rng.random(n_veg) < 0.08
    vx[trunk] = centres[which[trunk], 0] + rng.normal(0, 0.06, trunk.sum())
    vy[trunk] = centres[which[trunk], 1] + rng.normal(0, 0.06, trunk.sum())
    vz[trunk] = rng.uniform(0.0, 1.4, trunk.sum())
    veg = np.column_stack([vx, vy, vz])

    xyz = np.vstack([ground, veg])
    is_ground = np.zeros(n_hit, dtype=np.uint8)
    is_ground[:n_ground] = 1

    if n_miss:
        # Sky returns: rays above the horizon projected out to the miss range.
        el = rng.uniform(0.15, 1.2, n_miss)
        maz = rng.uniform(0, 2 * math.pi, n_miss)
        mx = scanner[0] + MISS_RANGE_M * np.cos(el) * np.cos(maz)
        my = scanner[1] + MISS_RANGE_M * np.cos(el) * np.sin(maz)
        mz = scanner[2] + MISS_RANGE_M * np.sin(el)
        xyz = np.vstack([xyz, np.column_stack([mx, my, mz])])
        is_ground = np.concatenate([is_ground, np.zeros(n_miss, dtype=np.uint8)])
    is_miss = np.zeros(n, dtype=np.uint8)
    is_miss[n_hit:] = 1

    perm = rng.permutation(n)
    xyz = xyz[perm]
    is_ground = is_ground[perm]
    is_miss = is_miss[perm]

    dist = np.linalg.norm(xyz - scanner, axis=1)
    intensity = np.clip(60000.0 / np.maximum(dist, 0.5) ** 1.2 * rng.uniform(0.6, 1.0, n), 0, 65535)
    intensity[is_miss == 1] = 0
    green = np.where(is_ground == 1, 90, 160).astype(np.uint16) * 257
    red = np.where(is_ground == 1, 120, 60).astype(np.uint16) * 257
    blue = np.where(is_ground == 1, 70, 40).astype(np.uint16) * 257
    return {
        "xyz": xyz,
        "intensity": intensity.astype(np.uint16),
        "red": red, "green": green, "blue": blue,
        "is_miss": is_miss,
        "ground_truth": is_ground,
    }


def write_cloud(out: Path, n_points: int, *, extent: float = 60.0, n_trees: int = 36,
                ground_fraction: float = 0.45, miss_fraction: float = 0.0,
                seed: int = 0, chunk: int = CHUNK, quiet: bool = False) -> int:
    import laspy

    rng = np.random.default_rng(seed)
    centres = _tree_centres(rng, extent, n_trees)
    scanner = np.array([extent / 2.0, extent / 2.0, SCANNER_HEIGHT_M])

    hdr = laspy.LasHeader(point_format=3, version="1.4")
    hdr.scales = np.array([0.001, 0.001, 0.001])
    hdr.offsets = np.array([0.0, 0.0, 0.0])
    hdr.add_extra_dim(laspy.ExtraBytesParams(name="is_miss", type=np.uint8))
    hdr.add_extra_dim(laspy.ExtraBytesParams(name="ground_truth", type=np.uint8))
    hdr.add_extra_dim(laspy.ExtraBytesParams(name="target_index", type=np.uint8))
    hdr.add_extra_dim(laspy.ExtraBytesParams(name="target_count", type=np.uint8))

    written = 0
    t0 = time.perf_counter()
    gps = 0.0
    with laspy.open(str(out), mode="w", header=hdr) as w:
        while written < n_points:
            n = min(chunk, n_points - written)
            cols = generate_chunk(rng, n, extent, centres, ground_fraction, miss_fraction, scanner)
            rec = laspy.ScaleAwarePointRecord.zeros(n, header=hdr)
            rec.x = cols["xyz"][:, 0]
            rec.y = cols["xyz"][:, 1]
            rec.z = cols["xyz"][:, 2]
            rec.intensity = cols["intensity"]
            rec.red = cols["red"]
            rec.green = cols["green"]
            rec.blue = cols["blue"]
            rec.gps_time = gps + np.arange(n, dtype=np.float64) * 1e-6
            gps += n * 1e-6
            rec.is_miss = cols["is_miss"]
            rec.ground_truth = cols["ground_truth"]
            rec.target_index = np.ones(n, dtype=np.uint8)
            rec.target_count = np.ones(n, dtype=np.uint8)
            w.write_points(rec)
            written += n
            if not quiet:
                rate = written / max(1e-9, time.perf_counter() - t0)
                print(f"\r  {written:,}/{n_points:,} points ({rate / 1e6:.1f} M/s)", end="", flush=True)
    if not quiet:
        print(f"\nwrote {written:,} points to {out} in {time.perf_counter() - t0:.1f}s", flush=True)
    return written


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--points", type=_parse_points, default=10_000_000)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--extent", type=float, default=60.0, help="XY extent in metres")
    ap.add_argument("--trees", type=int, default=36)
    ap.add_argument("--ground", type=float, default=0.45, help="fraction of hits on the ground")
    ap.add_argument("--misses", type=float, default=0.0, help="fraction of points that are sky/miss")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    write_cloud(args.out, args.points, extent=args.extent, n_trees=args.trees,
                ground_fraction=args.ground, miss_fraction=args.misses, seed=args.seed,
                quiet=args.quiet)
    return 0


if __name__ == "__main__":
    sys.exit(main())
