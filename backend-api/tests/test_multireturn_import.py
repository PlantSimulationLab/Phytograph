"""Tests for preserving per-pulse multi-return LiDAR fields through the import
pipeline so the LAD path can feed them to PyHelios.

The three fields — timestamp, target_index, target_count — are carried as
session `extras` under canonical slugs. They must:
  - survive the ASCII import path (file -> _source_to_las -> _read_las_into_arrays),
  - survive the LAS import path (laspy native return_number/number_of_returns/
    gps_time auto-mapped to the canonical slugs),
  - compact in lockstep with positions across a delete + bake cycle, and
  - dump back out as a Helios-ready ASCII file via _session_to_lad_ascii.

None of these need PotreeConverter — they exercise the in-RAM IO helpers
directly, building a CloudSession without an octree.
"""

import time
from pathlib import Path

import numpy as np
import pytest

import main

laspy = pytest.importorskip("laspy")


# A 5-row multi-return fixture: two pulses. Pulse @ t=1.0 has a single return
# (target_count 1); pulse @ t=2.0 has THREE returns (target_count 3, indices
# 0/1/2). Columns: x y z timestamp target_index target_count.
_MULTI_ROWS = [
    # x     y     z     ts   ti  tc
    (0.10, 0.20, 1.00, 1.0, 0, 1),
    (0.30, 0.40, 1.50, 2.0, 0, 3),
    (0.31, 0.41, 1.20, 2.0, 1, 3),
    (0.32, 0.42, 0.90, 2.0, 2, 3),
    (0.50, 0.60, 0.50, 3.0, 0, 1),
]
_MULTI_FORMAT = "x y z timestamp target_index target_count"


def _write_multireturn_xyz(path: Path) -> None:
    lines = [" ".join(str(v) for v in row) for row in _MULTI_ROWS]
    path.write_text("\n".join(lines) + "\n")


def _session_from_arrays(positions, colors, intensity, extras, extra_dims_meta):
    """Build a CloudSession directly from in-RAM arrays (no octree)."""
    n = len(positions)
    return main.CloudSession(
        session_id="testsess",
        source_path="<test>",
        ascii_format=_MULTI_FORMAT,
        column_plan=None,
        positions=positions,
        colors=colors,
        intensity=intensity,
        extras=extras,
        extra_dims_meta=extra_dims_meta,
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
    )


def _session_from_xyz(xyz_path: Path, tmp_path: Path):
    """Run the real session-create IO path: source -> LAS -> in-RAM arrays."""
    las_path, is_temp, source_extra_dims = main._source_to_las(
        xyz_path, _MULTI_FORMAT, tmp_path, None,
    )
    positions, colors, intensity, extras, extra_dims_meta = main._read_las_into_arrays(las_path)
    return _session_from_arrays(positions, colors, intensity, extras, extra_dims_meta)


# ---------------------------------------------------------------------------
# Column planning
# ---------------------------------------------------------------------------

def test_column_plan_pins_canonical_multireturn_slugs(tmp_path):
    """An explicit ascii_format with the three multi-return tokens carries them
    as extras under their canonical slug (not a header-derived name)."""
    f = tmp_path / "mr.xyz"
    _write_multireturn_xyz(f)
    names, extras = main._xyz_column_plan(f, _MULTI_FORMAT, None)
    assert names[:3] == ["x", "y", "z"]
    slugs = {e["slug"] for e in extras}
    assert {"timestamp", "target_index", "target_count"} <= slugs
    labels = {e["slug"]: e["label"] for e in extras}
    assert labels["timestamp"] == "Timestamp"
    assert labels["target_index"] == "Target Index"
    assert labels["target_count"] == "Target Count"


def test_header_named_multireturn_columns_round_trip(tmp_path):
    """Auto-detect (no ascii_format): a header naming the columns maps to the
    canonical slugs, including the common LAS aliases."""
    f = tmp_path / "hdr.xyz"
    f.write_text(
        "X Y Z GpsTime ReturnNumber NumberOfReturns\n"
        "0 0 0 1.0 1 1\n"
        "1 1 1 2.0 1 2\n"
    )
    names, extras = main._xyz_column_plan(f, None, None)
    assert names[:3] == ["x", "y", "z"]
    slugs = {e["slug"] for e in extras}
    assert {"timestamp", "target_index", "target_count"} <= slugs


# ---------------------------------------------------------------------------
# ASCII import round-trip
# ---------------------------------------------------------------------------

def test_ascii_import_preserves_multireturn_extras(tmp_path):
    f = tmp_path / "scan.xyz"
    _write_multireturn_xyz(f)
    sess = _session_from_xyz(f, tmp_path)

    assert len(sess.positions) == len(_MULTI_ROWS)
    for slug in main._MULTI_RETURN_SLUGS:
        assert slug in sess.extras, f"missing extra {slug}"
        assert len(sess.extras[slug]) == len(_MULTI_ROWS)

    # The 3-return pulse survived: at least one point reports target_count > 1.
    assert sess.extras["target_count"].max() > 1
    # target_index spans 0..2 for that pulse.
    assert sess.extras["target_index"].max() == pytest.approx(2.0)


# ---------------------------------------------------------------------------
# Delete + bake compaction
# ---------------------------------------------------------------------------

def test_multireturn_extras_survive_delete_and_bake(tmp_path):
    f = tmp_path / "scan.xyz"
    _write_multireturn_xyz(f)
    sess = _session_from_xyz(f, tmp_path)

    # Delete the single-return point at t=3.0 (row index 4, z=0.5).
    z = sess.positions[:, 2]
    sess.deleted = z < 0.6  # deletes the last row (z=0.5)
    deleted_count = int(sess.deleted.sum())
    assert deleted_count >= 1

    # Replicate the bake compaction the endpoint performs on the in-RAM arrays.
    keep = ~sess.deleted
    expected_remaining = int(keep.sum())
    sess.positions = sess.positions[keep]
    for slug in list(sess.extras.keys()):
        sess.extras[slug] = sess.extras[slug][keep]
    sess.deleted = np.zeros(len(sess.positions), dtype=bool)

    assert len(sess.positions) == expected_remaining
    for slug in main._MULTI_RETURN_SLUGS:
        assert len(sess.extras[slug]) == expected_remaining
    # The multi-return pulse is untouched by the delete.
    assert sess.extras["target_count"].max() > 1


# ---------------------------------------------------------------------------
# LAS native auto-map
# ---------------------------------------------------------------------------

def test_las_native_multireturn_dims_auto_mapped(tmp_path):
    """A LAS with return_number/number_of_returns/gps_time set is read into the
    session under the canonical multi-return slugs, verbatim (no base shift)."""
    las_path = tmp_path / "native.las"
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    las = laspy.LasData(header)
    las.x = np.array([0.1, 0.3, 0.31, 0.32, 0.5])
    las.y = np.array([0.2, 0.4, 0.41, 0.42, 0.6])
    las.z = np.array([1.0, 1.5, 1.2, 0.9, 0.5])
    las.gps_time = np.array([1.0, 2.0, 2.0, 2.0, 3.0])
    las.return_number = np.array([1, 1, 2, 3, 1], dtype=np.uint8)
    las.number_of_returns = np.array([1, 3, 3, 3, 1], dtype=np.uint8)
    las.write(str(las_path))

    positions, colors, intensity, extras, extra_dims_meta = main._read_las_into_arrays(las_path)

    for slug in main._MULTI_RETURN_SLUGS:
        assert slug in extras, f"missing {slug}"
    # return_number carried verbatim as target_index (1-based here).
    np.testing.assert_allclose(extras["target_index"], [1, 1, 2, 3, 1])
    np.testing.assert_allclose(extras["target_count"], [1, 3, 3, 3, 1])
    np.testing.assert_allclose(extras["timestamp"], [1.0, 2.0, 2.0, 2.0, 3.0])
    slugs = {ed["slug"] for ed in extra_dims_meta}
    assert {"timestamp", "target_index", "target_count"} <= slugs


# ---------------------------------------------------------------------------
# LAD ASCII accessor
# ---------------------------------------------------------------------------

def test_session_to_lad_ascii_emits_multireturn_columns(tmp_path):
    f = tmp_path / "scan.xyz"
    _write_multireturn_xyz(f)
    sess = _session_from_xyz(f, tmp_path)

    out = tmp_path / "lad.txt"
    ascii_format, is_multi = main._session_to_lad_ascii(sess, out)

    assert is_multi is True
    assert ascii_format == "x y z timestamp target_index target_count"

    parsed = np.loadtxt(str(out))
    assert parsed.shape == (len(_MULTI_ROWS), 6)
    # Column order matches the format string; the 3-return pulse is present.
    assert parsed[:, 5].max() == pytest.approx(3.0)
    # x/y/z round-trip.
    np.testing.assert_allclose(parsed[:, 0], [r[0] for r in _MULTI_ROWS], atol=1e-5)


def test_session_to_lad_ascii_degrades_to_xyz_only(tmp_path):
    """A positions-only session (no multi-return extras) yields 'x y z'."""
    positions = np.array([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]], dtype=np.float64)
    sess = _session_from_arrays(positions, None, None, {}, [])

    out = tmp_path / "lad.txt"
    ascii_format, is_multi = main._session_to_lad_ascii(sess, out)

    assert is_multi is False
    assert ascii_format == "x y z"
    parsed = np.loadtxt(str(out))
    assert parsed.shape == (2, 3)


def test_session_to_lad_ascii_honors_deletions(tmp_path):
    """Only surviving (non-deleted) points are written."""
    f = tmp_path / "scan.xyz"
    _write_multireturn_xyz(f)
    sess = _session_from_xyz(f, tmp_path)
    sess.deleted = sess.positions[:, 2] < 0.6  # drop the last row

    out = tmp_path / "lad.txt"
    _, is_multi = main._session_to_lad_ascii(sess, out)
    parsed = np.loadtxt(str(out))
    assert is_multi is True
    assert parsed.shape[0] == int((~sess.deleted).sum())
