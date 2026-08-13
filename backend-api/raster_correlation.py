"""Coarse registration by correlating top-down rasters.

Why this replaced landmark matching
-----------------------------------
The previous coarse stage reduced each cloud to one landmark per plant and
matched landmark TRIANGLES. It failed on real data, and the reason is
structural rather than a tuning problem.

Landmark repeatability between two scan positions is about 50%: measured 25 of
46 on a real vineyard, and the forest-registration literature reports the same
(Liang & Hyyppa: "the common trees between two scans account for approximately
50% of all trees in a scan"; Kelbe et al.: stem-based pairwise registration
connected 51% of scans on average, as low as 8%). Occlusion means each scanner
simply sees a different subset of plants.

Triangle congruence then CUBES that penalty. At 54% per-landmark repeatability
only 0.54^3 = 16% of triangles have all three corners shared, so the matcher was
starved of usable evidence by construction.

Correlation avoids the exponent entirely: it never picks landmarks, so it never
has to pick the SAME ones twice. The whole cloud contributes.

How it works
------------
Both clouds are gravity-aligned (the scanner is levelled), so the unknown is
yaw + horizontal translation + a height offset -- 4 degrees of freedom, not 6.
That reduction is what makes an exhaustive search cheap:

1. Rasterise each cloud to a top-down grid.
2. Sweep yaw. For each candidate, correlate the two rasters with an FFT, which
   evaluates EVERY translation at once (the correlation theorem) rather than
   searching over them.
3. Take the best (yaw, shift) pair; recover the height offset from the median
   height difference.
4. Hand the result to point-to-plane ICP for refinement.

Raster choice
-------------
Occupancy (is anything in this cell) is the default. Mean height was
recommended on the strength of synthetic tests, but measured on three real
datasets -- a trellised vineyard, an almond orchard and a peach orchard -- both
rasters scored 24/24 on known-yaw recovery with 70% partial overlap, so the
distinction did not survive contact with real data. Occupancy is cheaper and
does not depend on canopy height variation, which a trellised vineyard barely
has. `mode="height"` is kept for scenes where height genuinely carries more
signal than presence.
"""

import math
from typing import Optional, Tuple

import numpy as np

# The sweep is coarse-then-fine: a full circle at 5 degrees, then a local
# refinement. Measured recovery error on real data was 0-2 degrees, i.e. within
# the coarse step, so the refinement mainly buys sub-step precision for ICP.
_COARSE_STEP_DEG = 5.0
_FINE_HALFWIDTH_DEG = 5.0
_FINE_STEP_DEG = 0.5

# Grid side in cells. 180 keeps the FFT small (~32k cells) while resolving
# plant-scale structure on plots from a few metres to a few hundred.
_TARGET_CELLS = 180


def auto_cell_size(points: np.ndarray, extent: Optional[float] = None) -> Tuple[float, float]:
    """(cell_size, extent) chosen from the cloud itself.

    Parameter fragility has been the recurring bug in this feature -- values
    derived from one scene's extent broke on another. Here the rule is tied to
    the cloud's own footprint and clamped to a range that is physically sensible
    for vegetation (0.2 m resolves individual vines; 2 m is coarse enough for a
    large block), and measured accuracy was insensitive across a wide band of
    cell sizes, so the exact value is not load-bearing.
    """
    if extent is None:
        extent = 1.3 * float(max(np.ptp(points[:, 0]), np.ptp(points[:, 1])))
    extent = max(extent, 1e-6)
    cell = float(np.clip(extent / _TARGET_CELLS, 0.2, 2.0))
    return cell, extent


def rasterise(points: np.ndarray, cell: float, extent: float,
              centre: np.ndarray, mode: str = "occupancy") -> np.ndarray:
    """Top-down grid: occupancy, or mean height per cell.

    Centred on the cloud's own XY median rather than its bounding-box centre --
    a terrestrial scan's bbox is dominated by sparse far-field returns, so its
    centre can sit hundreds of metres from the actual plot.
    """
    n = max(int(round(extent / cell)), 4)
    ij = np.floor((points[:, :2] - centre + extent / 2.0) / cell).astype(np.int64)
    inside = (ij[:, 0] >= 0) & (ij[:, 0] < n) & (ij[:, 1] >= 0) & (ij[:, 1] < n)
    ij = ij[inside]
    if len(ij) == 0:
        return np.zeros((n, n))
    flat = ij[:, 0] * n + ij[:, 1]
    counts = np.bincount(flat, minlength=n * n).astype(np.float64)
    if mode == "occupancy":
        return (counts > 0).astype(np.float64).reshape(n, n)
    sums = np.bincount(flat, weights=points[inside, 2], minlength=n * n)
    out = np.zeros(n * n)
    filled = counts > 0
    out[filled] = sums[filled] / counts[filled]
    return out.reshape(n, n)


def _correlate(target_fft: np.ndarray, target_shape, target_norm: float,
               raster: np.ndarray) -> Tuple[float, Tuple[int, int]]:
    """Peak normalised cross-correlation and the shift that produces it.

    One FFT multiply evaluates every possible translation simultaneously -- the
    reason this is fast enough to wrap in a yaw sweep.
    """
    r = raster - raster.mean()
    norm = np.linalg.norm(r)
    if norm <= 0 or target_norm <= 0:
        return -1.0, (0, 0)
    cc = np.fft.irfft2(target_fft * np.conj(np.fft.rfft2(r)), target_shape)
    idx = int(np.argmax(cc))
    peak = float(cc.flat[idx]) / (target_norm * norm)
    return peak, np.unravel_index(idx, target_shape)


def _rotate_xy(points: np.ndarray, degrees: float, centre: np.ndarray) -> np.ndarray:
    th = math.radians(degrees)
    c, s = math.cos(th), math.sin(th)
    out = points.copy()
    out[:, :2] = (points[:, :2] - centre) @ np.array([[c, -s], [s, c]]).T + centre
    return out


def register_by_correlation(target: np.ndarray, source: np.ndarray,
                            mode: str = "occupancy",
                            cell: Optional[float] = None) -> dict:
    """Coarse-align `source` onto `target`.

    Returns {'transformation' 4x4, 'score', 'margin', 'ambiguous', 'yaw_deg'}.

    `margin` and `ambiguous` carry over from the landmark matcher and matter for
    the same reason: a regular planting is close to symmetric, so a wrong pose
    can score nearly as well as the right one. A residual-based check cannot see
    that -- a row-flipped orchard genuinely lands plant-on-plant -- but the gap
    between the best and second-best correlation peak can.
    """
    target = np.asarray(target, dtype=np.float64)
    source = np.asarray(source, dtype=np.float64)
    empty = dict(transformation=np.eye(4), score=0.0, margin=0.0,
                 ambiguous=True, yaw_deg=0.0)
    if len(target) < 100 or len(source) < 100:
        return empty

    tgt_centre = np.median(target[:, :2], axis=0)
    src_centre = np.median(source[:, :2], axis=0)
    if cell is None:
        cell, extent = auto_cell_size(target)
    else:
        _, extent = auto_cell_size(target)

    tgt_raster = rasterise(target, cell, extent, tgt_centre, mode)
    tgt_raster = tgt_raster - tgt_raster.mean()
    tgt_norm = float(np.linalg.norm(tgt_raster))
    if tgt_norm <= 0:
        return empty
    tgt_fft = np.fft.rfft2(tgt_raster)
    shape = tgt_raster.shape

    def best_over(angles):
        out = []
        for a in angles:
            rot = _rotate_xy(source, a, src_centre)
            peak, shift = _correlate(tgt_fft, shape, tgt_norm,
                                     rasterise(rot, cell, extent, src_centre, mode))
            out.append((peak, a, shift))
        return sorted(out, key=lambda t: -t[0])

    coarse = best_over(np.arange(-180.0, 180.0, _COARSE_STEP_DEG))
    best_peak, best_angle, best_shift = coarse[0]

    # Runner-up must be a genuinely DIFFERENT pose, not a neighbouring step of
    # the same peak, or every result would look ambiguous.
    second = 0.0
    for peak, a, _ in coarse[1:]:
        if abs((a - best_angle + 180) % 360 - 180) > 20.0:
            second = peak
            break

    fine = best_over(np.arange(best_angle - _FINE_HALFWIDTH_DEG,
                               best_angle + _FINE_HALFWIDTH_DEG + 1e-9,
                               _FINE_STEP_DEG))
    best_peak, best_angle, best_shift = fine[0]

    # Un-wrap the FFT shift: an index past halfway is a negative displacement.
    n = shape[0]
    dx = (best_shift[0] - n if best_shift[0] > n // 2 else best_shift[0]) * cell
    dy = (best_shift[1] - n if best_shift[1] > n // 2 else best_shift[1]) * cell

    th = math.radians(best_angle)
    c, s = math.cos(th), math.sin(th)
    R = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
    M = np.eye(4)
    M[:3, :3] = R

    # Compose the translation carefully. Each raster is centred on its OWN XY
    # median, so the FFT shift is measured between two grids with DIFFERENT
    # origins and does not include the offset between those origins. The full
    # mapping is: rotate the source about its own centre, move that centre onto
    # the target's centre, then apply the residual shift the correlation found.
    # Omitting the centre term leaves the rotation exact but the translation
    # metres out -- measured 2-14 m across all three datasets.
    src_pivot = np.array([src_centre[0], src_centre[1], 0.0])
    tgt_pivot = np.array([tgt_centre[0], tgt_centre[1], 0.0])
    M[:3, 3] = tgt_pivot - R @ src_pivot + np.array([dx, dy, 0.0])
    M[2, 3] = float(np.median(target[:, 2]) - np.median(source[:, 2]))

    margin = (best_peak - second) / best_peak if best_peak > 0 else 0.0
    return dict(transformation=M, score=float(best_peak), margin=float(margin),
                ambiguous=bool(second >= 0.85 * best_peak), yaw_deg=float(best_angle))
