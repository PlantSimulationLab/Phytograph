"""`session_filter` must never DELETE sky/miss points.

`delete_region` already refuses to select them, with the comment "deleting it
would silently corrupt LAD's beam set". `session_filter` — the other destructive
path — had no such guard, so a routine filter wiped the Beer's-law transmission
denominator with no warning and no `backfilled_misses_stale` flag.

Both real triggers are pinned here:

  (a) SPATIAL. The renderer builds the filter box from `cloud.data.bounds`,
      which come from the HITS-ONLY octree. Every miss sits ~1 km out, so it
      falls outside the box and was deleted.

  (b) SCALAR. Wood/leaf segmentation in "remove" mode filters `wood_class ==
      LEAF`, but `_session_add_extra_column` scatters labels over survivors with
      misses defaulting to 0 — so every miss failed the test and was deleted.

Uses a small in-RAM session with `rebuild=False`, so no PotreeConverter is
needed and the test always runs (the leafcube miss suites are skipped without a
local-only dataset).
"""

import asyncio
import time

import numpy as np
import pytest

import main


N_HITS = 6
N_MISSES = 4
MISS_X = 1000.0          # far field, as a real miss is projected


@pytest.fixture
def miss_session():
    """A session of 6 hits at x=0..5 and 4 misses parked ~1 km out."""
    n = N_HITS + N_MISSES
    xyz = np.column_stack([np.arange(n, dtype=float), np.zeros(n), np.zeros(n)])
    xyz[N_HITS:, 0] = MISS_X
    miss = np.zeros(n, dtype=np.float32)
    miss[N_HITS:] = 1.0
    # wood_class: hits split leaf/wood; misses default to 0, exactly as
    # `_session_add_extra_column` scatters them.
    wood = np.zeros(n, dtype=np.float32)
    wood[:3] = 2.0     # leaf
    wood[3:N_HITS] = 1.0   # wood

    sess = main.CloudSession(
        session_id="filter_miss_sess",
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


def _surviving(sess):
    surv = ~sess.deleted
    miss_col = sess.extras["is_miss"][surv]
    return int((miss_col != 0).sum()), int((miss_col == 0).sum())


def test_spatial_filter_does_not_delete_misses(miss_session):
    """A box drawn around the hits (the hits-only octree bounds) must not take
    the sky with it."""
    req = main.SessionFilterRequest(
        region=main.CropOctreeRegion(kind="box", min=[-1, -1, -1], max=[5.5, 1, 1]),
        rebuild=False,
    )
    main.session_filter(miss_session.session_id, req)

    misses, hits = _surviving(miss_session)
    assert misses == N_MISSES, "spatial filter destroyed sky/miss points"
    assert hits == N_HITS


def test_spatial_filter_still_deletes_the_hits_it_should(miss_session):
    """The guard must protect misses WITHOUT neutering the filter itself."""
    req = main.SessionFilterRequest(
        region=main.CropOctreeRegion(kind="box", min=[-1, -1, -1], max=[2.5, 1, 1]),
        rebuild=False,
    )
    main.session_filter(miss_session.session_id, req)

    misses, hits = _surviving(miss_session)
    assert misses == N_MISSES          # sky intact
    assert hits == 3                   # x = 0,1,2 kept; 3,4,5 deleted


def test_scalar_filter_does_not_delete_misses(miss_session):
    """Wood/leaf 'remove' mode keeps wood_class == LEAF. Misses carry 0 there and
    match nothing, so they were collateral damage."""
    req = main.SessionFilterRequest(
        scalar_filters=[main.ScalarFilter(slug="wood_class", values=[2])],
        rebuild=False,
    )
    main.session_filter(miss_session.session_id, req)

    misses, hits = _surviving(miss_session)
    assert misses == N_MISSES, "scalar filter destroyed sky/miss points"
    assert hits == 3                   # the three leaf points


def test_filter_keeping_no_hits_still_reports_empty(miss_session):
    """The 'you filtered everything away' guard is measured on HITS, so forcing
    misses back in must not make an empty filter look non-empty."""
    req = main.SessionFilterRequest(
        region=main.CropOctreeRegion(kind="box", min=[500, -1, -1], max=[600, 1, 1]),
        rebuild=False,
    )
    res = main.session_filter(miss_session.session_id, req)

    assert res["point_count"] == 0
    assert res["rebuilt"] is False
    # Nothing was committed — the session is untouched.
    assert not miss_session.deleted.any()
