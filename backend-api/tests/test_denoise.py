"""Noise-filter masks: `backend-api/denoise.py`.

The fixture (`noisy_tree_fixture.build_noisy_tree`) is bimodal in density on
purpose — a dense trunk plus a sparse twig population — because that is the
property that separates the three methods. Several assertions here are
CHARACTERIZATION tests: they record what each method actually does to fine
structure, so a parameter change that quietly starts eating twigs fails loudly.
"""

from __future__ import annotations

import numpy as np
import pytest

import denoise
from denoise import (
    NOISE_CLEAN,
    NOISE_NOISE,
    denoise_labels,
    denoise_mask,
    radius_outlier_mask,
    statistical_outlier_mask,
    voxel_count_mask,
)
from tests.noisy_tree_fixture import build_noisy_tree


@pytest.fixture(scope="module")
def tree():
    return build_noisy_tree()


def flagged_per_group(keep, groups):
    bad = np.where(~keep)[0]
    return {name: int(np.isin(bad, idx).sum()) for name, idx in groups.items()}


# --- 1. shape / partition invariants ----------------------------------------

@pytest.mark.parametrize("method", denoise.METHODS)
def test_mask_is_a_bool_keep_mask_aligned_to_the_input(tree, method):
    points, _ = tree
    keep, stats = denoise_mask(points, method)
    assert keep.dtype == bool
    assert keep.shape == (len(points),)
    # kept + flagged partitions the input exactly — nothing invented, nothing lost.
    assert int(keep.sum()) + int((~keep).sum()) == len(points)
    assert stats["kept"] + stats["flagged"] == stats["total"] == len(points)


# --- 2. what each method flags on the full cloud ----------------------------

def test_ror_flags_exactly_the_isolated_flyers(tree):
    """The default method: it must take the 25 genuine flyers and nothing else —
    no trunk, and above all no twig points."""
    points, groups = tree
    keep, stats = denoise_mask(points, "ror")
    assert stats["flagged"] == 25
    assert np.array_equal(np.where(~keep)[0], groups["flyers"])
    assert flagged_per_group(keep, groups) == {
        "trunk": 0, "twigs": 0, "flyers": 25, "clump": 0}


def test_sor_also_catches_the_self_supporting_clump(tree):
    """SOR's one genuine advantage: the 8-point clump is dense enough to satisfy
    a radius rule but its k-th neighbour is still metres away."""
    points, groups = tree
    keep, stats = denoise_mask(points, "sor")
    assert stats["flagged"] == 33
    assert flagged_per_group(keep, groups) == {
        "trunk": 0, "twigs": 0, "flyers": 25, "clump": 8}


def test_ror_and_voxel_count_both_miss_the_clump(tree):
    """Documents the known gap that small-cluster removal would close: noise that
    supports itself defeats every purely local density criterion."""
    points, groups = tree
    for method in ("ror", "voxel_count"):
        keep, _ = denoise_mask(points, method)
        assert flagged_per_group(keep, groups)["clump"] <= 1, method


def test_voxel_count_is_coarser_at_branch_ends(tree):
    """The O(N) method's documented cost: a twig point whose branch end falls
    alone in a voxel is flagged. It still takes every flyer and no trunk point."""
    points, groups = tree
    keep, _ = denoise_mask(points, "voxel_count")
    per = flagged_per_group(keep, groups)
    assert per["flyers"] == 25
    assert per["trunk"] == 0
    assert per["twigs"] == 24  # ~7% of the twig population, at the branch ends


# --- 3. the design argument, pinned -----------------------------------------

def test_sor_second_pass_eats_fine_structure(tree):
    """THE regression test for `denoise`'s "why ror, not sor" docstring.

    SOR thresholds on `mean + std_ratio*std` over the whole cloud, so its
    threshold is set by the most extreme population present. With the flyers in,
    the twigs clear it comfortably. Remove the flyers — which is exactly what a
    successful denoise does — and the threshold collapses onto the twigs.

    If this fails because someone restored the open3d default of std_ratio=2.0,
    read the module docstring before "fixing" the test.
    """
    points, groups = tree
    clean = points[np.concatenate([groups["trunk"], groups["twigs"]])]
    n_trunk = len(groups["trunk"])

    def twigs_lost(std_ratio):
        keep, _ = denoise_mask(clean, "sor", {"std_ratio": std_ratio})
        bad = np.where(~keep)[0]
        assert (bad >= n_trunk).all(), "SOR should never reach the dense trunk"
        return len(bad)

    # The conventional default destroys most of the fine structure on pass 2...
    assert twigs_lost(2.0) == 264          # 73% of the 360 twig points
    # ...the shipped default is much safer but still not safe...
    assert twigs_lost(denoise.DEFAULT_SOR_STD_RATIO) == 48
    # ...and monotonically less aggressive as the ratio rises.
    assert twigs_lost(2.0) > twigs_lost(3.0) > twigs_lost(4.0) > twigs_lost(6.0) == 0


def test_ror_is_idempotent_on_an_already_clean_cloud(tree):
    """The property SOR lacks: a local criterion gives the same answer no matter
    what else was removed, so re-running it is free rather than destructive."""
    points, groups = tree
    keep, _ = denoise_mask(points, "ror")
    survivors = points[keep]
    again, stats = denoise_mask(survivors, "ror")
    assert stats["flagged"] == 0
    assert again.all()


def test_sor_warns_when_re_run_on_an_already_denoised_cloud(tree):
    points, _ = tree
    _, plain = denoise_mask(points, "sor")
    _, rerun = denoise_mask(points, "sor", previously_denoised=True)
    assert not any("already been denoised" in w for w in plain["warnings"])
    assert any("already been denoised" in w for w in rerun["warnings"])
    # Only SOR gets more aggressive on a second pass, so only SOR warns.
    _, ror_rerun = denoise_mask(points, "ror", previously_denoised=True)
    assert not any("already been denoised" in w for w in ror_rerun["warnings"])


# --- 4. refactor guards ------------------------------------------------------

def test_chunked_query_matches_one_shot(tree):
    """Pins the chunking added so these survive a real scan: chunking is a memory
    optimisation and must not change a single bit of the answer."""
    points, _ = tree
    for chunked, whole in (
        (statistical_outlier_mask(points, 20, 2.0, chunk=7),
         statistical_outlier_mask(points, 20, 2.0, chunk=10 ** 9)),
        (radius_outlier_mask(points, 2, 0.15, chunk=7),
         radius_outlier_mask(points, 2, 0.15, chunk=10 ** 9)),
    ):
        assert np.array_equal(chunked, whole)


def test_voxel_count_mask_matches_the_legacy_registration_filter():
    """`main._reject_sparse_voxels` now delegates here. Pins the swap from
    `np.unique(axis=0)` to a packed int64 key against the original behaviour."""
    import main

    # A deterministic lattice plus sparse scatter — over the 1000-point floor and
    # over the 25% retention bail-out that `_reject_sparse_voxels` keeps.
    g = np.arange(15) * 0.05
    xx, yy, zz = np.meshgrid(g, g, g[:8], indexing="ij")
    dense = np.column_stack([xx.ravel(), yy.ravel(), zz.ravel()])
    scatter = np.column_stack([np.arange(40) * 3.0, np.zeros(40), np.full(40, 20.0)])
    points = np.vstack([dense, scatter])

    keep = voxel_count_mask(points, 0.10, 2)
    assert np.array_equal(points[keep], main._reject_sparse_voxels(points, 0.10, 2))
    assert keep[:len(dense)].all()          # lattice survives
    assert not keep[len(dense):].any()      # scatter goes


def test_voxel_count_mask_packed_and_unpacked_keys_agree(tree):
    """The int64-overflow fallback must give the same answer as the fast path."""
    points, _ = tree
    fast = voxel_count_mask(points, 0.25, 2)
    key = np.floor((points - points.min(axis=0)) / 0.25).astype(np.int64)
    _, inverse, counts = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    assert np.array_equal(fast, counts[inverse] >= 2)


# --- 5. auto parameters ------------------------------------------------------

def test_auto_params_derive_from_the_p95_spacing_not_the_median(tree):
    """The radius must be sized off the SPARSE tail. On this fixture the median
    NN distance is the 1 cm trunk and p95 is the 5 cm twigs; a median-derived
    radius would be 5x too small and would flag the twigs."""
    points, _ = tree
    params, p50, p95 = denoise.resolve_params(points, "ror")
    assert p50 == pytest.approx(0.01, abs=1e-3)
    assert p95 == pytest.approx(0.05, abs=1e-3)
    assert params["radius"] == pytest.approx(3.0 * p95, rel=1e-6)
    assert params["nb_points"] == denoise.DEFAULT_ROR_NB_POINTS

    voxel_params, _, _ = denoise.resolve_params(points, "voxel_count")
    assert voxel_params["voxel"] == pytest.approx(5.0 * p95, rel=1e-6)


def test_explicit_params_are_never_overridden_by_auto(tree):
    points, _ = tree
    params, _, _ = denoise.resolve_params(points, "ror", {"radius": 0.9, "nb_points": 7})
    assert params == {"radius": 0.9, "nb_points": 7}


def test_auto_params_clamp_and_fall_back_when_spacing_is_unmeasurable():
    # Fewer than 100 points: no spacing estimate is possible, so the documented
    # literals stand in rather than something arbitrary.
    tiny = np.zeros((10, 3))
    params, p50, p95 = denoise.resolve_params(tiny, "voxel_count")
    assert p50 is None and p95 is None
    assert params["voxel"] == denoise._FALLBACK_VOXEL_M


# --- 6. guardrails and edge cases -------------------------------------------

def test_non_finite_rows_are_flagged_rather_than_crashing(tree):
    """cKDTree RAISES on non-finite input, so an unguarded NaN is a crash."""
    points, _ = tree
    poisoned = np.vstack([points, [[np.nan, 0, 0], [0, np.inf, 0]]])
    keep, stats = denoise_mask(poisoned, "ror")
    assert stats["non_finite"] == 2
    assert not keep[-1] and not keep[-2]
    # The finite rows are judged exactly as they were without the poison.
    baseline, _ = denoise_mask(points, "ror")
    assert np.array_equal(keep[:len(points)], baseline)


def test_too_few_points_is_rejected():
    with pytest.raises(ValueError, match="at least 1000"):
        denoise_mask(np.zeros((50, 3)), "ror")


def test_unknown_method_is_rejected(tree):
    points, _ = tree
    with pytest.raises(ValueError, match="unknown noise method"):
        denoise_mask(points, "magic")


def test_over_removal_is_reported_but_never_refused(tree):
    """Detect is non-destructive, so an aggressive result must come back with a
    warning rather than an error — the guard belongs on the destructive commit."""
    points, _ = tree
    keep, stats = denoise_mask(points, "ror", {"radius": 0.011, "nb_points": 40})
    assert stats["fraction"] > denoise.OVER_REMOVAL_FRACTION
    assert stats["over_removal"] is True
    assert any("too aggressive" in w for w in stats["warnings"])
    assert int((~keep).sum()) == stats["flagged"]


def test_results_are_deterministic(tree):
    points, _ = tree
    for method in denoise.METHODS:
        first, _ = denoise_mask(points, method)
        second, _ = denoise_mask(points, method)
        assert np.array_equal(first, second), method


# --- 7. the label shape the worker/endpoint consume -------------------------

def test_denoise_labels_returns_two_classes_and_fills_meta(tree):
    points, groups = tree
    meta: dict = {}
    labels = denoise_labels(points, "ror", meta)
    assert labels.dtype == np.int64
    assert set(np.unique(labels)) == {NOISE_CLEAN, NOISE_NOISE}
    assert int((labels == NOISE_NOISE).sum()) == 25
    assert (labels[groups["flyers"]] == NOISE_NOISE).all()
    assert (labels[groups["twigs"]] == NOISE_CLEAN).all()
    assert meta["method"] == "ror" and meta["flagged"] == 25
    assert "params_used" in meta and "spacing_m" in meta
