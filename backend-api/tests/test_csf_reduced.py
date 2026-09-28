"""CSF on one point per cloth particle gives CSF's own labels for every point.

`csf_reduced` runs the Cloth Simulation Filter on the points its cloth can
depend on (the bounding-box extremes and, per particle, the nearest point)
and labels the rest against the settled cloth with CSF's `c2cdist`
arithmetic. These tests compare it with plain CSF on the whole cloud.

The one allowed difference is a point exactly on the threshold, which CSF
itself decides by floating-point rounding; the fixtures here keep elevations
off a regular grid, so none should occur.
"""
import os
import tempfile

import numpy as np
import pytest

import csf_reduced as cr

CSF = pytest.importorskip("CSF")


def _plain(points, *, cloth_resolution, rigidness, class_threshold, iterations,
           slope_smooth, time_step):
    csf = CSF.CSF()
    csf.params.bSloopSmooth = slope_smooth
    csf.params.cloth_resolution = cloth_resolution
    csf.params.rigidness = rigidness
    csf.params.class_threshold = class_threshold
    csf.params.time_step = time_step
    csf.params.interations = iterations
    csf.setPointCloud(np.ascontiguousarray(points[:, :3], dtype=np.float64))
    g, ng = CSF.VecInt(), CSF.VecInt()
    prev = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            os.chdir(tmp)
            csf.do_filtering(g, ng)
        finally:
            os.chdir(prev)
    m = np.zeros(len(points), dtype=bool)
    m[np.fromiter(g, np.int64, len(g))] = True
    return m


def _plot(n=150_000, seed=0):
    """Sloped, rolling terrain under stems and crowns, at a terrestrial scan's
    1/r^2 density (log-uniform range), plus exact duplicate points so ties in
    the nearest-point choice are exercised."""
    rng = np.random.default_rng(seed)
    r = np.exp(rng.uniform(np.log(0.3), np.log(25.0), n))
    th = rng.uniform(0, 2 * np.pi, n)
    x, y = r * np.cos(th), r * np.sin(th)
    ground = 0.05 * x + 0.3 * np.sin(y * 0.3)
    z = ground + np.where(rng.random(n) < 0.6, rng.normal(0, 0.01, n), rng.uniform(0.2, 8, n))
    pts = np.column_stack([x, y, z])
    return np.vstack([pts, pts[: n // 20]])


PARAMS = [
    dict(cloth_resolution=0.5, rigidness=3, class_threshold=0.1, iterations=500,
         slope_smooth=False, time_step=0.65),
    dict(cloth_resolution=0.2, rigidness=2, class_threshold=0.05, iterations=300,
         slope_smooth=True, time_step=0.65),
    dict(cloth_resolution=1.0, rigidness=1, class_threshold=0.3, iterations=500,
         slope_smooth=True, time_step=0.65),
]


@pytest.mark.parametrize("params", PARAMS, ids=lambda p: f"res{p['cloth_resolution']}")
def test_labels_match_plain_csf_on_the_whole_cloud(params):
    pts = _plot()
    ref = _plain(pts, **params)
    got, grid, cloth, n_reps = cr.segment(pts, **params)
    assert n_reps < len(pts) / 5, "the cloth must see far fewer points than the cloud"
    assert 0 < ref.sum() < len(pts)
    assert np.array_equal(got, ref), f"{int((got != ref).sum())} labels differ"


def test_the_grid_and_cloth_are_csfs_own():
    pts = _plot(40_000)
    p = PARAMS[0]
    grid, cloth, reps = cr.settle_cloth(pts, **p)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    res = p["cloth_resolution"]
    assert grid.origin_x == lo[0] - 2 * res and grid.origin_y == lo[1] - 2 * res
    assert grid.width == int(np.floor((hi[0] - lo[0]) / res)) + 4
    assert cloth.shape == (grid.height, grid.width)
    # The six bounding-box extremes are always handed to CSF.
    for d in range(3):
        assert int(np.argmin(pts[:, d])) in set(reps.tolist())
        assert int(np.argmax(pts[:, d])) in set(reps.tolist())
    # The node table is x / y / elevation with the cloth under the points.
    nodes = cr.cloth_nodes(grid, cloth)
    assert nodes.shape == (grid.width * grid.height, 3)
    assert np.median(nodes[:, 2]) < np.median(pts[:, 2])


def test_the_particle_choice_keeps_near_ties():
    """Two points equidistant from a particle both reach CSF, in input order,
    so CSF's first-wins rule picks the same one it would among all points."""
    g = cr.ClothGrid(origin_x=0.0, origin_y=0.0, step=1.0, width=4, height=4)
    pts = np.array([[1.2, 1.0, 5.0], [0.8, 1.0, 3.0], [1.45, 1.0, 1.0],
                     [3.0, 3.0, 0.0]], dtype=np.float64)
    reps = cr.representative_indices(pts, g).tolist()
    assert 0 in reps and 1 in reps          # the tie at distance 0.2
    assert 2 not in reps                    # 0.45 away: never CSF's choice
    assert 3 in reps                        # max x and min z: a bounding-box extreme


def test_points_on_the_far_edge_of_a_grid_aligned_cloud():
    """A cloud whose extent is (nearly) a whole number of cloth cells puts its
    far-corner points on col0 + 1 == width; CSF reads past its row there and,
    on the last row, past its array. Labeling must not raise, and must agree
    with CSF wherever CSF's own read is defined."""
    xs = np.arange(20) * 0.1
    g = np.array([(x, y, 0.0) for x in xs for y in xs])
    blob = np.array([(0.5 + i * 0.05, 0.5 + j * 0.05, 1.0) for i in range(5) for j in range(5)])
    pts = np.vstack([g, blob])
    p = dict(cloth_resolution=0.1, rigidness=3, class_threshold=0.02, iterations=500,
             slope_smooth=False, time_step=0.65)
    got, grid, cloth, _ = cr.segment(pts, **p)
    ref = _plain(pts, **p)
    assert got[:400].all() and not got[400:].any()
    edge = (pts[:, 0] >= xs[-1] - 1e-9) & (pts[:, 1] >= xs[-1] - 1e-9)
    assert np.array_equal(got[~edge], ref[~edge])
