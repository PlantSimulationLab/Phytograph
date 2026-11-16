"""Whole-cloud session operations after issue #7: no fixed deadline, no orphans.

The stitch failed because one blocking request sat behind a fixed client
deadline and the backend carried on after the client gave up. The same shape
existed on split, extract, duplicate, transform and rebuild_octree, and around
it a handful of windows in which a cloud's display octree, or the cloud itself,
could go missing. These pin the rest of that work:

  - `?keepalive=1` streams the same result behind keepalives, while the plain
    JSON contract (scripting client, direct callers) is unchanged;
  - a child session whose octree build fails, or whose result is never
    collected, is discarded; a split in either case is undone, so the parent
    gets its points back;
  - the merge copies WITHOUT holding the global session lock, and refuses its
    result if an input was edited meanwhile;
  - an octree a session just stopped using stays in the cache for a grace
    period (the renderer is still drawing it);
  - a store directory that could not be deleted (a mapped file, on Windows) is
    retried later;
  - disk-backed sessions no longer take a slot under the in-RAM count cap;
  - a session being spilled is never in no registry at all.

PotreeConverter is stubbed: none of this is about the converter.
"""

import asyncio
import threading
import time

import numpy as np
import pytest

import main
from tests.binframe import decode_progress_markers, decode_streamed_json
from tests.test_session_merge_streaming import (  # noqa: F401 - `isolated` is a fixture
    _cloud, _install_fake_converter, _store_dirs, isolated)

HALF = {"scalar_filters": [{"slug": "reflectance", "min": 0.0, "max": 0.5}]}


def _survivors(sid: str) -> int:
    return int((~main._cloud_sessions[sid].deleted).sum())


# ---- keepalive transport ----------------------------------------------------

@pytest.mark.parametrize("path,body,key", [
    ("split", HALF, "kept"),
    ("extract", HALF, "extracted"),
    ("duplicate", None, "duplicate"),
    ("rebuild_octree", None, "cache_id"),
])
def test_keepalive_mode_streams_the_same_result_and_plain_mode_is_unchanged(
        client, isolated, monkeypatch, path, body, key):
    _install_fake_converter(monkeypatch)
    sid = _cloud("a")
    url = f"/api/cloud/session/{sid}/{path}"

    plain = client.post(url, json=body) if body is not None else client.post(url)
    assert plain.status_code == 200, plain.text
    assert key in plain.json()                      # plain JSON, exactly as before

    sid2 = _cloud("b", offset=5.0)
    url2 = f"/api/cloud/session/{sid2}/{path}?keepalive=1"
    res = client.post(url2, json=body) if body is not None else client.post(url2)
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("application/octet-stream")
    assert key in decode_streamed_json(res.content)


def test_keepalive_transform_streams_too(client, isolated, monkeypatch):
    _install_fake_converter(monkeypatch)
    sid = _cloud("a")
    before = main._cloud_sessions[sid].positions.copy()
    shift = [1, 0, 0, 2.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    res = client.post(f"/api/cloud/session/{sid}/transform?keepalive=1", json={"matrix": shift})
    assert res.status_code == 200, res.text
    decode_streamed_json(res.content)
    np.testing.assert_allclose(main._cloud_sessions[sid].positions, before + [2.5, 0, 0])


def test_a_long_keepalive_operation_actually_sends_keepalives(client, isolated, monkeypatch):
    """The point of the mode: bytes reach the client while the work runs, so an
    idle deadline is refreshed. (The interval is shortened; it is 5 s in use.)"""
    def slow(cancel_event):
        time.sleep(0.6)
    _install_fake_converter(monkeypatch, before_write=slow)
    sid = _cloud("a")
    real = main._bin_frame_streaming_response
    # The helper's keepalive cadence is a local; drive it through asyncio.sleep.
    sleeps = []
    real_sleep = asyncio.sleep

    async def fast_sleep(d):
        sleeps.append(d)
        await real_sleep(d / 50)           # make "5 s of silence" elapse quickly
    monkeypatch.setattr(asyncio, "sleep", fast_sleep)
    res = client.post(f"/api/cloud/session/{sid}/duplicate?keepalive=1")
    monkeypatch.setattr(asyncio, "sleep", real_sleep)
    assert res.status_code == 200
    body = res.content
    assert real is main._bin_frame_streaming_response
    lead = len(body) - len(body.lstrip(b" "))
    assert lead >= 4, "no keepalive bytes preceded the result"
    assert "duplicate" in decode_streamed_json(body)


def test_a_failure_in_keepalive_mode_is_reported_with_its_detail(client, isolated):
    res = client.post("/api/cloud/session/nope/duplicate?keepalive=1")
    assert res.status_code == 200                    # the stream was already open
    errors = [m["error"] for m in decode_progress_markers(res.content) if m.get("error")]
    assert errors == ["Cloud session not found: nope"], errors
    # Plain mode keeps its status code.
    assert client.post("/api/cloud/session/nope/duplicate").status_code == 404


# ---- no orphans --------------------------------------------------------------

@pytest.mark.parametrize("path,body", [("duplicate", None), ("extract", HALF)])
def test_a_child_whose_octree_build_fails_is_discarded(client, isolated, monkeypatch, path, body):
    sid = _cloud("a")
    before = set(main._cloud_sessions)
    monkeypatch.setattr(main, "_session_rebuild",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("converter exploded")))
    with pytest.raises(RuntimeError, match="converter exploded"):
        if path == "duplicate":
            main.session_duplicate(sid)
        else:
            main.session_extract(sid, main.SessionExtractRequest(**body))
    assert set(main._cloud_sessions) == before


async def _run_until_frame_then_disconnect(resp):
    """Consume a keepalive response up to and including its result, then close
    it without resuming: what a client disconnecting as the work finishes does."""
    body = resp.body_iterator
    while True:
        chunk = await body.__anext__()
        if chunk.lstrip().startswith((b"{", b"null")):
            break
    await body.aclose()


async def _eventually(predicate, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.05)
    return predicate()


@pytest.mark.parametrize("which", ["duplicate", "extract"])
async def test_a_child_nobody_collects_is_discarded(isolated, monkeypatch, which):
    _install_fake_converter(monkeypatch)
    sid = _cloud("a")
    before = set(main._cloud_sessions)
    if which == "duplicate":
        resp = main.session_duplicate(sid, None, keepalive=True)
    else:
        resp = main.session_extract(sid, main.SessionExtractRequest(**HALF), None, keepalive=True)
    await _run_until_frame_then_disconnect(resp)
    assert await _eventually(lambda: set(main._cloud_sessions) == before), (
        "the uncollected child session stayed resident")


def test_a_split_that_fails_after_its_commit_is_undone(isolated, monkeypatch):
    """The reviewer's worst case: the split has already moved points off the
    parent when the octree build fails. The caller is told it failed, and the
    points sat on a leftover session nothing pointed at."""
    sid = _cloud("a")
    before_sessions, whole = set(main._cloud_sessions), _survivors(sid)
    calls = []

    def fail_on_first(sess, *a, **k):
        calls.append(sess.session_id)
        raise RuntimeError("converter exploded")

    monkeypatch.setattr(main, "_session_rebuild", fail_on_first)
    with pytest.raises(RuntimeError, match="converter exploded"):
        main.session_split(sid, main.SessionSplitRequest(**HALF))
    assert calls and calls[0] != sid, "the leftover was never built: the split did nothing"
    assert _survivors(sid) == whole, "the parent did not get its points back"
    assert set(main._cloud_sessions) == before_sessions, "the leftover session was left behind"


def test_an_undone_split_gives_back_the_undo_state_it_ended(isolated, monkeypatch):
    """The split commit makes the post-split mask (moved rows included) the
    floor erase-undo replays onto, and ends the erase/label undo history.
    Undoing the split un-deleted the rows but kept that floor, so the next
    erase-undo re-deleted the half that had just been given back."""
    sid = _cloud("a")
    sess = main._cloud_sessions[sid]
    whole = _survivors(sid)
    pos = np.asarray(sess.positions)
    lo, hi = pos.min(axis=0) - 1.0, pos.max(axis=0) + 1.0
    hi[0] = np.quantile(pos[:, 0], 0.2)          # erase the lowest-x fifth
    main.delete_cloud_region(sid, main.DeleteRegionRequest(
        region={"kind": "box", "min": lo.tolist(), "max": hi.tolist()}))
    erased = whole - _survivors(sid)
    assert erased > 0 and len(sess.deleted_history) == 1

    monkeypatch.setattr(main, "_session_rebuild",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("converter exploded")))
    with pytest.raises(RuntimeError):
        main.session_split(sid, main.SessionSplitRequest(**HALF))
    assert _survivors(sid) == whole - erased, "the split was not undone"
    assert len(sess.deleted_history) == 1, "the erase's undo step was not given back"

    main.reset_cloud_edits(sid, main.ResetCloudEditsRequest(edit_count=0))   # undo the erase
    assert _survivors(sid) == whole, "erase-undo re-deleted the rows the split gave back"


def test_an_undone_split_never_replays_its_moved_rows_after_a_later_erase(isolated, monkeypatch):
    """If an erase was recorded after the split (so its prior undo state cannot
    simply be put back), the moved rows must at least leave the replay floor."""
    _install_fake_converter(monkeypatch)
    sid = _cloud("a")
    sess = main._cloud_sessions[sid]
    whole = _survivors(sid)
    undo: dict = {}
    main._do_session_split(sid, main.SessionSplitRequest(**HALF), undo)
    moved = len(undo["rows"])
    pos = np.asarray(sess.positions)
    live = np.flatnonzero(~sess.deleted)
    target = pos[live[0]]
    main.delete_cloud_region(sid, main.DeleteRegionRequest(region={
        "kind": "box", "min": (target - 1e-6).tolist(), "max": (target + 1e-6).tolist()}))
    assert sess.deleted_history, "the later erase recorded nothing"

    main._undo_split(undo)
    assert _survivors(sid) == whole - 1
    main.reset_cloud_edits(sid, main.ResetCloudEditsRequest(edit_count=0))
    assert moved > 0 and _survivors(sid) == whole


def test_a_successful_split_is_not_undone(client, isolated, monkeypatch):
    _install_fake_converter(monkeypatch)
    sid = _cloud("a")
    whole = _survivors(sid)
    out = decode_streamed_json(client.post(
        f"/api/cloud/session/{sid}/split?keepalive=1", json=HALF).content)
    time.sleep(0.3)
    assert out["leftover"]["session_id"] in main._cloud_sessions
    # (Counted on the sessions: the stubbed converter reports 0 points.)
    kept, moved = _survivors(sid), _survivors(out["leftover"]["session_id"])
    assert 0 < kept < whole and kept + moved == whole


async def test_a_split_nobody_collects_is_undone(isolated, monkeypatch):
    _install_fake_converter(monkeypatch)
    sid = _cloud("a")
    before_sessions, whole = set(main._cloud_sessions), _survivors(sid)
    resp = main.session_split(sid, main.SessionSplitRequest(**HALF), None, keepalive=True)
    await _run_until_frame_then_disconnect(resp)
    assert await _eventually(lambda: _survivors(sid) == whole
                             and set(main._cloud_sessions) == before_sessions), (
        "an uncollected split left the parent short and its leftover orphaned")


def _rows_of(sess):
    """Every surviving row as (x, y, z, reflectance), sorted: the cloud's
    content regardless of row order, with the column still paired to its point."""
    keep = ~np.asarray(sess.deleted)
    rows = np.column_stack([np.asarray(sess.positions)[keep],
                            np.asarray(sess.extras["reflectance"])[keep]])
    return rows[np.lexsort(rows.T[::-1])]


def _split_then_compact(sid, monkeypatch):
    """A split whose parent is then COMPACTED by a bake (the real compaction),
    so the rows the split moved no longer exist on the parent at all."""
    _install_fake_converter(monkeypatch)
    sess = main._cloud_sessions[sid]
    whole = _rows_of(sess)
    undo = {}
    out = main._do_session_split(sid, main.SessionSplitRequest(**HALF), undo)
    leftover = out["leftover"]["session_id"]
    main._compact_baked_session(sess, "c" * 40, np.asarray(sess.deleted).copy(),
                                sess.octree_stale_gen)
    assert 0 < len(sess.positions) < len(whole), "the compaction dropped nothing"
    return sess, whole, undo, leftover


@pytest.mark.parametrize("store_backed", [False, True])
def test_a_split_is_undone_even_after_the_parent_was_compacted(isolated, monkeypatch, store_backed):
    """Un-deleting cannot work once a bake has compacted the parent: the moved
    rows are gone from it. The leftover's points are appended back instead, so
    the cloud is whole again and no orphan is left holding part of it."""
    sid = _cloud("a")
    before_sessions = set(main._cloud_sessions)
    sess, whole, undo, leftover = _split_then_compact(sid, monkeypatch)
    if store_backed:
        monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1")
    stores_before = _store_dirs()

    main._undo_split(undo)

    np.testing.assert_array_equal(_rows_of(sess), whole)      # every point, column still paired
    assert len(sess.positions) == len(whole) and not np.asarray(sess.deleted).any()
    assert np.asarray(sess.colors).shape == (len(whole), 3)
    assert set(main._cloud_sessions) == before_sessions, "the leftover was left behind"
    assert main._cloud_sessions[sid] is sess, "the parent must keep its identity"
    assert sess.octree_cache_id is None, "the display must be rebuilt for the restored points"
    if store_backed:
        assert isinstance(sess.positions, np.memmap) and sess.store is not None
        new_dirs = _store_dirs() - stores_before
        # Named for the PARENT, so deleting the parent removes it.
        assert len(new_dirs) == 1 and next(iter(new_dirs)).name.startswith(f"{sid}.g")
        main._discard_cloud_session(sid)
        assert _store_dirs() == stores_before
    else:
        assert sess.store is None


def test_an_undo_that_can_restore_the_parent_neither_way_keeps_the_leftover(isolated, monkeypatch):
    """Compacted AND then edited: appending would apply the parent's new
    deletions for good and drop their undo. Then the leftover is the points'
    only copy and must survive."""
    sid = _cloud("a")
    sess, whole, undo, leftover = _split_then_compact(sid, monkeypatch)
    with main._cloud_session_lock:
        sess.deleted[:5] = True                      # a delete landed after the bake
    kept_rows = len(sess.positions)
    main._undo_split(undo)
    assert leftover in main._cloud_sessions
    assert len(sess.positions) == kept_rows, "the parent must be left exactly as it was"


# ---- merge without the global lock -------------------------------------------

def test_the_merge_copy_does_not_hold_the_session_lock(isolated, monkeypatch):
    """Holding the global lock across the copy stalled every session request on
    every cloud for as long as it took (minutes at issue #7's size)."""
    _install_fake_converter(monkeypatch)
    monkeypatch.setattr(main.session_store, "DEFAULT_CHUNK_ROWS", 16)
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    got_lock_mid_copy = []

    def progress(fraction, message):
        if "Combining cloud" in message and not got_lock_mid_copy:
            free = main._cloud_session_lock.acquire(timeout=0.5)
            if free:
                main._cloud_session_lock.release()
            got_lock_mid_copy.append(free)

    merged = main._do_session_merge([a, b], progress=progress)["merged"]
    assert got_lock_mid_copy == [True]
    assert main._cloud_sessions[merged["session_id"]].positions.shape[0] == 600

    # The caller-holds-the-lock variant keeps it throughout, as its callers expect.
    held = []

    def progress_locked(fraction, message):
        free = main._cloud_session_lock.acquire(timeout=0.05)
        if free:
            main._cloud_session_lock.release()
        held.append(not free)

    sessions = [main._cloud_sessions[a], main._cloud_sessions[b]]
    with main._cloud_session_lock:
        main._merge_sessions_locked(sessions, progress=progress_locked)
    assert held and all(held)


def test_a_merge_whose_input_was_edited_during_the_copy_is_refused(isolated, monkeypatch):
    _install_fake_converter(monkeypatch)
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1")
    monkeypatch.setattr(main.session_store, "DEFAULT_CHUNK_ROWS", 16)
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    before_sessions, before_stores = set(main._cloud_sessions), _store_dirs()
    edited = []

    def progress(fraction, message):
        if "Combining cloud" in message and not edited:
            # A label stroke lands mid-copy. (With a timeout, so a regression
            # that holds the lock across the copy FAILS here instead of hanging.)
            assert main._cloud_session_lock.acquire(timeout=2), "the copy holds the lock"
            try:
                main._cloud_sessions[b].column_write_gen += 1
            finally:
                main._cloud_session_lock.release()
            edited.append(1)

    with pytest.raises(RuntimeError, match="edited while it was being stitched"):
        main._do_session_merge([a, b], progress=progress)
    assert set(main._cloud_sessions) == before_sessions
    assert _store_dirs() == before_stores
    assert not main._cloud_session_lock.locked(), "the lock was left held"


def test_a_delete_during_the_copy_does_not_refuse_the_merge(isolated, monkeypatch):
    """A delete only flips a mask the merge already snapshotted: the result is
    the cloud as it was when the stitch began, like any other operation."""
    _install_fake_converter(monkeypatch)
    monkeypatch.setattr(main.session_store, "DEFAULT_CHUNK_ROWS", 16)
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    done = []

    def progress(fraction, message):
        if "Combining cloud" in message and not done:
            assert main._cloud_session_lock.acquire(timeout=2), "the copy holds the lock"
            try:
                main._cloud_sessions[b].deleted[:100] = True
            finally:
                main._cloud_session_lock.release()
            done.append(1)

    merged = main._do_session_merge([a, b], progress=progress)["merged"]
    assert main._cloud_sessions[merged["session_id"]].positions.shape[0] == 600


# ---- a replaced octree outlives its replacement for a while ------------------

def test_an_octree_a_session_just_stopped_using_stays_pinned_for_a_grace_period(isolated, monkeypatch):
    sid = _cloud("a")
    sess = main._cloud_sessions[sid]
    old, new = "a" * 40, "b" * 40
    sess.octree_cache_id = old
    assert old in main._live_session_octree_ids()
    sess.octree_cache_id = new                       # a rebuild finished
    pinned = main._live_session_octree_ids()
    assert new in pinned and old in pinned, "the octree the renderer still draws was unpinned"

    # ...for a while, not for good.
    with main._recently_replaced_lock:
        main._recently_replaced_octrees[old] = time.time() - 1
    assert old not in main._live_session_octree_ids()

    # Every octree field is covered, and assigning the same id is not a replacement.
    sess.miss_octree_cache_id = "c" * 40
    sess.miss_octree_cache_id = "c" * 40
    assert "c" * 40 not in main._recently_replaced_octrees
    sess.miss_octree_cache_id = None
    sess.rendered_octree_cache_id = "d" * 40
    sess.rendered_octree_cache_id = None
    assert {"c" * 40, "d" * 40} <= main._recently_replaced_octree_ids()

    monkeypatch.setenv("PHYTOGRAPH_OCTREE_REPLACED_GRACE_S", "0")
    sess.octree_cache_id = "e" * 40
    assert new not in main._recently_replaced_octrees, "a zero grace must pin nothing"


def test_a_bake_on_a_full_cache_does_not_delete_the_octree_it_replaces(client, tmp_path, monkeypatch):
    """End to end, with the real converter: the cache is over its cap, a refresh
    replaces the drawn octree, and the old one must still be on disk right
    after, because the renderer is still streaming from it."""
    try:
        main._resolve_potree_converter_path()
    except Exception:
        pytest.skip("PotreeConverter binary not found")
    root = tmp_path / "octrees"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    rng = np.random.default_rng(3)
    f = tmp_path / "c.xyz"
    np.savetxt(f, rng.uniform(0, 10, (2000, 3)), fmt="%.4f")
    created = decode_streamed_json(client.post(
        "/api/cloud/session/create", json={"source_path": str(f), "ascii_format": "x y z"}).content)
    sid, drawn = created["session_id"], created["cache_id"]
    client.post(f"/api/cloud/session/{sid}/delete_region",
                json={"region": {"kind": "box", "min": [0, 0, 0], "max": [3, 3, 10]}})
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_MAX_BYTES", "1")

    r = client.post(f"/api/cloud/session/{sid}/bake?compact=false")
    assert r.status_code == 200, r.text
    fresh = main._cloud_sessions[sid].octree_cache_id
    assert fresh and fresh != drawn
    assert (root / drawn / "metadata.json").is_file(), "the still-drawn octree was evicted"

    # Once the grace has passed, the next trim takes it.
    with main._recently_replaced_lock:
        main._recently_replaced_octrees.clear()
    main._evict_octree_cache(1, keep=[root / fresh])
    assert not (root / drawn).exists()


# ---- store directories that could not be deleted -----------------------------

def test_a_store_directory_that_cannot_be_deleted_yet_is_retried(isolated, monkeypatch):
    """Windows refuses to delete a mapped file. One best-effort try left a
    canceled merge's store on disk until the next launch."""
    store_dir = main._session_spill_root() / "deadbeef.store"
    store_dir.mkdir(parents=True)
    (store_dir / "positions.npy").write_bytes(b"x" * 64)
    real_rmtree = main._shutil.rmtree
    blocked = {"on": True}

    def rmtree(path, ignore_errors=False, **kw):
        if blocked["on"] and str(path) == str(store_dir):
            return                                   # "the file is in use"
        return real_rmtree(path, ignore_errors=ignore_errors, **kw)

    monkeypatch.setattr(main._shutil, "rmtree", rmtree)
    main._delete_session_store_dir(store_dir)
    assert store_dir.exists() and str(store_dir) in main._pending_store_deletes

    main._sweep_cloud_sessions()                     # still mapped: still pending
    assert store_dir.exists() and str(store_dir) in main._pending_store_deletes

    blocked["on"] = False                            # the last reference is gone
    main._sweep_cloud_sessions()
    assert not store_dir.exists()
    assert str(store_dir) not in main._pending_store_deletes


def test_a_discarded_merge_releases_its_arrays_before_deleting(isolated, monkeypatch):
    """The discard clears the session's own array fields first, so the store's
    maps are not kept alive by the object being thrown away."""
    _install_fake_converter(monkeypatch)
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1")
    a, b = _cloud("a"), _cloud("b", offset=5.0)
    merged_id = main._do_session_merge([a, b])["merged"]["session_id"]
    sess = main._cloud_sessions[merged_id]
    assert isinstance(sess.positions, np.memmap)
    main._discard_cloud_session(merged_id, release_arrays=True)
    assert sess.positions is None and sess.colors is None and sess.extras == {}
    assert merged_id not in main._cloud_sessions
    assert not any(merged_id in p.name for p in _store_dirs())


# ---- the count cap counts sessions that hold RAM ------------------------------

def _register(name, n=64, *, on_disk, age):
    sess = main.CloudSession(
        session_id=name, source_path=f"/tmp/{name}.las", ascii_format=None, column_plan=None,
        positions=np.zeros((n, 3)), colors=None, intensity=None, extras={}, extra_dims_meta=[],
        deleted=np.zeros(n, dtype=bool), deleted_history=[], octree_cache_id=None,
        created_at=time.time() - age, last_accessed=time.time() - age)
    sess.store = object() if on_disk else None      # only "is it store-backed" is read here
    main._cloud_sessions[name] = sess
    return sess


def test_disk_backed_sessions_do_not_take_slots_under_the_ram_cap(isolated, monkeypatch):
    """Issue #7: 26 store-backed scans under a cap of 7 meant every crop across
    the scene spilled and restored 10-12 clouds per step, for sessions that
    hold almost no RAM."""
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 2)
    monkeypatch.delenv("PHYTOGRAPH_MAX_STORE_BACKED_SESSIONS", raising=False)
    for i in range(26):
        _register(f"disk{i}", on_disk=True, age=100 + i)
    for i in range(3):
        _register(f"ram{i}", on_disk=False, age=10 + i)
    with main._cloud_session_lock:
        victims = main._eviction_victims_locked(time.time(), set())
    assert victims == ["ram2"], victims                # the oldest IN-RAM one, and nothing else

    # Disk-backed sessions still have a cap of their own.
    monkeypatch.setenv("PHYTOGRAPH_MAX_STORE_BACKED_SESSIONS", "20")
    with main._cloud_session_lock:
        victims = main._eviction_victims_locked(time.time(), set())
    assert sorted(victims) == sorted(["ram2"] + [f"disk{i}" for i in range(20, 26)])


# ---- a session being spilled is always in SOME registry -----------------------

def test_a_spilled_session_is_indexed_in_the_same_step_it_stops_spilling(isolated, monkeypatch):
    """Popped from `_spilling_sessions` in one critical section and added to
    `_spilled_sessions` in the next, a session was briefly in neither: a lookup
    answered 404 for a cloud that exists, and its octrees were unpinned."""
    a = _cloud("a")
    _cloud("b", offset=5.0)
    main._cloud_sessions[a].last_accessed = time.time() - 3600
    main._cloud_sessions[a].octree_cache_id = "f" * 40
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 1)
    with main._recently_replaced_lock:
        main._recently_replaced_octrees.clear()

    real_lock = main._cloud_session_lock
    in_no_registry = []

    class Watching:
        """Every time the lock is released, check where session `a` is."""
        def __enter__(self):
            return real_lock.__enter__()

        def __exit__(self, *exc):
            where = (a in main._cloud_sessions, a in main._spilling_sessions,
                     a in main._spilled_sessions)
            if not any(where):
                in_no_registry.append(where)
            return real_lock.__exit__(*exc)

        def acquire(self, *a_, **k):
            return real_lock.acquire(*a_, **k)

        def release(self):
            return real_lock.release()

        def locked(self):
            return real_lock.locked()

    monkeypatch.setattr(main, "_cloud_session_lock", Watching())
    main._sweep_cloud_sessions()
    assert a in main._spilled_sessions
    assert in_no_registry == [], "the session was in no registry between two lock holds"


# ---- the last three fixed deadlines: import by path, stem detection, LAD export

def test_import_by_path_keepalive_sends_the_same_bytes_after_its_keepalives(client, tmp_path):
    f = tmp_path / "small.xyz"
    f.write_text("\n".join(f"{i * 0.1:.3f} {i * 0.2:.3f} {i * 0.3:.3f}" for i in range(50)) + "\n")
    body = {"file_path": str(f), "ascii_format": "x y z"}
    plain = client.post("/api/pointcloud/import_by_path", json=body)
    assert plain.status_code == 200 and plain.content[:4] == b"PHX1"

    kept = client.post("/api/pointcloud/import_by_path?keepalive=1", json=body)
    assert kept.status_code == 200
    lead = len(kept.content) - len(kept.content.lstrip(b" "))
    assert lead % 4 == 0, "keepalives must keep the float arrays 4-byte aligned"
    assert kept.content[lead:] == plain.content

    missing = client.post("/api/pointcloud/import_by_path?keepalive=1",
                          json={"file_path": str(tmp_path / "nope.xyz")})
    assert missing.status_code == 200
    errors = [m["error"] for m in decode_progress_markers(missing.content) if m.get("error")]
    assert errors and "nope.xyz" in errors[0]
    assert client.post("/api/pointcloud/import_by_path",
                       json={"file_path": str(tmp_path / "nope.xyz")}).status_code >= 400


def test_stem_detection_and_lad_export_keepalive_report_refusals_with_their_text(client, isolated):
    sid = _cloud("a")
    plain = client.post(f"/api/cloud/session/{sid}/detect_stems", json={})
    assert plain.status_code == 400 and "heights above the terrain" in plain.json()["detail"]
    kept = client.post(f"/api/cloud/session/{sid}/detect_stems?keepalive=1", json={})
    assert kept.status_code == 200
    errors = [m["error"] for m in decode_progress_markers(kept.content) if m.get("error")]
    assert errors == [plain.json()["detail"]]

    lad = {"cells": [], "nx": 1, "ny": 1, "nz": 1, "origin": [0, 0, 0],
           "cell_size": [1, 1, 1], "format": "csv"}
    plain = client.post("/api/lad/export", json=lad)
    assert plain.status_code == 400 and plain.json()["detail"] == "No voxels to export."
    kept = client.post("/api/lad/export?keepalive=1", json=lad)
    assert kept.status_code == 200
    errors = [m["error"] for m in decode_progress_markers(kept.content) if m.get("error")]
    assert errors == ["No voxels to export."]


def test_stem_detection_keepalive_returns_the_same_result(client, isolated):
    sid = _cloud("a")
    sess = main._cloud_sessions[sid]
    with main._cloud_session_lock:
        sess.extras[main.HEIGHT_ABOVE_GROUND_SLUG] = np.full(len(sess.positions), 1.3, dtype=np.float32)
    plain = client.post(f"/api/cloud/session/{sid}/detect_stems", json={})
    assert plain.status_code == 200, plain.text
    kept = client.post(f"/api/cloud/session/{sid}/detect_stems?keepalive=1", json={})
    assert decode_streamed_json(kept.content) == plain.json()
    assert plain.json()["layer_points"] == 300
