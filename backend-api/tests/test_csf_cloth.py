"""`csf_cloth` is CSF's cloth simulation, ported; with `fill_mode=0` it must
be the wheel's cloth bit for bit, and its default fill may change only the
heights CSF's own per-particle BFS would have chosen.

The fixtures leave rows AND columns of the cloth empty (the 2-particle
buffer always does; `_blobs` does over most of the grid), so CSF's BFS
fallback runs on many particles, not just the corners.
"""
import os
import tempfile
from collections import deque

import numpy as np
import pytest

import csf_cloth as cc
import csf_reduced as cr

CSF = pytest.importorskip("CSF")

from tests.test_csf_reduced import PARAMS, _plain, _plot, one_omp_thread  # noqa: E402


def _wheel_cloth(sub, *, cloth_resolution, rigidness, time_step, iterations,
                 slope_smooth, **_):
    csf = CSF.CSF()
    csf.params.bSloopSmooth = slope_smooth
    csf.params.cloth_resolution = cloth_resolution
    csf.params.rigidness = rigidness
    csf.params.time_step = time_step
    csf.params.interations = iterations
    csf.setPointCloud(np.ascontiguousarray(sub, dtype=np.float64))
    prev = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp, one_omp_thread():
        try:
            os.chdir(tmp)
            flat = np.asarray(csf.do_cloth_export(), dtype=np.float64)
        finally:
            os.chdir(prev)
    return -flat.reshape(-1, 3)[:, 2]


def _blobs(seed=1):
    """Two dense patches in opposite corners of a 30 x 30 m box: most of the
    cloth has no point in its row or its column."""
    rng = np.random.default_rng(seed)
    parts = []
    for cx, cy in ((3.0, 3.0), (27.0, 26.0)):
        n = 4000
        x = cx + rng.uniform(-2.5, 2.5, n)
        y = cy + rng.uniform(-2.5, 2.5, n)
        z = 0.1 * x + np.where(rng.random(n) < 0.7, rng.normal(0, 0.01, n), rng.uniform(0.2, 3, n))
        parts.append(np.column_stack([x, y, z]))
    return np.vstack(parts)


CASES = [(_plot, p) for p in PARAMS] + [
    (_blobs, dict(cloth_resolution=0.5, rigidness=3, iterations=500, slope_smooth=False,
                  time_step=0.65)),
    (_blobs, dict(cloth_resolution=0.25, rigidness=1, iterations=500, slope_smooth=True,
                  time_step=0.65)),
]


@pytest.mark.parametrize("make,params", CASES,
                         ids=lambda c: c.__name__ if callable(c) else f"res{c['cloth_resolution']}")
def test_stock_fill_is_the_wheels_cloth_bit_for_bit(make, params):
    pts = make()
    if make is _plot:
        pts = pts[:40_000]
    got, info = cc.settle(pts, fill_mode=0, **{k: v for k, v in params.items()
                                               if k != "class_threshold"})
    ref = _wheel_cloth(pts, **params)
    assert got.size == ref.size
    assert np.array_equal(got.ravel(), ref), \
        f"max |d| {np.abs(got.ravel() - ref).max()} over {int((got.ravel() != ref).sum())} particles"
    assert info["iterations"] > 1


def _grid_inputs(pts, res):
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    w = int(np.floor((hi[0] - lo[0]) / res)) + 4
    h = int(np.floor((hi[1] - lo[1]) / res)) + 4
    start, nbr = cc._neighbors(w, h)
    args = (np.ascontiguousarray(pts[:, 0]), np.ascontiguousarray(-pts[:, 2]),
            np.ascontiguousarray(pts[:, 1]), lo[0] - 2 * res, lo[1] - 2 * res, res,
            w, h, start, nbr)
    return w, h, start, nbr, args


def test_default_fill_changes_only_bfs_particles_and_stays_hop_nearest():
    pts = _blobs()
    res = 0.5
    w, h, start, nbr, args = _grid_inputs(pts, res)
    hv0, _ = cc.rasterize(*args, 0)
    hv1, _ = cc.rasterize(*args, 1)

    # Which particles hold a point, and which CSF fills by scanline.
    col = ((pts[:, 0] - args[3]) / res + 0.5).astype(int)
    row = ((pts[:, 1] - args[4]) / res + 0.5).astype(int)
    holds = np.zeros(w * h, dtype=bool)
    holds[row * w + col] = True
    grid = holds.reshape(h, w)
    by_bfs = ~(grid.any(axis=1)[:, None] | grid.any(axis=0)[None, :]).ravel()
    assert by_bfs.sum() > 100, "the fixture must exercise CSF's BFS fallback"
    assert np.array_equal(hv0[~by_bfs], hv1[~by_bfs])

    # Every BFS particle gets the height of a point-holding particle at the
    # smallest hop distance over CSF's 16-neighbor links.
    for p in np.flatnonzero(by_bfs)[::7]:
        dist = {p: 0}
        dq = deque([p])
        best, heights = None, set()
        while dq:
            c = dq.popleft()
            if best is not None and dist[c] > best:
                break
            if holds[c]:
                best = dist[c]
                heights.add(hv0[c])
                continue
            for k in range(start[c], start[c + 1]):
                t = int(nbr[k])
                if t not in dist:
                    dist[t] = dist[c] + 1
                    dq.append(t)
        assert hv1[p] in heights
        assert hv0[p] in heights        # CSF's own choice is hop-nearest too


@pytest.mark.parametrize("make,params", CASES[-2:], ids=["rigid", "smooth"])
def test_default_fill_labels_against_plain_csf_on_empty_rows(make, params):
    """On a cloud whose cloth is mostly filled by CSF's BFS, the default fill
    may move a label only where the two fills chose different (equally near)
    heights nearby. On the rigid cloth it does: 13 of 8,000 points on the
    edge of one patch, facing the empty region whose filled heights come
    from either patch (2.4 m apart in elevation). That is the departure, so
    it is bounded here rather than asserted away."""
    pts = make()
    p = dict(params, class_threshold=0.1)
    ref = _plain(pts, **p)
    got, grid, _, _ = cr.segment(pts, **p)
    assert 0 < ref.sum() < len(pts)
    differ = np.flatnonzero(got != ref)
    if params["slope_smooth"]:
        assert differ.size == 0, f"{differ.size} labels differ"
        return
    assert differ.size <= len(pts) // 200, f"{differ.size} labels differ"
    res = params["cloth_resolution"]
    _, _, _, _, args = _grid_inputs(pts, res)
    changed = np.argwhere((cc.rasterize(*args, 0)[0] != cc.rasterize(*args, 1)[0])
                          .reshape(grid.height, grid.width))
    cell = np.column_stack([((pts[differ, 1] - grid.origin_y) / res).astype(int),
                            ((pts[differ, 0] - grid.origin_x) / res).astype(int)])
    nearest = np.sqrt(((cell[:, None, :] - changed[None, :, :]) ** 2).sum(-1)).min(axis=1)
    assert nearest.max() <= 12, f"a label moved {nearest.max():.1f} cells from any changed fill"


def test_particle_positions_round_twice_not_fused():
    """A particle's position is `origin + i * step`, rounded twice. The macOS
    arm64 wheel's compiler fuses that into one FMA; the x86 wheels (Intel
    Mac, Windows, Linux) cannot. On mm-quantized TLS data the two pick
    different points among exact distance ties: here two stem points 2 mm
    from the particle, 2.5 m apart in height. Unfused keeps the first, which
    is the convention the port uses on every platform. (Fused picks the
    4.213 m point; on ExampleScan_01's dense tile at 0.3 m that difference
    moved 195 k of 45.5 M labels, with accuracy on tree_1/tree_4 equal to
    within 0.00006 either way.) Values are that tile's, verbatim."""
    origin_x, origin_z, step, w = -39.598000000000006, -31.594, 0.3, 267
    pts = np.array([[1.5039999999999907, -0.9939999999999998, 1.7320000000000002],
                    [1.5020000000000095, -0.9920000000000044, 4.213]])
    start, nbr = cc._neighbors(w, w)
    hv, _ = cc.rasterize(pts[:, 0].copy(), -pts[:, 2], pts[:, 1].copy(),
                         origin_x, origin_z, step, w, w, start, nbr, 0)
    assert hv[102 * w + 137] == -1.7320000000000002


def test_imports_and_settles_when_numba_has_nowhere_to_cache(monkeypatch):
    """With no usable cache location numba raises at decoration time; the
    module must fall back to compiling per process, not become unimportable
    (which would take ground segmentation and the DEM's auto ground down)."""
    import importlib.util
    from numba.core import caching
    monkeypatch.setattr(caching.CacheImpl, "_locator_classes", [])
    spec = importlib.util.spec_from_file_location("csf_cloth_nocache", cc.__file__)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    pts = np.random.default_rng(0).random((300, 3)) * 5.0
    got, _ = mod.settle(pts, cloth_resolution=0.5, rigidness=3, time_step=0.65,
                        iterations=50, slope_smooth=True)
    ref, _ = cc.settle(pts, cloth_resolution=0.5, rigidness=3, time_step=0.65,
                       iterations=50, slope_smooth=True)
    assert np.array_equal(got, ref)


def test_non_finite_coordinates_are_refused():
    pts = np.random.default_rng(0).random((100, 3))
    pts[7, 2] = np.nan
    with pytest.raises(ValueError, match="non-finite"):
        cc.settle(pts, cloth_resolution=0.5, rigidness=3, time_step=0.65,
                  iterations=10, slope_smooth=False)
