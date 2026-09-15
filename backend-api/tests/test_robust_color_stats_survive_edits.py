"""The colorbar's outlier-resistant domains must survive an EDIT, not just import.

THE BUG THIS PINS: `robust_bounds` / `robust_attribute_ranges` were emitted by
exactly one endpoint — cloud-session create. Every edit (crop, filter, bake,
split, segment, label-commit, noise removal) rebuilds the octree through
`_session_rebuild`, whose metadata carried neither. The renderer's rebuild path
(`buildSessionOctreeData` -> `buildPointCloudFromOctree`) reads both straight off
that metadata, so after any edit they came back `undefined` and every colorbar
silently fell back to RAW extrema.

The user-visible shape: import a plot with one noise point 400 m up and the
height colorbar correctly spans 0-3 m. Crop something unrelated — or filter, or
bake a delete — and the colorbar snaps back to 0-400, i.e. the outlier sets the
ramp again and the whole plot renders one flat colour. The feature looks like it
randomly stopped working, with nothing on screen to explain why.

Recomputing (rather than carrying the import values forward) is also the only
correct answer: cropping the outlier away genuinely changes the percentile, so a
carried-forward value would be stale in the opposite direction.

These drive the REAL chokepoint every edit funnels through.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main  # noqa: E402


def _session(n_real=400, outlier_z=400.0, with_outlier=True):
    """A dense plot spanning z 0..3 plus (optionally) one stray return far above.

    `reflectance` mirrors the z structure so one column exercises the attribute
    path and the bounds path with the same outlier.
    """
    rng = np.random.default_rng(0)
    xy = rng.uniform(0.0, 6.0, size=(n_real, 2))
    z = rng.uniform(0.0, 3.0, size=n_real)
    refl = z * 10.0
    if with_outlier:
        xy = np.vstack([xy, [[3.0, 3.0]]])
        z = np.append(z, outlier_z)
        refl = np.append(refl, outlier_z * 10.0)
    positions = np.column_stack([xy[:, 0], xy[:, 1], z]).astype(np.float64)
    n = positions.shape[0]
    return main.CloudSession(
        session_id="t", source_path="mem", ascii_format=None, column_plan=None,
        positions=positions, colors=None, intensity=None,
        extras={"reflectance": refl.astype(np.float32)},
        extra_dims_meta=[{"slug": "reflectance", "label": "Reflectance"}],
        world_shift=None, deleted=np.zeros(n, dtype=bool),
        deleted_history=[], octree_cache_id=None, created_at=0.0, last_accessed=0.0,
    )


def test_rebuild_metadata_carries_the_robust_domains():
    """The regression itself, asserted on the SHIPPED path.

    This drives `_session_rebuild` — the one function every edit funnels through
    and the thing the renderer actually reads — rather than the helper it calls.
    Testing the helper alone passes even with the wiring deleted, which is the
    exact bug: the helper was never the broken part, the metadata was.

    Runs the real PotreeConverter, so it is slower than its siblings; that is the
    price of asserting on the real chokepoint instead of a stand-in.
    """
    sess = _session()
    _, _, meta = main._session_rebuild(sess)
    assert "robust_bounds" in meta, (
        "the edit chokepoint dropped robust_bounds — every colorbar silently "
        "reverts to raw extrema after a crop/filter/bake"
    )
    assert "robust_attribute_ranges" in meta
    assert "reflectance" in meta["robust_attribute_ranges"]
    # And the values are the outlier-resistant ones, not the raw box.
    assert meta["robust_bounds"]["max"][2] < 10.0


def test_rebuild_metadata_keeps_its_existing_keys():
    """The new keys must be additive — observed_classes and the octree metadata
    the renderer needs are still there."""
    sess = _session()
    cache_key, cache_dir, meta = main._session_rebuild(sess)
    assert "observed_classes" in meta
    assert meta.get("point_count", 0) > 0
    assert cache_key and cache_dir


def test_the_lone_outlier_does_not_set_the_domain_after_an_edit():
    stats = main._session_robust_color_stats_locked(_session())
    # z: the plot is 0..3 with one point at 400. Raw max would be 400.
    assert stats["robust_bounds"]["max"][2] < 10.0
    assert stats["robust_bounds"]["max"][2] > 2.0
    # reflectance: same story, scaled 10x.
    lo, hi = stats["robust_attribute_ranges"]["reflectance"]
    assert hi < 100.0


def test_deleting_points_re_measures_rather_than_carrying_stale_values():
    """Recompute, don't carry forward. Cropping the plot down to its lower half
    must TIGHTEN the domain — a value carried over from import would still
    describe the taller cloud that no longer exists."""
    sess = _session(with_outlier=False)
    before = main._session_robust_color_stats_locked(sess)["robust_bounds"]["max"][2]
    sess.deleted = sess.positions[:, 2] > 1.5
    after = main._session_robust_color_stats_locked(sess)["robust_bounds"]["max"][2]
    assert after < before - 1.0


def test_sky_miss_points_are_excluded():
    """A miss sits ~1 km out along the beam and would dominate the percentile
    exactly as it dominates the raw box."""
    sess = _session(with_outlier=False)
    n = sess.positions.shape[0]
    sess.positions = np.vstack([sess.positions, [[0.0, 0.0, 1000.0]]])
    sess.extras = {k: np.append(v, 0.0).astype(np.float32) for k, v in sess.extras.items()}
    sess.extras[main._MISS_SLUG] = np.concatenate(
        [np.zeros(n, dtype=np.float32), [1.0]]
    )
    sess.deleted = np.zeros(n + 1, dtype=bool)
    stats = main._session_robust_color_stats_locked(sess)
    assert stats["robust_bounds"]["max"][2] < 10.0


def test_an_all_deleted_session_reports_nothing_rather_than_raising():
    sess = _session()
    sess.deleted = np.ones(sess.positions.shape[0], dtype=bool)
    assert main._session_robust_color_stats_locked(sess) == {}


def test_the_miss_column_itself_is_not_offered_as_a_colour_domain():
    """`is_miss` is a flag, and the octree is hits-only, so its surviving values
    are all 0 — a degenerate column the helper must omit rather than emit as a
    zero-width range."""
    sess = _session(with_outlier=False)
    n = sess.positions.shape[0]
    sess.extras[main._MISS_SLUG] = np.zeros(n, dtype=np.float32)
    ranges = main._session_robust_color_stats_locked(sess)["robust_attribute_ranges"]
    assert main._MISS_SLUG not in ranges
