"""POST /api/cloud/session/{id}/resample — thinning a session cloud.

The Resample tool used to work only on in-memory (flat) clouds, which a normal
import never produces, so it silently did nothing. Session clouds now thin on
the backend by setting the deleted mask (the renderer then bakes). Asserted
here on the real session arrays, in-process.
"""

import asyncio

import numpy as np
import pytest
from fastapi import HTTPException

import main
from tests.binframe import _create_session_direct

GRID_FORMAT = "x y z r255 g255 b255 reflectance"


def _session(tmp_path, monkeypatch, n=10, spacing=0.1):
    tmp_path.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    grid = tmp_path / "grid.xyz"
    grid.write_text("\n".join(
        f"{i*spacing:.4f} {j*spacing:.4f} {k*spacing:.4f} 10 20 30 0.5"
        for i in range(n) for j in range(n) for k in range(n)
    ) + "\n")
    req = main.CloudSessionCreateRequest(source_path=str(grid), ascii_format=GRID_FORMAT)
    return asyncio.new_event_loop().run_until_complete(_create_session_direct(req))["session_id"]


def _req(**kw):
    return main.SessionResampleRequest(**kw)


def test_random_keeps_the_requested_fraction_reproducibly(tmp_path, monkeypatch):
    sid = _session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]
    dry = main.session_resample(sid, _req(mode="random", fraction=0.25, dry_run=True))
    assert dry == {"session_id": sid, "hits_before": 1000, "hits_after": 250, "committed": False}
    assert not sess.deleted.any(), "a dry run must not touch the session"

    res = main.session_resample(sid, _req(mode="random", fraction=0.25, seed=7))
    assert res["committed"] and res["remaining_count"] == 250
    kept_a = np.where(~sess.deleted)[0]

    # Same seed on a fresh copy → the same points.
    sid2 = _session(tmp_path / "b", monkeypatch)
    main.session_resample(sid2, _req(mode="random", fraction=0.25, seed=7))
    np.testing.assert_array_equal(np.where(~main._cloud_sessions[sid2].deleted)[0], kept_a)


def test_voxel_keeps_one_real_point_per_occupied_cell(tmp_path, monkeypatch):
    # A 10x10x10 grid at 0.1 m spacing; 0.2 m cells hold 2x2x2 = 8 points each.
    sid = _session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]
    before = sess.positions.copy()
    res = main.session_resample(sid, _req(mode="voxel", voxel_size=0.2))
    assert res["hits_after"] == 125 and res["remaining_count"] == 125
    kept = before[~sess.deleted]
    # Every kept point is an ORIGINAL point (not an average) ...
    assert set(map(tuple, np.round(kept, 6))) <= set(map(tuple, np.round(before, 6)))
    # ... and no two share a cell.
    cells = np.floor((kept - before.min(axis=0)) / 0.2 + 1e-9).astype(int)
    assert len({tuple(c) for c in cells}) == 125


def test_resample_composes_on_survivors_and_never_drops_misses(tmp_path, monkeypatch):
    sid = _session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]
    # Mark the first 100 rows as sky/miss returns.
    miss = np.zeros(len(sess.positions), dtype=np.float32)
    miss[:100] = 1
    with main._cloud_session_lock:
        main._session_put_column_locked(sess, main._MISS_SLUG, miss)
    res = main.session_resample(sid, _req(mode="random", fraction=0.5))
    assert res["hits_before"] == 900 and res["hits_after"] == 450
    assert not sess.deleted[:100].any(), "misses must survive a resample"
    # A second resample thins what is LEFT, not the original.
    res2 = main.session_resample(sid, _req(mode="random", fraction=0.5, seed=1))
    assert res2["hits_before"] == 450 and res2["hits_after"] == 225


@pytest.mark.parametrize("kw", [
    {"mode": "random", "fraction": 0.0},
    {"mode": "random", "fraction": 1.5},
    {"mode": "voxel", "voxel_size": 0.0},
    {"mode": "voxel"},
])
def test_bad_parameters_are_400(tmp_path, monkeypatch, kw):
    sid = _session(tmp_path, monkeypatch)
    with pytest.raises(HTTPException) as exc:
        main.session_resample(sid, _req(**kw))
    assert exc.value.status_code == 400
    assert not main._cloud_sessions[sid].deleted.any()
