"""Outlier-resistant ground level (`_robust_ground_z`).

`positions[:, 2].min()` is what the UI used to treat as "ground" — the default
scene origin's height, the ground grid, the fallback pick plane. A single
erroneous return below the terrain (multipath, a bird, a scanner artefact) drags
that arbitrarily far down, visibly sinking the ground reference on real scans.

`_robust_ground_z` takes a low percentile instead, with a guard so it can never
cut into real terrain on a steep site. These tests pin both halves of that
trade-off: noise is rejected, signal is not.
"""
import numpy as np
import pytest

from main import _GROUND_PERCENTILE, _robust_ground_z


def _cloud(z, n_xy=None):
    """Build an (N,3) cloud from a Z array; X/Y are irrelevant to the estimate."""
    z = np.asarray(z, dtype=np.float64)
    n = z.size if n_xy is None else n_xy
    xy = np.zeros((n, 2), dtype=np.float64)
    return np.column_stack([xy, z])


class TestRejectsLowOutliers:
    def test_a_few_points_below_ground_do_not_move_the_estimate(self):
        # 10k points of "terrain" at z=0..2, plus 5 noise points 30 m below.
        rng = np.random.default_rng(0)
        ground = rng.uniform(0.0, 2.0, 10_000)
        noise = np.array([-30.0, -28.0, -25.0, -31.5, -29.0])
        pts = _cloud(np.concatenate([ground, noise]))

        got = _robust_ground_z(pts)

        # The true min is -31.5 and is exactly what we must NOT return.
        assert pts[:, 2].min() == pytest.approx(-31.5)
        # The estimate sits in the real terrain band instead.
        assert 0.0 <= got <= 0.2, got

    def test_scales_with_the_noise_count_up_to_the_percentile(self):
        # 0.4% noise — still under the 0.5th-percentile cut, so still rejected.
        rng = np.random.default_rng(1)
        ground = rng.uniform(10.0, 12.0, 10_000)
        noise = np.full(40, -5.0)
        pts = _cloud(np.concatenate([ground, noise]))

        got = _robust_ground_z(pts)

        assert got >= 10.0, got

    def test_single_stray_point_far_below(self):
        # The reported case: one bad point, a long way down.
        ground = np.linspace(5.0, 6.0, 5_000)
        pts = _cloud(np.concatenate([ground, [-500.0]]))

        got = _robust_ground_z(pts)

        assert got == pytest.approx(5.0, abs=0.05)


class TestPreservesRealTerrain:
    def test_a_steep_site_barely_moves_off_its_true_minimum(self):
        # Uniformly distributed over 50 m of relief and no outliers: the low tail
        # is SIGNAL. Here the percentile is *allowed* (it is a tiny fraction of
        # the real content height) but it barely matters — with no gap between
        # the minimum and the bulk, p0.5 sits ~0.5% of the relief above the min.
        # The property that matters is that we do not clip meaningful terrain.
        rng = np.random.default_rng(2)
        pts = _cloud(rng.uniform(0.0, 50.0, 20_000))
        z_min = float(pts[:, 2].min())

        got = _robust_ground_z(pts)

        assert got - z_min < 50.0 * 0.01, got - z_min

    def test_a_dense_low_tail_is_kept_as_terrain(self):
        # A third of the cloud lies in a lower tier (a terrace, a pit, a lower
        # storey). That is structure, not noise: the estimate must stay at the
        # true floor rather than jumping up to the dense upper tier.
        rng = np.random.default_rng(5)
        lower = rng.uniform(0.0, 1.0, 6_000)
        upper = rng.uniform(20.0, 21.0, 12_000)
        pts = _cloud(np.concatenate([lower, upper]))

        got = _robust_ground_z(pts)

        assert got < 1.0, got

    def test_flat_cloud_returns_that_level(self):
        pts = _cloud(np.full(1_000, 7.25))
        assert _robust_ground_z(pts) == pytest.approx(7.25)

    def test_never_returns_below_the_true_minimum(self):
        # A percentile of the data can never sit under the data. Cheap invariant,
        # but it is the one that keeps the ground reference from going backwards.
        rng = np.random.default_rng(3)
        for scale in (0.5, 5.0, 500.0):
            z = rng.normal(0.0, scale, 5_000)
            got = _robust_ground_z(_cloud(z))
            assert got >= float(z.min()) - 1e-9, (scale, got)

    def test_at_most_the_configured_fraction_of_points_lie_below(self):
        # The defining property: `_GROUND_PERCENTILE`% of points may sit below the
        # reported ground, and no more. This is what bounds how much real terrain
        # the estimate can ever discard.
        rng = np.random.default_rng(6)
        z = np.concatenate([rng.uniform(0.0, 3.0, 20_000), rng.uniform(-40.0, -35.0, 50)])
        pts = _cloud(z)

        got = _robust_ground_z(pts)

        # np.percentile interpolates between adjacent order statistics, so the
        # fraction strictly below can exceed the nominal percentile by up to one
        # point's worth. Allow that, not an arbitrary fudge factor.
        one_point_pct = 100.0 / z.size
        below = float((z < got).sum()) / z.size * 100.0
        assert below <= _GROUND_PERCENTILE + one_point_pct, below


class TestDegenerateInputs:
    def test_empty_cloud_returns_none(self):
        assert _robust_ground_z(np.zeros((0, 3))) is None

    def test_none_returns_none(self):
        assert _robust_ground_z(None) is None

    def test_non_finite_z_is_ignored(self):
        z = np.array([np.nan, np.inf, -np.inf, 3.0, 3.1, 3.2])
        got = _robust_ground_z(_cloud(z))
        # NaN/inf must not propagate, and must not be treated as the minimum.
        assert got is not None and np.isfinite(got)
        assert got == pytest.approx(3.0, abs=0.05)

    def test_all_non_finite_returns_none(self):
        assert _robust_ground_z(_cloud([np.nan, np.inf])) is None

    def test_single_point(self):
        assert _robust_ground_z(_cloud([2.5])) == pytest.approx(2.5)


class TestCost:
    def test_is_a_single_cheap_pass_on_a_large_cloud(self):
        # This runs on the import path, so it must not be a sort. np.percentile
        # uses introselect (O(n)); assert the wall time stays small for 5M points
        # to catch anyone swapping in an O(n log n) implementation.
        import time

        rng = np.random.default_rng(4)
        pts = _cloud(rng.uniform(0.0, 30.0, 5_000_000))
        t0 = time.perf_counter()
        _robust_ground_z(pts)
        elapsed = time.perf_counter() - t0

        # Generous bound — the point is to catch an order-of-magnitude change,
        # not to benchmark the machine.
        assert elapsed < 2.0, f"{elapsed:.3f}s for 5M points"
