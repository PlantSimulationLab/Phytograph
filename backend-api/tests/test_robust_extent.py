"""Outlier-resistant scene extent (`_robust_extent`).

The renderer scales the camera's zoom limits from the scene size. Taken from the
raw bounding box, that size is set by the single most extreme point on each axis,
so a handful of stray returns hundreds of metres out make the scene
un-navigable: you can't get close enough to inspect anything, and the far limit
sits out where the real data is a dot.

`_robust_extent` reports a per-axis percentile span instead, so a thin tail at
either end of any axis is ignored while the real content still sets the answer.
These tests pin both halves: noise is rejected, structure is not.
"""
import numpy as np
import pytest

from main import (
    _EXTENT_HIGH_PERCENTILE,
    _EXTENT_LOW_PERCENTILE,
    _robust_aabb,
    _robust_extent,
)


def _grid(nx=25, ny=25, nz=25, span=(10.0, 10.0, 4.0)):
    """A dense axis-aligned block of points spanning `span`, starting at 0."""
    xs = np.linspace(0.0, span[0], nx)
    ys = np.linspace(0.0, span[1], ny)
    zs = np.linspace(0.0, span[2], nz)
    gx, gy, gz = np.meshgrid(xs, ys, zs, indexing="ij")
    return np.column_stack([gx.ravel(), gy.ravel(), gz.ravel()])


def test_reports_the_real_span_on_a_clean_cloud():
    ext = _robust_extent(_grid(span=(10.0, 6.0, 4.0)))
    # A percentile span trims a sliver of a uniform block, so it lands just under
    # the true extent rather than exactly on it.
    assert ext[0] == pytest.approx(10.0, rel=0.05)
    assert ext[1] == pytest.approx(6.0, rel=0.05)
    assert ext[2] == pytest.approx(4.0, rel=0.05)


def test_rejects_far_outliers_on_every_axis_at_once():
    """The case the median-of-axes heuristic cannot handle.

    With strays in X, Y AND Z, every axis of the bounding box is inflated, so
    there is no clean axis left to fall back on — only looking at the point
    distribution works.
    """
    cloud = _grid(span=(6.0, 6.0, 3.0))
    outliers = np.array([
        [500.0, 3.0, 1.0],
        [-480.0, 2.0, 0.5],
        [3.0, 505.0, 1.2],
        [2.0, -495.0, 0.8],
        [3.0, 3.0, 400.0],
    ])
    noisy = np.vstack([cloud, outliers])

    raw = noisy[:, :3].max(axis=0) - noisy[:, :3].min(axis=0)
    assert raw.max() > 500  # the bounding box really is inflated ~100x

    ext = _robust_extent(noisy)
    assert ext[0] == pytest.approx(6.0, rel=0.05)
    assert ext[1] == pytest.approx(6.0, rel=0.05)
    assert ext[2] == pytest.approx(3.0, rel=0.05)


def test_a_single_sky_point_does_not_inflate_z():
    """A miss projected ~1 km up is the recurring shape of this bug."""
    cloud = np.vstack([_grid(span=(8.0, 8.0, 3.0)), np.array([[4.0, 4.0, 1000.0]])])
    assert _robust_extent(cloud)[2] == pytest.approx(3.0, rel=0.05)


def test_real_structure_is_not_trimmed_away():
    """A genuinely tall scene must report its real height.

    The percentile is self-correcting: when the tail is real structure it holds
    far more than 1% of the points, so the cut lands inside it and the estimate
    stays large. A canopy is not noise.
    """
    # A 40 m tall stand — every height is equally populated.
    ext = _robust_extent(_grid(nz=200, span=(20.0, 20.0, 40.0)))
    assert ext[2] > 38.0


def test_a_sparse_far_cluster_below_the_cut_is_still_rejected():
    """Fewer than 1% of points, however many, are tail."""
    cloud = _grid(span=(5.0, 5.0, 2.0))
    n_out = max(1, cloud.shape[0] // 500)  # 0.2% — under the 1% cut
    outliers = np.column_stack([
        np.full(n_out, 900.0), np.full(n_out, 900.0), np.full(n_out, 900.0),
    ])
    ext = _robust_extent(np.vstack([cloud, outliers]))
    assert ext[0] == pytest.approx(5.0, rel=0.05)
    assert ext[2] == pytest.approx(2.0, rel=0.05)


def test_a_dense_second_cluster_is_kept():
    """Two real plots 100 m apart are structure, not noise — the extent spans both."""
    a = _grid(nx=12, ny=12, nz=6, span=(5.0, 5.0, 2.0))
    b = a + np.array([100.0, 0.0, 0.0])
    ext = _robust_extent(np.vstack([a, b]))
    assert ext[0] > 90.0


def test_handles_degenerate_and_empty_input():
    assert _robust_extent(None) is None
    assert _robust_extent(np.empty((0, 3))) is None
    assert _robust_extent(np.empty((0, 2))) is None
    # A single point has zero extent, not an error.
    assert _robust_extent(np.array([[1.0, 2.0, 3.0]])) == [0.0, 0.0, 0.0]


def test_ignores_non_finite_points():
    cloud = np.vstack([
        _grid(span=(4.0, 4.0, 2.0)),
        np.array([[np.nan, 1.0, 1.0], [np.inf, 1.0, 1.0], [1.0, 1.0, np.nan]]),
    ])
    ext = _robust_extent(cloud)
    assert all(np.isfinite(ext))
    assert ext[0] == pytest.approx(4.0, rel=0.05)


def test_extent_is_never_negative():
    ext = _robust_extent(_grid(nx=2, ny=2, nz=2, span=(1.0, 1.0, 1.0)))
    assert all(e >= 0.0 for e in ext)


def test_percentile_bounds_are_symmetric_and_sane():
    assert _EXTENT_LOW_PERCENTILE > 0
    assert _EXTENT_HIGH_PERCENTILE < 100
    assert _EXTENT_LOW_PERCENTILE + _EXTENT_HIGH_PERCENTILE == pytest.approx(100.0)


class TestRobustAabb:
    """The percentile box itself — what the renderer needs to find the CONTENT.

    The raw bounding box's centre is the midpoint of the outliers, which on a
    scene with far strays sits in empty space nowhere near the data. A camera
    that converges on it stalls hundreds of metres short of anything visible.
    """

    def test_centre_tracks_the_content_not_the_outliers(self):
        cloud = _grid(span=(6.0, 6.0, 3.0))  # content centred on (3, 3, 1.5)
        outliers = np.array([
            [500.0, 3.0, 1.0],
            [-480.0, 2.0, 0.5],
            [3.0, 505.0, 1.2],
            [2.0, -495.0, 0.8],
            [3.0, 3.0, 400.0],
        ])
        noisy = np.vstack([cloud, outliers])

        raw_centre = (noisy.min(axis=0) + noisy.max(axis=0)) / 2.0
        box = _robust_aabb(noisy)
        centre = [(box["min"][i] + box["max"][i]) / 2.0 for i in range(3)]

        # The robust centre is on the content...
        assert centre[0] == pytest.approx(3.0, abs=0.3)
        assert centre[1] == pytest.approx(3.0, abs=0.3)
        assert centre[2] == pytest.approx(1.5, abs=0.3)
        # ...and the raw one is badly off, which is the bug being fixed.
        assert abs(raw_centre[2] - 1.5) > 100

    def test_box_matches_the_extent(self):
        cloud = _grid(span=(9.0, 4.0, 2.0))
        box = _robust_aabb(cloud)
        ext = _robust_extent(cloud)
        for i in range(3):
            assert box["max"][i] - box["min"][i] == pytest.approx(ext[i], rel=1e-9)

    def test_never_inverts_on_a_degenerate_axis(self):
        # All points share a Z: the percentile bounds coincide, and must not
        # come back with max < min through floating-point noise.
        cloud = np.column_stack([
            np.linspace(0, 5, 50), np.linspace(0, 5, 50), np.zeros(50),
        ])
        box = _robust_aabb(cloud)
        assert box["max"][2] >= box["min"][2]

    def test_handles_degenerate_and_empty_input(self):
        assert _robust_aabb(None) is None
        assert _robust_aabb(np.empty((0, 3))) is None
        assert _robust_aabb(np.empty((0, 2))) is None

    def test_ignores_non_finite_points(self):
        cloud = np.vstack([
            _grid(span=(4.0, 4.0, 2.0)),
            np.array([[np.nan, 1.0, 1.0], [np.inf, 1.0, 1.0]]),
        ])
        box = _robust_aabb(cloud)
        assert all(np.isfinite(box["min"])) and all(np.isfinite(box["max"]))
