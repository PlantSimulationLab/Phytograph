"""Tests for the explicit Backfill Misses step (POST .../backfill-misses) and the
session miss buffer it persists.

LAD needs miss points (transmitted beams) for the Beer's-law denominator. Some
formats retain them; others carry only the data to reconstruct them (a per-hit
timestamp and/or scan-grid row/column indices). This endpoint recovers them up
front via PyHelios gapfillMisses(), stores them in a lightweight per-session
buffer (CloudSession.backfilled_misses), and leaves the hit arrays untouched.

These tests stub pyhelios with a fake cloud that models the gapfill contract:
ingested hits are tagged gapfillMisses_code 0.0; gapfillMisses() APPENDS synthetic
miss rows tagged 1.0. The bulk getters (getHitsXYZRGBArrays / getHitDataArray)
return hits-then-misses so _run_gapfill_extract can slice the misses out. No
native lib required.
"""

import asyncio
import time

import numpy as np
import pytest

import main


def _converter_available() -> bool:
    """True when the PotreeConverter binary is present, so the miss-octree build
    (which runs it) can be asserted. Off it, the build returns None by design."""
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Fake PyHelios cloud modelling the gapfill contract
# ---------------------------------------------------------------------------

class _FakeCloud:
    """Models addScan/addHitPointsWithData + gapfillMisses + the bulk getters.

    On ingest, every hit is recorded with code 0.0. gapfillMisses() synthesises
    a fixed number of sky misses (far-field) tagged code 1.0, appended after the
    hits — mirroring how Helios tags synthesised misses in-cloud. The number of
    synthesised misses and the data keys seen are recorded for assertions.
    """
    instances = []
    SYNTH = 3  # synthetic misses produced per gapfill
    gapfill_error = None  # set to an exception instance to make gapfillMisses raise

    def __init__(self):
        self.calls = []
        self._hit_xyz = np.empty((0, 3), np.float32)
        self._codes = np.empty((0,), np.float64)
        self._labels_seen = []
        _FakeCloud.instances.append(self)

    def disableMessages(self):
        pass

    def addScan(self, **kwargs):
        self.calls.append(("addScan", kwargs))
        return 0

    def addHitPointsWithData(self, scanID, xyz, dirs, labels, vals):
        self.calls.append(("addHitPointsWithData", scanID, len(xyz)))
        self._labels_seen = list(labels or [])
        self._hit_xyz = np.ascontiguousarray(xyz, dtype=np.float32)
        self._codes = np.zeros(len(xyz), dtype=np.float64)

    def gapfillMisses(self):
        self.calls.append(("gapfill",))
        if _FakeCloud.gapfill_error is not None:
            raise _FakeCloud.gapfill_error
        # Append SYNTH far-field misses tagged code 1.0, after the hits.
        synth = np.array([[100.0 + i, 0.0, 0.0] for i in range(self.SYNTH)],
                         dtype=np.float32)
        self._hit_xyz = np.vstack([self._hit_xyz, synth]) if self._hit_xyz.size else synth
        self._codes = np.concatenate([self._codes, np.ones(self.SYNTH, np.float64)])

    def getHitDataArray(self, label):
        if label == "gapfillMisses_code":
            return self._codes.copy()
        return np.full(self._codes.shape[0], np.nan, np.float64)

    def getHitsXYZRGBArrays(self):
        rgb = np.zeros_like(self._hit_xyz)
        return self._hit_xyz.copy(), rgb

    def getHitMissArray(self):
        return (self._codes >= 1.0).astype(np.int32)


@pytest.fixture
def stub_pyhelios(monkeypatch):
    import sys
    import types
    _FakeCloud.instances = []
    _FakeCloud.gapfill_error = None
    fake = types.ModuleType("pyhelios")
    fake.LiDARCloud = _FakeCloud
    monkeypatch.setitem(sys.modules, "pyhelios", fake)
    return _FakeCloud


# ---------------------------------------------------------------------------
# Session construction helpers
# ---------------------------------------------------------------------------

def _make_session(positions, extras, extra_dims_meta, session_id="bf-test"):
    n = len(positions)
    return main.CloudSession(
        session_id=session_id,
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=np.asarray(positions, dtype=np.float64),
        colors=None,
        intensity=None,
        extras={k: np.asarray(v, dtype=np.float32) for k, v in extras.items()},
        extra_dims_meta=extra_dims_meta,
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
    )


def _register(sess):
    with main._cloud_session_lock:
        main._cloud_sessions[sess.session_id] = sess


@pytest.fixture(autouse=True)
def _clear_sessions():
    """Keep the global session table clean between tests."""
    with main._cloud_session_lock:
        before = dict(main._cloud_sessions)
    yield
    with main._cloud_session_lock:
        main._cloud_sessions.clear()
        main._cloud_sessions.update(before)


def _drain(resp):
    """Decode a backfill endpoint response into (result_dict, progress_markers).

    The endpoint returns a plain JSONResponse for the already-has-misses no-op, or
    a StreamingResponse (PHP1 progress markers + JSON tail) for the heavy path.
    Returns the parsed result dict plus the list of (fraction, message) markers.
    """
    import json

    # JSONResponse (no-op path): body is the JSON dict, no markers.
    if hasattr(resp, "body") and not hasattr(resp, "body_iterator"):
        return json.loads(bytes(resp.body)), []

    async def _collect():
        return b"".join([
            c if isinstance(c, (bytes, bytearray)) else c.encode()
            async for c in resp.body_iterator])

    raw = asyncio.run(_collect())
    # Split leading PHP1 markers from the trailing JSON. Each marker: 'PHP1' +
    # uint32 len + len bytes (space-padded). Whitespace keepalives are 4 spaces.
    markers = []
    i = 0
    while i + 8 <= len(raw) and raw[i:i + 4] == b"PHP1":
        mlen = int.from_bytes(raw[i + 4:i + 8], "little")
        payload = json.loads(raw[i + 8:i + 8 + mlen])
        markers.append((payload["progress"], payload["message"]))
        i += 8 + mlen
    # Skip any trailing whitespace keepalives before the JSON tail.
    while i < len(raw) and raw[i:i + 1] in (b" ", b"\n", b"\t"):
        i += 1
    result = json.loads(raw[i:]) if i < len(raw) else {}
    return result, markers


def _call(session_id, **body):
    """Run the endpoint and return the result dict (progress markers discarded)."""
    req = main.BackfillMissesRequest(**body)
    resp = asyncio.run(main.backfill_cloud_misses(session_id, req))
    result, _markers = _drain(resp)
    return result


_TS_POSITIONS = [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.5, 0.5, 0.5]]


# ---------------------------------------------------------------------------
# Eligibility + persistence
# ---------------------------------------------------------------------------

def test_timestamp_session_backfills_and_populates_buffer(stub_pyhelios):
    sess = _make_session(
        _TS_POSITIONS,
        {"timestamp": [1.0, 2.0, 3.0]},
        [{"slug": "timestamp", "label": "Timestamp"}],
    )
    _register(sess)
    before_positions = sess.positions.copy()

    resp = _call(sess.session_id, origin=[0, 0, 5])

    assert resp["already_had_misses"] is False
    assert resp["backfilled"] == _FakeCloud.SYNTH
    assert resp["has_misses"] is True
    # Buffer populated with positions + directions; hit arrays untouched.
    assert sess.backfilled_misses is not None
    assert sess.backfilled_misses["positions"].shape == (_FakeCloud.SYNTH, 3)
    assert sess.backfilled_misses["directions"].shape == (_FakeCloud.SYNTH, 3)
    np.testing.assert_array_equal(sess.positions, before_positions)
    assert "is_miss" not in sess.extras  # not interleaved into the column arrays


def test_grid_only_session_relabels_row_column(stub_pyhelios):
    # A session with row_index/column_index but NO timestamp is eligible (has_grid).
    sess = _make_session(
        _TS_POSITIONS,
        {"row_index": [0, 1, 2], "column_index": [0, 0, 1]},
        [{"slug": "row_index", "label": "Row Index"},
         {"slug": "column_index", "label": "Column Index"}],
    )
    _register(sess)

    resp = _call(sess.session_id, origin=[0, 0, 5])

    assert resp["backfilled"] == _FakeCloud.SYNTH
    # The C++ gapfill dispatcher probes the bare 'row'/'column' hit-data keys, so
    # the slugs must be relabelled on the way into addHitPointsWithData.
    cloud = stub_pyhelios.instances[-1]
    assert "row" in cloud._labels_seen and "column" in cloud._labels_seen
    assert "row_index" not in cloud._labels_seen
    assert "column_index" not in cloud._labels_seen
    # The row/column backfill must also BUILD the projected-miss octree and return
    # its id, so the renderer can stream the shell. (Regression: the row/col path
    # recovered misses but showed none, because the build/return was missing or the
    # display gated on a live scanner origin the backfilled scan didn't have.)
    if _converter_available():
        assert resp["miss_octree_cache_id"], "row/col backfill built no miss octree"
        assert sess.miss_octree_cache_id == resp["miss_octree_cache_id"]
        assert sess.backfilled_misses_stale is False


def test_timestamp_preferred_over_grid_drops_grid_columns(stub_pyhelios):
    # A scan carrying BOTH a timestamp and a row/column grid: the timestamp path
    # is far more robust than the brittle row/column one (which errors on a sparse
    # grid), so the grid columns are DROPPED and only 'timestamp' reaches the
    # cloud — steering the C++ dispatcher onto the timestamp path.
    sess = _make_session(
        _TS_POSITIONS,
        {"timestamp": [1.0, 2.0, 3.0], "row_index": [0, 0, 0], "column_index": [0, 0, 0]},
        [{"slug": "timestamp", "label": "Timestamp"},
         {"slug": "row_index", "label": "Row Index"},
         {"slug": "column_index", "label": "Column Index"}],
    )
    _register(sess)

    resp = _call(sess.session_id, origin=[0, 0, 5])

    assert resp["backfilled"] == _FakeCloud.SYNTH
    cloud = stub_pyhelios.instances[-1]
    assert "timestamp" in cloud._labels_seen
    assert "row" not in cloud._labels_seen and "column" not in cloud._labels_seen
    assert "row_index" not in cloud._labels_seen


def _addscan_kwargs(cloud):
    """The kwargs of the addScan call captured by the stub cloud."""
    return next(k for (name, k) in cloud.calls if name == "addScan")


def test_supplied_raster_drives_addscan_grid_and_sweep(stub_pyhelios):
    # The frontend forwards the scan's REAL angular raster (Ntheta/Nphi + the
    # theta/phi sweep) so the C++ gapfiller reconstructs misses over the actual
    # scan grid — not a point-count estimate that assumes a full 0–180°/0–360°
    # sweep. This is the fix for the 360° miss-ring bug: a row/column scan with a
    # limited zenith (thetaMax 150) and a 3415×8122 grid must build the cloud with
    # exactly those values, not an estimate.
    import math
    sess = _make_session(
        _TS_POSITIONS,
        {"row_index": [0, 1, 2], "column_index": [0, 0, 1]},
        [{"slug": "row_index", "label": "Row Index"},
         {"slug": "column_index", "label": "Column Index"}],
    )
    _register(sess)

    resp = _call(
        sess.session_id, origin=[0, 0, 5],
        n_theta=3415, n_phi=8122,
        theta_min=0.0, theta_max=150.0, phi_min=0.0, phi_max=360.0,
    )

    assert resp["backfilled"] == _FakeCloud.SYNTH
    kw = _addscan_kwargs(stub_pyhelios.instances[-1])
    # Grid dimensions reach addScan verbatim (no estimate).
    assert kw["Ntheta"] == 3415
    assert kw["Nphi"] == 8122
    # Sweep is forwarded in RADIANS — crucially theta_max is 150°, NOT the 180°
    # default that would over-fill misses into the unscanned polar cap.
    assert kw["theta_range"][0] == pytest.approx(0.0)
    assert kw["theta_range"][1] == pytest.approx(math.radians(150.0))
    assert kw["phi_range"][0] == pytest.approx(0.0)
    assert kw["phi_range"][1] == pytest.approx(math.radians(360.0))


def test_omitted_raster_falls_back_to_estimate(stub_pyhelios):
    # Backward-compatible default: with no raster supplied, the backend estimates
    # the grid from point count and assumes a full 0–180°/0–360° sweep. (This is
    # the legacy behaviour the frontend now overrides; kept as a regression guard
    # so the fallback isn't accidentally removed.)
    import math
    sess = _make_session(
        _TS_POSITIONS,
        {"row_index": [0, 1, 2], "column_index": [0, 0, 1]},
        [{"slug": "row_index", "label": "Row Index"},
         {"slug": "column_index", "label": "Column Index"}],
    )
    _register(sess)

    resp = _call(sess.session_id, origin=[0, 0, 5])  # no raster

    assert resp["backfilled"] == _FakeCloud.SYNTH
    kw = _addscan_kwargs(stub_pyhelios.instances[-1])
    assert kw["theta_range"][1] == pytest.approx(math.radians(180.0))
    assert kw["phi_range"][1] == pytest.approx(math.radians(360.0))


def test_helios_gapfill_failure_returns_error_in_json_tail(stub_pyhelios):
    # When Helios can't reconstruct the grid (e.g. a sparse row/column raster), it
    # raises mid-stream. The streamed worker must convert that into a clean,
    # actionable `error` field in the JSON tail rather than breaking the stream
    # with a raw 500.
    _FakeCloud.gapfill_error = RuntimeError(
        "ERROR (LiDARcloud::gapfillMisses): scan 0 has too few populated scan rows")
    sess = _make_session(
        _TS_POSITIONS,
        {"row_index": [0, 1, 2], "column_index": [0, 0, 1]},
        [{"slug": "row_index", "label": "Row Index"},
         {"slug": "column_index", "label": "Column Index"}],
    )
    _register(sess)

    resp = _call(sess.session_id, origin=[0, 0, 5])
    assert resp["backfilled"] == 0
    assert resp["has_misses"] is False
    assert "reconstruct" in resp["error"].lower()
    assert sess.backfilled_misses is None  # nothing persisted on failure


def test_streams_progress_markers_then_json_tail(stub_pyhelios):
    # The eligible path streams PHP1 progress markers ahead of the JSON tail so the
    # renderer can show a per-stage bar. Assert ≥1 marker fires, the stage sequence
    # includes the indeterminate gapfill step, and the JSON tail is the result.
    sess = _make_session(
        _TS_POSITIONS, {"timestamp": [1.0, 2.0, 3.0]},
        [{"slug": "timestamp", "label": "Timestamp"}])
    _register(sess)

    req = main.BackfillMissesRequest(origin=[0, 0, 5])
    resp = asyncio.run(main.backfill_cloud_misses(sess.session_id, req))
    result, markers = _drain(resp)

    assert result["backfilled"] == _FakeCloud.SYNTH
    assert len(markers) >= 1
    messages = [m[1] for m in markers]
    assert any("Reconstructing misses" in m for m in messages)
    # The gapfill stage reports an indeterminate (None) fraction.
    assert any(frac is None for frac, _ in markers)
    # And a terminal 1.0 "Done" marker.
    assert any(frac == 1.0 for frac, _ in markers)


def test_already_has_misses_short_circuits(stub_pyhelios):
    sess = _make_session(
        _TS_POSITIONS,
        {"timestamp": [1.0, 2.0, 3.0], "is_miss": [0.0, 0.0, 1.0]},
        [{"slug": "timestamp", "label": "Timestamp"},
         {"slug": "is_miss", "label": "Miss"}],
    )
    _register(sess)

    resp = _call(sess.session_id, origin=[0, 0, 5])

    assert resp["already_had_misses"] is True
    assert resp["backfilled"] == 0
    assert sess.backfilled_misses is None      # buffer not created
    # gapfill must never be attempted for a scan that already has misses.
    assert not stub_pyhelios.instances  # no cloud built at all


def test_plain_xyz_is_rejected(stub_pyhelios):
    sess = _make_session(_TS_POSITIONS, {}, [])
    _register(sess)

    with pytest.raises(main.HTTPException) as exc:
        _call(sess.session_id, origin=[0, 0, 5])
    assert exc.value.status_code == 400
    assert "reconstruct" in str(exc.value.detail).lower()


def test_orphaned_session_404(stub_pyhelios):
    with pytest.raises(main.HTTPException) as exc:
        _call("does-not-exist", origin=[0, 0, 5])
    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# Reader integration: the buffer flows into the misses overlay + LAD arrays
# ---------------------------------------------------------------------------

def test_gather_miss_positions_no_cap(stub_pyhelios):
    # The miss octree streams via LOD, so there is NO subsample cap (unlike the
    # old overlay). _gather_miss_positions must return the FULL placeable set —
    # well above the old 200k cap conceptually; here we use a count that would
    # have been capped by any small stride and assert every point survives.
    n = 1000
    rng = np.arange(n, dtype=np.float64)
    miss_pos = np.column_stack([rng, np.zeros(n), np.full(n, 50.0)])  # spread out
    sess = _make_session(
        _TS_POSITIONS, {"timestamp": [1.0, 2.0, 3.0]},
        [{"slug": "timestamp", "label": "Timestamp"}])
    sess.backfilled_misses = {
        "positions": miss_pos,
        "directions": main._directions_from_origin(miss_pos, [0, 0, 5]),
    }
    _register(sess)

    # With an origin every miss is projected onto a sphere of the computed radius;
    # none are dropped (all have a beam direction), and the FULL count is returned.
    origin = [0.0, 0.0, 5.0]
    relocated, radius = main._gather_miss_positions(sess, origin)
    assert relocated.shape[0] == n          # no cap, no subsample
    assert radius > 0
    dists = np.linalg.norm(relocated - np.asarray(origin), axis=1)
    assert np.allclose(dists, radius, rtol=1e-6)  # all on the sphere


def test_gather_miss_positions_true_coords_no_origin(stub_pyhelios):
    # No origin → misses returned at their true stored coordinates, untouched.
    sess = _make_session(
        _TS_POSITIONS,
        {"timestamp": [1.0, 2.0, 3.0]},
        [{"slug": "timestamp", "label": "Timestamp"}],
    )
    _register(sess)
    _call(sess.session_id, origin=[0, 0, 5])

    positions, radius = main._gather_miss_positions(sess, None)
    assert radius == 0.0
    assert positions.shape[0] == _FakeCloud.SYNTH
    assert np.allclose(positions, sess.backfilled_misses["positions"])


def test_session_to_lad_arrays_appends_buffer_as_misses(stub_pyhelios):
    sess = _make_session(
        _TS_POSITIONS,
        {"timestamp": [1.0, 2.0, 3.0]},
        [{"slug": "timestamp", "label": "Timestamp"}],
    )
    _register(sess)
    _call(sess.session_id, origin=[0, 0, 5])

    # Default read path INCLUDES the buffer: hits + misses, has_misses True.
    xyz, dirs, labels, vals, flags = main._session_to_lad_arrays(sess, [0, 0, 5])
    assert flags["has_misses"] is True
    assert "is_miss" in labels
    assert xyz.shape[0] == len(_TS_POSITIONS) + _FakeCloud.SYNTH
    miss_col = vals[:, labels.index("is_miss")]
    # First rows are hits (0), appended rows are misses (1).
    assert miss_col[:len(_TS_POSITIONS)].tolist() == [0.0, 0.0, 0.0]
    assert miss_col[len(_TS_POSITIONS):].tolist() == [1.0] * _FakeCloud.SYNTH

    # The backfill endpoint itself must NOT see the buffer (operates on raw hits).
    rxyz, *_rest, rflags = main._session_to_lad_arrays(
        sess, [0, 0, 5], include_backfilled=False)
    assert rxyz.shape[0] == len(_TS_POSITIONS)
    assert rflags["has_misses"] is False


# ---------------------------------------------------------------------------
# Moving-platform path: a request carrying a trajectory reconstructs per-beam
# emission origins (joined by timestamp) instead of fanning misses from a single
# static apex. Mirrors what the renderer now forwards (poseStreamToWire) and the
# LAD beam path already does via _apply_trajectory_origins.
# ---------------------------------------------------------------------------

def _trajectory(t0=1.0, t1=3.0):
    """A two-pose PoseStream spanning [t0, t1] with distinct positions (identity
    attitude) so the timestamp join yields per-return origins that VARY."""
    return main.PoseStream(
        poses=[
            main.PoseSample(t=t0, x=0.0, y=0.0, z=10.0, qx=0.0, qy=0.0, qz=0.0, qw=1.0),
            main.PoseSample(t=t1, x=20.0, y=0.0, z=10.0, qx=0.0, qy=0.0, qz=0.0, qw=1.0),
        ],
    )


def test_moving_trajectory_reconstructs_per_beam_origins(stub_pyhelios):
    # A moving-platform scan: timestamps in [1,3] join to a trajectory spanning the
    # same range. _apply_trajectory_origins must run — appending origin_x/y/z data
    # columns the C++ beam path reads — and the persisted buffer must carry the
    # per-miss origins so the LAD reader gets an origin column.
    sess = _make_session(
        _TS_POSITIONS, {"timestamp": [1.0, 2.0, 3.0]},
        [{"slug": "timestamp", "label": "Timestamp"}])
    _register(sess)

    resp = _call(sess.session_id, origin=[0, 0, 10], trajectory=_trajectory())

    assert resp["backfilled"] == _FakeCloud.SYNTH
    assert resp["has_misses"] is True
    # The trajectory join attached origin_x/y/z to the hit data map (proof the
    # moving branch ran, not the static single-origin one).
    cloud = stub_pyhelios.instances[-1]
    for slug in ("origin_x", "origin_y", "origin_z"):
        assert slug in cloud._labels_seen
    # The miss buffer carries a broadcast per-miss origin column for the LAD reader.
    assert sess.backfilled_misses is not None
    origins = sess.backfilled_misses.get("origins")
    assert origins is not None
    assert origins.shape == (_FakeCloud.SYNTH, 3)


def test_static_request_omits_trajectory_keeps_single_origin(stub_pyhelios):
    # Regression: with no trajectory the moving branch is skipped entirely — no
    # origin_x/y/z columns, no buffer origins — identical to the legacy static path.
    sess = _make_session(
        _TS_POSITIONS, {"timestamp": [1.0, 2.0, 3.0]},
        [{"slug": "timestamp", "label": "Timestamp"}])
    _register(sess)

    resp = _call(sess.session_id, origin=[0, 0, 5])  # no trajectory

    assert resp["backfilled"] == _FakeCloud.SYNTH
    cloud = stub_pyhelios.instances[-1]
    assert "origin_x" not in cloud._labels_seen
    assert sess.backfilled_misses.get("origins") is None


def test_moving_without_timestamp_returns_clean_error(stub_pyhelios):
    # A grid-only session is eligible (has_grid) but a trajectory needs a per-return
    # timestamp to join. The unguarded join would raise ValueError mid-stream; the
    # worker must instead return a clean, actionable error in the JSON tail.
    sess = _make_session(
        _TS_POSITIONS,
        {"row_index": [0, 1, 2], "column_index": [0, 0, 1]},
        [{"slug": "row_index", "label": "Row Index"},
         {"slug": "column_index", "label": "Column Index"}],
    )
    _register(sess)

    resp = _call(sess.session_id, origin=[0, 0, 10], trajectory=_trajectory())

    assert resp["backfilled"] == 0
    assert resp["has_misses"] is False
    assert "timestamp" in resp["error"].lower()
    assert sess.backfilled_misses is None  # nothing persisted on the guarded error
