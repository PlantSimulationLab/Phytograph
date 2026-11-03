"""Compacting a store-backed session writes outside the global session lock.

It is multi-GB of disk I/O, so under the lock it stalled every request on every
cloud. The price is that the session can change during the write, so these pin
both halves: the lock is free meanwhile, and any edit that the copy would lose
refuses the compaction with the session and its store intact.
"""
import threading

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json


EVERYWHERE = {"kind": "box", "min": [-100, -100, -100], "max": [100, 100, 100]}


@pytest.fixture
def stored(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1")
    pts = np.random.default_rng(0).uniform(0, 10, size=(2000, 3))
    f = tmp_path / "cloud.xyz"
    np.savetxt(f, pts, fmt="%.4f")
    res = client.post("/api/cloud/session/create", json={"source_path": str(f), "ascii_format": "x y z"})
    assert res.status_code == 200, res.text
    sid = decode_streamed_json(res.content)["session_id"]
    sess = main._cloud_sessions[sid]
    assert sess.store is not None, "fixture must be store-backed"
    client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": {
        "kind": "box", "min": [0, 0, 0], "max": [3, 10, 10]}}).raise_for_status()
    return client, sid, sess


def _compact(sess):
    with main._cloud_session_lock:
        mask = np.array(sess.deleted, dtype=bool, copy=True)
        gen = sess.octree_stale_gen
    return main._compact_baked_session(sess, "c" * 40, mask, gen)


def _during_write(monkeypatch, action):
    real = main._write_compacted_store
    def wrapped(sess, refs, keep):
        out = real(sess, refs, keep)
        action()
        return out
    monkeypatch.setattr(main, "_write_compacted_store", wrapped)


def test_compaction_keeps_exactly_the_survivors(stored):
    _client, _sid, sess = stored
    want = np.asarray(sess.positions)[~sess.deleted].copy()
    old_root = sess.store.root
    assert _compact(sess) == len(want)
    np.testing.assert_array_equal(np.asarray(sess.positions), want)
    assert sess.store.root != old_root and not old_root.exists()
    assert sess.store.n == len(want) and not np.asarray(sess.deleted).any()
    assert isinstance(sess.positions, np.memmap), "compaction pulled the cloud back into RAM"


def test_the_lock_is_free_during_the_write(stored, monkeypatch):
    _client, _sid, sess = stored
    got = []
    def probe():
        def other_request():
            ok = main._cloud_session_lock.acquire(timeout=2)
            got.append(ok)
            if ok:
                main._cloud_session_lock.release()
        t = threading.Thread(target=other_request)
        t.start()
        t.join()
    _during_write(monkeypatch, probe)
    _compact(sess)
    assert got == [True], "another request could not get the lock during the store write"


def _assert_refused_and_intact(sess, old_store, want_positions):
    with pytest.raises(main.HTTPException) as e:
        _compact(sess)
    assert e.value.status_code == 409
    assert sess.store is old_store and old_store.root.exists()
    np.testing.assert_array_equal(np.asarray(sess.positions), want_positions)
    spill = old_store.root.parent
    orphans = [p for p in spill.glob(f"{sess.session_id}.g*.store")]
    assert orphans == [], f"a refused compaction left {orphans}"


def test_a_label_stroke_during_the_write_is_not_lost(stored, monkeypatch):
    """A stroke writes the column IN PLACE: same array, same mask, same octree
    generation. Without a write counter this one compacts the OLD labels."""
    client, sid, sess = stored
    client.post(f"/api/cloud/session/{sid}/label_region", json={
        "slug": "manual_class", "strokes": [{"region": EVERYWHERE, "to_class": 3, "stroke_id": "a"}],
    }).raise_for_status()
    old, want = sess.store, np.asarray(sess.positions).copy()
    def paint():
        res = client.post(f"/api/cloud/session/{sid}/label_region", json={
            "slug": "manual_class", "strokes": [{"region": EVERYWHERE, "to_class": 7, "stroke_id": "b"}]})
        assert res.status_code == 200, res.text
    _during_write(monkeypatch, paint)
    _assert_refused_and_intact(sess, old, want)
    alive = ~np.asarray(sess.deleted)
    assert (np.asarray(sess.extras["manual_class"])[alive & (np.asarray(sess.extras.get("is_miss", np.zeros(len(alive)))) == 0)] == 7).all()


def test_a_label_undo_during_the_write_is_not_lost(stored, monkeypatch):
    client, sid, sess = stored
    client.post(f"/api/cloud/session/{sid}/label_region", json={
        "slug": "manual_class", "strokes": [{"region": EVERYWHERE, "to_class": 3, "stroke_id": "a"}],
    }).raise_for_status()
    old, want = sess.store, np.asarray(sess.positions).copy()
    gen0 = sess.column_write_gen
    def undo():
        res = client.post(f"/api/cloud/session/{sid}/reset_label_edits", json={"slug": "manual_class", "edit_count": 0})
        assert res.status_code == 200, res.text
        assert sess.column_write_gen > gen0
    _during_write(monkeypatch, undo)
    _assert_refused_and_intact(sess, old, want)


def test_a_new_column_during_the_write_is_not_lost(stored, monkeypatch):
    _client, _sid, sess = stored
    old, want = sess.store, np.asarray(sess.positions).copy()
    def add_column():
        with main._cloud_session_lock:
            sess.extras["computed"] = np.ones(len(sess.positions), dtype=np.float32)
    _during_write(monkeypatch, add_column)
    _assert_refused_and_intact(sess, old, want)
    assert "computed" in sess.extras


def test_a_delete_during_the_write_is_refused(stored, monkeypatch):
    client, sid, sess = stored
    old, want = sess.store, np.asarray(sess.positions).copy()
    def delete():
        client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": {
            "kind": "box", "min": [8, 0, 0], "max": [10, 10, 10]}}).raise_for_status()
    _during_write(monkeypatch, delete)
    _assert_refused_and_intact(sess, old, want)


def test_a_session_evicted_during_the_write_keeps_its_store(stored, monkeypatch):
    """Installing into the orphan would delete the store its spill still needs."""
    _client, sid, sess = stored
    old, want = sess.store, np.asarray(sess.positions).copy()
    def evict():
        with main._cloud_session_lock:
            main._cloud_sessions.pop(sid)
    _during_write(monkeypatch, evict)
    try:
        _assert_refused_and_intact(sess, old, want)
    finally:
        main._cloud_sessions[sid] = sess


def test_a_failed_write_leaves_nothing_behind(stored, monkeypatch):
    _client, sid, sess = stored
    old = sess.store
    real_iter = main.session_store.iter_ranges
    def failing(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(main.session_store, "iter_ranges", failing)
    with pytest.raises(OSError):
        _compact(sess)
    monkeypatch.setattr(main.session_store, "iter_ranges", real_iter)
    assert sess.store is old
    assert list(old.root.parent.glob(f"{sid}.g*.store")) == []


def test_two_overlapping_compactions_do_not_share_a_directory(stored, monkeypatch):
    _client, _sid, sess = stored
    roots = []
    real = main._write_compacted_store
    def wrapped(s, refs, keep):
        out = real(s, refs, keep)
        roots.append(out["store"].root)
        if len(roots) == 1:
            second = real(s, refs, keep)
            roots.append(second["store"].root)
            second["store"].close()
            main._delete_session_store_dir(second["store"].root)
            assert out["store"].root.exists(), "the second write removed the first one's files"
        return out
    monkeypatch.setattr(main, "_write_compacted_store", wrapped)
    _compact(sess)
    assert len(set(roots)) == 2
