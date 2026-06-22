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
