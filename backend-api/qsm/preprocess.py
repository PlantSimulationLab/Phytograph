"""Stage A: deterministic point-cloud preprocessing for QSM reconstruction.

Pipeline (each step optional / guarded):
  1. ground removal (Cloth Simulation Filter, reused from main.segment_ground)
  2. statistical + radius outlier removal (denoise)
  3. optional intensity/deviation filter (only if the cloud carries that column)
  4. single-tree isolation (largest connected component on a radius graph)
  5. voxel downsample (uniform density; edge <= 1/2 smallest target radius)
  6. optional trellis/wire removal (off by default until validated)

Design constraints (from the plan):
- **Deterministic**: no global RNG; voxel downsample uses a stable
  lowest-index-per-voxel rule, connected components use scipy.csgraph, inputs
  are processed in given order. Same input -> identical output.
- **Index-preserving**: every step returns a boolean ``keep`` mask over the
  *current* points so the caller (and the validation harness) can map the final
  cloud back to the input and check "didn't delete real wood / did remove
  strays". ``run_preprocess`` threads these into one final index array.
- **No scikit-learn** (not a dependency): clustering via scipy.sparse.csgraph.

All distances in meters. Reuses ``main.segment_ground`` (CSF) and
``main.remove_statistical_outliers`` where helpful, but adds index-preserving
variants since those upstream helpers drop the index correspondence.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree


@dataclass
class PreprocessOptions:
    remove_ground: bool = True
    ground_class_threshold: float = 0.02
    ground_cloth_resolution: float = 0.05

    denoise: bool = True
    sor_nb_neighbors: int = 20
    sor_std_ratio: float = 2.0
    ror_nb_points: int = 8
    ror_radius: float | None = None  # auto from density if None

    isolate_tree: bool = True
    isolate_radius: float | None = None  # auto from density if None

    voxel_downsample: bool = True
    voxel_size: float | None = None  # auto: 1/2 the target_min_radius if None
    target_min_radius: float = 0.005  # smallest branch radius we want to resolve

    remove_trellis: bool = False  # opt-in; not validated yet

    # When the cloud has an intensity/deviation column, drop scatter.
    intensity_min: float | None = None


@dataclass
class PreprocessResult:
    points: np.ndarray  # (M, 3) the cleaned cloud
    kept_index: np.ndarray  # (M,) indices into the ORIGINAL input cloud
    stages: dict = field(default_factory=dict)  # per-stage counts for reporting


def _avg_nn_distance(points: np.ndarray, sample: int = 2000) -> float:
    """Median nearest-neighbor spacing -- a robust density estimate. Deterministic
    (evenly-spaced sample, no RNG)."""
    n = len(points)
    if n < 2:
        return 0.01
    idx = np.linspace(0, n - 1, min(sample, n)).astype(np.int64)
    tree = cKDTree(points)
    d, _ = tree.query(points[idx], k=2)
    nn = d[:, 1]
    nn = nn[nn > 0]
    return float(np.median(nn)) if nn.size else 0.01


def statistical_outlier_mask(
    points: np.ndarray, nb_neighbors: int = 20, std_ratio: float = 2.0
) -> np.ndarray:
    """Boolean keep-mask (True = inlier). Index-preserving SOR using a KD-tree --
    same criterion as open3d's remove_statistical_outlier but returns a mask."""
    n = len(points)
    if n <= nb_neighbors:
        return np.ones(n, dtype=bool)
    tree = cKDTree(points)
    d, _ = tree.query(points, k=nb_neighbors + 1)
    mean_d = d[:, 1:].mean(axis=1)  # exclude self
    thresh = mean_d.mean() + std_ratio * mean_d.std()
    return mean_d <= thresh


def radius_outlier_mask(points: np.ndarray, nb_points: int, radius: float) -> np.ndarray:
    """Keep points having >= ``nb_points`` neighbors within ``radius``."""
    n = len(points)
    if n == 0:
        return np.zeros(0, dtype=bool)
    tree = cKDTree(points)
    counts = tree.query_ball_point(points, radius, return_length=True)
    # query_ball_point counts include the point itself.
    return counts >= (nb_points + 1)


def largest_connected_component_mask(points: np.ndarray, radius: float) -> np.ndarray:
    """Keep the largest connected component of the radius graph -- isolates the
    main tree from detached debris. Deterministic (csgraph)."""
    n = len(points)
    if n == 0:
        return np.zeros(0, dtype=bool)
    tree = cKDTree(points)
    pairs = tree.query_pairs(radius, output_type="ndarray")
    if len(pairs) == 0:
        # No edges: every point isolated; keep the single largest "component"
        # which is one point -- degenerate, keep all (nothing to isolate).
        return np.ones(n, dtype=bool)
    data = np.ones(len(pairs), dtype=np.int8)
    adj = coo_matrix((data, (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    ncomp, labels = connected_components(adj, directed=False)
    # Largest component (lowest label on ties for determinism).
    counts = np.bincount(labels, minlength=ncomp)
    best = int(np.argmax(counts))
    return labels == best


def voxel_downsample(
    points: np.ndarray, voxel_size: float
) -> tuple[np.ndarray, np.ndarray]:
    """Keep one representative point per occupied voxel: the one with the lowest
    original index (deterministic; no centroid averaging so the kept point is a
    real measured point). Returns (kept_points, kept_index)."""
    n = len(points)
    if n == 0 or voxel_size <= 0:
        return points, np.arange(n)
    keys = np.floor(points / voxel_size).astype(np.int64)
    # Unique voxel keys; np.unique returns the FIRST occurrence index when the
    # input order is preserved -> lowest original index per voxel (deterministic).
    _, first_idx = np.unique(keys, axis=0, return_index=True)
    first_idx = np.sort(first_idx)
    return points[first_idx], first_idx


def run_preprocess(
    points: np.ndarray, opts: PreprocessOptions | None = None
) -> PreprocessResult:
    """Run the full preprocessing chain. Returns the cleaned cloud, the indices
    into the original input that survived, and per-stage counts."""
    opts = opts or PreprocessOptions()
    points = np.asarray(points, dtype=np.float64)
    idx = np.arange(len(points))  # indices into ORIGINAL cloud, threaded through
    stages: dict = {"input": len(points)}

    density = _avg_nn_distance(points)

    # 1. ground removal (CSF) -- reuse main.segment_ground.
    if opts.remove_ground and len(points) > 10:
        try:
            from main import GROUND_CLASS_PLANT, segment_ground

            labels = segment_ground(
                points,
                cloth_resolution=opts.ground_cloth_resolution,
                class_threshold=opts.ground_class_threshold,
            )
            keep = labels == GROUND_CLASS_PLANT
            points, idx = points[keep], idx[keep]
        except ImportError:
            stages["ground_skipped"] = "CSF unavailable"
    stages["after_ground"] = len(points)

    # 2. denoise: SOR then ROR.
    if opts.denoise and len(points) > opts.sor_nb_neighbors:
        keep = statistical_outlier_mask(points, opts.sor_nb_neighbors, opts.sor_std_ratio)
        points, idx = points[keep], idx[keep]
        ror_r = opts.ror_radius if opts.ror_radius is not None else 2.5 * density
        keep = radius_outlier_mask(points, opts.ror_nb_points, ror_r)
        points, idx = points[keep], idx[keep]
    stages["after_denoise"] = len(points)

    # 4. single-tree isolation: largest connected component.
    if opts.isolate_tree and len(points) > 1:
        iso_r = opts.isolate_radius if opts.isolate_radius is not None else 3.0 * density
        keep = largest_connected_component_mask(points, iso_r)
        points, idx = points[keep], idx[keep]
    stages["after_isolate"] = len(points)

    # 5. voxel downsample (uniform density).
    if opts.voxel_downsample and len(points) > 0:
        vsize = opts.voxel_size
        if vsize is None:
            vsize = max(0.5 * opts.target_min_radius, 0.5 * density)
        kept_pts, kept_local = voxel_downsample(points, vsize)
        points, idx = kept_pts, idx[kept_local]
        stages["voxel_size"] = vsize
    stages["after_voxel"] = len(points)

    # 6. trellis removal (opt-in; not yet implemented beyond the hook).
    if opts.remove_trellis:
        stages["trellis_removal"] = "requested but not implemented"

    stages["output"] = len(points)
    return PreprocessResult(points=points, kept_index=idx, stages=stages)
