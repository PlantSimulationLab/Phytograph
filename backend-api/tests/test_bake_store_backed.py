"""A bake on a store-backed session must keep the cloud recoverable.

`bake` compacts every point-aligned array to the survivors of a delete. On a
session whose columns are memory-mapped from its `SessionStore`, that used to
(1) replace each map with a full in-RAM copy of the survivors, undoing the
point of the store for exactly the clouds it exists for, and (2) leave the
store recording the PRE-bake point count. The next eviction's write-back then
raised on the count mismatch, the spill failed, and the sweep dropped the
session - an edited 100 M-point cloud gone after a crop and 30 idle minutes.

Driven through the real HTTP API: import store-backed, delete a region, bake
(what the renderer's background refresh queue calls after every crop), evict,
restore.
"""
from pathlib import Path

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json
from tests.test_session_store_backed import _write_las


@pytest.fixture
def stored(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_SPILL_ROOT", str(tmp_path / "sessions"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "0")
    monkeypatch.setattr(main, "_cloud_sessions", {})
    monkeypatch.setattr(main, "_spilled_sessions", {})
    las = _write_las(tmp_path / "a.las")
    res = client.post("/api/cloud/session/create", json={"source_path": str(las)})
    assert res.status_code == 200, res.text
    return decode_streamed_json(res.content)["session_id"], tmp_path


def _crop_and_bake(client, sid):
    """Delete the x <= 2.5 half, then bake. Returns the survivors' positions
    as they stood before the bake (a detached copy)."""
    sess = main._get_cloud_session(sid)
    assert sess.store is not None and isinstance(sess.positions, np.memmap)
    res = client.post(f"/api/cloud/session/{sid}/delete_region",
                      json={"region": {"kind": "box", "min": [-1, -1, -10],
                                       "max": [2.5, 6, 10], "invert": False}})
    assert res.status_code == 200, res.text
    with main._cloud_session_lock:
        survivors = np.array(sess.positions[~sess.deleted])
    assert 0 < len(survivors) < len(sess.positions)
    res = client.post(f"/api/cloud/session/{sid}/bake")
    assert res.status_code == 200, res.text
    baked = decode_streamed_json(res.content)
    assert baked["point_count"] == len(survivors)
    return survivors


def test_bake_keeps_a_store_backed_session_on_its_store(stored, client):
    sid, _tmp = stored
    survivors = _crop_and_bake(client, sid)
    sess = main._get_cloud_session(sid)
    # The compacted columns are the store's maps again, sized to the survivors -
    # not a RAM copy of the whole cloud.
    assert sess.store is not None
    assert sess.store.n == len(survivors)
    assert isinstance(sess.positions, np.memmap)
    assert isinstance(sess.deleted, np.memmap)
    for arr in sess.extras.values():
        assert isinstance(arr, np.memmap)
    assert main._session_ram_bytes(sess) < survivors.nbytes
    np.testing.assert_array_equal(np.asarray(sess.positions), survivors)
    assert not np.asarray(sess.deleted).any()
    # The pre-bake directory is gone: exactly one store for this session.
    stores = [q for q in (_tmp / "sessions").rglob("*.store") if q.name.startswith(sid)]
    assert stores == [Path(sess.store.root)]


def test_a_second_bake_rehomes_again(stored, client):
    sid, _tmp = stored
    first = _crop_and_bake(client, sid)
    sess = main._get_cloud_session(sid)
    res = client.post(f"/api/cloud/session/{sid}/delete_region",
                      json={"region": {"kind": "box", "min": [-1, -1, -10],
                                       "max": [6, 2.5, 10], "invert": False}})
    assert res.status_code == 200, res.text
    with main._cloud_session_lock:
        expect = np.array(sess.positions[~sess.deleted])
    assert 0 < len(expect) < len(first)
    res = client.post(f"/api/cloud/session/{sid}/bake")
    assert res.status_code == 200, res.text
    sess = main._get_cloud_session(sid)
    assert sess.store.n == len(expect)
    np.testing.assert_array_equal(np.asarray(sess.positions), expect)
    stores = [q for q in (_tmp / "sessions").rglob("*.store") if q.name.startswith(sid)]
    assert stores == [Path(sess.store.root)]


def test_deleting_a_baked_store_backed_session_removes_its_store(stored, client):
    sid, tmp = stored
    _crop_and_bake(client, sid)
    res = client.delete(f"/api/cloud/session/{sid}")
    assert res.json()["deleted"] is True
    assert not list((tmp / "sessions").rglob("*.store"))


def test_a_baked_store_backed_session_survives_eviction(stored, client, monkeypatch):
    sid, _tmp = stored
    survivors = _crop_and_bake(client, sid)
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 0)
    main._sweep_cloud_sessions()
    assert sid in main._spilled_sessions, "the spill failed and the edited cloud was dropped"
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 8)
    back = main._get_cloud_session(sid)
    assert len(back.positions) == len(survivors)
    np.testing.assert_array_equal(np.asarray(back.positions), survivors)
    assert isinstance(back.positions, np.memmap)
    assert Path(back.store.root).is_dir()
