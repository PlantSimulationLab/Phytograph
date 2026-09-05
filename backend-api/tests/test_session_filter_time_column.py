"""The Filter tool must be able to filter on the TIME column.

A per-point timestamp lives on the float64 `CloudSession.timestamps` field, not
in the float32 `extras` (a float32 extra dim quantises GPS-magnitude times to
32 s; see `_split_timestamp_extra_dim`). The renderer offers that column in the
Filter picker under its octree BUFFER key, `gps-time` — PotreeConverter's name
for the LAS gps_time dimension the import writes it to — but the filter worker
resolved every slug against `extras` alone, so choosing it answered
`Unknown scalar attribute: 'gps-time'` for a field the picker had just listed.

`_session_scalar_column` closes that: either spelling of the time column
resolves to `timestamps`, with the same (N,) alignment as an extra. Pinned on
`_do_session_filter` (the worker behind the streaming route) with an in-RAM
session and `rebuild=False`, so no PotreeConverter is needed.
"""

import time

import numpy as np
import pytest
from fastapi import HTTPException

import main


N = 60


@pytest.fixture
def timed_session():
    """60 hits along x with timestamps 100, 102.5, …, 247.5 — the same values as
    tests/e2e/fixtures/scalars.xyz, so the E2E filter spec and this test agree
    on the expected count."""
    xyz = np.column_stack([np.arange(N, dtype=float), np.zeros(N), np.zeros(N)])
    ts = 100.0 + 2.5 * np.arange(N, dtype=np.float64)
    dev = (np.arange(N) % 5).astype(np.float32)
    sess = main.CloudSession(
        session_id="filter_time_sess",
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=xyz,
        colors=None,
        intensity=None,
        extras={"Deviation": dev},
        extra_dims_meta=[{"slug": "Deviation", "label": "Deviation"}],
        deleted=np.zeros(N, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
        timestamps=ts,
    )
    main._cloud_sessions[sess.session_id] = sess
    try:
        yield sess
    finally:
        main._cloud_sessions.pop(sess.session_id, None)


def _survivors(sess) -> int:
    return int((~sess.deleted).sum())


@pytest.mark.parametrize("slug", ["gps-time", "timestamp"])
def test_filter_on_the_time_column_under_either_spelling(timed_session, slug):
    """Keep 100 <= t <= 150: that is i = 0..20, twenty-one points."""
    req = main.SessionFilterRequest(
        scalar_filters=[main.ScalarFilter(slug=slug, min=100.0, max=150.0)],
        rebuild=False,
    )
    res = main._do_session_filter(timed_session.session_id, req)

    # `rebuild=False` reports counts without an octree rebuild.
    assert res["remaining_count"] == 21
    assert res["deleted_count"] == N - 21
    assert _survivors(timed_session) == 21
    # It kept the RIGHT points — the first 21 along x — not just the right number.
    kept_x = timed_session.positions[~timed_session.deleted, 0]
    assert np.array_equal(kept_x, np.arange(21, dtype=float))


def test_time_column_filter_composes_with_an_extra(timed_session):
    """One request may filter on the time column AND an ordinary extra; the
    masks must AND together exactly as two extras would."""
    req = main.SessionFilterRequest(
        scalar_filters=[
            main.ScalarFilter(slug="gps-time", min=100.0, max=150.0),
            main.ScalarFilter(slug="Deviation", min=0.0, max=1.0),
        ],
        rebuild=False,
    )
    res = main._do_session_filter(timed_session.session_id, req)
    # i in 0..20 with i % 5 in {0, 1}: 0,1,5,6,10,11,15,16,20 -> nine points.
    assert res["remaining_count"] == 9
    assert _survivors(timed_session) == 9


def test_time_column_is_not_offered_when_the_session_has_no_timestamps(timed_session):
    """Without a timestamps field the spelling must still be rejected — and the
    rejection must not list a column the session does not have."""
    timed_session.timestamps = None
    req = main.SessionFilterRequest(
        scalar_filters=[main.ScalarFilter(slug="gps-time", min=100.0, max=150.0)],
        rebuild=False,
    )
    with pytest.raises(HTTPException) as exc:
        main._do_session_filter(timed_session.session_id, req)
    assert exc.value.status_code == 400
    assert "gps-time" not in str(exc.value.detail).split("Available:")[-1]
    assert not timed_session.deleted.any()


def test_unknown_slug_error_lists_the_time_column(timed_session):
    """The 'Available:' hint in the 400 must name the time column when the
    session carries one, or the message steers the user away from a field that
    would have worked."""
    req = main.SessionFilterRequest(
        scalar_filters=[main.ScalarFilter(slug="nope", min=0.0, max=1.0)],
        rebuild=False,
    )
    with pytest.raises(HTTPException) as exc:
        main._do_session_filter(timed_session.session_id, req)
    assert exc.value.status_code == 400
    assert "gps-time" in str(exc.value.detail)
