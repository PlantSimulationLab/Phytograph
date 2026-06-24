"""Regression gate for the moving-platform LAD timestamp precision fix.

GPS Adjusted-Standard time is a huge double (~3.5e8 s). The old import path stored
the per-point `gps_time` in the float32 `extras` dict, whose ~7 significant digits
give only ~32 s of resolution at that magnitude — so every return within tens of
seconds collapsed onto a single trajectory pose, silently destroying per-beam
origins. The fix routes `gps_time` to a dedicated float64 `CloudSession.timestamps`
field, read back by `_session_to_lad_arrays` via its `_get('timestamp')` chokepoint.

These tests build a LAS whose returns are 1 ms apart around a large epoch and prove
the distinct timestamps survive end-to-end — with a CONTROL assertion that a float32
cast would have collapsed them (so the test fails loudly if the float32 path returns).
"""

import time

import numpy as np
import pytest

import main

laspy = pytest.importorskip("laspy")


# A large adjusted-standard epoch; 1 ms spacing. float32 cannot resolve these.
_EPOCH = 3.5e8
_N = 8
_GPS_TIMES = _EPOCH + np.arange(_N) * 0.001  # 1 ms apart


def _write_gps_las(path):
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.zeros(3, dtype=np.float64)
    las = laspy.LasData(header)
    las.x = np.linspace(0.1, 0.8, _N)
    las.y = np.linspace(0.2, 0.9, _N)
    las.z = np.linspace(1.0, 0.5, _N)
    las.gps_time = _GPS_TIMES
    # Mark as multi-return so the LAD path actually carries the timestamp column.
    las.return_number = np.ones(_N, dtype=np.uint8)
    las.number_of_returns = np.ones(_N, dtype=np.uint8)
    las.write(str(path))


def test_gps_time_survives_as_float64_through_read(tmp_path):
    """`_read_las_into_arrays` returns the per-point time as a distinct-valued
    float64 array, NOT collapsed into float32 extras."""
    las_path = tmp_path / "gps.las"
    _write_gps_las(las_path)

    _r = main._read_las_into_arrays(las_path)
    extras = _r.extras
    timestamps = _r.timestamps

    assert timestamps is not None
    assert timestamps.dtype == np.float64
    assert "timestamp" not in extras  # must not ride the float32 dict
    # All 8 returns are distinct at full precision.
    assert len(np.unique(timestamps)) == _N
    np.testing.assert_allclose(timestamps, _GPS_TIMES, rtol=0, atol=0)

    # CONTROL: a float32 cast (the OLD behaviour) collapses the 1 ms spacing at
    # this epoch. If this assertion ever fails, the float32 path has returned and
    # the precision fix is broken — that is exactly what this gate guards.
    assert len(np.unique(timestamps.astype(np.float32))) < _N


def test_gps_time_reaches_lad_arrays_distinct(tmp_path):
    """Through `_session_to_lad_arrays` the timestamp column in `vals` keeps its
    distinct float64 values — proving the `_get` chokepoint prefers the float64
    session field over `extras`."""
    las_path = tmp_path / "gps.las"
    _write_gps_las(las_path)
    _r = main._read_las_into_arrays(las_path)
    positions, colors, intensity = _r.positions, _r.colors, _r.intensity
    extras, extra_dims_meta, timestamps = _r.extras, _r.extra_dims_meta, _r.timestamps

    sess = main.CloudSession(
        session_id="ts_test",
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=positions,
        colors=colors,
        intensity=intensity,
        extras=extras,
        extra_dims_meta=extra_dims_meta,
        timestamps=timestamps,
        deleted=np.zeros(len(positions), dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
    )

    origin = positions.mean(axis=0).tolist()
    _xyz, _dirs, labels, vals, _flags = main._session_to_lad_arrays(sess, origin)

    assert "timestamp" in labels, "LAD arrays must carry the timestamp join key"
    ts_col = vals[:, labels.index("timestamp")]
    assert ts_col.dtype == np.float64
    assert len(np.unique(ts_col)) == _N
    np.testing.assert_allclose(ts_col, _GPS_TIMES, rtol=0, atol=0)


def test_deleted_points_subset_timestamps(tmp_path):
    """The `_get` closure applies the `~deleted` mask to the float64 timestamps,
    keeping them aligned with the surviving positions."""
    las_path = tmp_path / "gps.las"
    _write_gps_las(las_path)
    _r = main._read_las_into_arrays(las_path)
    positions, colors, intensity = _r.positions, _r.colors, _r.intensity
    extras, extra_dims_meta, timestamps = _r.extras, _r.extra_dims_meta, _r.timestamps

    deleted = np.zeros(len(positions), dtype=bool)
    deleted[[0, 3, 7]] = True  # drop 3 of 8
    sess = main.CloudSession(
        session_id="ts_del",
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=positions,
        colors=colors,
        intensity=intensity,
        extras=extras,
        extra_dims_meta=extra_dims_meta,
        timestamps=timestamps,
        deleted=deleted,
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
    )

    origin = positions[~deleted].mean(axis=0).tolist()
    xyz, _dirs, labels, vals, _flags = main._session_to_lad_arrays(sess, origin)

    assert xyz.shape[0] == int((~deleted).sum()) == 5
    ts_col = vals[:, labels.index("timestamp")]
    np.testing.assert_allclose(ts_col, _GPS_TIMES[~deleted], rtol=0, atol=0)


# ---------------------------------------------------------------------------
# Phase 1: GPS-time encoding flag (global_encoding bit 0)
# ---------------------------------------------------------------------------

def _write_las_with_encoding(path, gps_time_type, gps_values):
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.zeros(3, dtype=np.float64)
    header.global_encoding.gps_time_type = gps_time_type
    las = laspy.LasData(header)
    n = len(gps_values)
    las.x = np.linspace(0.1, 0.8, n)
    las.y = np.linspace(0.2, 0.9, n)
    las.z = np.linspace(1.0, 0.5, n)
    las.gps_time = np.asarray(gps_values, dtype=np.float64)
    las.return_number = np.ones(n, dtype=np.uint8)
    las.number_of_returns = np.ones(n, dtype=np.uint8)
    las.write(str(path))


def test_encoding_adjusted_standard(tmp_path):
    """global_encoding bit set → Adjusted-Standard; raw values preserved."""
    las_path = tmp_path / "adj.las"
    vals = _EPOCH + np.arange(5) * 0.5
    _write_las_with_encoding(las_path, 1, vals)  # 1 = STANDARD/Adjusted

    _r = main._read_las_into_arrays(las_path)
    timestamps = _r.timestamps
    encoding = _r.gps_time_encoding
    assert encoding == "adjusted_standard"
    np.testing.assert_allclose(timestamps, vals, rtol=0, atol=0)  # no −1e9 applied


def test_encoding_gps_week(tmp_path):
    """global_encoding bit clear + week-range values → GPS Week Time; raw values
    preserved (NOT silently normalised to adjusted-standard)."""
    las_path = tmp_path / "week.las"
    vals = np.array([100.0, 200.0, 300000.0, 400000.0, 604000.0])  # seconds-into-week
    _write_las_with_encoding(las_path, 0, vals)  # 0 = WEEK_TIME

    _r = main._read_las_into_arrays(las_path)
    timestamps = _r.timestamps
    encoding = _r.gps_time_encoding
    assert encoding == "gps_week"
    np.testing.assert_allclose(timestamps, vals, rtol=0, atol=0)  # raw, unmodified


def test_encoding_none_when_no_gps_time(tmp_path):
    """Point format 0 carries no gps_time → no timestamps, no encoding."""
    las_path = tmp_path / "fmt0.las"
    header = laspy.LasHeader(point_format=0, version="1.2")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.zeros(3, dtype=np.float64)
    las = laspy.LasData(header)
    las.x = np.array([0.1, 0.3, 0.5])
    las.y = np.array([0.2, 0.4, 0.6])
    las.z = np.array([1.0, 1.5, 0.5])
    las.write(str(las_path))

    _r = main._read_las_into_arrays(las_path)
    timestamps = _r.timestamps
    encoding = _r.gps_time_encoding
    assert timestamps is None
    assert encoding is None


# ---------------------------------------------------------------------------
# Synthetic-scan path: the same precision guarantee for the synthetic-scan
# session builder (the import path is covered above; this covers _do_lidar_scan
# → _create_lidar_scan_session, which must route the float64 columnar timestamp
# to CloudSession.timestamps just as the LAS reader does for imported clouds).
# ---------------------------------------------------------------------------

def _synthetic_scan_r(n=_N, with_misses=False):
    """A `_create_lidar_scan_session` input dict mirroring what `_do_lidar_scan`
    builds for one scanner: float32 `scalars` (the renderer/display copy) plus the
    float64 `timestamps_f64` columnar copy that must reach CloudSession.timestamps."""
    pts = np.column_stack([
        np.linspace(0.1, 0.8, n),
        np.linspace(0.2, 0.9, n),
        np.linspace(1.0, 0.5, n),
    ]).astype(np.float32)
    is_miss = np.zeros(n, dtype=np.uint8)
    if with_misses:
        is_miss[-1] = 1  # one sky return
    return {
        "scanner_id": "syn",
        "origin": [0.0, 0.0, 5.0],
        "points": pts,
        "colors": None,
        # Display copy is float32 (exactly what getHitDataArray returns).
        "scalars": {"timestamp": _GPS_TIMES.astype(np.float32)},
        # Precision copy is float64 (what getHitDataColumnArray returns).
        "timestamps_f64": {"timestamp": _GPS_TIMES.copy()},
        "is_miss": is_miss,
    }


class TestSyntheticScanTimestampFloat64:
    """A synthetic scan must route its per-hit timestamp to the float64
    CloudSession.timestamps field, so GPS-magnitude times keep sub-second
    precision the float32 getHitDataArray() display copy would quantize away."""

    def _make_session(self, r):
        out = main._create_lidar_scan_session(r)
        sid = out["session_id"]
        with main._cloud_session_lock:
            sess = main._cloud_sessions[sid]
        return sid, sess

    def test_session_stores_float64_timestamps_with_float32_display_copy(self):
        sid, sess = self._make_session(_synthetic_scan_r())
        try:
            # The dedicated float64 field carries the join-key precision.
            assert sess.timestamps is not None
            assert sess.timestamps.dtype == np.float64
            assert len(np.unique(sess.timestamps)) == _N
            np.testing.assert_allclose(sess.timestamps, _GPS_TIMES, rtol=0, atol=0)

            # The two-copy contract: timestamp ALSO stays in float32 extras for
            # octree color-by / backfill display.
            assert "timestamp" in sess.extras
            assert sess.extras["timestamp"].dtype == np.float32

            # CONTROL: a float32 cast (the display copy / the old bug) collapses the
            # 1 ms spacing at this epoch. If this fails, the float32 path returned.
            assert len(np.unique(sess.timestamps.astype(np.float32))) < _N
        finally:
            with main._cloud_session_lock:
                main._cloud_sessions.pop(sid, None)

    def test_export_emits_float64_timestamp_column(self):
        sid, sess = self._make_session(_synthetic_scan_r())
        try:
            entry = main.HeliosScanEntry(origin=[0.0, 0.0, 5.0], session_id=sid)
            xyz, labels, vals = main._resolve_scan_export_arrays(entry, include_misses=True)
            assert "timestamp" in labels, "export must carry the timestamp column"
            ts_col = vals[:, labels.index("timestamp")]
            assert ts_col.dtype == np.float64
            # Full precision survived to the exported column.
            assert len(np.unique(ts_col)) == _N
            np.testing.assert_allclose(np.sort(ts_col), _GPS_TIMES, rtol=0, atol=0)
        finally:
            with main._cloud_session_lock:
                main._cloud_sessions.pop(sid, None)

    def test_subset_keeps_timestamps_aligned_and_precise(self):
        """`_session_subset_locked` (split/crop) must carry the float64 timestamps
        onto the new session, aligned with the surviving points."""
        sid, sess = self._make_session(_synthetic_scan_r())
        new_id = None
        try:
            keep = np.ones(_N, dtype=bool)
            keep[[1, 4]] = False  # drop 2 of N survivors
            with main._cloud_session_lock:
                new_sess = main._session_subset_locked(sess, keep)
            new_id = new_sess.session_id
            assert new_sess.timestamps is not None
            assert new_sess.timestamps.dtype == np.float64
            assert new_sess.timestamps.shape[0] == new_sess.positions.shape[0]
            np.testing.assert_allclose(
                new_sess.timestamps, _GPS_TIMES[keep], rtol=0, atol=0)
        finally:
            with main._cloud_session_lock:
                main._cloud_sessions.pop(sid, None)
                if new_id:
                    main._cloud_sessions.pop(new_id, None)


class TestSyntheticScanTimestampFloat64RealPyhelios:
    """End-to-end through the real synthetic-scan FFI: a scan with misses must
    populate CloudSession.timestamps as a float64 column read via
    getHitDataColumnArray (NOT the float32 getHitDataArray display copy). Skipped
    when the native pyhelios build is unavailable."""

    def test_scan_session_has_float64_timestamps(self):
        pytest.importorskip("pyhelios")
        # Reuse the pyramid geometry + static scanner from the lidar-scan suite. A
        # 0..180 theta sweep from above sends most beams past the pyramid → misses,
        # so record_misses builds a session (the path that stores timestamps).
        from tests.test_lidar_scan import _PYRAMID_VERTS, _PYRAMID_TRIS, _scanner

        req = main.LidarScanRequest(
            meshes=[main.LidarScanMesh(vertices=_PYRAMID_VERTS, triangles=_PYRAMID_TRIS)],
            scanners=[main.LidarScanScanner(**_scanner("top"))],
            record_misses=True)
        res = main._do_lidar_scan(req)
        assert res["results"], res.get("error")
        sess_meta = res["results"][0].get("session")
        assert sess_meta is not None, "record_misses over the pyramid should create a session"
        sid = sess_meta["session_id"]
        try:
            with main._cloud_session_lock:
                sess = main._cloud_sessions[sid]
            # The columnar float64 read reached the dedicated field, aligned 1:1
            # with positions (hits + misses) at full double precision.
            assert sess.timestamps is not None, \
                "synthetic scan must populate float64 timestamps"
            assert sess.timestamps.dtype == np.float64
            assert sess.timestamps.shape[0] == sess.positions.shape[0]
            assert np.isfinite(sess.timestamps).any(), "some return must carry a time"
        finally:
            with main._cloud_session_lock:
                main._cloud_sessions.pop(sid, None)
