"""`/api/cloud/session/{id}/denoise` plumbing.

The criteria themselves are covered by `test_denoise.py`; this file is about
what the ENDPOINT does around them — which is where the miss-exclusion traps
live:

  (a) misses must never reach the KD-tree. A miss is projected ~1 km out, so it
      would both blow up the tree's extent and poison the nearest-neighbour
      spacing the auto parameters are derived from.
  (b) misses must come back labelled CLEAN, not the house-convention 0, so no
      commit path can ever move one into a noise cloud and cost the parent its
      Beer's-law transmission denominator.

`_run_killable` and `_session_rebuild` are stubbed: the first spawns a ~4 s
subprocess, the second needs PotreeConverter, and neither is what is under test.
"""

import time

import numpy as np
import pytest

import denoise
import main

MISS_X = 1000.0  # far field, as a real miss is projected


def _make_session(n_hits=1200, n_misses=40, session_id="denoise_sess", extras=None):
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
    ex = {"is_miss": miss}
    meta = [{"slug": "is_miss", "label": "is_miss"}]
    if extras:
        ex.update(extras)
        meta += [{"slug": k, "label": k} for k in extras]

    sess = main.CloudSession(
        session_id=session_id, source_path="<test>", ascii_format=None,
        column_plan=None, positions=xyz, colors=None, intensity=None,
        extras=ex, extra_dims_meta=meta,
        deleted=np.zeros(n, dtype=bool), deleted_history=[],
        octree_cache_id=None, created_at=time.time())
    main._cloud_sessions[session_id] = sess
    return sess


@pytest.fixture
def session(request):
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
        meta: dict = {}
        labels = denoise.denoise_labels(points, meta=meta, **params)
        seen["meta"] = meta
        return labels, meta

    monkeypatch.setattr(main, "_run_killable", fake_run_killable)
    monkeypatch.setattr(main, "_session_rebuild",
                        lambda s: ("cache", main._Path("/tmp/x"), {"point_count": 0}))
    return seen


async def _denoise(session, spy, **kw):
    return await main.session_denoise(
        session.session_id, main.SessionDenoiseRequest(**kw), http_request=None)


@pytest.mark.asyncio
async def test_misses_never_reach_the_compute(session, spy):
    """The 1 km trap: a single miss in the KD-tree input inflates the extent
    ~1000x and the spacing estimate with it."""
    await _denoise(session, spy)
    fed = spy["points"]
    assert len(fed) == 1200                      # hits only, all 40 misses dropped
    assert fed[:, 0].max() < MISS_X / 100        # nothing from the far field


@pytest.mark.asyncio
async def test_misses_are_labelled_clean_not_zero(session, spy):
    """Defence in depth. `session_split` already forces misses onto the kept
    side; labelling them CLEAN means no future refactor of that guard can move a
    miss into a noise cloud."""
    await _denoise(session, spy)
    col = session.extras[denoise.NOISE_CLASS_SLUG]
    is_miss = session.extras["is_miss"] != 0
    assert (col[is_miss] == denoise.NOISE_CLEAN).all()
    assert not (col == 0).any(), "0 is not a noise_class value on a live session"
    assert set(np.unique(col)) <= {denoise.NOISE_CLEAN, denoise.NOISE_NOISE}


@pytest.mark.asyncio
async def test_flagged_count_covers_hits_only(session, spy):
    result = await _denoise(session, spy)
    col = session.extras[denoise.NOISE_CLASS_SLUG]
    assert result["flagged"] == int((col == denoise.NOISE_NOISE).sum())
    assert result["analyzed_points"] == 1200
    # A clean lattice: the rule should take almost nothing.
    assert result["fraction"] < 0.05
    assert result["over_removal"] is False


@pytest.mark.asyncio
async def test_spacing_estimate_is_unaffected_by_misses(spy):
    """The 2,500x error this codebase has hit repeatedly: misses DEFINE the
    nearest-neighbour distribution if they are not excluded."""
    with_misses = _make_session(session_id="with_misses", n_misses=40)
    without = _make_session(session_id="without_misses", n_misses=0)
    try:
        a = await _denoise(with_misses, spy)
        b = await _denoise(without, spy)
    finally:
        main._cloud_sessions.pop("with_misses", None)
        main._cloud_sessions.pop("without_misses", None)
    assert a["spacing_m"] == pytest.approx(b["spacing_m"], rel=1e-9)
    assert a["params_used"] == b["params_used"]


@pytest.mark.asyncio
async def test_auto_params_are_reported_back(session, spy):
    result = await _denoise(session, spy)
    assert result["method"] == "ror"
    assert set(result["params_used"]) == {"radius", "nb_points"}
    assert result["params_used"]["radius"] > 0
    assert result["spacing_m"] == pytest.approx(0.01, abs=2e-3)


@pytest.mark.asyncio
async def test_explicit_params_win_and_only_the_methods_own_keys_are_sent(session, spy):
    await _denoise(session, spy, method="ror", radius=0.25, nb_points=3, std_ratio=9.9)
    assert spy["params"]["radius"] == 0.25
    assert spy["params"]["nb_points"] == 3
    # std_ratio belongs to SOR; sending it would make `params_used` advertise a
    # value the panel then shows as applied.
    assert "std_ratio" not in spy["params"]


@pytest.mark.asyncio
async def test_rerunning_sor_flags_the_second_pass_hazard(session, spy):
    first = await _denoise(session, spy, method="sor")
    assert spy["params"]["previously_denoised"] is False
    assert not any("already been denoised" in w for w in first["warnings"])
    # The column now exists, so the next run is a second pass.
    second = await _denoise(session, spy, method="sor")
    assert spy["params"]["previously_denoised"] is True
    assert any("already been denoised" in w for w in second["warnings"])


@pytest.mark.asyncio
async def test_unknown_method_is_rejected_before_any_work(session, spy):
    with pytest.raises(main.HTTPException) as exc:
        await _denoise(session, spy, method="magic")
    assert exc.value.status_code == 400
    assert "magic" in exc.value.detail
    assert "tool" not in spy, "must reject before spawning the worker"


@pytest.mark.asyncio
async def test_too_few_points_is_rejected(spy):
    small = _make_session(n_hits=50, n_misses=5, session_id="small_sess")
    try:
        with pytest.raises(main.HTTPException) as exc:
            await _denoise(small, spy)
    finally:
        main._cloud_sessions.pop("small_sess", None)
    assert exc.value.status_code == 400
    assert "at least" in exc.value.detail
    assert "tool" not in spy


@pytest.mark.asyncio
async def test_deleted_points_are_excluded_and_the_column_stays_full_length(session, spy):
    session.deleted[:100] = True
    await _denoise(session, spy)
    assert len(spy["points"]) == 1100        # 1200 hits - 100 deleted
    # `_session_add_extra_column` keeps every session array the same length.
    assert len(session.extras[denoise.NOISE_CLASS_SLUG]) == len(session.positions)


@pytest.mark.asyncio
async def test_cancellation_leaves_the_session_pristine(session, monkeypatch):
    async def cancelled(*a, **kw):
        raise main.ClientDisconnected()

    monkeypatch.setattr(main, "_run_killable", cancelled)
    with pytest.raises(main.HTTPException) as exc:
        await main.session_denoise(session.session_id,
                                   main.SessionDenoiseRequest(), http_request=None)
    assert exc.value.status_code == 499
    assert denoise.NOISE_CLASS_SLUG not in session.extras
