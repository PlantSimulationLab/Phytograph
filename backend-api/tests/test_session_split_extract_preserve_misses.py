"""`session_split` and `session_extract` must not strand sky/miss points.

`delete_region` refuses to select misses and `_do_session_filter` force-keeps
them; these two paths — the remaining region/scalar consumers — had no guard.
The failure is the same one those two comments describe, in two shapes:

  - SPLIT moves the region's complement to the leftover cloud. Every miss sits
    ~1 km out, so it fails a hit-shaped box and the WHOLE sky migrated to the
    leftover — the parent kept its hits and lost its Beer's-law transmission
    denominator, silently under-reading LAD.

  - EXTRACT builds a child from the selection. Misses are never selected, so
    every extracted cloud was hits-only and LAD on it had no denominator at all.
    The parent is untouched here, so the fix DUPLICATES the misses onto the
    child rather than moving them: both clouds need the beam set.

Both emptiness guards are measured on HITS, so forcing misses in must not make
a selection that keeps nothing visible look non-empty.

Calls the route functions directly on a small in-RAM session. Split rebuilds
octrees, so its cases stub `_session_rebuild`; extract's empty case needs no
build at all.
"""

import time

import numpy as np
import pytest

import main


N_HITS = 6
N_MISSES = 4
MISS_X = 1000.0          # far field, as a real miss is projected


@pytest.fixture
def miss_session():
    """6 hits at x=0..5, 4 misses parked ~1 km out."""
    n = N_HITS + N_MISSES
    xyz = np.column_stack([np.arange(n, dtype=float), np.zeros(n), np.zeros(n)])
    xyz[N_HITS:, 0] = MISS_X
    miss = np.zeros(n, dtype=np.float32)
    miss[N_HITS:] = 1.0
    # wood_class: hits split leaf/wood; misses default to 0, exactly as
    # `_session_add_extra_column` scatters them.
    wood = np.zeros(n, dtype=np.float32)
    wood[:3] = 2.0          # leaf
    wood[3:N_HITS] = 1.0    # wood

    sess = main.CloudSession(
        session_id="split_miss_sess",
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=xyz,
        colors=None,
        intensity=None,
        extras={"is_miss": miss, "wood_class": wood},
        extra_dims_meta=[{"slug": "is_miss", "label": "is_miss"},
                         {"slug": "wood_class", "label": "Wood Class"}],
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
    )
    main._cloud_sessions[sess.session_id] = sess
    try:
        yield sess
    finally:
        main._cloud_sessions.pop(sess.session_id, None)


@pytest.fixture
def no_rebuild(monkeypatch):
    """Stub the octree build — this suite is about which points land where."""
    built = []

    def _fake_rebuild(sess, *a, **kw):
        built.append(sess)
        return ("cache", "/tmp/cache", {})

    monkeypatch.setattr(main, "_session_rebuild", _fake_rebuild)
    # Child sessions register themselves; drop them after the test.
    known = set(main._cloud_sessions)
    try:
        yield built
    finally:
        for sid in set(main._cloud_sessions) - known:
            main._cloud_sessions.pop(sid, None)


def _counts(sess):
    """(misses, hits) surviving on a session."""
    surv = ~sess.deleted
    col = sess.extras["is_miss"][surv]
    return int((col != 0).sum()), int((col == 0).sum())


def _child_counts(child):
    col = child.extras["is_miss"]
    return int((col != 0).sum()), int((col == 0).sum())


# ---------------------------------------------------------------- split

def test_split_keeps_misses_on_the_parent(miss_session, no_rebuild):
    """A box around the hits must not sweep the sky into the leftover cloud."""
    req = main.SessionSplitRequest(
        region=main.CropOctreeRegion(kind="box", min=[-1, -1, -1], max=[2.5, 1, 1]),
    )
    res = main.session_split(miss_session.session_id, req)

    misses, hits = _counts(miss_session)
    assert misses == N_MISSES, "split moved sky/miss points to the leftover cloud"
    assert hits == 3                       # x = 0,1,2 kept
    assert res["kept"]["point_count"] == 3 + N_MISSES
    # The leftover is the three out-of-box HITS and nothing else.
    assert res["leftover"] is not None
    leftover = main._cloud_sessions[res["leftover"]["session_id"]]
    assert _child_counts(leftover) == (0, 3)


def test_split_scalar_keeps_misses_on_the_parent(miss_session, no_rebuild):
    """Scalar splits fail misses the same way: they carry 0 on class columns."""
    req = main.SessionSplitRequest(
        scalar_filters=[main.ScalarFilter(slug="wood_class", values=[2])],
    )
    main.session_split(miss_session.session_id, req)

    misses, hits = _counts(miss_session)
    assert misses == N_MISSES, "scalar split moved sky/miss points to the leftover"
    assert hits == 3                       # the three leaf points


def test_split_keeping_no_hits_still_reports_empty(miss_session, no_rebuild):
    """The empty guard is measured on HITS, so the forced-in sky must not make a
    split that keeps nothing visible look non-empty."""
    req = main.SessionSplitRequest(
        region=main.CropOctreeRegion(kind="box", min=[500, -1, -1], max=[600, 1, 1]),
    )
    res = main.session_split(miss_session.session_id, req)

    assert res["kept"]["point_count"] == 0
    assert res["leftover"] is None
    # Nothing was committed — the session is untouched.
    assert not miss_session.deleted.any()


# --------------------------------------------------------------- extract

def test_extract_carries_misses_into_the_child(miss_session, no_rebuild):
    """An extracted cloud needs the beam set, or LAD on it has no denominator."""
    req = main.SessionExtractRequest(
        region=main.CropOctreeRegion(kind="box", min=[-1, -1, -1], max=[2.5, 1, 1]),
    )
    res = main.session_extract(miss_session.session_id, req)

    assert res["extracted"] is not None
    child = main._cloud_sessions[res["extracted"]["session_id"]]
    child_misses, child_hits = _child_counts(child)
    assert child_misses == N_MISSES, "extracted child lost the sky/miss points"
    assert child_hits == 3                 # x = 0,1,2

    # Extract leaves the parent alone — the misses are duplicated, not moved.
    assert _counts(miss_session) == (N_MISSES, N_HITS)


def test_extract_scalar_carries_misses_into_the_child(miss_session, no_rebuild):
    req = main.SessionExtractRequest(
        scalar_filters=[main.ScalarFilter(slug="wood_class", values=[2])],
    )
    res = main.session_extract(miss_session.session_id, req)

    child = main._cloud_sessions[res["extracted"]["session_id"]]
    child_misses, child_hits = _child_counts(child)
    assert child_misses == N_MISSES
    assert child_hits == 3                 # the three leaf points


def test_extract_selecting_no_hits_reports_empty(miss_session, no_rebuild):
    """A selection that catches only sky is not an extraction — without the
    hits-only guard the forced-in misses would spawn a miss-only child."""
    req = main.SessionExtractRequest(
        region=main.CropOctreeRegion(kind="box", min=[500, -1, -1], max=[600, 1, 1]),
    )
    res = main.session_extract(miss_session.session_id, req)

    assert res["extracted"] is None
    assert no_rebuild == [], "built an octree for a hits-empty extraction"


def test_extract_without_miss_column_is_unaffected(miss_session, no_rebuild):
    """A plain cloud (no is_miss column) must behave exactly as before."""
    del miss_session.extras["is_miss"]
    miss_session.extra_dims_meta = [m for m in miss_session.extra_dims_meta
                                    if m["slug"] != "is_miss"]
    req = main.SessionExtractRequest(
        region=main.CropOctreeRegion(kind="box", min=[-1, -1, -1], max=[2.5, 1, 1]),
    )
    res = main.session_extract(miss_session.session_id, req)

    child = main._cloud_sessions[res["extracted"]["session_id"]]
    assert len(child.positions) == 3
