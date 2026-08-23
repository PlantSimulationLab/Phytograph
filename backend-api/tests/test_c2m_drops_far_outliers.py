"""The inline `points` branch of C2M must drop sky/miss returns.

The `source` branch is filtered server-side by `_read_points_from_source
(include_misses=False)`. The inline branch is passed through VERBATIM, so
nothing but the caller guaranteed misses were gone -- and the renderer was
shipping raw positions to both `/api/c2m/distance` and `/api/c2m/icp`.

This is worse than the usual hang: it produces a confident wrong answer. Both
endpoints scale off the cloud's extent -- the coverage threshold from the robust
diagonal, the ICP pre-alignment from the centroid. Measured on a real vineyard
scan (21.06M points, 61% misses):

    robust diagonal   64,207 m  (with misses)  vs      29.3 m  (hits only)
    max_corr @ 5%      3,210 m                          1.47 m
    centroid       [-27, -243, 5041]              [-18, 0, -1]

so C2M reported coverage against a threshold ~2,192x too generous and ICP
pre-aligned to a centroid 5 km out in Z. The renderer now filters, but a stale
client or a direct API caller must not be able to reintroduce it.
"""
import numpy as np

import main


def _cloud_with_misses(n_hits=400, n_miss=600, seed=0):
    """A compact cloud plus a ~1 km miss shell -- the real shape, majority-miss."""
    rng = np.random.default_rng(seed)
    hits = rng.uniform(-5.0, 5.0, (n_hits, 3))
    # Misses: a ray that hit nothing, projected ~1 km out along its beam.
    dirs = rng.normal(size=(n_miss, 3))
    dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
    misses = dirs * rng.uniform(900.0, 1100.0, (n_miss, 1))
    return hits, np.vstack([hits, misses])


def test_drop_far_outliers_recovers_the_true_extent():
    hits, mixed = _cloud_with_misses()
    kept = main._drop_far_outliers(mixed)

    # Every survivor is a real return...
    assert len(kept) == len(hits)
    assert np.abs(kept).max() < 50.0
    # ...and the extent it implies matches the hits, not the shell.
    assert main._robust_cloud_diagonal(kept) < 2.0 * main._robust_cloud_diagonal(hits)


def test_miss_shell_would_have_inflated_the_diagonal():
    """Guard the premise -- if misses were harmless the test above is moot."""
    hits, mixed = _cloud_with_misses()
    assert (main._robust_cloud_diagonal(mixed)
            > 50.0 * main._robust_cloud_diagonal(hits))


def test_c2m_distance_inline_branch_is_guarded():
    """Pin the call site: `/api/c2m/distance` must filter its inline array."""
    src = open(main.__file__, encoding="utf-8").read()
    start = src.index("def _do_c2m_distance")
    block = src[start:start + 4000]
    assert "_drop_far_outliers(" in block, "inline c2m distance lost its guard"


def test_c2m_icp_inline_branch_is_guarded():
    src = open(main.__file__, encoding="utf-8").read()
    start = src.index("def _do_c2m_icp")
    block = src[start:start + 4000]
    assert "_drop_far_outliers(" in block, "inline c2m icp lost its guard"
