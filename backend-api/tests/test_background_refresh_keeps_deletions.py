"""The background display refresh must not throw deleted rows away.

After a crop, erase, filter or split, the renderer rebuilds the cloud's octree
in the background (`refreshCloudOctree` -> `/bake?compact=false`). That refresh
used to COMPACT the session. Compaction is irreversible, and LAD depends on the
deleted rows: it restores the deleted hits outside its voxel grid from them,
which is what lets a crop to the grid leave LAD unchanged (pinned end to end in
`test_lad.py::test_crop_survives_the_background_octree_refresh`). Only an
explicit bake ("Apply deletions") compacts now.

Keeping the mask across a rebuild exposed two things that compaction had been
hiding, both pinned here:

- the undo floor: a refresh or commit clears the delete history, and
  `reset_edits` replays history onto `deleted_base` (or all-False), so without
  a floor "undo the erase" restored every point ever deleted;
- the renderer's count: it shows `pointCount - pendingDeletedCount`, and a
  cumulative `deleted_count` subtracted the already-rebuilt deletions twice.

Driven through the real HTTP API on both session kinds.
"""
import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json
from tests.test_session_store_backed import _write_las

LOW_X = {"kind": "box", "min": [-1, -1, -10], "max": [2.5, 6, 10], "invert": False}
LOW_Y = {"kind": "box", "min": [-1, -1, -10], "max": [6, 1.0, 10], "invert": False}
HIGH_Y = {"kind": "box", "min": [-1, 4.0, -10], "max": [6, 6, 10], "invert": False}


@pytest.fixture(params=["ram", "store"])
def session(request, client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_SPILL_ROOT", str(tmp_path / "sessions"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS",
                       "0" if request.param == "store" else str(10**9))
    monkeypatch.setattr(main, "_cloud_sessions", {})
    monkeypatch.setattr(main, "_spilled_sessions", {})
    las = _write_las(tmp_path / "a.las")
    res = client.post("/api/cloud/session/create", json={"source_path": str(las)})
    assert res.status_code == 200, res.text
    sid = decode_streamed_json(res.content)["session_id"]
    sess = main._get_cloud_session(sid)
    assert (sess.store is not None) == (request.param == "store")
    return sid


def _delete(client, sid, region):
    res = client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": region})
    assert res.status_code == 200, res.text
    return res.json()


def _refresh(client, sid):
    res = client.post(f"/api/cloud/session/{sid}/bake?compact=false")
    assert res.status_code == 200, res.text
    return decode_streamed_json(res.content)


def _mask(sid):
    sess = main._get_cloud_session(sid)
    with main._cloud_session_lock:
        return np.array(sess.deleted, dtype=bool)


def test_refresh_rebuilds_the_display_but_keeps_every_row(session, client):
    sid = session
    n = len(main._get_cloud_session(sid).positions)
    crop = _delete(client, sid, LOW_X)
    cropped = _mask(sid)
    assert 0 < crop["deleted_count"] < n
    assert crop["pending_deleted_count"] == crop["deleted_count"]

    out = _refresh(client, sid)
    sess = main._get_cloud_session(sid)
    assert out["baked"] is True
    assert out["point_count"] == crop["remaining_count"] == n - crop["deleted_count"]
    assert out["deleted_history_len"] == 0
    assert out["pending_deleted_count"] == 0
    # Every row is still in the session, under the same mask...
    assert len(sess.positions) == n
    np.testing.assert_array_equal(_mask(sid), cropped)
    if sess.store is not None:
        # ...and a store-backed session was not re-homed to the survivors.
        assert sess.store.n == n
        assert isinstance(sess.positions, np.memmap)
    # The octree is current, so a second refresh is the no-rebuild fast path.
    again = _refresh(client, sid)
    assert again["baked"] is False
    assert again["cache_id"] == out["cache_id"]
    assert again["point_count"] == out["point_count"]
    assert again["pending_deleted_count"] == 0


def test_refreshed_mask_survives_eviction(session, client, monkeypatch):
    sid = session
    _delete(client, sid, LOW_X)
    _refresh(client, sid)
    cropped = _mask(sid)
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 0)
    main._sweep_cloud_sessions()
    assert sid in main._spilled_sessions
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 8)
    np.testing.assert_array_equal(_mask(sid), cropped)
    # The undo floor came back too: undoing nothing leaves the crop in place.
    res = client.post(f"/api/cloud/session/{sid}/reset_edits", json={"edit_count": 0})
    assert res.status_code == 200, res.text
    np.testing.assert_array_equal(_mask(sid), cropped)


def test_undo_after_a_refresh_stops_at_the_refreshed_mask(session, client):
    sid = session
    _delete(client, sid, LOW_X)
    _refresh(client, sid)
    cropped = _mask(sid)

    erase = _delete(client, sid, LOW_Y)
    newly = int((_mask(sid) & ~cropped).sum())
    assert newly > 0
    # The backend's own count stays cumulative; the renderer's is only the rows
    # its rebuilt octree still draws.
    assert erase["deleted_count"] == int(_mask(sid).sum())
    assert erase["pending_deleted_count"] == newly

    res = client.post(f"/api/cloud/session/{sid}/reset_edits", json={"edit_count": 0})
    assert res.status_code == 200, res.text
    body = res.json()
    # Undo removes the erase, not the crop the refresh already committed.
    np.testing.assert_array_equal(_mask(sid), cropped)
    assert body["pending_deleted_count"] == 0


def test_undo_after_a_filter_stops_at_the_filtered_mask(session, client):
    sid = session
    _delete(client, sid, LOW_X)
    _refresh(client, sid)
    cropped = _mask(sid)
    # Remove points: keep only the HIGH_Y band (filter keeps what the region selects).
    res = client.post(f"/api/cloud/session/{sid}/filter",
                      json={"region": HIGH_Y, "rebuild": False})
    assert res.status_code == 200, res.text
    filtered = decode_streamed_json(res.content)
    after_filter = _mask(sid)
    removed_by_filter = int((after_filter & ~cropped).sum())
    assert removed_by_filter > 0
    # Pending = only what the filter removed; the crop is already out of the octree.
    assert filtered["deleted_count"] == int(after_filter.sum())
    assert filtered["pending_deleted_count"] == removed_by_filter

    _delete(client, sid, LOW_Y)
    res = client.post(f"/api/cloud/session/{sid}/reset_edits", json={"edit_count": 0})
    assert res.status_code == 200, res.text
    # The filter's commit is the floor: undo restores neither it nor the crop.
    np.testing.assert_array_equal(_mask(sid), after_filter)


def test_explicit_bake_still_compacts(session, client):
    sid = session
    crop = _delete(client, sid, LOW_X)
    _refresh(client, sid)
    res = client.post(f"/api/cloud/session/{sid}/bake")
    assert res.status_code == 200, res.text
    baked = decode_streamed_json(res.content)
    sess = main._get_cloud_session(sid)
    assert baked["point_count"] == crop["remaining_count"]
    assert len(sess.positions) == crop["remaining_count"]
    assert not _mask(sid).any()
    assert sess.unrestorable_hit_count == crop["deleted_count"]
    assert baked["pending_deleted_count"] == 0
    if sess.store is not None:
        assert sess.store.n == crop["remaining_count"]


def test_children_count_the_hits_they_cannot_restore(session, client):
    """A child holds only the parent's survivors it took, so every other parent
    hit is one LAD on the child cannot restore. The parent of a split keeps the
    moved rows under its mask (restorable), so its own count does not move."""
    sid = session
    n = len(main._get_cloud_session(sid).positions)
    crop = _delete(client, sid, LOW_X)

    res = client.post(f"/api/cloud/session/{sid}/duplicate")
    assert res.status_code == 200, res.text
    dup = main._get_cloud_session(res.json()["duplicate"]["session_id"])
    assert len(dup.positions) == crop["remaining_count"]
    assert dup.unrestorable_hit_count == crop["deleted_count"]

    res = client.post(f"/api/cloud/session/{sid}/split", json={"region": HIGH_Y})
    assert res.status_code == 200, res.text
    body = res.json()
    leftover = main._get_cloud_session(body["leftover"]["session_id"])
    parent = main._get_cloud_session(sid)
    assert parent.unrestorable_hit_count == 0
    # The leftover lacks the crop AND the band the parent kept.
    assert leftover.unrestorable_hit_count == n - len(leftover.positions)

    # A child of a child adds to what its parent had already lost.
    res = client.post(f"/api/cloud/session/{leftover.session_id}/duplicate")
    assert res.status_code == 200, res.text
    grand = main._get_cloud_session(res.json()["duplicate"]["session_id"])
    assert grand.unrestorable_hit_count == leftover.unrestorable_hit_count

    # A merge concatenates survivors, so it sums each input's losses.
    res = client.post("/api/cloud/session/merge",
                      json={"session_ids": [dup.session_id, leftover.session_id]})
    assert res.status_code == 200, res.text
    merged = main._get_cloud_session(res.json()["merged"]["session_id"])
    assert merged.unrestorable_hit_count == (dup.unrestorable_hit_count
                                             + leftover.unrestorable_hit_count)
