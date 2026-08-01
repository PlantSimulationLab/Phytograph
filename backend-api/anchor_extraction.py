"""Reduce a vegetation point cloud to sparse per-plant ANCHOR points.

Why this module exists
----------------------
Registering two scans of a planting by matching their raw points does not work.
Rows of similar plants are self-similar by construction: a descriptor computed
on one tree's foliage looks like every other tree's, so the correspondence set
is mostly wrong and the estimator cheerfully locks the source onto a NEIGHBOURING
plant — a whole row-spacing off — while reporting a healthy score.

The way out is to change the input rather than the estimator. If each cloud is
first reduced to one stable point per plant, the matching problem shrinks from
"two million ambiguous foliage points" to "thirty well-separated landmarks", the
outlier ratio collapses, and ordinary RANSAC is entirely sufficient. This is
also how mature aerial-LiDAR software works: it anchors on treetops/crowns, not
on the canopy surface.

Each extractor returns the same contract, so the caller is agnostic to which
one ran:

    extract_anchors(points, method, extent) -> (xyz (M,3), features (M,k))

`features` are weak per-plant descriptors (height, crown size). They exist to
break lattice symmetry: on a perfectly regular grid the anchor pattern maps onto
itself under a one-plant shift, and position alone cannot distinguish the right
answer from an off-by-one one. Since rigid transforms leave these columns
untouched, they act as invariant labels attached to each landmark.

Three extractors, because no single anchor survives every acquisition:
  * `crown` - crown centroids from tree-instance segmentation. The default:
    it needs no trunk, so it covers aerial/ALS data where trunks are occluded.
  * `trunk` - trunk seeds from ground removal + wood segmentation. For
    terrestrial scans of woody plantings, where trunk bases are the most
    repeatable thing in the scene.
  * `chm`   - local maxima of a canopy height model. Needs no segmentation at
    all, so it still produces landmarks when instance segmentation is
    unreliable (dense or touching canopies).

All three degrade to "too few anchors" rather than raising; the caller treats
that as a signal to fall back to raw-point matching and flag low confidence.
"""

from typing import Optional, Tuple

import logging

import numpy as np

# Points used when searching for the crown-clustering plateau. The plateau
# depends on plant spacing, not on sampling density, so a subsample finds it
# just as reliably — and clustering cost grows steeply enough with point count
# that sweeping the full cloud is not viable (measured: 65 s for 14k points,
# 14 passes). Also bounds the per-cluster cost of the extractors themselves.
logger = logging.getLogger(__name__)

_PLATEAU_PROBE_POINTS = 4000

# Above this, extractors decimate before clustering. Keeps a multi-million-point
# scan from spending minutes in neighbour search; anchors are one-per-plant, so
# a decimated cloud locates them equally well.
_CLUSTER_MAX_POINTS = 60000


def _crown_features(cluster: np.ndarray) -> Tuple[float, float]:
    """(height, crown_size) for one plant's points.

    Height is the vertical extent and crown_size the horizontal spread — two
    cheap, rotation-invariant numbers that differ between genuinely different
    plants. They are weak on purpose: strong per-plant descriptors would be
    unstable across viewpoints, and all we need is enough to break a tie."""
    if len(cluster) == 0:
        return 0.0, 0.0
    height = float(cluster[:, 2].max() - cluster[:, 2].min())
    centre = cluster[:, :2].mean(axis=0)
    crown_size = float(np.linalg.norm(cluster[:, :2] - centre, axis=1).mean())
    return height, crown_size


def _point_spacing(points: np.ndarray) -> float:
    """Median nearest-neighbour distance in XY — the cloud's own sampling scale.

    Cluster radii must NOT be derived from the scene extent. `_robust_cloud_diagonal`
    measures the whole plot on a dense synthetic cloud but only the canopy on a
    sparse real scan, so an extent-relative epsilon that groups a 5-tree row
    correctly (extent 23 m -> eps 1.4 m) shatters every crown on a 500-point scan
    of the same planting (extent 2.6 m -> eps 0.16 m), yielding 10 anchors for 3
    trees. Measuring the actual point spacing is stable across both."""
    if len(points) < 2:
        return 0.0
    from scipy.spatial import cKDTree

    d, _ = cKDTree(points[:, :2]).query(points[:, :2], k=2)
    nn = d[:, 1]
    nn = nn[np.isfinite(nn) & (nn > 0)]
    return float(np.median(nn)) if len(nn) else 0.0


def _cluster_eps(points: np.ndarray, extent: float, spacing_mult: float) -> float:
    """Neighbour distance that counts as "same plant".

    Driven by point spacing (see `_point_spacing`) with the extent-relative value
    as a floor, so it stays sane on a cloud too small or too uniform to measure.
    A few multiples of the spacing bridges the gaps *within* one crown while
    staying below the gap *between* crowns."""
    spacing = _point_spacing(points)
    if spacing <= 0:
        return max(extent * 0.02, 1e-6)
    return max(spacing * spacing_mult, extent * 0.005, 1e-6)


def _crown_cluster_eps(points: np.ndarray, extent: float) -> float:
    """Clustering epsilon for grouping a whole crown.

    Crowns are metres wide, so this needs a much larger epsilon than the "few
    point spacings" that suits trunks — but one as large as the plant-to-plant
    gap would fuse neighbouring trees.

    Rather than guess, find the PLATEAU. Sweeping epsilon over a real 5-tree row
    shows cluster count collapsing (73 -> 25 -> 9) and then sitting at exactly 5
    across a wide band (6x to 25x the point spacing) before crashing to 1 at 30x.
    That plateau is the signature of the true grouping: a range where nudging the
    threshold changes nothing because it is bridging within-crown gaps and not
    yet crossing between-crown ones. Picking the widest stable run is far more
    robust than any fixed multiple, and adapts to crown size and density
    automatically.
    """
    # The sweep clusters the cloud once per candidate epsilon, and clustering
    # cost grows fast with point count (neighbour pairs, then union-find). Doing
    # 14 passes over a full cloud measured 65 s for only 14k points, which would
    # be minutes-to-hours at real scan sizes. The plateau is a property of the
    # PLANT LAYOUT, not of sampling density, so a few thousand points locate it
    # just as well — subsample for the search, then apply the answer to
    # everything.
    probe = points
    if len(points) > _PLATEAU_PROBE_POINTS:
        idx = np.linspace(0, len(points) - 1, _PLATEAU_PROBE_POINTS).astype(int)
        probe = points[idx]

    spacing = _point_spacing(probe)
    if spacing <= 0:
        return max(extent * 0.02, 1e-6)

    # The sweep must span ORDERS of magnitude, not a narrow band. Point spacing
    # varies enormously between acquisitions — a synthetic shell samples at
    # ~0.06 m while a dense simulated scan of the same planting samples at
    # ~0.004 m — so a fixed 4-25x window that brackets the plateau for one lands
    # entirely below it for the other (25x of 0.004 m is 0.11 m, far too small to
    # group a 1 m crown, leaving each tree shattered). A geometric sweep from a
    # few point spacings up to a fraction of the scene finds the plateau in both
    # regimes. Candidates are also floored so an extremely dense cloud doesn't
    # spend the whole sweep below any useful scale.
    lo = max(spacing * 3.0, extent * 1e-4, 1e-6)
    hi = max(lo * 4.0, extent * 0.25)
    candidates = np.geomspace(lo, hi, 14)
    counts = []
    # min_samples scales with the probe so the "is this a real cluster" bar
    # means the same thing whether we sampled 500 points or 4000.
    min_samples = max(3, int(round(5 * len(probe) / max(len(points), 1))) if len(probe) < len(points) else 5)
    for eps in candidates:
        labels = _cluster_xy(probe, eps=float(eps), min_samples=min_samples)
        counts.append(len(np.unique(labels[labels >= 0])))
        # Stop once everything has merged. The sweep runs low-to-high and the
        # plateau always sits BELOW the merge point, so later candidates cannot
        # improve the answer — they only cost time, and they are the expensive
        # ones (a large epsilon makes the neighbour set quadratic; the sweep's
        # tail was 17 s of an 18 s search). Continue one step past the collapse
        # so a genuine 1-cluster scene is still distinguishable.
        if counts[-1] <= 1 and len(counts) >= 2:
            break

    # Longest run of an identical, plausible count (>=2 clusters — a single
    # cluster means the epsilon already merged everything).
    best_count, best_len, best_end = None, 0, 0
    run_len = 0
    for i, c in enumerate(counts):
        run_len = run_len + 1 if i > 0 and c == counts[i - 1] else 1
        if c >= 2 and run_len > best_len:
            best_count, best_len, best_end = c, run_len, i

    if best_count is None or best_len < 2:
        # No stable plateau (too few points, or one blob): a mid-range value is
        # the safest compromise.
        return max(spacing * 8.0, extent * 0.01, 1e-6)

    # Geometric middle of the winning run — furthest from both failure modes
    # (fragmenting below it, merging neighbours above it). Index into the
    # EVALUATED prefix only: the sweep may have stopped early once the clusters
    # collapsed, so `candidates` can be longer than `counts`.
    evaluated = candidates[:len(counts)]
    start = best_end - best_len + 1
    return float(np.exp(np.mean(np.log(evaluated[start:best_end + 1]))))


def _decimate(points: np.ndarray, limit: int = _CLUSTER_MAX_POINTS) -> np.ndarray:
    """Cap the point count fed to clustering.

    Anchors are one per plant, so resolving them does not need every return —
    but neighbour search does get much more expensive as points grow, and real
    scans reach millions. An evenly-strided subsample preserves the spatial
    layout (which is all the clustering keys on) at bounded cost."""
    if len(points) <= limit:
        return points
    return points[np.linspace(0, len(points) - 1, limit).astype(int)]


def _cluster_xy(points: np.ndarray, eps: float, min_samples: int = 5) -> np.ndarray:
    """Single-link spatial clustering in the XY plane, via scipy only.

    scikit-learn is NOT a declared dependency of this backend, so DBSCAN is out.
    `cKDTree` neighbour pairs + union-find gives the same single-link grouping
    with a dependency already in the bundle.

    MEMORY: `query_pairs` must use `output_type='ndarray'`. The default returns
    a Python SET OF TUPLES — roughly 200 bytes per pair against 16 for an array
    row — and pair count grows as (n * eps)^2. Measured with the default: 635k
    pairs cost 136 MB at 40k points, and ~5M pairs cost ~800 MB at the 60k cap
    with a metre-scale crown epsilon, in ONE call. `_crown_cluster_eps` sweeps
    up to 14 epsilons, so the set version could allocate gigabytes on a single
    registration — a real risk for a desktop app, not just for tests.

    The union-find is also vectorised over the pair array rather than looped in
    Python, which is where the ~30 s per call went.
    """
    from scipy.spatial import cKDTree

    n = len(points)
    if n == 0:
        return np.empty(0, dtype=int)

    pairs = cKDTree(points[:, :2]).query_pairs(eps, output_type='ndarray')

    parent = np.arange(n)

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]   # path halving
            i = parent[i]
        return i

    for a, b in pairs:
        ra, rb = find(int(a)), find(int(b))
        if ra != rb:
            # Union by index keeps the tree shallow enough in practice; the
            # path halving above bounds the rest.
            if ra < rb:
                parent[rb] = ra
            else:
                parent[ra] = rb

    roots = np.array([find(i) for i in range(n)])
    labels = np.full(n, -1, dtype=int)
    uniq, counts = np.unique(roots, return_counts=True)
    keep = uniq[counts >= min_samples]
    for new_label, root in enumerate(keep):
        labels[roots == root] = new_label
    return labels


def _decimate(points: np.ndarray, limit: int = _CLUSTER_MAX_POINTS) -> np.ndarray:
    """Cap the point count fed to clustering.

    Anchors are one per plant, so resolving them does not need every return —
    but neighbour search gets much more expensive as points grow, and real
    scans reach millions. An evenly-strided subsample preserves the spatial
    layout (all the clustering keys on) at bounded cost."""
    if len(points) <= limit:
        return points
    return points[np.linspace(0, len(points) - 1, limit).astype(int)]


def _drop_ground(points: np.ndarray, extent: Optional[float] = None) -> np.ndarray:
    """Return the non-ground points.

    Ground is poison for every extractor here: it is one huge connected surface
    touching every plant, so it merges neighbouring plants into a single cluster
    or TreeIso instance and collapses the anchor count (measured: 3 instances
    for a 5-tree row when ground was left in).

    Prefers CSF (the same segmenter `/api/segment/ground` uses), falling back to
    a low height-percentile cut when the C extension is unavailable or CSF finds
    nothing — the plots this targets are flat enough that the approximation
    costs little, and a working fallback beats a hard dependency."""
    if len(points) < 10:
        return points
    try:
        from main import segment_ground, GROUND_CLASS_PLANT

        labels = np.asarray(segment_ground(points))
        plant = points[labels == GROUND_CLASS_PLANT]
        if len(plant) >= 10:
            return plant
    except Exception:
        pass
    z = points[:, 2]
    span = float(np.percentile(z, 98) - np.percentile(z, 2))
    if span <= 0:
        return points
    cut = float(np.percentile(z, 2)) + span * 0.05
    above = points[z > cut]
    return above if len(above) >= 10 else points


def _anchors_from_labels(points: np.ndarray, labels: np.ndarray,
                         apex: bool = False) -> Tuple[np.ndarray, np.ndarray]:
    """Collapse labelled per-plant point groups into one anchor each.

    `apex=True` uses the highest point of the group (the treetop — the most
    view-stable landmark for a crown seen from above); otherwise the horizontal
    centroid at the group's base, which is the better choice when the group is a
    trunk. Either way the anchor's XY is the plant's position, which is what the
    matcher actually keys on."""
    xyz, feats = [], []
    for label in np.unique(labels):
        if label < 0:
            continue
        cluster = points[labels == label]
        if len(cluster) < 3:
            continue
        height, crown_size = _crown_features(cluster)
        if apex:
            anchor = cluster[np.argmax(cluster[:, 2])]
        else:
            anchor = np.array([cluster[:, 0].mean(), cluster[:, 1].mean(),
                               cluster[:, 2].min()])
        xyz.append(anchor)
        feats.append([height, crown_size])
    if not xyz:
        return np.empty((0, 3)), np.empty((0, 2))
    return np.asarray(xyz, dtype=np.float64), np.asarray(feats, dtype=np.float64)


def _extract_crown(points: np.ndarray, extent: float) -> Tuple[np.ndarray, np.ndarray]:
    """Crown centroids — the default, and the one that works without trunks.

    Prefers TreeIso instance segmentation when it is available and produces a
    sensible number of instances. TreeIso is a heavyweight CPU pipeline, though,
    and it is not always installed, so this falls back to clustering the upper
    canopy: taking only points in the top band of the height range separates
    crowns that touch lower down, which is the usual failure of naive clustering
    on a closed row.

    Ground MUST be excluded before TreeIso runs. `/api/segment/trees` does this
    for the same reason: a ground plane connects every plant into one enormous
    component, so TreeIso merges neighbours and returns far too few instances
    (measured: 3 instances for a 5-tree row when ground was left in). Both the
    TreeIso path and the geometric fallback therefore work on non-ground points.
    """
    non_ground = _drop_ground(points)
    if len(non_ground) < 6:
        non_ground = points

    try:
        from main import segment_trees

        labels = np.asarray(segment_trees(non_ground))
        # TreeIso uses 0 for unassigned; shift to the -1 convention used here.
        instance_labels = np.where(labels > 0, labels, -1)
        n_instances = len(np.unique(instance_labels[instance_labels >= 0]))
        if n_instances >= 3:
            return _anchors_from_labels(non_ground, instance_labels, apex=True)
    except Exception:
        # TreeIso missing or failed — fall through to the geometric path rather
        # than failing the whole registration.
        pass

    points = non_ground
    z = points[:, 2]
    z_lo, z_hi = np.percentile(z, 5), np.percentile(z, 99)
    span = z_hi - z_lo
    if span <= 0:
        return np.empty((0, 3)), np.empty((0, 2))
    # Upper ~45% of the canopy: high enough to be above where neighbouring
    # crowns merge, low enough to keep a usable number of points per tree.
    upper = points[z >= z_lo + span * 0.55]
    if len(upper) < 6:
        upper = points[z >= z_lo + span * 0.3]
    if len(upper) < 6:
        return np.empty((0, 3)), np.empty((0, 2))

    # Grouping a whole crown needs an epsilon comparable to the CROWN's own
    # width, not just the point spacing: a crown is a hollow-ish shell metres
    # across, so a spacing-derived epsilon (measured: 0.24 m against a 1.15 m
    # crown radius) splits every tree into several fragments. Estimating the
    # crown scale first, then clustering at a fraction of it, keeps whole crowns
    # together while leaving the inter-crown gap intact.
    upper = _decimate(upper)
    labels = _cluster_xy(upper, eps=_crown_cluster_eps(upper, extent), min_samples=5)
    return _anchors_from_labels(upper, labels, apex=True)


def _extract_trunk(points: np.ndarray, extent: float) -> Tuple[np.ndarray, np.ndarray]:
    """Trunk seeds — for terrestrial scans where trunk bases are visible.

    Ground is removed first (a ground plane would otherwise cluster into one
    giant "plant"), then the near-ground band is clustered: at trunk height the
    only things left are trunks, well separated from each other, which is
    exactly the sparse landmark set we want.

    CSF ground segmentation is used when available but is not required — see
    `_drop_ground`."""
    points_ng = _drop_ground(points, extent)

    if len(points_ng) < 6:
        return np.empty((0, 3)), np.empty((0, 2))

    # A band low on the stem: above the ground/understory but below the crown,
    # where trunks are isolated vertical structures.
    zz = points_ng[:, 2]
    lo, hi = np.percentile(zz, 2), np.percentile(zz, 98)
    span = hi - lo
    if span <= 0:
        return np.empty((0, 3)), np.empty((0, 2))
    band = points_ng[(zz >= lo + span * 0.05) & (zz <= lo + span * 0.45)]
    if len(band) < 6:
        band = points_ng

    band = _decimate(band)
    labels = _cluster_xy(band, eps=_cluster_eps(band, extent, 3.0), min_samples=4)
    xyz, feats = _anchors_from_labels(band, labels, apex=False)
    if len(xyz) == 0:
        return xyz, feats

    # Report each trunk's FULL height, not just the sampled band's, so the weak
    # feature reflects the plant rather than the slice we happened to cut.
    from scipy.spatial import cKDTree

    tree = cKDTree(points_ng[:, :2])
    full = []
    for anchor, (_, crown_size) in zip(xyz, feats):
        idx = tree.query_ball_point(anchor[:2], max(extent * 0.05, 1e-6))
        column_z = points_ng[idx, 2] if idx else np.array([anchor[2]])
        full.append([float(column_z.max() - column_z.min()), crown_size])
    return xyz, np.asarray(full, dtype=np.float64)


def _extract_chm(points: np.ndarray, extent: float) -> Tuple[np.ndarray, np.ndarray]:
    """Treetops as local maxima of a canopy height model.

    The classic aerial-LiDAR landmark, and the only extractor here that needs no
    segmentation at all — so it still works when instance segmentation gives up
    (touching crowns, dense understory). Rasterise the cloud to a top-down
    maximum-height grid, then take peaks.

    `skimage.feature.peak_local_max` does the peak finding; scikit-image is
    already a declared dependency (it ships for TreeIso), so this adds nothing
    to the bundle."""
    from skimage.feature import peak_local_max

    if len(points) < 10:
        return np.empty((0, 3)), np.empty((0, 2))

    # Cell size is a compromise: fine enough to resolve neighbouring crowns,
    # coarse enough that each cell actually catches returns on sparse scans.
    # Driven by the point spacing rather than the extent — an extent-relative
    # cell is far too fine on a sparse scan and shatters each crown into many
    # peaks (measured: 32 peaks for a 3-tree row).
    spacing = _point_spacing(points)
    cell = max(spacing * 1.5, extent * 0.005, 1e-6) if spacing > 0 else max(extent * 0.02, 1e-6)
    mins = points[:, :2].min(axis=0)
    ij = np.floor((points[:, :2] - mins) / cell).astype(int)
    nx, ny = ij[:, 0].max() + 1, ij[:, 1].max() + 1
    if nx < 3 or ny < 3:
        return np.empty((0, 3)), np.empty((0, 2))

    # Max height per cell = a DSM. Empty cells stay at -inf so they can never
    # be mistaken for peaks.
    grid = np.full((nx, ny), -np.inf)
    np.maximum.at(grid, (ij[:, 0], ij[:, 1]), points[:, 2])
    filled = np.isfinite(grid)
    if filled.sum() < 9:
        return np.empty((0, 3)), np.empty((0, 2))
    base = float(np.percentile(grid[filled], 5))
    heights = np.where(filled, grid - base, 0.0)

    # How far apart two treetops must be. This has to track the PLANT spacing,
    # never the scene extent: extent grows with the size of the plot while plant
    # spacing does not, so an extent-derived separation silently exceeds the real
    # tree spacing on a long row and suppresses genuine treetops (measured: 8.1 m
    # separation on a 40-tree row of 4 m spacing, finding 7 of 40).
    #
    # Measure the spacing instead of estimating it. Detect peaks once at a
    # deliberately permissive separation — that over-splits crowns — then take
    # the median nearest-neighbour distance between those raw peaks as the plant
    # spacing, and re-detect requiring peaks to be ~60% of it apart. Two passes
    # over a small grid are cheap, and the answer comes from the data.
    # Smooth the surface before looking for peaks. A raw canopy grid is bumpy at
    # the cell scale — individual leaves and gaps — so a crown that happens to
    # span many cells produces many local maxima and the tree is counted several
    # times (measured: 50 peaks for 4 trees on a finely-celled grid). Blurring at
    # roughly one crown width leaves one maximum per crown, which is the standard
    # treetop-detection approach. The blur is only for FINDING peaks; heights are
    # still read from the unsmoothed grid.
    from scipy import ndimage

    # Blur width tracks how many cells a crown covers, which varies a lot: the
    # same 1.1 m crown spans ~3 cells on a large plot and ~11 on a small one, so
    # a fixed sigma either does nothing or erases the canopy. Estimate the crown
    # from the footprint of the tall cells (total tall area / a rough plant
    # count) and blur at a fraction of it.
    tall_cells = int((heights > max(heights.max() * 0.25, 1e-9)).sum())
    approx_plants = max(1, int(round(np.sqrt(max(tall_cells, 1)) / 2)))
    crown_cells = max(2.0, np.sqrt(max(tall_cells, 1) / approx_plants))
    smoothed = ndimage.gaussian_filter(heights, sigma=max(1.0, crown_cells * 0.35))
    threshold = max(heights.max() * 0.25, 1e-9)
    seed_peaks = peak_local_max(
        smoothed, min_distance=2, threshold_abs=threshold * 0.5, exclude_border=False)
    if len(seed_peaks) == 0:
        return np.empty((0, 3)), np.empty((0, 2))

    min_distance = 2
    if len(seed_peaks) >= 2:
        from scipy.spatial import cKDTree

        d, _ = cKDTree(seed_peaks).query(seed_peaks, k=2)
        nn = d[:, 1]
        nn = nn[np.isfinite(nn) & (nn > 0)]
        if len(nn):
            min_distance = max(2, int(round(float(np.median(nn)) * 0.6)))

    peaks = peak_local_max(
        smoothed, min_distance=min_distance,
        threshold_abs=threshold * 0.5,
        exclude_border=False,
    )
    if len(peaks) == 0:
        return np.empty((0, 3)), np.empty((0, 2))

    xyz, feats = [], []
    for px, py in peaks:
        if not filled[px, py]:
            continue
        world = mins + (np.array([px, py]) + 0.5) * cell
        height = float(heights[px, py])
        # Crown size ~ how far the canopy stays high around the peak; a cheap
        # proxy for extent that needs no second pass over the points.
        lo_x, hi_x = max(0, px - min_distance), min(nx, px + min_distance + 1)
        lo_y, hi_y = max(0, py - min_distance), min(ny, py + min_distance + 1)
        window = heights[lo_x:hi_x, lo_y:hi_y]
        crown_size = float((window > height * 0.5).sum()) * cell
        xyz.append([world[0], world[1], grid[px, py]])
        feats.append([height, crown_size])

    if not xyz:
        return np.empty((0, 3)), np.empty((0, 2))
    return np.asarray(xyz, dtype=np.float64), np.asarray(feats, dtype=np.float64)


_EXTRACTORS = {
    "crown": _extract_crown,
    "trunk": _extract_trunk,
    "chm": _extract_chm,
}


def extract_anchors(points: np.ndarray, method: str,
                    extent: float) -> Tuple[np.ndarray, np.ndarray]:
    """Reduce `points` to per-plant anchors using the named extractor.

    `extent` is the cloud's robust diagonal; every internal length scale is
    expressed as a fraction of it so the same parameters work on a 3 m potted
    plant and a 300 m orchard block without retuning.

    Returns (xyz (M,3), features (M,2)). An empty result is a normal outcome,
    not an error: the caller falls back to raw-point matching and reports low
    confidence."""
    extractor = _EXTRACTORS.get(method)
    if extractor is None:
        raise ValueError(f"Unknown anchor method '{method}'")
    points = np.asarray(points, dtype=np.float64)

    # Drop non-finite coordinates BEFORE anything else touches them. This is a
    # crash guard, not tidiness: an infinite coordinate makes CSF size its cloth
    # from an infinite bounding box, the dimension overflows to a negative int
    # (observed: "width: -2147483645"), and the C extension SEGFAULTS — which
    # kills the whole backend process rather than raising something catchable.
    # scipy's cKDTree also rejects non-finite input. NaN happens to be handled
    # downstream, but inf is not, so filter both here where it is cheap.
    points = points[np.isfinite(points).all(axis=1)]

    if len(points) < 6:
        return np.empty((0, 3)), np.empty((0, 2))
    try:
        return extractor(points, float(extent))
    except (MemoryError, ValueError, IndexError, RuntimeError, ImportError) as exc:
        # A DATA problem (odd geometry, a missing optional C extension) is a
        # fallback signal, not a hard error: the caller degrades to raw-surface
        # matching and reports it.
        #
        # Programming errors are NOT caught. A bare `except Exception` here once
        # swallowed a NameError from a refactor that deleted a helper, and the
        # extractors silently returned "no plants found" instead of crashing —
        # a broken build that looked like a legitimately difficult scene. Let
        # NameError/AttributeError/TypeError propagate so they surface as bugs.
        logger.warning("anchor extraction (%s) failed, falling back: %s",
                       method, exc)
        return np.empty((0, 3)), np.empty((0, 2))
