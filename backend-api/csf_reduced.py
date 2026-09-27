"""Cloth Simulation Filter on the few points the cloth can see.

CSF (Zhang et al. 2016; the Apache-2.0 `cloth-simulation-filter` package)
settles an inverted cloth onto a cloud and labels a point ground when it lies
within `class_threshold` of the settled cloth. Read in the package source, the
cloth depends on the input points through exactly two things:

  * the cloud's bounding box, which fixes the cloth grid's origin and size
    (`CSF::do_cloth`); and
  * for each cloth particle, the height of ONE point: the first, in input
    order, at the smallest squared XY distance from that particle, over the
    points whose rounded grid cell is that particle (`RasterTerrian`). Slope
    smoothing (`movableFilter`) reads those same per-particle heights, and the
    per-particle point lists it fills are never read.

Every other point matters only to the final labelling (`c2cdist`), which
interpolates the settled cloth bilinearly at each point. So the cloth that
all N points produce is the cloth that at most one point per particle (plus
the six bounding-box extremes) produces. At a 0.5 m cloth a 45.7 M-point
terrestrial scan has ~10^5 particles, so CSF runs on ~10^5 points instead of
all of them, and its working set (~60 B per point, twice over) stops scaling
with the scan. The labelling is then done here, in chunks, with `c2cdist`'s
own arithmetic against the full-precision cloth (`do_cloth_export`).

Exactness. Which point a particle keeps is decided with CSF's arithmetic
(`int(delta / step + 0.5)`, `SQUARE_DIST`) reproduced in float64. A compiled
library may fuse a multiply-add and differ in the last bit, so every point
within a relative 1e-9 of its particle's minimum distance is kept, not just
the minimum; they keep their input order, so CSF's own first-wins tie-break
picks among them exactly as it would have among all N. The labelling
reproduces `c2cdist` operation for operation; a point can only disagree if
its height above the cloth is within rounding (~1e-15 m) of the threshold.
`tests/test_csf_reduced.py` checks label equality against plain CSF.
"""
from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from typing import Optional

import numpy as np

# Rows per pass over the cloud. Each pass holds a few float64 temporaries of
# this length, so the working set is bounded by it, not by the cloud.
CHUNK_ROWS = 2_000_000
# Relative slack on the per-particle minimum distance (see module docstring).
_TIE_RTOL = 1e-9
_CLOTH_BUFFER = 2          # clothbuffer_d in CSF::do_cloth


@dataclass
class ClothGrid:
    """The cloth grid CSF builds for a cloud (CSF's x/z plane is our x/y)."""
    origin_x: float
    origin_y: float
    step: float
    width: int             # particles along x
    height: int            # particles along y

    @classmethod
    def from_bbox(cls, lo, hi, cloth_resolution: float) -> "ClothGrid":
        res = float(cloth_resolution)
        return cls(
            origin_x=lo[0] - _CLOTH_BUFFER * res,
            origin_y=lo[1] - _CLOTH_BUFFER * res,
            step=res,
            width=int(np.floor((hi[0] - lo[0]) / res)) + 2 * _CLOTH_BUFFER,
            height=int(np.floor((hi[1] - lo[1]) / res)) + 2 * _CLOTH_BUFFER,
        )

    @classmethod
    def for_points(cls, points: np.ndarray, cloth_resolution: float) -> "ClothGrid":
        lo, hi, _ = bbox_and_extremes(points)
        return cls.from_bbox(lo, hi, cloth_resolution)


def bbox_and_extremes(points: np.ndarray):
    """(lo, hi, rows): the bounding box and the first row holding each
    coordinate's minimum and maximum, in one pass. CSF's own box always finds
    the true extremes, so handing it these six rows reproduces its grid."""
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    lo_row = np.zeros(3, dtype=np.int64)
    hi_row = np.zeros(3, dtype=np.int64)
    for a in range(0, len(points), CHUNK_ROWS):
        c = np.asarray(points[a:a + CHUNK_ROWS, :3], dtype=np.float64)
        imin, imax = c.argmin(axis=0), c.argmax(axis=0)
        for d in range(3):
            v = c[imin[d], d]
            if v < lo[d]:
                lo[d], lo_row[d] = v, a + imin[d]
            v = c[imax[d], d]
            if v > hi[d]:
                hi[d], hi_row[d] = v, a + imax[d]
    return lo, hi, np.unique(np.concatenate([lo_row, hi_row]))


def _particle_and_distance(c: np.ndarray, g: ClothGrid):
    """RasterTerrian's particle (1-D index) and squared distance per point."""
    dx = c[:, 0] - g.origin_x
    dy = c[:, 1] - g.origin_y
    col = (dx / g.step + 0.5).astype(np.int64)      # C++ int(): truncation
    row = (dy / g.step + 0.5).astype(np.int64)
    px = g.origin_x + col * g.step
    py = g.origin_y + row * g.step
    dist = (c[:, 0] - px) * (c[:, 0] - px) + (c[:, 1] - py) * (c[:, 1] - py)
    return row * g.width + col, dist


def _near(d: np.ndarray, m: np.ndarray) -> np.ndarray:
    return d <= m + np.abs(m) * _TIE_RTOL


def representative_indices(points: np.ndarray, grid: ClothGrid,
                           extremes: "Optional[np.ndarray]" = None) -> np.ndarray:
    """Sorted row indices of the points CSF's cloth can depend on.

    One pass: each chunk's points that are near the RUNNING per-particle
    minimum are kept as candidates (the minimum only falls, so the final
    choice is always among them), then the candidates are filtered against
    the final minimum."""
    dmin = np.full(grid.width * grid.height, np.inf)
    rows, parts, dists = [], [], []
    for a in range(0, len(points), CHUNK_ROWS):
        c = np.asarray(points[a:a + CHUNK_ROWS, :3], dtype=np.float64)
        p, d = _particle_and_distance(c, grid)
        np.minimum.at(dmin, p, d)
        k = np.flatnonzero(_near(d, dmin[p]))
        rows.append(a + k)
        parts.append(p[k])
        dists.append(d[k])
    rows, parts, dists = (np.concatenate(x) for x in (rows, parts, dists))
    keep = rows[_near(dists, dmin[parts])]
    if extremes is None:
        extremes = bbox_and_extremes(points)[2]
    return np.unique(np.concatenate([keep, extremes]))


def settle_cloth(points: np.ndarray, *, cloth_resolution: float, rigidness: int,
                 time_step: float, iterations: int, slope_smooth: bool,
                 class_threshold: float) -> "tuple[ClothGrid, np.ndarray, np.ndarray]":
    """Run CSF on the representative points. Returns (grid, cloth, reps):
    `cloth` is the settled cloth as CSF holds it internally, a (height, width)
    array of particle y (CSF's inverted up axis, i.e. minus the elevation),
    and `reps` the rows CSF was given."""
    import CSF

    lo, hi, extremes = bbox_and_extremes(points)
    grid = ClothGrid.from_bbox(lo, hi, cloth_resolution)
    reps = representative_indices(points, grid, extremes)
    sub = np.ascontiguousarray(np.asarray(points[reps, :3], dtype=np.float64))

    csf = CSF.CSF()
    csf.params.bSloopSmooth = bool(slope_smooth)
    csf.params.cloth_resolution = float(cloth_resolution)
    csf.params.rigidness = int(rigidness)
    csf.params.class_threshold = float(class_threshold)
    csf.params.time_step = float(time_step)
    csf.params.interations = int(iterations)       # sic: the CSF API spelling
    csf.setPointCloud(sub)
    # do_cloth_export never writes cloth_nodes.txt, but run from a temp dir
    # anyway in case a future CSF does, as segment_ground does for do_filtering.
    prev = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            os.chdir(tmp)
            flat = np.asarray(csf.do_cloth_export(), dtype=np.float64)
        finally:
            os.chdir(prev)
    nodes = flat.reshape(-1, 3)                    # (x, y, elevation) per particle
    if len(nodes) != grid.width * grid.height:
        raise RuntimeError(
            f"CSF built {len(nodes)} particles, expected {grid.width} x {grid.height}")
    # toVector writes -pos.y; negating back is exact.
    cloth = (-nodes[:, 2]).reshape(grid.height, grid.width)
    return grid, cloth, reps


def cloth_nodes(grid: ClothGrid, cloth: np.ndarray) -> np.ndarray:
    """(M, 3) x / y / elevation table, the layout of CSF's `cloth_nodes.txt`."""
    cols = np.arange(grid.width)
    rows = np.arange(grid.height)
    x = np.broadcast_to(grid.origin_x + cols * grid.step, (grid.height, grid.width))
    y = np.broadcast_to((grid.origin_y + rows * grid.step)[:, None], (grid.height, grid.width))
    return np.column_stack([x.ravel(), y.ravel(), -cloth.ravel()])


def ground_mask(points: np.ndarray, grid: ClothGrid, cloth: np.ndarray,
                class_threshold: float) -> np.ndarray:
    """`c2cdist::calCloud2CloudDist` over every point, in chunks: True where
    the point is within `class_threshold` of the cloth."""
    out = np.empty(len(points), dtype=bool)
    flat = cloth.ravel()
    w = grid.width
    for a in range(0, len(points), CHUNK_ROWS):
        c = np.asarray(points[a:a + CHUNK_ROWS, :3], dtype=np.float64)
        dx = c[:, 0] - grid.origin_x
        dz = c[:, 1] - grid.origin_y
        col0 = (dx / grid.step).astype(np.int64)
        row0 = (dz / grid.step).astype(np.int64)
        sx = (dx - col0 * grid.step) / grid.step
        sz = (dz - row0 * grid.step) / grid.step
        # CSF indexes particles[row * width + col] without bounds checks. A
        # point on the cloud's far x edge can land on col0 + 1 == width, which
        # reads the NEXT row's first particle: the same flat index here
        # reproduces that. On the last row it reads past the array (undefined
        # in CSF), so the index is clamped to the last particle.
        last = len(flat) - 1
        p0 = flat[np.minimum(row0 * w + col0, last)]               # (col0, row0)
        p3 = flat[np.minimum((row0 + 1) * w + col0, last)]         # (col0, row0 + 1)
        p2 = flat[np.minimum((row0 + 1) * w + col0 + 1, last)]     # (col0 + 1, row0 + 1)
        p1 = flat[np.minimum(row0 * w + col0 + 1, last)]           # (col0 + 1, row0)
        fxy = (p0 * (1 - sx) * (1 - sz) + p3 * (1 - sx) * sz
               + p2 * sx * sz + p1 * sx * (1 - sz))
        height_var = fxy - (-c[:, 2])            # pc.y is minus the elevation
        out[a:a + len(c)] = np.abs(height_var) < class_threshold
    return out


def segment(points: np.ndarray, *, cloth_resolution: float, rigidness: int,
            class_threshold: float, iterations: int, slope_smooth: bool,
            time_step: float) -> "tuple[np.ndarray, ClothGrid, np.ndarray, int]":
    """CSF's ground mask for every point, from a cloth settled on the
    representative points. Returns (ground mask, grid, cloth, n_representative)."""
    grid, cloth, reps = settle_cloth(
        points, cloth_resolution=cloth_resolution, rigidness=rigidness,
        time_step=time_step, iterations=iterations, slope_smooth=slope_smooth,
        class_threshold=class_threshold)
    return ground_mask(points, grid, cloth, class_threshold), grid, cloth, int(len(reps))
