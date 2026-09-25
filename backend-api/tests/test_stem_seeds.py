"""Automatic stem seeds on synthetic plots of known stems."""
import math

import numpy as np
import pytest

import stem_seeds as ss
from tests.synthetic_trees import SyntheticTree

SLOPE = (0.25, -0.1)


def _plot(trees, clutter=0, seed=0):
    pts, hag = [], []
    for t in trees:
        p, h = t.sample()
        pts.append(p); hag.append(h)
    if clutter:
        rng = np.random.default_rng(seed)
        c = np.column_stack([rng.uniform(-5, 15, clutter), rng.uniform(-5, 15, clutter),
                             rng.uniform(0, 2.5, clutter)])
        c[:, 2] += trees[0].ground(c[:, 0], c[:, 1])
        pts.append(c); hag.append(c[:, 2] - trees[0].ground(c[:, 0], c[:, 1]))
    return np.vstack(pts), np.concatenate(hag)


TREES = [
    SyntheticTree(base_xy=(0, 0), dbh_m=0.35, slope=SLOPE, seed=1),
    SyntheticTree(base_xy=(6, 2), dbh_m=0.20, slope=SLOPE, arc_deg=180, noise_m=0.003, seed=2),
    SyntheticTree(base_xy=(2, 8), dbh_m=0.50, slope=SLOPE, lean_deg=8, lean_azimuth_deg=45, seed=3),
    SyntheticTree(base_xy=(10, 9), dbh_m=0.12, slope=SLOPE, taper_m_per_m=0.005, stem_length_m=4,
                  crown_base_m=3, height_m=6, crown_radius_m=(1, 1), seed=4),
]


def test_finds_every_stem_once_at_breast_height():
    pts, hag = _plot(TREES, clutter=20000)
    seeds = ss.detect_stems(pts, hag)
    assert len(seeds) == len(TREES)
    for t in TREES:
        a = t.axis()
        # The stem centre at 1.3 m above its ground: base + axis * (1.3 / a_z).
        c = t.base() + a * (1.3 / a[2])
        s = min(seeds, key=lambda s: math.hypot(s["x"] - c[0], s["y"] - c[1]))
        assert math.hypot(s["x"] - c[0], s["y"] - c[1]) < 0.03
        assert s["radius_m"] == pytest.approx(t.dbh_m / 2 / a[2], rel=0.1, abs=0.01)
        assert s["z"] == pytest.approx(t.base()[2] + 1.3, abs=0.05)


def test_clutter_and_a_low_branch_are_not_stems():
    rng = np.random.default_rng(1)
    # A dense shrub: a blob of random points 0.5-2 m tall.
    shrub = rng.normal([5, 5, 1.2], [0.4, 0.4, 0.4], size=(4000, 3))
    # A horizontal branch crossing the layer at 1.5 m (one sub-layer only).
    branch = np.column_stack([np.linspace(0, 2, 400), np.zeros(400), np.full(400, 1.5)])
    pts = np.vstack([shrub, branch])
    assert ss.detect_stems(pts, pts[:, 2].copy()) == []


def test_needs_layer_points():
    assert ss.detect_stems(np.zeros((0, 3)), np.zeros(0)) == []
    assert ss.detect_stems(np.zeros((10, 3)), np.full(10, 5.0)) == []


def test_close_duplicates_merge():
    # One stem sampled twice (two scans): one seed.
    t = SyntheticTree(seed=5)
    p1, h1 = t.sample()
    p2, h2 = SyntheticTree(seed=6).sample()
    seeds = ss.detect_stems(np.vstack([p1, p2 + [0.01, 0, 0]]), np.concatenate([h1, h2]))
    assert len(seeds) == 1


def test_cluster_cells_eight_connectivity():
    xy = np.array([[0.0, 0.0], [0.06, 0.06], [0.5, 0.5], [0.52, 0.0]])
    c = ss.cluster_cells(xy, 0.05)
    assert c[0] == c[1] and len({c[0], c[2], c[3]}) == 3


def test_params_validate():
    with pytest.raises(ValueError):
        ss.StemSeedParams.from_dict({"band_min_m": 2, "band_max_m": 1})


def test_session_endpoint_returns_stored_frame_seeds(tmp_path):
    """Through the session: misses, ground and deleted points are left out,
    and seeds come back in the STORED frame (world minus the shift)."""
    import time
    import main
    shift = np.array([500000.0, 4200000.0, 0.0])
    pts, hag = _plot(TREES[:2])
    n = len(pts)
    stored = pts - shift
    extras = {main.HEIGHT_ABOVE_GROUND_SLUG: hag.astype(np.float32),
              main.GROUND_CLASS_SLUG: np.full(n, float(main.GROUND_CLASS_PLANT), np.float32),
              main._MISS_SLUG: np.zeros(n, np.float32)}
    sess = main.CloudSession(
        session_id="stems", source_path="<t>", ascii_format=None, column_plan=None,
        positions=stored, colors=None, intensity=None, extras=extras,
        extra_dims_meta=[{"slug": k, "label": k} for k in extras],
        deleted=np.zeros(n, dtype=bool), deleted_history=[], octree_cache_id=None,
        created_at=time.time(), world_shift=shift)
    with main._cloud_session_lock:
        main._cloud_sessions["stems"] = sess
    try:
        res = main.session_detect_stems("stems", main.DetectStemsRequest())
        assert len(res["seeds"]) == 2
        for t in TREES[:2]:
            c = t.base() - shift
            assert min(math.hypot(s["x"] - c[0], s["y"] - c[1]) for s in res["seeds"]) < 0.05
        # Deleting one stem's layer removes its seed.
        near0 = np.hypot(*(pts[:, :2] - TREES[0].base()[:2]).T) < 1.0
        sess.deleted = near0
        assert len(main.session_detect_stems("stems", main.DetectStemsRequest())["seeds"]) == 1
        del sess.extras[main.HEIGHT_ABOVE_GROUND_SLUG]
        with pytest.raises(main.HTTPException) as e:
            main.session_detect_stems("stems", main.DetectStemsRequest())
        assert "Generate DEM" in e.value.detail
    finally:
        with main._cloud_session_lock:
            main._cloud_sessions.pop("stems", None)
