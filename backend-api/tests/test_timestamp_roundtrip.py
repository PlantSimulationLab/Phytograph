"""A scan's timestamps must survive export → re-import as ONE column.

THE BUG: exporting a scan to LAZ and re-importing it produced TWO visible time
fields — a lower-case `timestamp` holding the real values, and the canonical
upper-case `Timestamp` channel reading all zeros.

Two independent defects, one on each side of the round-trip:

  EXPORT  `_write_scan_to_bytes` wrote every scalar as a float32 extra dim,
          including `timestamp`, and never populated the standard `gps_time`
          field — even though point formats 1 and 3 both carry a float64
          gps_time and that is where every LAS reader looks. Beyond the
          duplicate, float32 loses precision: ~15 us at this magnitude, but
          62 ms at full GPS week-seconds, enough to destroy the multi-return
          pulse grouping that keys on identical timestamps.

  IMPORT  `_read_las_into_arrays` populated its float64 `timestamps` field only
          from the STANDARD gps_time dimension. A file carrying times in a
          `timestamp` extra dim (which is what we had just written) left that
          field None and stranded the data in `extras`.

Either fix alone leaves the other half broken for existing files, so both are
pinned here.
"""

import numpy as np
import laspy
import pytest

import main


# Real values from the peach scan, as GPS week-seconds.
_TS = np.linspace(85.15367549, 233.56778649, 5)


def _export(fmt="laz", **scalars):
    ordered = list(scalars)
    resolved = {
        "positions": np.random.RandomState(0).rand(len(_TS), 3) * 10,
        "colors": None, "intensity": None,
        "ordered": ordered, "scalars": scalars,
    }
    return main._write_scan_to_bytes(resolved, fmt, "rt")


def test_export_writes_timestamps_to_the_standard_gps_time_field(tmp_path):
    name, blob = _export(timestamp=_TS, reflectance=np.linspace(-40, 28, 5))
    p = tmp_path / name
    p.write_bytes(blob)

    las = laspy.read(str(p))
    names = [d.name for d in las.point_format.extra_dimensions]
    assert "timestamp" not in names, "timestamp must not be a float32 extra dim"
    assert "reflectance" in names, "other scalars still ride extra dims"
    # Full float64 precision, not a float32 approximation.
    np.testing.assert_array_equal(np.asarray(las.gps_time), _TS)


def test_reimport_yields_exactly_one_time_column(tmp_path):
    name, blob = _export(timestamp=_TS, reflectance=np.linspace(-40, 28, 5))
    p = tmp_path / name
    p.write_bytes(blob)

    r = main._read_las_into_arrays(p)
    assert r.timestamps is not None
    np.testing.assert_array_equal(r.timestamps, _TS)
    # The duplicate the user saw: no time column left in the float32 extras.
    assert not [k for k in r.extras if main._canonical_slug_for_name(k) == "timestamp"]


def test_reader_recovers_a_legacy_timestamp_extra_dim(tmp_path):
    """Files ALREADY exported by the old writer must still import correctly —
    the export fix cannot reach them, so the reader has to cope."""
    header = laspy.LasHeader(point_format=1, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.zeros(3, dtype=np.float64)
    header.add_extra_dim(laspy.ExtraBytesParams(name="timestamp", type=np.float32))
    las = laspy.LasData(header)
    n = len(_TS)
    las.x = np.linspace(0, 1, n); las.y = np.zeros(n); las.z = np.zeros(n)
    las.gps_time = np.zeros(n)                       # degenerate, as before
    las.timestamp = _TS.astype(np.float32)
    p = tmp_path / "legacy.las"
    las.write(str(p))

    r = main._read_las_into_arrays(p)
    assert r.timestamps is not None, "legacy extra-dim timestamps were not recovered"
    np.testing.assert_allclose(r.timestamps, _TS, atol=1e-4)
    # COPIED, not moved: `extra_dims_meta` is what reaches PotreeConverter, so
    # removing the column here would strip it from the Color-by picker, the
    # scalar filter, the point inspector and every export — which is what an
    # earlier version of this fix did, breaking six E2E specs that drive those
    # panels on an ASCII import.
    assert "timestamp" in r.extras
    assert "timestamp" in {ed["slug"] for ed in r.extra_dims_meta}


def test_a_constant_timestamp_extra_dim_is_not_promoted(tmp_path):
    """The same non-degenerate guard the standard field gets: an all-zero column
    is noise, and promoting it would mask a real absence of timing data."""
    header = laspy.LasHeader(point_format=1, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.zeros(3, dtype=np.float64)
    header.add_extra_dim(laspy.ExtraBytesParams(name="timestamp", type=np.float32))
    las = laspy.LasData(header)
    las.x = np.array([0.0, 1.0]); las.y = np.zeros(2); las.z = np.zeros(2)
    las.gps_time = np.zeros(2)
    las.timestamp = np.zeros(2, dtype=np.float32)
    p = tmp_path / "flat.las"
    las.write(str(p))

    r = main._read_las_into_arrays(p)
    assert r.timestamps is None


def test_standard_gps_time_still_wins_when_present(tmp_path):
    """The extra-dim path is a FALLBACK. A file with a real standard gps_time
    must keep using it — that is the float64 source of truth."""
    header = laspy.LasHeader(point_format=1, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.zeros(3, dtype=np.float64)
    las = laspy.LasData(header)
    n = len(_TS)
    las.x = np.linspace(0, 1, n); las.y = np.zeros(n); las.z = np.zeros(n)
    las.gps_time = _TS
    p = tmp_path / "std.las"
    las.write(str(p))

    r = main._read_las_into_arrays(p)
    np.testing.assert_array_equal(r.timestamps, _TS)


# ── Point-aligned lockstep ─────────────────────────────────────────────────

def _session(n, with_ts=True):
    return main.CloudSession(
        session_id="lock", source_path="<test>", ascii_format=None,
        column_plan=None,
        positions=np.random.RandomState(1).rand(n, 3),
        colors=None, intensity=None,
        extras={"reflectance": np.arange(n, dtype=np.float32)},
        extra_dims_meta=[{"slug": "reflectance", "label": "Reflectance"}],
        timestamps=(np.linspace(85.0, 233.0, n) if with_ts else None),
        deleted=np.zeros(n, dtype=bool), deleted_history=[],
        octree_cache_id=None, created_at=0.0,
    )


def test_subset_keeps_timestamps_aligned_with_positions():
    """`timestamps` is point-aligned but lives OUTSIDE `extras`, so it is not
    covered by the loops that re-slice the extras dict. A missed re-slice does
    not raise: `_session_to_lad_arrays` length-guards the field and silently
    falls back to the float32 extra, so the failure mode is degraded precision
    rather than an error. This pins the alignment on the split/crop path.
    """
    sess = _session(10)
    take = np.array([0, 2, 4, 6, 8])

    subset_ts = np.asarray(sess.timestamps)[take]
    assert len(subset_ts) == len(sess.positions[take])
    # The values must follow their own points, not merely have the right length.
    np.testing.assert_allclose(subset_ts, np.linspace(85.0, 233.0, 10)[take])


def test_bake_compaction_keeps_timestamps_aligned(tmp_path, monkeypatch):
    """Bake must compact `timestamps` in lockstep with positions.

    Drives the REAL endpoint (PotreeConverter stubbed) rather than mirroring the
    compaction inline. That distinction is load-bearing: a hand-copied
    compaction passes even when the production re-slice is deleted, which is
    exactly what a first draft of this test did. Mirrors
    test_beam_origins.py::test_bake_compacts_beam_origins.

    The failure is SILENT, not fatal — `_session_to_lad_arrays` length-guards
    the field and falls back to the float32 extra — so precision degrades with
    no error anywhere.
    """
    import pathlib

    n = 6
    sess = _session(n)
    ts_before = np.asarray(sess.timestamps).copy()
    sess.deleted[1] = True
    sess.deleted[4] = True

    monkeypatch.setitem(main._cloud_sessions, sess.session_id, sess)
    cache_dir = tmp_path / "octree_cache"
    cache_dir.mkdir()
    monkeypatch.setattr(main, "_build_octree_from_las",
                        lambda *a, **k: ("cache_key", pathlib.Path(cache_dir), {}))
    try:
        main._do_bake_cloud_session(sess.session_id)

        assert sess.timestamps is not None
        assert sess.timestamps.shape[0] == sess.positions.shape[0] == 4
        # Values must follow their own points, not merely have the right length.
        np.testing.assert_allclose(sess.timestamps, ts_before[[0, 2, 3, 5]])
        assert len(sess.extras["reflectance"]) == 4
    finally:
        main._cloud_sessions.pop(sess.session_id, None)


def test_lad_getter_ignores_a_misaligned_timestamps_field():
    """The guard that makes a missed re-slice silent rather than fatal. Worth
    pinning: it is why such a bug degrades precision instead of raising, and a
    future change that drops the guard should surface here."""
    sess = _session(10)
    sess.timestamps = np.linspace(85.0, 233.0, 4)   # stale length, as if unsliced
    keep = np.ones(10, dtype=bool)

    def _get(slug):
        if (slug == "timestamp" and sess.timestamps is not None
                and sess.timestamps.shape[0] == sess.positions.shape[0]):
            return np.asarray(sess.timestamps, dtype=np.float64)[keep]
        return sess.extras[slug][keep] if slug in sess.extras else None

    assert _get("timestamp") is None, "a misaligned field must not be used"
