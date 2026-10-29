"""Box-counting fractal dimension of a finished QSM.

The box-counting (Minkowski-Bouligand) dimension ``D_b`` is the slope of
``log N(s)`` against ``log(1/s)``, where ``N(s)`` is the number of cubes of edge
``s`` that the woody surface touches. A straight stick reads 1, a surface that
fills a plane reads 2; a tree sits between, higher for crowns that branch more
densely and more self-similarly. This is the "box dimension" used for TLS trees
by Seidel (2018, Ecol. Indic.) and Seidel et al. (2019), computed here from the
model's cylinder surfaces instead of from the raw points, so it describes the
reconstructed architecture and is unaffected by scan density or occlusion
holes the QSM has already filled in.

Scale range
-----------
Counting is meaningful only between two physical scales:

- **Largest box** = the tree's largest bounding-box edge. Above it ``N`` is 1.
- **Smallest box** = the length-weighted median cylinder diameter (floored at
  ``extent / 2**MAX_HALVINGS``). Below the typical branch diameter a box sees
  the smooth surface of one cylinder, which counts as 2 whatever the tree's
  architecture, so smaller boxes would only drag ``D`` toward 2.

Sizes are halved between those bounds, so each scale is an octave.

Fit quality
-----------
Two numbers say how well a single power law describes the counts:

- ``r_squared`` of the log-log regression -- the figure the literature reports.
  It is always high (``N`` is monotone in ``s``), so read 0.99 as ordinary and
  anything much below 0.98 as a poor fit.
- the min/max **local slope** between successive octaves. A true fractal has the
  same slope at every scale; a wide spread means the dimension depends on which
  scales you look at (typically ~1 at the coarse end where the trunk dominates,
  steeper inside the crown), and the single ``D`` is an average over regimes.

Grid placement biases box counting, so each scale takes the minimum count over
a few fixed grid offsets (the standard correction; deterministic, no RNG).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .model import QSM

# Finest box = extent / 2**MAX_HALVINGS at most: 8 octaves keeps the surface
# sample to ~1e5-1e6 points for a whole tree.
MAX_HALVINGS = 8
# Fewer octaves than this and a slope is not worth reporting.
MIN_SCALES = 4
# Surface samples per box edge at the finest scale; >2 so a box the surface
# crosses cannot be skipped between two samples.
SAMPLES_PER_BOX = 3.0
# Hard cap on surface samples; the finest box is coarsened to stay under it.
MAX_SAMPLES = 3_000_000
# Grid offsets (fractions of the box edge, per axis) tried at each scale.
_OFFSETS = np.array([
    [0.0, 0.0, 0.0],
    [0.5, 0.5, 0.5],
    [0.25, 0.75, 0.5],
    [0.75, 0.25, 0.25],
])


@dataclass
class FractalMetrics:
    """Box-counting dimension of the woody surface and its fit diagnostics."""

    dimension: float  # D_b, the log-log slope
    r_squared: float  # coefficient of determination of that fit
    local_slope_min: float  # smallest slope between successive octaves
    local_slope_max: float  # largest slope between successive octaves
    box_sizes_m: list[float] = field(default_factory=list)  # largest -> smallest
    box_counts: list[int] = field(default_factory=list)  # N(s) per box size


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    order = np.argsort(values)
    cum = np.cumsum(weights[order])
    return float(values[order][np.searchsorted(cum, 0.5 * cum[-1])])


def _sample_surface(starts, ends, radii, spacing: float) -> np.ndarray:
    """Points on every cylinder's lateral surface, roughly ``spacing`` apart.
    A twig thinner than ``spacing`` gets 3 points per ring, i.e. effectively
    its axis, which is what a box that size sees anyway."""
    chunks = []
    for p0, p1, r in zip(starts, ends, radii):
        v = p1 - p0
        length = float(np.linalg.norm(v))
        if length <= 0.0:
            continue
        axis = v / length
        # Any unit vector not parallel to the axis seeds the ring basis.
        seed = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        u = np.cross(axis, seed)
        u /= np.linalg.norm(u)
        w = np.cross(axis, u)
        n_ax = int(np.ceil(length / spacing)) + 1
        n_ring = max(3, int(np.ceil(2.0 * np.pi * r / spacing)))
        t = np.linspace(0.0, length, n_ax)
        th = np.linspace(0.0, 2.0 * np.pi, n_ring, endpoint=False)
        ring = r * (np.cos(th)[:, None] * u + np.sin(th)[:, None] * w)  # (n_ring, 3)
        pts = p0 + t[:, None, None] * axis + ring[None, :, :]
        chunks.append(pts.reshape(-1, 3))
    return np.vstack(chunks) if chunks else np.empty((0, 3))


def _count_boxes(pts: np.ndarray, origin: np.ndarray, s: float) -> int:
    """Occupied boxes of edge ``s``, minimized over the fixed grid offsets."""
    best = None
    for off in _OFFSETS:
        idx = np.floor((pts - origin) / s + off).astype(np.int64)
        idx -= idx.min(axis=0)
        span = idx.max(axis=0) + 1
        keys = (idx[:, 0] * span[1] + idx[:, 1]) * span[2] + idx[:, 2]
        n = int(np.unique(keys).size)
        best = n if best is None else min(best, n)
    return best


def compute_fractal_dimension(qsm: QSM) -> FractalMetrics | None:
    """Box-counting dimension of the QSM's cylinder surfaces, or None when the
    model is empty or spans fewer than ``MIN_SCALES`` octaves (e.g. a trunk-only
    model whose median diameter is comparable to its extent)."""
    cyls = [c for c in qsm.cylinders if c.length > 0.0 and c.radius >= 0.0]
    if not cyls:
        return None
    starts = np.array([c.start for c in cyls])
    ends = np.array([c.end for c in cyls])
    radii = np.array([c.radius for c in cyls])
    lengths = np.linalg.norm(ends - starts, axis=1)

    lo = np.minimum(starts, ends).min(axis=0) - radii.max()
    hi = np.maximum(starts, ends).max(axis=0) + radii.max()
    extent = float((hi - lo).max())
    if extent <= 0.0:
        return None

    s_floor = max(_weighted_median(2.0 * radii, lengths), extent / 2.0 ** MAX_HALVINGS)
    # Stay under the sample cap: samples ~ lateral area / spacing^2.
    area = float(np.sum(2.0 * np.pi * np.maximum(radii, 1e-6) * lengths))
    s_floor = max(s_floor, SAMPLES_PER_BOX * np.sqrt(area / MAX_SAMPLES))

    # Slightly larger than the extent so the largest box holds the whole tree.
    s0 = extent * (1.0 + 1e-6)
    n_scales = int(np.floor(np.log2(s0 / s_floor))) + 1
    if n_scales < MIN_SCALES:
        return None
    sizes = s0 / 2.0 ** np.arange(n_scales)

    pts = _sample_surface(starts, ends, radii, sizes[-1] / SAMPLES_PER_BOX)
    counts = np.array([_count_boxes(pts, lo, s) for s in sizes])

    x = np.log(1.0 / sizes)
    y = np.log(counts.astype(np.float64))
    slope, intercept = np.polyfit(x, y, 1)
    ss_res = float(np.sum((y - (slope * x + intercept)) ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    local = np.diff(y) / np.diff(x)

    return FractalMetrics(
        dimension=float(slope),
        r_squared=float(r2),
        local_slope_min=float(local.min()),
        local_slope_max=float(local.max()),
        box_sizes_m=[float(s) for s in sizes],
        box_counts=[int(n) for n in counts],
    )
