"""A session tool must not write its result over an edit made while it ran.

Ground, normals, denoise and tree segmentation snapshot the hit survivors,
release the session lock for the seconds-to-minutes the killable worker runs,
then scatter the result back over the survivors. An erase, crop or undo in
between changes that set. Unguarded, the write either failed with a NumPy shape
error after the whole compute, or -- when the survivor COUNT came out the same --
put every label after the edit on the wrong point and reported success.

Each test uses the count-preserving edit (one point restored, another erased),
because that is the silent case: the shape-mismatch case at least errored.
Wood and organ segmentation already refused; this pins the rest.
"""

import numpy as np
import pytest

import main
from tests.test_session_segment_excludes_misses import leafcube_session  # noqa: F401


def _swap_one_deletion(sess):
    """Restore the one deleted point and erase another: same survivor count,
    different survivors."""
    was = np.flatnonzero(sess.deleted)[0]
    sess.deleted[was] = False
    sess.deleted[np.flatnonzero(~sess.deleted)[-1]] = True


def _fake_result(tool, pts):
    n = len(pts)
    if tool == "normals":
        return np.zeros((n, main.normals_mod.N_COLUMNS), np.float32), {}
    if tool == "trees":
        return np.ones(n, np.int64)
    return np.ones(n, np.int64), {}


TOOLS = [
    ("segment_ground", {"acknowledge_cost": True}, main.GROUND_CLASS_SLUG),
    ("compute_normals", {"acknowledge_cost": True}, main.normals_mod.COLUMNS[0][0]),
    ("denoise", {}, None),  # slug filled in below; denoise is imported lazily
    ("segment_trees", {"acknowledge_cost": True}, main.TREE_INSTANCE_SLUG),
]


@pytest.mark.parametrize("route,body,slug", TOOLS, ids=[t[0] for t in TOOLS])
def test_edit_during_run_is_refused(client, leafcube_session, monkeypatch,  # noqa: F811
                                    route, body, slug):
    import denoise
    slug = slug or denoise.NOISE_CLASS_SLUG
    sess = main._cloud_sessions[leafcube_session]
    sess.deleted[0] = True  # so the edit can restore it

    async def run_and_edit(tool, pts, params, **kw):
        _swap_one_deletion(sess)  # the user edits the cloud mid-run
        return _fake_result(tool, pts)

    monkeypatch.setattr(main, "_run_killable", run_and_edit)
    resp = client.post(f"/api/cloud/session/{leafcube_session}/{route}", json=body)
    assert resp.status_code == 409, resp.text
    assert "edited" in resp.json()["detail"]
    assert slug not in sess.extras


@pytest.mark.parametrize("route,body,slug", TOOLS, ids=[t[0] for t in TOOLS])
def test_untouched_cloud_still_writes(client, leafcube_session, monkeypatch,  # noqa: F811
                                      route, body, slug):
    """Control: the guard must not refuse a run nobody interfered with."""
    import denoise
    slug = slug or denoise.NOISE_CLASS_SLUG
    sess = main._cloud_sessions[leafcube_session]
    sess.deleted[0] = True

    async def run(tool, pts, params, **kw):
        return _fake_result(tool, pts)

    monkeypatch.setattr(main, "_run_killable", run)
    monkeypatch.setattr(main, "_session_rebuild",
                        lambda s: ("k", "/nonexistent", {"point_count": 0}))
    resp = client.post(f"/api/cloud/session/{leafcube_session}/{route}", json=body)
    assert resp.status_code == 200, resp.text
    assert slug in sess.extras
    assert len(sess.extras[slug]) == len(sess.positions)


def test_dem_height_column_refused_after_edit(leafcube_session, monkeypatch):  # noqa: F811
    """The DEM writes its height-above-ground column after the gridding; an edit
    during the gridding must leave the column unwritten and say why."""
    sess = main._cloud_sessions[leafcube_session]
    sess.deleted[0] = True
    real = main._compute_dem_layers

    def compute_and_edit(*a, **kw):
        out = real(*a, **kw)
        _swap_one_deletion(sess)
        return out

    monkeypatch.setattr(main, "_compute_dem_layers", compute_and_edit)
    req = main.SessionDemRequest(cell_size=0.5, add_height_column=True,
                                 auto_segment_ground=False)
    result = main._do_session_dem_inner(sess, req)
    assert result["success"] is False
    assert "edited" in result["error"]
    assert main.HEIGHT_ABOVE_GROUND_SLUG not in sess.extras
