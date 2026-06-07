"""Phase A: preprocessing validation against known geometry (Layer 1).

Asserts (per the approved plan):
- retained points sit on real wood: >= 97% within r_min of a GT cylinder surface;
- strays/ground removed: <= 2% of retained points farther than 5*r_min;
- deterministic: identical output on a repeat run.

Uses hand-built synthetic trees (no external data). Ground is added as a flat
slab and outliers as scattered points; preprocessing must strip both while
keeping the tree.
"""

from __future__ import annotations

import numpy as np
import pytest

from qsm.preprocess import (
    PreprocessOptions,
    largest_connected_component_mask,
    run_preprocess,
    statistical_outlier_mask,
    voxel_downsample,
)
from qsm.validation.metrics import point_to_cylinder_surface_distance
from qsm.validation.synthetic import sample_cloud, simple_tree

R_MIN = 0.005


def _add_ground(cloud: np.ndarray, seed: int, n: int = 4000, extent: float = 1.5) -> np.ndarray:
    """A flat ground slab at z~0 below the tree."""
    rng = np.random.default_rng(seed)
    xy = rng.uniform(-extent, extent, (n, 2))
    z = rng.normal(0.0, 0.003, n)  # slight roughness
    ground = np.column_stack([xy, z])
    return np.concatenate([cloud, ground], axis=0)


def _add_outliers(cloud: np.ndarray, seed: int, n: int = 300) -> np.ndarray:
    rng = np.random.default_rng(seed)
    mins, maxs = cloud.min(axis=0) - 0.5, cloud.max(axis=0) + 0.5
    stray = rng.uniform(mins, maxs, (n, 3))
    return np.concatenate([cloud, stray], axis=0)


# --------------------------------------------------------------------------
# unit-level: each filter does what it claims, index-preserving
# --------------------------------------------------------------------------


def test_voxel_downsample_is_deterministic_and_keeps_real_points():
    qsm = simple_tree()
    cloud = sample_cloud(qsm, seed=1)
    a_pts, a_idx = voxel_downsample(cloud, 0.01)
    b_pts, b_idx = voxel_downsample(cloud, 0.01)
    np.testing.assert_array_equal(a_idx, b_idx)
    # kept points are exactly original points (no centroid averaging)
    np.testing.assert_array_equal(a_pts, cloud[a_idx])
    assert len(a_pts) < len(cloud)


def test_sor_mask_removes_far_strays():
    qsm = simple_tree()
    cloud = sample_cloud(qsm, seed=2)
    with_out = _add_outliers(cloud, seed=3, n=200)
    keep = statistical_outlier_mask(with_out, nb_neighbors=20, std_ratio=2.0)
    # Most of the appended outliers (last 200) should be flagged out.
    removed_outliers = np.sum(~keep[len(cloud):])
    assert removed_outliers > 150


def test_connected_component_isolates_main_tree():
    qsm = simple_tree()
    cloud = sample_cloud(qsm, seed=4)
    # Add a detached blob far away.
    blob = cloud[:200] + np.array([5.0, 5.0, 0.0])
    both = np.concatenate([cloud, blob], axis=0)
    density = 0.02
    keep = largest_connected_component_mask(both, radius=3 * density)
    assert keep[: len(cloud)].mean() > 0.95  # tree kept
    assert keep[len(cloud):].mean() < 0.05  # blob dropped


# --------------------------------------------------------------------------
# pipeline-level validation against ground truth
# --------------------------------------------------------------------------


@pytest.fixture
def messy_cloud_and_truth():
    qsm = simple_tree()
    clean = sample_cloud(qsm, seed=10, noise_sigma=0.0008)
    cloud = _add_ground(clean, seed=11)
    cloud = _add_outliers(cloud, seed=12, n=400)
    return cloud, qsm


def test_preprocess_keeps_wood_removes_junk(messy_cloud_and_truth):
    cloud, qsm = messy_cloud_and_truth
    # CSF (ground removal) needs the optional CSF extension; if absent the
    # largest-component + denoise still strip most ground/strays. Run with
    # ground removal on but tolerate its absence.
    opts = PreprocessOptions(target_min_radius=R_MIN)
    res = run_preprocess(cloud, opts)
    print("stages:", res.stages)

    assert len(res.points) > 0
    d = point_to_cylinder_surface_distance(res.points, qsm)
    on_wood = np.mean(d <= R_MIN)
    far = np.mean(d > 5 * R_MIN)
    print(f"on_wood={on_wood:.3f}  far={far:.3f}  kept={len(res.points)}/{len(cloud)}")

    assert on_wood >= 0.97, f"only {on_wood:.3f} of retained points are on wood"
    assert far <= 0.02, f"{far:.3f} of retained points are strays/ground"
    # kept_index maps back into the original cloud
    np.testing.assert_array_equal(res.points, cloud[res.kept_index])


def test_preprocess_is_deterministic(messy_cloud_and_truth):
    cloud, _ = messy_cloud_and_truth
    opts = PreprocessOptions(target_min_radius=R_MIN)
    a = run_preprocess(cloud, opts)
    b = run_preprocess(cloud, opts)
    np.testing.assert_array_equal(a.kept_index, b.kept_index)
    np.testing.assert_array_equal(a.points, b.points)


def test_preprocess_preserves_thin_branches(messy_cloud_and_truth):
    """The rank-2 sub-branches (r~5-10mm) must survive -- voxel size must not
    erase them. Check that retained points still cover the highest-rank wood."""
    cloud, qsm = messy_cloud_and_truth
    res = run_preprocess(cloud, PreprocessOptions(target_min_radius=R_MIN))
    # Distance from each rank-2 cylinder midpoint to the nearest retained point
    # should be small (the branch wasn't wiped out).
    from scipy.spatial import cKDTree

    tree = cKDTree(res.points)
    rank2 = [c for c in qsm.cylinders if c.rank == 2]
    assert rank2
    mids = np.array([c.midpoint for c in rank2])
    d, _ = tree.query(mids)
    # within ~2 voxels of a retained point
    assert np.median(d) < 0.02
