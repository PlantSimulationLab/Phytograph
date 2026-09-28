"""POST /api/cloud/session/{id}/tree_qsm: one QSM per tree_instance.

Two copies of the QSM package's known synthetic tree stand in one session,
wrapped in leaf points labeled leaf. The batch must build each tree from its
own points only (wood points when asked), give the same model a single-tree
build gives for those points, report a too-small tree as a per-tree failure
rather than failing the batch, and exclude sky/miss points.
"""
import asyncio
import time

import numpy as np
import pytest

import main
import tree_inventory as ti
from qsm.metrics import compute_metrics
from qsm.validation.synthetic import sample_cloud, simple_tree
from tests.binframe import decode_streamed_json


@pytest.fixture(scope="module")
def wood():
    gt = simple_tree()
    return sample_cloud(gt, seed=7, points_per_m2=12000, noise_sigma=0.0006), compute_metrics(gt)


def _session(wood_pts, sid="tqsm", with_wood=True):
    rng = np.random.default_rng(3)
    parts, tid, wc, miss = [], [], [], []
    for t_id, off in ((4, (0.0, 0.0)), (9, (8.0, 3.0))):
        w = wood_pts + [off[0], off[1], 0.0]
        lo, hi = w.min(axis=0), w.max(axis=0)
        leaves = rng.uniform(lo, hi, size=(3000, 3))
        parts += [w, leaves]
        tid += [np.full(len(w), t_id), np.full(len(leaves), t_id)]
        wc += [np.full(len(w), main.WOOD_CLASS_WOOD), np.full(len(leaves), main.WOOD_CLASS_LEAF)]
        miss += [np.zeros(len(w)), np.zeros(len(leaves))]
    # A tiny "tree" of 20 wood points, and a sky point labeled tree 4.
    parts += [rng.normal([20, 20, 1], 0.05, size=(20, 3)), np.array([[400.0, 900.0, 800.0]])]
    tid += [np.full(20, 13), np.array([4])]
    wc += [np.full(20, main.WOOD_CLASS_WOOD), np.array([main.WOOD_CLASS_WOOD])]
    miss += [np.zeros(20), np.array([1.0])]
    pos = np.vstack(parts)
    extras = {main.TREE_INSTANCE_SLUG: np.concatenate(tid).astype(np.float32),
              main._MISS_SLUG: np.concatenate(miss).astype(np.float32)}
    if with_wood:
        extras[main.WOOD_CLASS_SLUG] = np.concatenate(wc).astype(np.float32)
    sess = main.CloudSession(
        session_id=sid, source_path="<test>", ascii_format=None, column_plan=None,
        positions=pos, colors=None, intensity=None, extras=extras,
        extra_dims_meta=[{"slug": k, "label": k} for k in extras],
        deleted=np.zeros(len(pos), dtype=bool), deleted_history=[], octree_cache_id=None,
        created_at=time.time(), world_shift=None)
    with main._cloud_session_lock:
        main._cloud_sessions[sid] = sess
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


def _run(sid, **body):
    resp = main.session_tree_qsm(sid, main.TreeQSMRequest(**body), _Req())

    async def _collect():
        return b"".join([c if isinstance(c, (bytes, bytearray)) else c.encode()
                         async for c in resp.body_iterator])

    return decode_streamed_json(asyncio.run(_collect()))


def test_one_qsm_per_tree_from_its_wood_points(wood):
    pts, gt = wood
    _session(pts)
    res = _run("tqsm", max_points_per_tree=500_000)
    by = {r["tree_id"]: r for r in res["results"]}
    assert sorted(by) == [4, 9, 13]
    assert res["success"]
    for t in (4, 9):
        r = by[t]
        assert r["success"], r["error"]
        assert r["wood_only"] is True
        # Only this tree's wood points: the leaves and the miss are gone.
        assert r["points_used"] == len(pts)
        assert r["n_cylinders"] > 0 and len(r["cylinders"]) == r["n_cylinders"]
        # Woody volume within 30% of the known tree's.
        assert r["metrics"]["total_woody_volume_m3"] == pytest.approx(gt.total_woody_volume_m3, rel=0.3)
    # The same points give the same model as a single-tree build.
    single = main._do_qsm_build(main.QSMBuildRequest(points=pts.tolist()))
    assert by[4]["metrics"]["total_woody_volume_m3"] == pytest.approx(
        single["metrics"]["total_woody_volume_m3"], rel=1e-9)
    # Tree 9 is tree 4 moved by (8, 3): its cylinders moved with it.
    c4 = np.array(by[4]["cylinders"][0]["start"])
    c9 = np.array(by[9]["cylinders"][0]["start"])
    assert c9 - c4 == pytest.approx([8.0, 3.0, 0.0], abs=1e-6)
    # The 20-point tree fails on its own, with a reason.
    assert by[13]["success"] is False and "at least 50" in by[13]["error"]


def test_all_points_without_wood_labels_and_metrics_only(wood):
    pts, _gt = wood
    _session(pts, sid="tqsm-nowood", with_wood=False)
    res = _run("tqsm-nowood", tree_ids=[4], include_models=False, max_points_per_tree=500_000)
    assert [r["tree_id"] for r in res["results"]] == [4]
    r = res["results"][0]
    assert r["wood_only"] is False and r["points_used"] == len(pts) + 3000
    assert "cylinders" not in r
    assert any("No wood labels" in w for w in res["warnings"])


def test_budget_thins_on_a_voxel_grid(wood):
    pts, _gt = wood
    _session(pts)
    res = _run("tqsm", tree_ids=[4], max_points_per_tree=2000)
    r = res["results"][0]
    assert r["points_used"] <= 2000 and r["voxel_m"] > 0


def test_voxel_thin():
    rng = np.random.default_rng(0)
    # Dense near cluster + sparse far points: a stride would keep the density
    # ratio, a voxel grid evens it out.
    near = rng.uniform(0, 1, (20000, 3))
    far = rng.uniform(9, 10, (200, 3))
    p = np.vstack([near, far])
    keep, v = ti.voxel_thin(p, 1000)
    assert len(keep) <= 1000 and v > 0
    # The far points are 1% of the input; one-per-voxel keeps far more of them.
    assert (keep >= 20000).mean() > 5 * (200 / len(p))
    same, none = ti.voxel_thin(p[:10], 1000)
    assert none is None and len(same) == 10


def test_rejects_tiny_budget_and_missing_labels(wood):
    pts, _gt = wood
    sess = _session(pts)
    assert "between 1,000 and" in _run("tqsm", max_points_per_tree=10)["error"]
    assert "between 1,000 and" in _run("tqsm", max_points_per_tree=5_000_000)["error"]
    with main._cloud_session_lock:
        del sess.extras[main.TREE_INSTANCE_SLUG]
    assert "Segment Trees" in _run("tqsm")["error"]


def test_endpoint_is_a_plain_def():
    import inspect
    assert not inspect.iscoroutinefunction(main.session_tree_qsm)
