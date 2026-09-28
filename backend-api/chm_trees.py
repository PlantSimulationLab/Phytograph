"""Individual-tree segmentation from a canopy height model (CHM), for airborne
and other top-down clouds where crowns interlock and stems are barely sampled.

Method specification: docs/docs/concepts/tree-segmentation-methods.md. Keep the
two in step.

Why a second method exists at all. TreeIso (the default) assembles trees from
3D over-segments and then merges them by stem-like features, which is what a
terrestrial scan shows well. An airborne scan of a closed canopy shows almost
no stems, so TreeIso's stage 2 (2D cut-pursuit) is left grouping crown
fragments by XY proximity alone and fuses touching crowns: on a 40 x 40 m crop
of a plantation with ~3.5 m tree spacing it returned 16 instances for ~90
trees, and no setting of its knobs recovered more than two thirds of them. What
such a scan DOES show well is the top of each crown, so here the trees are
found where they are visible:

  1. height above ground (HAG) for every point: a DTM from the ground points
     when the cloud has them, otherwise a coarse lowest-return surface
     (a ground-removed cloud still reaches down to understory and stem bases);
  2. CHM = highest HAG per cell, pit-filled and lightly smoothed;
  3. one marker per treetop: local maxima in a window scaled to the
     `crown_scale` and at least `min_height` tall; a user seed replaces the
     automatic tops near it;
  4. marker-controlled watershed on the inverted CHM, masked to canopy taller
     than `min_height`, gives each tree its crown footprint;
  5. every point takes the id of the crown above it, so a stem or understory
     point under a crown belongs to that tree, and points outside every crown
     get 0.

Pure numpy/scipy/scikit-image: nothing here reads a session, a lock or a file.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

# Cell size of the lowest-return ground surface used when the cloud carries no
# ground points. Coarse on purpose: under a closed canopy a small cell holds no
# low returns at all and would read a crown's underside as "ground".
GROUND_CELL_M = 5.0
# Everything scale-dependent follows ONE user-facing distance, the crown
# scale S: roughly the width of the smaller crowns in the stand. It is NOT the
# trunk-to-trunk spacing, though it was briefly named that: the best S tracks
# the shape of the crown tops, and in a sparse stand it sits well below the
# spacing (synthetic natural stand, trees 4.4 m apart: best S 2.5 m, 91% of
# trees; S near the measured spacing, 4.0-5.0 m, merges them: 68-76%). Before that it was a
# "min spacing" that was really the window diameter, which on the poplar tile
# needed 1.25-1.5 m for trunks 2.4-2.7 m apart.
#
# The rule, scored by per-tree IoU (a tree is right at IoU >= 0.5):
#   window diameter = WINDOW_PER_SCALE x S    (local-maximum footprint)
#   cell            = S / CELL_DIVISOR        (clamped to CELL_MIN/MAX)
#   smoothing sigma = one cell
# and S = 2.5 m is at or near the best on every stand measured, not one site:
#   poplar ALS tile, 6 hand-labeled trees (bad_segment_example_handlabels.laz):
#       S 2.0-2.5 -> 6/6 at IoU 0.80-0.86; 2.75 merges a pair, 3.0 three
#   synthetic plantation 3.5 x 4 m: S 3.0-3.5 -> 20/20; 2.5 -> 20-25 (splits)
#   synthetic uniform stand, 3.1 m apart, 8-12 m tall: S 2.0-3.5 -> 99-100%
#   synthetic natural, sparse (4.4 m apart, 10-25 m tall): best 2.5 -> 91%
#   synthetic natural, dense mixed heights (2.5 m apart, 6-20 m): best 2.0 ->
#       64%, 2.5 -> 56% - the method's real limit; 93% of those trees are
#       visible from above, so it is not occlusion. A height-scaled window
#       (window = k x local height, as in Popescu & Wynne 2004) was tried and
#       gained at most 5 points, so it was not adopted.
# Errors are asymmetric: too small an S splits crowns (visible), too large
# merges trees (easy to miss), so the guidance is to err low.
#
# The cell is tied to the crown scale, never the point spacing: a 0.3 m cell
# recovered 20/20 synthetic trees at 8-60 returns/m² while 0.6 m lost 3-11 at
# every density, and the first rule (2.5x point spacing) made the cell coarser
# exactly as data got sparser (17 of 20 trees lost at 8 returns/m²). Empty
# cells are filled instead (HOLE_FILL_M).
WINDOW_PER_SCALE = 0.55
CELL_DIVISOR = 12.0
CELL_MIN_M = 0.1
CELL_MAX_M = 1.0
DEFAULT_MIN_HEIGHT_M = 2.0
DEFAULT_CROWN_SCALE_M = 2.5
# A seed takes over the automatic treetops within this share of the crown
# scale, so the tops it replaces are those of its own crown.
SEED_TAKEOVER_PER_SCALE = 0.5
# Watershed compactness, in meters of canopy height per meter from the marker
# (see the watershed call). Small: it only has to break ties on flat tops.
COMPACTNESS_PER_M = 0.03
# Widest CHM hole (m) filled from its neighbors rather than read as a gap.
HOLE_FILL_M = 1.0


def pit_fill_chm(chm: np.ndarray) -> np.ndarray:
    """First-pass pit-free CHM smoothing: fill the 'pits' where a DSM cell dipped
    because a pulse penetrated the canopy to a lower return. Runs a NaN-aware 3×3
    gray-closing (dilation then erosion) over finite cells, which lifts isolated
    low cells to their neighborhood max without inflating the overall surface.
    A full Khosravipour spiral pit-free CHM is a future refinement."""
    from scipy.ndimage import maximum_filter, minimum_filter
    finite = np.isfinite(chm)
    if not finite.any():
        return chm
    # Gray-closing = max-filter then min-filter. Feed NaNs as -inf into the max
    # pass (so real cells win) and +inf into the min pass, then restore voids.
    filled = np.where(finite, chm, -np.inf)
    filled = maximum_filter(filled, size=3, mode="nearest")
    filled = np.where(np.isfinite(filled), filled, np.inf)
    filled = minimum_filter(filled, size=3, mode="nearest")
    out = np.where(finite, filled, np.nan)
    return out


def default_cell(crown_scale: float) -> float:
    """CHM cell for a crown scale (see CELL_DIVISOR)."""
    return float(np.clip(crown_scale / CELL_DIVISOR, CELL_MIN_M, CELL_MAX_M))


def _fill_nearest(grid: np.ndarray) -> np.ndarray:
    """Fill NaN cells with the value of the nearest finite cell."""
    from scipy.ndimage import distance_transform_edt

    empty = ~np.isfinite(grid)
    if not empty.any():
        return grid
    if empty.all():
        return np.zeros_like(grid)
    _, (ii, jj) = distance_transform_edt(empty, return_indices=True)
    return grid[ii, jj]


def _ground_surface(xy_origin: np.ndarray, extent: np.ndarray, src: np.ndarray,
                    *, lowest: bool) -> tuple[np.ndarray, float]:
    """Coarse ground elevation grid over the cloud's footprint.

    `lowest=True` (no ground points): the minimum z per GROUND_CELL_M cell, then
    a 3×3 minimum filter so a cell under an unbroken crown borrows the lowest
    return of its neighbors instead of the crown's underside. `lowest=False`
    (ground-labeled points): the median z per cell. Both are gap-filled from
    the nearest occupied cell and smoothed. Returns (grid, cell)."""
    from scipy.ndimage import gaussian_filter, minimum_filter

    cell = GROUND_CELL_M
    shape = (np.floor(extent / cell).astype(int) + 1)
    g = np.full(tuple(shape), np.nan)
    ij = np.floor((src[:, :2] - xy_origin) / cell).astype(int)
    ij = np.clip(ij, 0, shape - 1)
    flat = ij[:, 0] * shape[1] + ij[:, 1]
    if lowest:
        vals = np.full(g.size, np.inf)
        np.minimum.at(vals, flat, src[:, 2])
        vals[~np.isfinite(vals)] = np.nan
        g = vals.reshape(g.shape)
        g = _fill_nearest(g)
        g = minimum_filter(g, size=3, mode="nearest")
    else:
        order = np.argsort(flat, kind="stable")
        f_sorted = flat[order]
        z_sorted = src[order, 2]
        cuts = np.flatnonzero(np.diff(f_sorted)) + 1
        starts = np.r_[0, cuts]
        ends = np.r_[cuts, len(f_sorted)]
        vals = np.full(g.size, np.nan)
        for s, e in zip(starts, ends):
            vals[f_sorted[s]] = np.median(z_sorted[s:e])
        g = _fill_nearest(vals.reshape(g.shape))
    return gaussian_filter(g, sigma=1.0, mode="nearest"), cell


def height_above_ground(points: np.ndarray, ground: Optional[np.ndarray] = None) -> np.ndarray:
    """Per-point height above a coarse ground surface (see `_ground_surface`)."""
    from scipy.ndimage import map_coordinates

    pts = np.asarray(points, dtype=np.float64)
    use_ground = ground is not None and len(ground) >= 10
    src = np.asarray(ground, dtype=np.float64) if use_ground else pts
    both = np.vstack([pts[:, :2], src[:, :2]])
    origin = both.min(axis=0)
    extent = both.max(axis=0) - origin
    grid, cell = _ground_surface(origin, extent, src, lowest=not use_ground)
    # Bilinear, in cell-center coordinates.
    fx = (pts[:, 0] - origin[0]) / cell - 0.5
    fy = (pts[:, 1] - origin[1]) / cell - 0.5
    z0 = map_coordinates(grid, [fx, fy], order=1, mode="nearest")
    return pts[:, 2] - z0


def _disk(radius_cells: float) -> np.ndarray:
    r = max(1, int(np.ceil(radius_cells)))
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= radius_cells * radius_cells + 1e-9


def segment_trees_chm(
    points: np.ndarray,
    *,
    cell: Optional[float] = None,
    min_height: float = DEFAULT_MIN_HEIGHT_M,
    crown_scale: float = DEFAULT_CROWN_SCALE_M,
    smooth_sigma: Optional[float] = None,
    ground: Optional[np.ndarray] = None,
    seeds: Optional[np.ndarray] = None,
    meta: Optional[dict] = None,
) -> np.ndarray:
    """Per-point tree ids (0 = no crown above, 1..K = trees) from a CHM.

    Args:
        points: (N, 3) non-ground points.
        cell: CHM cell size (m); None = crown_scale / 12 (see default_cell).
        min_height: canopy lower than this above ground is not a tree.
        crown_scale: roughly the width of the smaller crowns in the stand
            (m). The main knob, and it sets the treetop window, the cell and
            the smoothing: lower it if neighboring trees are merged, raise it
            if one crown is split. Not the trunk spacing (see
            WINDOW_PER_SCALE).
        smooth_sigma: Gaussian smoothing of the CHM (m); None = one cell (the
            usual 3x3 CHM filter). More smoothing loses a low crown beside a
            tall one; less turns canopy roughness into false treetops.
        ground: optional (M, 3) ground points for the DTM.
        seeds: optional (S, 3) user treetops/trunks. Each yields exactly one
            tree, with ids 1..S in seed order, and takes over any automatic
            treetop within half the `crown_scale`; the other automatic trees follow
            as S+1.. .
        meta: optional dict receiving the resolved parameters.
    """
    from scipy import ndimage as ndi
    from skimage.segmentation import watershed

    pts = np.asarray(points, dtype=np.float64)[:, :3]
    n = len(pts)
    if n == 0:
        return np.zeros(0, dtype=np.int64)
    if not (crown_scale > 0):
        raise ValueError("crown_scale must be positive")
    if cell is None or not (cell > 0):
        cell = default_cell(crown_scale)
    cell = float(cell)
    if smooth_sigma is None:
        smooth_sigma = cell

    hag = height_above_ground(pts, ground)

    origin = pts[:, :2].min(axis=0)
    shape = np.floor((pts[:, :2].max(axis=0) - origin) / cell).astype(int) + 1
    ij = np.clip(np.floor((pts[:, :2] - origin) / cell).astype(int), 0, shape - 1)
    flat = ij[:, 0] * shape[1] + ij[:, 1]

    chm = np.full(int(shape[0] * shape[1]), -np.inf)
    np.maximum.at(chm, flat, hag)
    chm[~np.isfinite(chm)] = np.nan
    chm = pit_fill_chm(chm.reshape(tuple(shape)))
    # Fill cells that no return landed in from their nearest occupied cell, but
    # only across a small hole (<= HOLE_FILL_M or 2 cells); a wider hole is a
    # real gap in the canopy. At sparse density most cells of a fine grid are
    # empty, and left empty they cut every crown into islands the watershed
    # cannot flood across and turn each lone cell into a "treetop" (measured
    # at 8 returns/m²: 20 trees found, but 4 of 20 recovered).
    empty = ~np.isfinite(chm)
    occupied = ~empty
    if empty.any() and occupied.any():
        dist, (ii, jj) = ndi.distance_transform_edt(empty, return_indices=True)
        near = empty & (dist * cell <= max(HOLE_FILL_M, 2 * cell))
        chm[near] = chm[ii[near], jj[near]]
        occupied = occupied | near
    chm = np.where(occupied, chm, 0.0)
    if smooth_sigma > 0:
        chm = ndi.gaussian_filter(chm, sigma=smooth_sigma / cell, mode="nearest")
    canopy = occupied & (chm >= min_height)

    peaks = (chm == ndi.maximum_filter(chm, footprint=_disk(0.5 * WINDOW_PER_SCALE * crown_scale / cell),
                                       mode="nearest")) & canopy
    # A flat top reads as several adjacent maxima; each plateau is ONE top.
    auto, n_auto = ndi.label(peaks, structure=np.ones((3, 3)))

    n_seeds = 0 if seeds is None else len(seeds)
    markers = np.zeros(chm.shape, dtype=np.int64)
    if n_seeds:
        # Seeds CORRECT the automatic treetops rather than replace all of them:
        # a seed takes over every automatic top within half the crown scale
        # (two seeds on a crown the automatic pass merged split it; one seed
        # on a crown it split joins it), and every other automatic top still
        # yields a tree. Seeding only the trees that came out wrong is the
        # point — with seeds-only markers, one seed's flood crosses every
        # unseeded crown on its way to the next seed.
        seeds_xy = np.asarray(seeds, dtype=np.float64)[:, :2]
        sij = np.clip(np.floor((seeds_xy - origin) / cell).astype(int), 0, shape - 1)
        if n_auto:
            centers = np.array(ndi.center_of_mass(peaks, auto, range(1, n_auto + 1)))
            d = np.linalg.norm(centers[:, None, :] - sij[None, :, :], axis=2) * cell
            drop = np.flatnonzero((d < SEED_TAKEOVER_PER_SCALE * crown_scale).any(axis=1)) + 1
            auto[np.isin(auto, drop)] = 0
        for k, (i, j) in enumerate(sij, start=1):
            markers[i, j] = k
        # A seed placed on low canopy still has to own a crown.
        canopy = canopy | (markers > 0)
    keep = auto > 0
    markers[keep & (markers == 0)] = auto[keep & (markers == 0)] + n_seeds

    # Compact watershed: a cell also pays for its distance from the marker, so
    # a tall crown's flood cannot run across a shallow valley and take half of
    # a suppressed neighbor's flat top (measured on the fixture: a seeded 9 m
    # tree beside an 11 m one kept only 74% of its top without this, 100%
    # with). Per meter, so it means the same at any cell size.
    crowns = watershed(-chm, markers, mask=canopy,
                       compactness=COMPACTNESS_PER_M * cell)
    labels = crowns.ravel()[flat].astype(np.int64)

    # Contiguous ids after the seeds' fixed 1..S (an automatic top can lose
    # every point to rounding, or have been taken over by a seed).
    present = np.unique(labels[labels > n_seeds])
    remap = np.arange(int(crowns.max()) + 1, dtype=np.int64)
    remap[present] = np.arange(n_seeds + 1, n_seeds + 1 + len(present))
    labels = remap[labels]

    if meta is not None:
        meta.update(method="chm", cell=cell, min_height=float(min_height),
                    crown_scale=float(crown_scale), smooth_sigma=float(smooth_sigma),
                    ground_source="ground_class" if ground is not None and len(ground) >= 10
                    else "lowest_return",
                    num_trees=int(labels.max()) if labels.size else 0)
    return labels
