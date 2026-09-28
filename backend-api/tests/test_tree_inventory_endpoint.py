"""POST /api/cloud/session/{id}/tree_inventory against a real session.

A plot of synthetic trees of known DBH on a sloped DTM, with the columns the
segmentation tools write (tree_instance, height_above_ground, ground_class,
is_miss), a far-field miss shell and a few deleted points. Checks that each
tree is measured from its own points only, in world coordinates, that misses
and deletions never reach the measurement, and that a memory-mapped session
store gives the same answer as an in-RAM one.
"""
import asyncio
import time

import numpy as np
import pytest

import main
import session_store
from tests.binframe import decode_streamed_json
from tests.synthetic_trees import SyntheticTree

SLOPE = (0.2, -0.1)
TREES = {
    3: SyntheticTree(base_xy=(0.0, 0.0), dbh_m=0.30, slope=SLOPE, seed=1),
    8: SyntheticTree(base_xy=(9.0, 1.0), dbh_m=0.45, slope=SLOPE, lean_deg=8,
                     lean_azimuth_deg=120, seed=2),
    12: SyntheticTree(base_xy=(2.0, 10.0), dbh_m=0.20, slope=SLOPE, height_m=9.0,
                      crown_base_m=4.0, stem_length_m=6.0, crown_radius_m=(1.5, 1.5),
                      arc_deg=200, noise_m=0.003, seed=3),
}
SHIFT = np.array([612000.0, 4270000.0, 0.0])


def _plot():
    pos, tid, hag, grd = [], [], [], []
    for t_id, t in TREES.items():
        p, h = t.sample()
        pos.append(p)
        tid.append(np.full(len(p), float(t_id)))
        hag.append(h)
        grd.append(np.full(len(p), float(main.GROUND_CLASS_PLANT)))
    # Ground points (tree id 0).
    gx, gy = np.meshgrid(np.arange(-4, 14, 0.25), np.arange(-4, 14, 0.25))
    g = np.column_stack([gx.ravel(), gy.ravel(),
                         100.0 + SLOPE[0] * gx.ravel() + SLOPE[1] * gy.ravel()])
    pos.append(g)
    tid.append(np.zeros(len(g)))
    hag.append(np.zeros(len(g)))
    grd.append(np.full(len(g), float(main.GROUND_CLASS_GROUND)))
    pos = np.vstack(pos)
    tid = np.concatenate(tid)
    hag = np.concatenate(hag)
    grd = np.concatenate(grd)
    miss = np.zeros(len(pos))
    # Sky/miss points labeled as tree 3, 1 km out: if they reached the
    # measurement, tree 3's height and crown would be absurd.
    m = np.array([[500.0, 800.0, 1100.0], [-700.0, 300.0, 900.0]])
    pos = np.vstack([pos, m])
    tid = np.concatenate([tid, [3.0, 3.0]])
    hag = np.concatenate([hag, [1000.0, 800.0]])
    grd = np.concatenate([grd, [2.0, 2.0]])
    miss = np.concatenate([miss, [1.0, 1.0]])
    return pos, tid, hag, grd, miss


def _make_session(session_id, *, store_root=None, delete_high=True):
    pos, tid, hag, grd, miss = _plot()
    deleted = np.zeros(len(pos), dtype=bool)
    if delete_high:
        # A deleted point 50 m above tree 8: a height of ~50 m would mean
        # deletions leak into the measurement.
        pos = np.vstack([pos, [[9.0, 1.0, 160.0]]])
        tid = np.concatenate([tid, [8.0]])
        hag = np.concatenate([hag, [58.0]])
        grd = np.concatenate([grd, [2.0]])
        miss = np.concatenate([miss, [0.0]])
        deleted = np.concatenate([deleted, [True]])
    stored = pos - SHIFT  # the session stores world - shift
    extras = {
        main.TREE_INSTANCE_SLUG: tid.astype(np.float32),
        main.HEIGHT_ABOVE_GROUND_SLUG: hag.astype(np.float32),
        main.GROUND_CLASS_SLUG: grd.astype(np.float32),
        main._MISS_SLUG: miss.astype(np.float32),
    }
    store = None
    if store_root is not None:
        store = session_store.SessionStore.create(store_root, len(stored))
        stored = store.add_column("positions", stored)
        deleted = store.add_column("deleted", deleted)
        extras = {k: store.add_column(f"x_{k}", v) for k, v in extras.items()}
    sess = main.CloudSession(
        session_id=session_id, source_path="<test>", ascii_format=None, column_plan=None,
        positions=stored, colors=None, intensity=None, extras=extras,
        extra_dims_meta=[{"slug": k, "label": k} for k in extras],
        deleted=deleted, deleted_history=[], octree_cache_id=None,
        created_at=time.time(), world_shift=SHIFT.copy(),
    )
    sess.store = None  # the maps are used directly; no spill/attach machinery
    with main._cloud_session_lock:
        main._cloud_sessions[session_id] = sess
    return sess


@pytest.fixture(autouse=True)
def _clean_sessions():
    with main._cloud_session_lock:
        before = dict(main._cloud_sessions)
    yield
    with main._cloud_session_lock:
        main._cloud_sessions.clear()
        main._cloud_sessions.update(before)


class _Req:
    async def is_disconnected(self):
        return False


def _run(session_id, **body):
    resp = main.session_tree_inventory(session_id, main.TreeInventoryRequest(**body), _Req())

    async def _collect():
        return b"".join([c if isinstance(c, (bytes, bytearray)) else c.encode()
                         async for c in resp.body_iterator])

    return decode_streamed_json(asyncio.run(_collect()))


def _check_plot(res):
    assert res["success"], res.get("error")
    by_id = {t["tree_id"]: t for t in res["trees"]}
    assert sorted(by_id) == [3, 8, 12]
    for t_id, truth in TREES.items():
        row = by_id[t_id]
        assert row["stem_base"] == pytest.approx(truth.base().tolist(), abs=0.02)
        assert row["dbh_m"] == pytest.approx(truth.diameter_at(1.3 + (row["breast_height_ref_z"] - row["stem_base"][2])), abs=0.006)
        assert row["height_m"] == pytest.approx(truth.height_m, abs=0.05)
        assert row["ground_source"] == "height_above_ground"
    assert by_id[8]["lean_deg"] == pytest.approx(8.0, abs=0.5)
    assert "partial_arc" not in by_id[3]["flags"]
    # Stem curve rows carry their tree id and belong to measured trees.
    assert {c["tree_id"] for c in res["stem_curve"]} == {3, 8, 12}
    return by_id


def test_measures_each_tree_in_world_coordinates():
    # The session stores truth - SHIFT; a stem base equal to the truth proves
    # the shift was added back.
    _make_session("inv-ram")
    res = _run("inv-ram")
    assert res["success"], res.get("error")
    by_id = {t["tree_id"]: t for t in res["trees"]}
    for t_id, truth in TREES.items():
        b = truth.base()
        assert by_id[t_id]["stem_base"][0] == pytest.approx(b[0], abs=0.02)
        assert by_id[t_id]["stem_base"][1] == pytest.approx(b[1], abs=0.02)
    _check_plot(res)


def test_memory_mapped_store_matches_in_ram(tmp_path):
    _make_session("inv-ram")
    _make_session("inv-map", store_root=tmp_path / "store")
    a = {t["tree_id"]: t for t in _run("inv-ram")["trees"]}
    b_res = _run("inv-map")
    _check_plot(b_res)
    b = {t["tree_id"]: t for t in b_res["trees"]}
    for k in a:
        assert b[k]["dbh_m"] == pytest.approx(a[k]["dbh_m"], abs=1e-9)
        assert b[k]["height_m"] == pytest.approx(a[k]["height_m"], abs=1e-9)


def test_tree_subset_and_min_points():
    _make_session("inv-sub")
    res = _run("inv-sub", tree_ids=[12, 3])
    assert sorted(t["tree_id"] for t in res["trees"]) == [3, 12]
    res = _run("inv-sub", min_points=10 ** 9)
    assert not res["success"] and res["trees"] == []
    assert any("skipped" in w for w in res["warnings"])


def test_ground_grid_used_without_height_above_ground():
    sess = _make_session("inv-grid")
    with main._cloud_session_lock:
        del sess.extras[main.HEIGHT_ABOVE_GROUND_SLUG]
    res = _run("inv-grid")
    assert res["ground_sources"] == {"height_above_ground": 0, "ground_class": 3, "tree_min_z": 0}
    by_id = {t["tree_id"]: t for t in res["trees"]}
    for t_id, truth in TREES.items():
        assert by_id[t_id]["ground_source"] == "ground_class"
        assert by_id[t_id]["stem_base"][2] == pytest.approx(truth.base()[2], abs=0.05)


def test_partial_dem_falls_back_to_ground_labels_per_tree():
    # The DEM missed tree 12: its height_above_ground is NaN. It must take its
    # ground from the ground-labeled points, not from its own lowest point.
    sess = _make_session("inv-partial")
    with main._cloud_session_lock:
        hag = np.array(sess.extras[main.HEIGHT_ABOVE_GROUND_SLUG])
        hag[np.array(sess.extras[main.TREE_INSTANCE_SLUG]) == 12] = np.nan
        sess.extras[main.HEIGHT_ABOVE_GROUND_SLUG] = hag
    res = _run("inv-partial")
    by_id = {t["tree_id"]: t for t in res["trees"]}
    assert by_id[12]["ground_source"] == "ground_class"
    assert "ground_from_tree_min" not in by_id[12]["flags"]
    assert by_id[12]["stem_base"][2] == pytest.approx(TREES[12].base()[2], abs=0.05)
    assert by_id[3]["ground_source"] == "height_above_ground"
    assert res["ground_sources"] == {"height_above_ground": 2, "ground_class": 1, "tree_min_z": 0}


def test_stand_geometry_and_competition():
    _make_session("inv-stand")
    res = _run("inv-stand", competition_radius_m=10.0)
    st = res["stand"]
    # Plot boundary = hull of the ground grid, x and y from -4 to 13.75.
    assert st["plot_source"] == "ground_class"
    assert st["plot_area_m2"] == pytest.approx(17.75 ** 2, rel=1e-6)
    assert st["competition_radius_m"] == 10.0
    # The union is rastered at 0.1 m; the sum is exact. They agree to raster precision.
    assert 0 < st["crown_union_area_m2"] <= st["crown_area_sum_m2"] * 1.02
    by = {t["tree_id"]: t for t in res["trees"]}
    # Tree 3 at (0, 0): tree 8 is 9.06 m away, tree 12 is 10.2 m (outside).
    d38 = np.hypot(9.0, 1.0)
    assert by[3]["n_competitors"] == 1
    assert by[3]["hegyi_index"] == pytest.approx(by[8]["dbh_m"] / by[3]["dbh_m"] / d38, rel=0.01)
    # 4 m from the boundary with a 10 m radius: an edge tree.
    assert by[3]["edge"] is True
    assert set(("crown_overlap_m2", "crown_overlap_fraction")) <= set(by[3])


def test_a_tree_subset_skips_stand_metrics():
    _make_session("inv-subset-stand")
    res = _run("inv-subset-stand", tree_ids=[3, 8])
    assert res["stand"] is None
    assert "hegyi_index" not in res["trees"][0]
    assert any("need every tree" in w for w in res["warnings"])


def test_undo_mid_run_is_reported():
    sess = _make_session("inv-undo")

    class _Undo:
        def __call__(self, frac, msg):
            if msg.startswith("Measuring tree 2"):
                sess.deleted = np.array(sess.deleted)   # reset_edits builds a new mask

        def should_cancel(self):
            return False

    res = main._do_tree_inventory(sess, main.TreeInventoryRequest(), progress=_Undo())
    assert not res["success"] and "changed" in res["error"]


def test_no_tree_labels_is_a_clear_error():
    sess = _make_session("inv-none")
    with main._cloud_session_lock:
        del sess.extras[main.TREE_INSTANCE_SLUG]
    res = _run("inv-none")
    assert not res["success"] and "Segment Trees" in res["error"]


def test_bad_method_is_rejected():
    _make_session("inv-bad")
    res = _run("inv-bad", fit_method="magic")
    assert not res["success"] and "fit method" in res["error"]


def test_cancel_between_trees():
    sess = _make_session("inv-cancel")

    class _Canceled:
        def __init__(self):
            self.calls = 0

        def __call__(self, frac, msg):
            self.calls += 1

        def should_cancel(self):
            return self.calls >= 2  # after indexing starts

    with pytest.raises(main.ScanCanceled):
        main._do_tree_inventory(sess, main.TreeInventoryRequest(), progress=_Canceled())


def test_cloud_replaced_mid_run_is_reported():
    sess = _make_session("inv-change")

    class _Swap:
        def __call__(self, frac, msg):
            if msg.startswith("Measuring tree 2"):
                sess.positions = np.array(sess.positions)  # a bake replaces the array

        def should_cancel(self):
            return False

    res = main._do_tree_inventory(sess, main.TreeInventoryRequest(), progress=_Swap())
    assert not res["success"] and "changed" in res["error"]


def test_endpoint_is_a_plain_def():
    import inspect
    assert not inspect.iscoroutinefunction(main.session_tree_inventory)
