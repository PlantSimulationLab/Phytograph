"""Whole-cloud work stays OUTSIDE the global session lock.

`_cloud_session_lock` guards every cloud at once, so any whole-cloud gather or
copy done while holding it stalls every request on every cloud. These pin that
the heavy part of each fixed path runs with the lock free, and that the result
is still the one the old locked code gave.
"""

import numpy as np

import main


class _Watched(np.ndarray):
    """An array that records, at every fancy-index gather, whether the global
    session lock was held and how many rows were asked for."""

    log: list = []

    def __getitem__(self, key):
        if isinstance(key, np.ndarray) and key.ndim == 1:
            n = int(key.sum()) if key.dtype == bool else len(key)
            _Watched.log.append((main._cloud_session_lock.locked(), n))
        return np.asarray(super().__getitem__(key))

    def astype(self, *a, **k):
        _Watched.log.append((main._cloud_session_lock.locked(), len(self)))
        return np.asarray(self).astype(*a, **k)


def _session(n=50_000, seed=0):
    rng = np.random.default_rng(seed)
    pos = rng.uniform(0, 10, (n, 3)).view(_Watched)
    deleted = np.zeros(n, dtype=bool)
    deleted[::7] = True
    miss = np.zeros(n, dtype=np.uint8)
    miss[::11] = 1
    s = main.CloudSession(
        session_id=f"lockscope-{seed}", source_path="", ascii_format=None,
        column_plan=None, positions=pos, colors=None, intensity=None,
        extras={main._MISS_SLUG: miss, "refl": rng.uniform(0, 1, n).astype(np.float32)},
        extra_dims_meta=[{"slug": main._MISS_SLUG, "label": "Miss"},
                         {"slug": "refl", "label": "Refl"}],
        deleted=deleted, deleted_history=[], octree_cache_id=None, created_at=0.0)
    main._cloud_sessions[s.session_id] = s
    return s


def test_reading_a_session_gathers_outside_the_lock_and_only_the_strided_rows():
    s = _session()
    try:
        _Watched.log.clear()
        pos, _c, _i, extras = main._read_points_and_extras(main.PointSource(
            session_id=s.session_id, max_points=2_000, want_extras=True))
        assert _Watched.log, "positions were never gathered"
        assert all(not locked for locked, _n in _Watched.log), "gathered under the global lock"
        assert all(n <= 2_000 for _locked, n in _Watched.log), (
            f"gathered {max(n for _l, n in _Watched.log):,} rows to keep 2,000")
        # The same rows the old code kept: survivors that are hits, strided.
        p = np.asarray(s.positions)
        keep = ~s.deleted & (s.extras[main._MISS_SLUG] == 0)
        expect = p[keep]
        stride = int(np.ceil(len(expect) / 2_000))
        np.testing.assert_array_equal(pos, expect[::stride])
        np.testing.assert_array_equal(extras["refl"], s.extras["refl"][keep][::stride])
        assert main._MISS_SLUG in extras and not extras[main._MISS_SLUG].any()
    finally:
        main._cloud_sessions.pop(s.session_id, None)


def _watch_subset_builds(monkeypatch):
    seen = []
    real = main._build_subset_session

    def watched(snap, take):
        seen.append(main._cloud_session_lock.locked())
        return real(snap, take)

    monkeypatch.setattr(main, "_build_subset_session", watched)
    return seen


def _no_octree(monkeypatch):
    monkeypatch.setattr(main, "_session_rebuild", lambda *a, **k: ("c", main._Path("/tmp"), {}))
    monkeypatch.setattr(main, "_build_child_or_discard",
                        lambda child, created: ("c", main._Path("/tmp"), {}))


HALF_X = {"region": {"kind": "box", "min": [-1, -1, -1], "max": [5, 11, 11]}}


def test_split_extract_and_duplicate_copy_outside_the_lock(monkeypatch):
    s = _session(seed=2)
    seen = _watch_subset_builds(monkeypatch)
    _no_octree(monkeypatch)
    made = []
    try:
        p = np.asarray(s.positions)
        surv = ~s.deleted
        hit = s.extras[main._MISS_SLUG] == 0
        r = main._do_session_extract(s.session_id, main.SessionExtractRequest(**HALF_X), {})
        made.append(r["extracted"]["session_id"])
        r = main._do_session_duplicate(s.session_id, {})
        made.append(r["duplicate"]["session_id"])
        r = main._do_session_split(s.session_id, main.SessionSplitRequest(**HALF_X), {})
        made.append(r["leftover"]["session_id"])
        assert len(seen) == 3 and not any(seen), f"lock held during the copy: {seen}"

        ext, dup, left = (main._cloud_sessions[m] for m in made)
        inside = p[:, 0] <= 5
        # extract: survivors inside the box, plus every surviving miss
        np.testing.assert_array_equal(ext.positions, p[surv & (inside | ~hit)])
        np.testing.assert_array_equal(dup.positions, p[surv])
        # split: the leftover is the surviving HITS outside the box (misses stay)
        np.testing.assert_array_equal(left.positions, p[surv & hit & ~inside])
        assert not (~s.deleted & hit & ~inside).any()
    finally:
        for sid in [s.session_id, *made]:
            main._cloud_sessions.pop(sid, None)


def test_extract_by_column_slices_outside_the_lock(monkeypatch):
    s = _session(seed=3)
    s.extras["tree"] = (np.arange(len(s.positions)) % 4).astype(np.int32)
    seen = _watch_subset_builds(monkeypatch)
    try:
        kids = main._slice_children_by_column(s, "tree", exclude={0})
        assert [v for v, _c in kids] == [1, 2, 3]
        assert seen and not any(seen)
        for v, child in kids:
            assert child.session_id in main._cloud_sessions
            assert set(np.unique(child.extras["tree"])) == {v}
    finally:
        main._cloud_sessions.pop(s.session_id, None)
        for _v, child in locals().get("kids", []):
            main._cloud_sessions.pop(child.session_id, None)


def test_a_split_refuses_when_the_cloud_is_edited_mid_copy(monkeypatch):
    s = _session(seed=4)
    real = main._build_subset_session
    _no_octree(monkeypatch)

    def edit_during(snap, take):
        child = real(snap, take)
        with main._cloud_session_lock:
            s.deleted[np.flatnonzero(~s.deleted)[0]] = True     # a concurrent erase
        return child

    monkeypatch.setattr(main, "_build_subset_session", edit_during)
    before_ids = set(main._cloud_sessions)
    deleted_before = s.deleted.copy()
    try:
        with __import__("pytest").raises(main.HTTPException) as exc:
            main._do_session_split(s.session_id, main.SessionSplitRequest(**HALF_X), {})
        assert exc.value.status_code == 409
        assert set(main._cloud_sessions) == before_ids, "the leftover was registered anyway"
        # Only the concurrent erase changed the mask; the split committed nothing.
        assert int((s.deleted != deleted_before).sum()) == 1
    finally:
        main._cloud_sessions.pop(s.session_id, None)


def test_resample_thins_outside_the_lock_and_refuses_a_stale_commit(monkeypatch):
    import pytest
    s = _session(seed=5)
    real = main._resample_keep_mask
    seen = []

    def watched(pos, request):
        seen.append(main._cloud_session_lock.locked())
        return real(pos, request)

    monkeypatch.setattr(main, "_resample_keep_mask", watched)
    try:
        req = main.SessionResampleRequest(mode="random", fraction=0.5, seed=1)
        r = main.session_resample(s.session_id, req)
        assert r["committed"] and seen == [False]

        def edit_during(pos, request):
            with main._cloud_session_lock:
                s.deleted[np.flatnonzero(~s.deleted)[0]] = True
            return real(pos, request)

        monkeypatch.setattr(main, "_resample_keep_mask", edit_during)
        before = s.deleted.copy()
        with pytest.raises(main.HTTPException) as exc:
            main.session_resample(s.session_id, req)
        assert exc.value.status_code == 409
        assert int((s.deleted != before).sum()) == 1        # only the concurrent erase
    finally:
        main._cloud_sessions.pop(s.session_id, None)


class _ReadWatched:
    """Positions that log the lock state on any read, by index or `np.asarray`."""

    def __init__(self, arr):
        self._a = arr
        self.shape = arr.shape
        self.log = []

    def __len__(self):
        return len(self._a)

    def __array__(self, dtype=None, copy=None):
        self.log.append(main._cloud_session_lock.locked())
        return self._a if dtype is None else self._a.astype(dtype)

    def __getitem__(self, key):
        self.log.append(main._cloud_session_lock.locked())
        return self._a[key]


def test_the_miss_gather_runs_outside_the_lock():
    s = _session(seed=6)
    plain = np.asarray(s.positions).copy()
    watched = _ReadWatched(plain)
    s.positions = watched
    try:
        miss_pos, _r = main._gather_miss_positions(s, None)
        assert watched.log and not any(watched.log), f"read under the lock: {watched.log}"
        sel = ~s.deleted & (s.extras[main._MISS_SLUG] != 0)
        np.testing.assert_array_equal(miss_pos, plain[sel])
    finally:
        main._cloud_sessions.pop(s.session_id, None)


def test_a_transform_does_its_arithmetic_outside_the_lock():
    s = _session(seed=1)
    try:
        before = np.asarray(s.positions).copy()
        _Watched.log.clear()
        m = [0, -1, 0, 2.0,  1, 0, 0, -3.0,  0, 0, 1, 0.5,  0, 0, 0, 1]   # 90 deg about z
        main._do_session_transform(s.session_id, main.SessionTransformRequest(
            matrix=m, octree_mode="none"))
        whole = [locked for locked, n in _Watched.log if n == len(before)]
        assert whole, "the transform never read the positions"
        assert not any(whole), "the whole-cloud transform ran under the global lock"
        M = np.array(m, dtype=float).reshape(4, 4)
        np.testing.assert_allclose(np.asarray(s.positions), before @ M[:3, :3].T + M[:3, 3])
    finally:
        main._cloud_sessions.pop(s.session_id, None)
