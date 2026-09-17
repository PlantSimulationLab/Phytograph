"""`/api/cloud/session/{id}/compute_normals` plumbing.

The estimator itself is covered by `test_normals.py` and its tiling by
`test_normals_tiled.py`; this file is about what the ENDPOINT does around them:

  (a) misses must never reach the estimator. A miss is projected ~1 km out, so
      it would unbalance the KD-tree and poison the k-th-neighbour spacing the
      tile collar is derived from.
  (b) the hit-aligned result must be scattered back over the survivors, or every
      point after the first miss gets another point's normal.
  (c) the five columns must land with the slugs the exporter and the renderer
      expect.
  (d) the sensor origin must be resolved from the session, preferring per-point
      beam origins, since that is what makes the orientation correct.

`_run_killable` and `_session_rebuild` are stubbed: the first spawns a ~4 s
subprocess, the second needs PotreeConverter, and neither is what is under test.
"""

import time

import numpy as np
import pytest

import main
import normals as normals_mod

MISS_X = 1000.0  # far field, as a real miss is projected


def _make_session(n_hits=1200, n_misses=40, session_id="normals_sess",
                  beam_origins=None, scan_origin=None):
    """Hits on a 1 cm lattice plus `n_misses` parked ~1 km out."""
    side = int(np.ceil(np.sqrt(n_hits)))
    g = np.arange(side) * 0.01
    xx, yy = np.meshgrid(g, g, indexing="ij")
    hits = np.column_stack([xx.ravel(), yy.ravel(), np.zeros(xx.size)])[:n_hits]
    misses = np.column_stack([np.full(n_misses, MISS_X),
                              np.arange(n_misses, dtype=float),
                              np.zeros(n_misses)])
    xyz = np.vstack([hits, misses]).astype(np.float64)

    n = n_hits + n_misses
    miss = np.zeros(n, dtype=np.float32)
    miss[n_hits:] = 1.0

    sess = main.CloudSession(
        session_id=session_id, source_path="<test>", ascii_format=None,
        column_plan=None, positions=xyz, colors=None, intensity=None,
        extras={"is_miss": miss},
        extra_dims_meta=[{"slug": "is_miss", "label": "is_miss"}],
        deleted=np.zeros(n, dtype=bool), deleted_history=[],
        octree_cache_id=None, created_at=time.time())
    if beam_origins is not None:
        sess.beam_origins = np.asarray(beam_origins, dtype=np.float64)
    if scan_origin is not None:
        sess.miss_octree_origin = list(scan_origin)
    main._cloud_sessions[session_id] = sess
    return sess


@pytest.fixture
def session():
    sess = _make_session()
    yield sess
    main._cloud_sessions.pop(sess.session_id, None)


@pytest.fixture
def spy(monkeypatch):
    """Stub the subprocess + octree rebuild, recording what the compute saw."""
    seen = {}

    async def fake_run_killable(tool, points, params, **kw):
        seen["tool"] = tool
        seen["points"] = np.asarray(points).copy()
        seen["params"] = dict(params)
        seen["origins"] = kw.get("origins")
        meta = {}
        values = normals_mod.compute_normals(
            points, origin=kw.get("origins") if kw.get("origins") is not None
            else params.get("origin"),
            meta=meta,
            **{k: v for k, v in params.items() if k != "origin"})
        seen["meta"] = meta
        return values, meta

    monkeypatch.setattr(main, "_run_killable", fake_run_killable)
    monkeypatch.setattr(main, "_session_rebuild",
                        lambda s: ("cache", main._Path("/tmp/x"), {"point_count": 0}))
    return seen


async def _compute(session, **kw):
    return await main.session_compute_normals(
        session.session_id, main.SessionComputeNormalsRequest(**kw),
        http_request=None)


@pytest.mark.asyncio
async def test_misses_never_reach_the_estimator(session, spy):
    """The 1 km trap: one miss in the KD-tree unbalances it and inflates the
    k-th-neighbour spacing the tile collar is measured from."""
    await _compute(session)
    fed = spy["points"]
    assert len(fed) == 1200                   # hits only, all 40 misses dropped
    assert fed[:, 0].max() < MISS_X / 100     # nothing from the far field


@pytest.mark.asyncio
async def test_all_five_columns_are_written_with_the_contract_slugs(session, spy):
    result = await _compute(session)
    for slug, label in normals_mod.COLUMNS:
        assert slug in session.extras, f"missing column {slug}"
        assert len(session.extras[slug]) == len(session.positions)
        assert session.extras[slug].dtype == np.float32
        assert any(d["slug"] == slug and d["label"] == label
                   for d in session.extra_dims_meta)
    assert result["columns"] == [s for s, _ in normals_mod.COLUMNS]
    # The PLY/LAS exporters and the renderer key off these exact spellings.
    assert [s for s, _ in normals_mod.COLUMNS][:3] == ["nx", "ny", "nz"]


@pytest.mark.asyncio
async def test_results_are_scattered_back_past_the_misses(session, spy):
    """The recurring indexing bug: the compute is indexed against the HIT
    subset, so writing it straight onto the survivors shifts every value after
    the first miss onto the wrong point."""
    await _compute(session, orientation="up")
    nz = session.extras["nz"]
    is_miss = session.extras["is_miss"] != 0
    # The lattice is flat, so every HIT must have a unit +Z normal...
    assert (nz[~is_miss] > 0.99).all()
    # ...and every miss must keep the zero fill rather than a borrowed value.
    assert (nz[is_miss] == 0).all()


@pytest.mark.asyncio
async def test_per_point_beam_origins_are_preferred_and_gathered(spy):
    """beam_origins is the best orientation source: it is the true emission
    point of each pulse, so a multi-scan cloud orients every point correctly."""
    n_hits, n_misses = 1200, 40
    origins = np.zeros((n_hits + n_misses, 3))
    origins[:, 2] = -50.0              # sensor BELOW the lattice
    sess = _make_session(session_id="bo_sess", beam_origins=origins)
    try:
        result = await _compute(sess, orientation="origin")
        assert result["orientation_source"] == "beam_origins"
        passed = spy["origins"]
        assert passed is not None and passed.shape == (n_hits, 3), \
            "per-point origins must be gathered to the HIT subset"
        # Sensor below => every normal points down.
        is_miss = sess.extras["is_miss"] != 0
        assert (sess.extras["nz"][~is_miss] < 0).all()
    finally:
        main._cloud_sessions.pop("bo_sess", None)


@pytest.mark.asyncio
async def test_scan_origin_is_used_when_there_are_no_beam_origins(spy):
    sess = _make_session(session_id="so_sess", scan_origin=[0.0, 0.0, 25.0])
    try:
        result = await _compute(sess, orientation="origin")
        assert result["orientation_source"] == "scan_origin"
        assert spy["origins"] is None, "a single viewpoint travels in params"
        assert spy["params"]["origin"] == [0.0, 0.0, 25.0]
        is_miss = sess.extras["is_miss"] != 0
        assert (sess.extras["nz"][~is_miss] > 0).all()
    finally:
        main._cloud_sessions.pop("so_sess", None)


@pytest.mark.asyncio
async def test_centroid_fallback_when_nothing_knows_the_sensor(session, spy):
    result = await _compute(session, orientation="origin")
    assert result["orientation_source"] == "centroid"


def test_centroid_fallback_faces_inward_like_a_real_sensor():
    """The centroid fallback treats the cloud's centre as the viewpoint, so
    normals face INWARD — the same convention as a real sensor origin.

    This is the OPPOSITE sign from `_do_open3d_triangulation`'s Ball-Pivoting
    fallback, which negates to get an outward field because BPA must roll on
    the outside of the surface. Pinned because the two live a few thousand
    lines apart and look like they disagree by mistake."""
    rng = np.random.default_rng(1)
    v = rng.normal(size=(8000, 3))
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    pts = v * 3.0                      # a sphere centred on the origin
    res = normals_mod.compute_normals(pts, k=30, orientation="origin",
                                      origin=pts.mean(axis=0))
    outward = np.einsum("ij,ij->i", res[:, 0:3].astype(np.float64), v)
    assert outward.mean() < -0.99, "centroid fallback must point inward"


@pytest.mark.asyncio
async def test_viewpoint_is_shifted_into_the_session_frame(spy):
    """A viewpoint from the renderer is WORLD-frame; the session's positions are
    shifted. Failing to subtract world_shift points the normals at the wrong
    place, and on a UTM cloud that is a kilometres-wide error."""
    sess = _make_session(session_id="vp_sess")
    sess.world_shift = np.array([1000.0, 2000.0, 0.0])
    try:
        await _compute(sess, orientation="origin", viewpoint=[1000.0, 2000.0, 25.0])
        assert spy["params"]["origin"] == [0.0, 0.0, 25.0]
    finally:
        main._cloud_sessions.pop("vp_sess", None)


@pytest.mark.asyncio
async def test_defer_octree_returns_no_octree_fields_and_marks_stale(session, spy,
                                                                    monkeypatch):
    rebuilt = []
    monkeypatch.setattr(main, "_session_rebuild",
                        lambda s: rebuilt.append(s) or ("c", main._Path("/tmp/x"), {}))
    result = await _compute(session, defer_octree=True)
    assert result["octree_deferred"] is True
    assert "cache_id" not in result, \
        "handing back the pre-column octree is the stale-octree bug"
    assert not rebuilt, "deferred means the rebuild is the caller's job"
    # The columns still landed.
    assert "nx" in session.extras


@pytest.mark.asyncio
async def test_normals_status_reports_presence_and_staleness(session, spy):
    before = main.session_normals_status(session.session_id)
    assert before["has_normals"] is False and before["stale"] is False

    await _compute(session)
    after = main.session_normals_status(session.session_id)
    assert after["has_normals"] is True
    assert after["columns"] == [s for s, _ in normals_mod.COLUMNS]
    assert after["stale"] is False, "a fresh compute describes the current geometry"


@pytest.mark.asyncio
async def test_a_deletion_marks_the_normals_stale(session, spy):
    """A normal is a neighbourhood statistic, so a cut changes the right answer
    for every surviving point beside it. The column stays correctly INDEXED -
    it just answers a question about a cloud that no longer exists."""
    await _compute(session)
    with main._cloud_session_lock:
        session.deleted[:50] = True
        main._mark_normals_stale_locked(session)
    assert main.session_normals_status(session.session_id)["stale"] is True
    # ...and the columns are still there: we warn, never auto-clear.
    assert "nx" in session.extras


@pytest.mark.asyncio
async def test_the_real_delete_endpoint_marks_normals_stale(session, spy):
    """Wired, not merely written: drives the ACTUAL crop endpoint rather than
    calling the helper, so a refactor that stops marking stale fails here."""
    await _compute(session)
    assert main.session_normals_status(session.session_id)["stale"] is False

    region = main.CropOctreeRegion(kind="box", min=[-1, -1, -1], max=[0.05, 0.05, 1])
    main.delete_cloud_region(session.session_id,
                             main.DeleteRegionRequest(region=region))

    assert int(session.deleted.sum()) > 0, "fixture must actually delete something"
    assert main.session_normals_status(session.session_id)["stale"] is True


@pytest.mark.asyncio
async def test_a_rotation_rotates_the_stored_normals(session, spy):
    """A transform is NOT a staleness case — it is a hard frame error.

    `session_transform` bakes a rigid 4x4 into `positions`, so an unrotated
    normal is wrong BY that rotation: after 90 deg a flat ground plane still
    reports nz=1 / verticality=0 while the surface is now vertical, and the
    status endpoint calls it fresh. This is the ICP / alignment commit path.
    """
    await _compute(session, orientation="up")
    assert session.extras["nz"][~(session.extras["is_miss"] != 0)].mean() > 0.99

    # 90 deg about X: the flat lattice becomes a vertical plane, so the true
    # normals swing from +Z to +/-Y.
    c, s = 0.0, 1.0  # cos(90), sin(90)
    matrix = [1, 0, 0, 0,
              0, c, -s, 0,
              0, s, c, 0,
              0, 0, 0, 1]
    main.session_transform(session.session_id,
                           main.SessionTransformRequest(matrix=matrix,
                                                        octree_mode="pose"))

    hit = session.extras["is_miss"] == 0
    assert abs(float(session.extras["nz"][hit].mean())) < 0.01, \
        "nz must follow the rotation to ~0"
    assert abs(float(session.extras["ny"][hit].mean())) > 0.99, \
        "the normal must now lie along Y"
    assert float(session.extras["verticality"][hit].mean()) == pytest.approx(90.0, abs=0.5)
    # Unit length survives the rotation (it is a rotation, not `_apply`, which
    # would add the translation and the world shift to a direction vector).
    n = np.column_stack([session.extras["nx"][hit], session.extras["ny"][hit],
                         session.extras["nz"][hit]])
    assert np.abs(np.linalg.norm(n, axis=1) - 1.0).max() < 1e-4


def test_merging_with_a_cloud_that_has_no_normals_drops_them(spy):
    """The extras union zero-fills a slug a source lacks. For a scalar that is a
    usable "unknown"; for a normal a zero-length vector is not a direction at
    all — and `normals_status` only sees that the slugs are PRESENT, so the
    merged cloud would report fresh while half of it was fabricated."""
    with_n = _make_session(session_id="mrg_a", n_misses=0)
    without = _make_session(session_id="mrg_b", n_misses=0)
    try:
        values = normals_mod.compute_normals(with_n.positions, k=12,
                                             orientation="up")
        with main._cloud_session_lock:
            for col, (slug, label) in enumerate(normals_mod.COLUMNS):
                main._session_add_extra_column(with_n, slug, label, values[:, col])
            merged = main._merge_sessions_locked([with_n, without])

        for slug, _ in normals_mod.COLUMNS:
            assert slug not in merged.extras, f"{slug} must not be fabricated"
        assert all(e["slug"] not in [s for s, _ in normals_mod.COLUMNS]
                   for e in merged.extra_dims_meta), "metadata must drop them too"
        assert main.session_normals_status(merged.session_id)["has_normals"] is False
    finally:
        for sid in ("mrg_a", "mrg_b"):
            main._cloud_sessions.pop(sid, None)


def test_merging_two_clouds_that_both_have_normals_keeps_them(spy):
    """The other direction: when every input has genuine normals the union is
    genuine too, so dropping them would be a needless loss."""
    a = _make_session(session_id="mrg_c", n_misses=0)
    b = _make_session(session_id="mrg_d", n_misses=0)
    try:
        with main._cloud_session_lock:
            for sess_i in (a, b):
                vals = normals_mod.compute_normals(sess_i.positions, k=12,
                                                   orientation="up")
                for col, (slug, label) in enumerate(normals_mod.COLUMNS):
                    main._session_add_extra_column(sess_i, slug, label, vals[:, col])
            merged = main._merge_sessions_locked([a, b])

        for slug, _ in normals_mod.COLUMNS:
            assert slug in merged.extras
        n = np.column_stack([merged.extras["nx"], merged.extras["ny"],
                             merged.extras["nz"]])
        assert (np.linalg.norm(n, axis=1) > 0.99).all(), \
            "no zero-length normals may survive the union"
    finally:
        for sid in ("mrg_c", "mrg_d"):
            main._cloud_sessions.pop(sid, None)


def test_staleness_is_not_claimed_for_a_cloud_without_normals(session):
    """An ordinary crop on a cloud that never had normals must stay clean, or
    every session would report stale and the warning would mean nothing."""
    with main._cloud_session_lock:
        main._mark_normals_stale_locked(session)
    assert session.normals_stale is False
    assert main.session_normals_status(session.session_id)["stale"] is False


@pytest.mark.asyncio
async def test_recomputing_clears_staleness(session, spy):
    await _compute(session)
    with main._cloud_session_lock:
        main._mark_normals_stale_locked(session)
    assert session.normals_stale is True
    await _compute(session)
    assert session.normals_stale is False


@pytest.mark.asyncio
async def test_too_few_points_is_a_400(spy):
    sess = _make_session(n_hits=10, n_misses=0, session_id="tiny_sess")
    try:
        with pytest.raises(main.HTTPException) as e:
            await _compute(sess)
        assert e.value.status_code == 400
    finally:
        main._cloud_sessions.pop("tiny_sess", None)


@pytest.mark.asyncio
async def test_unknown_orientation_is_a_400(session, spy):
    with pytest.raises(main.HTTPException) as e:
        await _compute(session, orientation="sideways")
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_expensive_run_answers_409_with_a_cost_warning(session, spy,
                                                             monkeypatch):
    """409, not 400, so the renderer can tell "needs confirmation" from a bad
    request and offer to proceed anyway."""
    monkeypatch.setattr(main, "_COST_WARNING_SECONDS", 0.0)
    with pytest.raises(main.HTTPException) as e:
        await _compute(session)
    assert e.value.status_code == 409
    assert "cost_warning" in e.value.detail
    # ...and acknowledging it lets the run through.
    result = await _compute(session, acknowledge_cost=True)
    assert result["analyzed_points"] == 1200


@pytest.mark.asyncio
async def test_cancel_leaves_the_session_pristine(session, monkeypatch):
    """A cancel during the compute must not half-write the columns."""
    async def cancelled(*a, **kw):
        raise main.ClientDisconnected()

    monkeypatch.setattr(main, "_run_killable", cancelled)
    with pytest.raises(main.HTTPException) as e:
        await _compute(session)
    assert e.value.status_code == 499
    for slug, _ in normals_mod.COLUMNS:
        assert slug not in session.extras


@pytest.mark.asyncio
async def test_a_wrong_shaped_result_is_rejected_rather_than_scattered(session,
                                                                      monkeypatch):
    """Defence against worker/protocol drift: scattering a mis-shaped array
    would corrupt the session silently."""
    async def wrong(*a, **kw):
        return np.zeros((7, normals_mod.N_COLUMNS), dtype=np.float32), {}

    monkeypatch.setattr(main, "_run_killable", wrong)
    monkeypatch.setattr(main, "_session_rebuild",
                        lambda s: ("c", main._Path("/tmp/x"), {}))
    with pytest.raises(main.HTTPException) as e:
        await _compute(session)
    assert e.value.status_code == 500
    assert "nx" not in session.extras
