"""How every LAS/LAZ the backend writes quantizes coordinates and scalar columns.

LAS stores a coordinate as a 32-bit integer ``round((x - offset) / scale)``, so
the header's scale IS the precision of the file. The backend used to hard-code
``scales = [0.001] * 3`` in a dozen writers. That is a 1 mm grid, and it was
fine for terrestrial scans of trees, so nobody noticed it was a decision: a
handheld scan of a cucumber plant with 0.5 mm point spacing came out of export
snapped to a grid as coarse as the points themselves (max error 0.5 mm), while
the in-RAM session held it to nanometers. The constant kept resurfacing because
each new writer copied it from the last one. This module is the one place the
choice is made; ``tests/test_las_precision.py`` fails if a writer hard-codes a
scale again.

The choice, per axis (:func:`las_scale_offset`):

* **Keep a grid the data is already on.** Points read from a LAS file sit on
  that file's grid (``k * scale + offset``). If a sample of the points is exact
  on one of the common LAS quanta, that quantum is used, with an offset ON the
  grid, so a 1 mm LAS re-exports bit-for-bit and its LAZ does not grow.
* **Otherwise, 10 µm** (:data:`FINEST_SCALE`, in the cloud's units, which are
  meters after import). Float sources (PLY, XYZ, E57, PTX, simulation) and any
  cloud that has been rotated are on no grid; 10 µm is far below any scanner's
  noise and well below the spacing of the densest clouds we see (~0.5 mm).
* **Never overflow.** ``(x - offset) / scale`` must fit an int32, so a scale is
  coarsened (to the next 1-2-5 step) when the cloud's extent needs it: 10 µm
  holds a ~21 km extent; a larger one gets 20 µm, 50 µm, ... The bound uses the
  LARGEST axis extent for every axis, because PotreeConverter fits the cloud in
  a cube whose side is that extent.

Scalar columns (:func:`extra_dim_dtype`, :func:`column_dtype_for_reading`):
an integer column is written and read back as the type it was declared with in
the source file when we know it, else ``int32`` (``int64`` if it does not
fit), and a float64 column stays float64. Writing everything as float32 turned class labels into decimals and
silently corrupted integers above 2**24.
"""
from __future__ import annotations

from typing import Iterable, Optional, Sequence, Tuple

import numpy as np

# 10 µm in the cloud's units (meters after import normalization).
FINEST_SCALE = 1e-5

# Grids a LAS file is commonly written on, coarsest first, so the first one the
# data is exactly on is the one that loses nothing and costs the fewest bits.
COMMON_LAS_SCALES: Tuple[float, ...] = (
    0.01, 0.005, 0.0025, 0.001, 0.0005, 0.00025, 0.0001,
    0.00005, 0.000025, 0.00001,
    # A 0.001-scale LAS in millimeters, converted to meters at import.
    0.000005, 0.0000025, 0.000001,
)

# Headroom below the int32 limit for the offset rounding and a pad on the
# bounding box.
_INT_LIMIT = float(2 ** 31 - 1) * 0.999

# Points sampled for the grid test; spread evenly over the cloud.
_GRID_SAMPLE = 20_000
# A coordinate is "on" the grid when it is within this fraction of a quantum of
# a grid line. Float64 coordinates read from a LAS are within ~1e-9 of their
# grid line (more after a world-shift round trip, still << 1e-3 quanta); a cloud
# on no grid passes a 20 000-point test by chance with probability ~0.
_GRID_TOL = 1e-3


def _step_up(x: float) -> float:
    """The smallest value of the 1-2-5 series (… 1e-5, 2e-5, 5e-5, 1e-4 …)
    that is >= x."""
    if x <= 0:
        return FINEST_SCALE
    e = np.floor(np.log10(x))
    for m in (1.0, 2.0, 5.0, 10.0):
        v = m * 10.0 ** e
        if v >= x * (1 - 1e-12):
            return float(v)
    return float(10.0 ** (e + 1))


def min_scale_for_extent(extent: float) -> float:
    """The finest scale at which an axis spanning ``extent`` still fits an
    int32 (0 extent → no constraint)."""
    if not np.isfinite(extent) or extent <= 0:
        return 0.0
    return extent / _INT_LIMIT


def _sample(positions: np.ndarray) -> np.ndarray:
    n = int(positions.shape[0])
    if n <= _GRID_SAMPLE:
        return np.asarray(positions[:, :3], dtype=np.float64)
    idx = np.linspace(0, n - 1, _GRID_SAMPLE).astype(np.int64)
    return np.asarray(positions[idx, :3], dtype=np.float64)


def detect_grid(values: np.ndarray, candidates: Iterable[float] = COMMON_LAS_SCALES
                ) -> Optional[Tuple[float, float]]:
    """``(scale, anchor)`` for the coarsest candidate grid every value is on
    (``value = anchor + k * scale``), or None. ``anchor`` is one of the values."""
    v = np.asarray(values, dtype=np.float64)
    v = v[np.isfinite(v)]
    if v.size < 2:
        return None
    anchor = float(v[0])
    d = v - anchor
    if not np.any(d):
        return None  # a flat axis says nothing about a grid
    for s in candidates:
        q = d / s
        if np.all(np.abs(q - np.rint(q)) <= _GRID_TOL):
            return float(s), anchor
    return None


def las_scale_offset(lo: Sequence[float], hi: Sequence[float],
                     positions: Optional[np.ndarray] = None,
                     *, finest: float = FINEST_SCALE,
                     scale: Optional[float] = None) -> Tuple[np.ndarray, np.ndarray]:
    """``(scales, offsets)`` for a LAS header holding points within
    ``[lo, hi]`` (the coordinates as WRITTEN, i.e. world coordinates).

    ``positions`` — some or all of those points, in the same frame — lets a
    cloud already on a grid keep it. Pass None when they are not to hand (the
    scale is then ``finest``, coarsened only for extent). ``scale`` forces one
    quantum (a user's explicit choice), still coarsened if the extent cannot
    fit it."""
    lo = np.asarray(lo, dtype=np.float64).reshape(3)
    hi = np.asarray(hi, dtype=np.float64).reshape(3)
    finite = np.isfinite(lo) & np.isfinite(hi)
    lo = np.where(finite, lo, 0.0)
    hi = np.where(finite, np.maximum(hi, lo), lo)
    # Offsets on whole units keep the header readable; the extent is measured
    # from there, plus one unit of slack for the floor.
    base = np.floor(lo)
    span = float(np.max(hi - base)) + 1.0
    floor_scale = min_scale_for_extent(span)
    want = float(scale) if scale is not None else float(finest)
    if want <= 0 or not np.isfinite(want):
        raise ValueError(f"LAS scale must be a positive number, got {scale!r}")

    sample = _sample(positions) if positions is not None and len(positions) else None
    scales = np.empty(3, dtype=np.float64)
    offsets = np.empty(3, dtype=np.float64)
    for ax in range(3):
        s = want
        off = float(base[ax])
        if scale is None and sample is not None:
            grid = detect_grid(sample[:, ax])
            if grid is not None and grid[0] >= floor_scale:
                s, anchor = grid
                # The offset must lie ON the grid so every point's integer is
                # exact. The whole-unit floor usually does (a LAS file's own
                # offset is a round number), and then it is used as is, so the
                # re-exported values are bit-identical; otherwise the grid line
                # at or below the minimum.
                q = (anchor - off) / s
                if abs(q - np.rint(q)) > _GRID_TOL:
                    off = anchor - s * np.ceil((anchor - lo[ax]) / s - _GRID_TOL)
        if s < floor_scale:
            s = _step_up(floor_scale)
        scales[ax] = s
        offsets[ax] = off
    return scales, offsets


# ── scalar columns ──────────────────────────────────────────────────────────

def extra_dim_dtype(arr: np.ndarray, declared: Optional[str] = None) -> np.dtype:
    """The LAS extra-bytes type to write a scalar column as: the same type
    :func:`column_dtype_for_reading` hands it back in, so a file and a script
    agree, and two clouds with the same column get the same type (storage
    narrows per cloud; a file must not)."""
    return column_dtype_for_reading(arr, declared)


def _fits(a: np.ndarray, dt: np.dtype) -> bool:
    """Whether every value of ``a`` is representable in ``dt``. A float type
    accepts any numeric column (the source declared it float, so its values
    came from that type); an integer type needs integer storage in range."""
    if dt.kind == "f":
        return a.dtype.kind in "iufb"
    if dt.kind == "b":
        return a.dtype.kind in "iub" and (a.size == 0 or (int(np.min(a)) >= 0 and int(np.max(a)) <= 1))
    if a.dtype.kind not in "iub":
        return False
    if a.size == 0:
        return True
    info = np.iinfo(dt)
    return int(np.min(a)) >= info.min and int(np.max(a)) <= info.max


def column_dtype_for_reading(arr: np.ndarray, declared: Optional[str] = None) -> np.dtype:
    """The dtype a column is HANDED BACK in (``/arrays``, scripting
    ``to_numpy``): the type it was declared with in the source file when known,
    else ``int32`` for any integer storage (``int64`` if it would not fit) and
    float32/float64 as stored. Storage narrows integer columns per cloud to
    save memory (``rank`` is int8 in one file, uint8 in the next), which must
    not leak into what a caller sees."""
    if declared:
        try:
            dt = np.dtype(declared)
            if dt.kind in "iuf" and _fits(arr, dt):
                return dt
        except TypeError:
            pass
    kind = arr.dtype.kind
    if kind in "iub":
        return np.dtype(np.int32) if _fits(arr, np.dtype(np.int32)) else np.dtype(np.int64)
    if arr.dtype == np.float64:
        return np.dtype(np.float64)
    return np.dtype(np.float32)
