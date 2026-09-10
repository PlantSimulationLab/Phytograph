"""Undo history stores index DELTAS, not full-length mask snapshots.

Each committed delete used to push `sess.deleted.copy()` - a full (N,) bool
array - so fifty erase clicks on a 100 M-point cloud cost 5 GB of undo
history, more than the positions themselves. An erase typically touches a few
thousand points; the history now records the indices each step newly deleted,
and `reset_edits` replays them. Behaviour through the API is unchanged and
pinned here; the storage shape is pinned alongside it.
"""
import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json

XYZ_FORMAT = "x y z"


@pytest.fixture
def grid_session(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    g = np.linspace(0.05, 0.95, 10)
    pts = np.array([[x, y, z] for x in g for y in g for z in g])     # 1000 points
    src = tmp_path / "grid.xyz"
    np.savetxt(src, pts, fmt="%.4f")
    res = client.post("/api/cloud/session/create",
                      json={"source_path": str(src), "ascii_format": XYZ_FORMAT})
    assert res.status_code == 200, res.text
    return decode_streamed_json(res.content)["session_id"]


def _box(lo, hi):
    return {"region": {"kind": "box", "min": [lo, lo, lo], "max": [hi, hi, hi], "invert": False}}


def test_three_deletes_then_undo_two_and_undo_all(client, grid_session):
    sid = grid_session
    counts = []
    for lo, hi in ((0.0, 0.3), (0.0, 0.5), (0.6, 1.0)):
        res = client.post(f"/api/cloud/session/{sid}/delete_region", json=_box(lo, hi))
        assert res.status_code == 200, res.text
        counts.append(res.json()["deleted_count"])
    assert counts[0] < counts[1] < counts[2]

    sess = main._get_cloud_session(sid)
    with main._cloud_session_lock:
        assert len(sess.deleted_history) == 3
        for entry in sess.deleted_history:
            # An index delta: integer, sorted-unique, and far smaller than N.
            assert np.issubdtype(entry.dtype, np.integer)
            assert entry.ndim == 1 and entry.size < len(sess.positions)
        # The deltas partition the deleted set: disjoint, and their union is it.
        union = np.concatenate(sess.deleted_history)
        assert union.size == np.unique(union).size == counts[2]
        assert int(sess.deleted.sum()) == counts[2]
        # Second delete overlaps the first (0-0.3 within 0-0.5): only the NEW
        # points are recorded, so the delta is smaller than the region.
        assert sess.deleted_history[1].size == counts[1] - counts[0]

    res = client.post(f"/api/cloud/session/{sid}/reset_edits", json={"edit_count": 2})
    assert res.status_code == 200, res.text
    assert res.json()["deleted_count"] == counts[1]
    with main._cloud_session_lock:
        assert len(sess.deleted_history) == 2
        assert int(sess.deleted.sum()) == counts[1]
        # The undo restores EXACTLY the post-second-delete mask.
        expect = np.zeros(len(sess.positions), dtype=bool)
        expect[np.concatenate(sess.deleted_history)] = True
        np.testing.assert_array_equal(sess.deleted, expect)

    res = client.post(f"/api/cloud/session/{sid}/reset_edits", json={"edit_count": 0})
    assert res.json()["deleted_count"] == 0
    with main._cloud_session_lock:
        assert sess.deleted_history == []
        assert not sess.deleted.any()


def test_a_delete_that_removes_nothing_new_still_records_a_step(client, grid_session):
    """The renderer mirrors the stack one entry per committed delete, so a
    delete whose region only re-selects already-deleted points must still push
    an (empty) entry, or the two stacks desynchronise and a later undo
    misaddresses."""
    sid = grid_session
    client.post(f"/api/cloud/session/{sid}/delete_region", json=_box(0.0, 0.3))
    client.post(f"/api/cloud/session/{sid}/delete_region", json=_box(0.0, 0.3))
    sess = main._get_cloud_session(sid)
    with main._cloud_session_lock:
        assert len(sess.deleted_history) == 2
        assert sess.deleted_history[1].size == 0


def test_history_memory_is_bounded_by_edits_not_by_cloud_size(client, grid_session):
    sid = grid_session
    for _ in range(5):
        client.post(f"/api/cloud/session/{sid}/delete_region", json=_box(0.0, 0.12))
    sess = main._get_cloud_session(sid)
    with main._cloud_session_lock:
        history_bytes = sum(int(e.nbytes) for e in sess.deleted_history)
        # Five snapshots would be 5 x N bytes; five deltas are ~one small
        # region's worth of indices plus four empties.
        assert history_bytes < len(sess.positions)
