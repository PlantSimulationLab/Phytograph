"""A streamed session DEM returns exactly what the in-memory one does.

`_do_session_dem_streamed` reads the session in blocks and takes the per-cell
percentile band by band. Here it is forced onto a small cloud with a tiny block
size and band size, so every pass crosses many block and band boundaries, and
compared field by field with the in-memory worker on an identical session.
Deleted rows and sky/miss rows are present, so the selection is exercised too.
"""
import time
from pathlib import Path

import numpy as np
import pytest

import main


def _scene(seed=5):
    rng = np.random.default_rng(seed)
    ng, nc, nm = 6000, 4000, 300
    gxy = rng.uniform([0, 0], [20, 14], (ng, 2))
    ground = np.column_stack([gxy, 0.1 * gxy[:, 0] + rng.normal(0, 0.05, ng)])
    cxy = rng.uniform([5, 3], [15, 11], (nc, 2))
    canopy = np.column_stack([cxy, rng.uniform(2.0, 6.0, nc)])
    miss = np.column_stack([rng.uniform(-500, 500, (nm, 2)), np.full(nm, 900.0)])
    pts = np.vstack([ground, canopy, miss])
    gc = np.concatenate([np.full(ng, main.GROUND_CLASS_GROUND),
                         np.full(nc, main.GROUND_CLASS_PLANT), np.zeros(nm)])
    ti = np.concatenate([rng.integers(0, 2, ng), (cxy[:, 0] > 10).astype(int),
                         np.full(nm, main._MISS_TARGET_INDEX)]).astype(np.float32)
    is_miss = np.concatenate([np.zeros(ng + nc), np.ones(nm)]).astype(np.float32)
    inten = rng.integers(1, 4000, len(pts)).astype(np.uint16)
    deleted = rng.random(len(pts)) < 0.05
    order = rng.permutation(len(pts))
    return pts[order], gc[order], ti[order], is_miss[order], inten[order], deleted[order]


def _session(scene, *, with_ground=True, with_ti=True, all_plant=False):
    pts, gc, ti, is_miss, inten, deleted = scene
    extras = {main._MISS_SLUG: is_miss.copy()}
    meta = [{"slug": main._MISS_SLUG, "label": main._MISS_LABEL}]
    if with_ground:
        col = np.full(len(gc), main.GROUND_CLASS_PLANT) if all_plant else gc
        extras[main.GROUND_CLASS_SLUG] = np.asarray(col, dtype=np.float32)
        meta.append({"slug": main.GROUND_CLASS_SLUG, "label": main.GROUND_CLASS_LABEL})
    if with_ti:
        extras["target_index"] = ti.copy()
        meta.append({"slug": "target_index", "label": "Target Index"})
    return main.CloudSession(
        session_id="demstream", source_path="mem", ascii_format=None, column_plan=None,
        positions=pts.astype(np.float64).copy(), colors=None, intensity=inten.copy(),
        extras=extras, extra_dims_meta=meta, deleted=deleted.copy(), deleted_history=[],
        octree_cache_id=None, created_at=time.time(),
    )


@pytest.fixture
def stubs(tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_SESSION_SPILL_ROOT", str(tmp_path / "sessions"))
    monkeypatch.setattr(main, "_session_rebuild", lambda s, **kw: ("stub", Path("/tmp/stub"), {}))


def _run(monkeypatch, sess, request, *, streamed):
    with monkeypatch.context() as m:
        if streamed:
            m.setattr(main, "_dem_stream_min_points", lambda: 0)
            m.setattr(main, "_LAS_WRITE_CHUNK", 777)
            m.setattr(main, "_DEM_BAND_POINTS", 1500)

            def _no_inner(*a, **k):
                raise AssertionError("the streamed request fell back to the in-memory worker")

            m.setattr(main, "_do_session_dem_inner", _no_inner)
        else:
            m.setattr(main, "_dem_stream_min_points", lambda: 10 ** 12)
        return main._do_session_dem(sess, request)


def _assert_same(a, b):
    assert a.get("success") == b.get("success"), (a.get("error"), b.get("error"))
    assert set(a) == set(b)
    for key in a:
        va, vb = a[key], b[key]
        if key == "layers":
            assert va.keys() == vb.keys()
            for name in va:
                np.testing.assert_array_equal(va[name]["grid"], vb[name]["grid"], err_msg=name)
                assert (va[name]["min"], va[name]["max"], va[name]["label"]) == \
                       (vb[name]["min"], vb[name]["max"], vb[name]["label"]), name
        elif key == "layer_vertex":
            assert va.keys() == vb.keys()
            for name in va:
                np.testing.assert_array_equal(va[name], vb[name], err_msg=name)
        elif isinstance(va, np.ndarray) or isinstance(vb, np.ndarray):
            np.testing.assert_array_equal(va, vb, err_msg=key)
        else:
            assert va == vb, key


@pytest.mark.parametrize("surface", ["dtm", "dsm", "chm"])
@pytest.mark.parametrize("fill", [False, True])
def test_streamed_matches_in_memory(stubs, monkeypatch, surface, fill):
    scene = _scene()
    req = main.SessionDemRequest(surface_type=surface, cell_size=0.5, method="tin",
                                 ground_percentile=10.0, fill_voids=fill,
                                 auto_segment_ground=False)
    mem = _run(monkeypatch, _session(scene), req, streamed=False)
    assert mem["success"], mem.get("error")
    streamed = _run(monkeypatch, _session(scene), req, streamed=True)
    _assert_same(mem, streamed)


@pytest.mark.parametrize("method", ["nearest", "idw"])
def test_streamed_matches_in_memory_for_every_interpolation(stubs, monkeypatch, method):
    scene = _scene(seed=9)
    req = main.SessionDemRequest(surface_type="dtm", cell_size=0.4, method=method,
                                 fill_voids=True, auto_segment_ground=False)
    mem = _run(monkeypatch, _session(scene), req, streamed=False)
    assert mem["success"], mem.get("error")
    _assert_same(mem, _run(monkeypatch, _session(scene), req, streamed=True))


def test_streamed_height_above_ground_matches(stubs, monkeypatch):
    scene = _scene(seed=11)
    req = main.SessionDemRequest(surface_type="dtm", cell_size=0.5, ground_percentile=50.0,
                                 add_height_column=True, auto_segment_ground=False)
    s_mem, s_str = _session(scene), _session(scene)
    mem = _run(monkeypatch, s_mem, req, streamed=False)
    assert mem["success"], mem.get("error")
    streamed = _run(monkeypatch, s_str, req, streamed=True)
    _assert_same(mem, streamed)
    hag_mem = np.asarray(s_mem.extras[main.HEIGHT_ABOVE_GROUND_SLUG])
    hag_str = np.asarray(s_str.extras[main.HEIGHT_ABOVE_GROUND_SLUG])
    # The session stores the column at full length (deleted rows included).
    assert len(hag_str) == len(scene[0])
    np.testing.assert_array_equal(hag_mem, hag_str)
    # Not vacuous: elevated canopy points really do carry height.
    assert float(np.nanmax(hag_str)) > 1.5


def test_streamed_without_ground_or_return_columns_matches(stubs, monkeypatch):
    scene = _scene(seed=13)
    req = main.SessionDemRequest(surface_type="chm", cell_size=0.5, auto_segment_ground=False)
    mem = _run(monkeypatch, _session(scene, with_ground=False, with_ti=False), req, streamed=False)
    assert mem["success"], mem.get("error")
    assert mem["surface_source"] == "all_points" and "warning" in mem
    streamed = _run(monkeypatch, _session(scene, with_ground=False, with_ti=False), req,
                    streamed=True)
    _assert_same(mem, streamed)


def test_too_fine_a_cell_is_refused_identically(stubs, monkeypatch):
    scene = _scene()
    req = main.SessionDemRequest(surface_type="dtm", cell_size=0.001, auto_segment_ground=False)
    mem = _run(monkeypatch, _session(scene), req, streamed=False)
    assert not mem["success"] and "too fine" in mem["error"]
    _assert_same(mem, _run(monkeypatch, _session(scene), req, streamed=True))


def test_no_usable_ground_column_with_csf_falls_back_to_in_memory(stubs, monkeypatch):
    """CSF needs every point at once, so a cloud whose ground column holds no
    ground and that asks for auto segmentation must reach the in-memory worker."""
    sess = _session(_scene(), all_plant=True)
    req = main.SessionDemRequest(surface_type="dtm", cell_size=0.5, auto_segment_ground=True)
    called = []
    with monkeypatch.context() as m:
        m.setattr(main, "_dem_stream_min_points", lambda: 0)
        m.setattr(main, "_do_session_dem_inner",
                  lambda s, r, progress=None: called.append(r) or {"success": False, "error": "inner"})
        out = main._do_session_dem(sess, req)
    assert called == [req]
    assert out["error"] == "inner"
