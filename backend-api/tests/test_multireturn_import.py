"""Tests for preserving per-pulse multi-return LiDAR fields through the import
pipeline so the LAD path can feed them to PyHelios.

The three fields — timestamp, target_index, target_count — are carried as
session `extras` under canonical slugs. They must:
  - survive the ASCII import path (file -> _source_to_las -> _read_las_into_arrays),
  - survive the LAS import path (laspy native return_number/number_of_returns/
    gps_time auto-mapped to the canonical slugs),
  - compact in lockstep with positions across a delete + bake cycle, and
  - feed back out as in-RAM arrays (+ a per-hit data map) via _session_to_lad_arrays.

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


def test_categorical_override_of_multireturn_column_keeps_class_field():
    """A multi-return column the user explicitly marks categorical (the wizard's
    'Label' role) is a discrete class field BY INTENT — it must NOT be diverted
    into the LAD canonicalisation that lower-cases the slug and relabels it as a
    per-pulse field. It carries as a normal categorical extra-dim under a
    readable, sanitised slug ('Target_Index'), so the renderer colours it as
    classes and the colour-mode option matches.

    The non-categorical default still pins the canonical lower-case slug so the
    LAD accessor finds it — that path is unchanged.
    """
    def _plan(categorical):
        cols = [
            main.ColumnPlanEntry(index=0, role='x', slug=None, label=None, categorical=False),
            main.ColumnPlanEntry(index=1, role='y', slug=None, label=None, categorical=False),
            main.ColumnPlanEntry(index=2, role='z', slug=None, label=None, categorical=False),
            # The wizard sends the preview's lower-cased canonical slug verbatim.
            main.ColumnPlanEntry(index=3, role='extra', slug='target_index',
                                 label='Target Index', categorical=categorical),
        ]
        return main.ColumnPlan(columns=cols, rgb_is_255=True)

    # Categorical (Label) override -> readable slug, categorical preserved.
    _, extras = main._plan_columns_from_column_plan(_plan(categorical=True))
    ti = next(e for e in extras if e["label"] == "Target Index")
    assert ti["slug"] == "Target_Index"
    assert ti["categorical"] is True

    # Default (Scalar) -> canonical lower-case slug so the LAD path finds it.
    _, extras_def = main._plan_columns_from_column_plan(_plan(categorical=False))
    ti_def = next(e for e in extras_def if e["label"] == "Target Index")
    assert ti_def["slug"] == "target_index"
    assert ti_def["categorical"] is False


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


def test_las_degenerate_standard_dims_not_mapped(tmp_path):
    """return_number/number_of_returns/gps_time are STANDARD LAS dims present
    (all-zero) in every point-format-3 record. A plain cloud that never had
    per-pulse data must NOT get phantom multi-return slugs from those zeros —
    otherwise LAD flips to the full-waveform algorithm and gapfills garbage."""
    las_path = tmp_path / "plain.las"
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    las = laspy.LasData(header)
    las.x = np.array([0.1, 0.3, 0.5])
    las.y = np.array([0.2, 0.4, 0.6])
    las.z = np.array([1.0, 1.5, 0.5])
    # Leave return_number/number_of_returns/gps_time at their default zeros.
    las.write(str(las_path))

    _, _, _, extras, _ = main._read_las_into_arrays(las_path)
    for slug in main._MULTI_RETURN_SLUGS:
        assert slug not in extras, f"phantom {slug} mapped from all-zero standard dim"


def test_las_nonconstant_standard_dims_carried_as_scalars(tmp_path):
    """Standard LAS dims that hold real (non-constant) data — classification,
    point_source_id, scan_angle, … — are carried into the session as scalar
    fields so they reach the renderer's colour-by picker. The octree is rebuilt
    from these arrays, not the source file, so a dropped dim is gone for good."""
    las_path = tmp_path / "rich.las"
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    las = laspy.LasData(header)
    las.x = np.array([0.1, 0.3, 0.5, 0.7])
    las.y = np.array([0.2, 0.4, 0.6, 0.8])
    las.z = np.array([1.0, 1.5, 0.5, 0.9])
    las.classification = np.array([2, 5, 5, 2], dtype=np.uint8)      # non-constant
    las.point_source_id = np.array([10, 10, 11, 12], dtype=np.uint16)  # non-constant
    las.user_data = np.array([0, 0, 0, 0], dtype=np.uint8)           # constant → skip
    las.write(str(las_path))

    _, _, _, extras, extra_dims_meta = main._read_las_into_arrays(las_path)

    # Carried under a 'las_'-prefixed slug (the bare name would collide with the
    # reserved LAS standard schema when _session_to_las rebuilds the octree LAS).
    assert "las_classification" in extras, "non-constant classification was dropped"
    assert "las_point_source_id" in extras, "non-constant point_source_id was dropped"
    np.testing.assert_allclose(extras["las_classification"], [2, 5, 5, 2])
    np.testing.assert_allclose(extras["las_point_source_id"], [10, 10, 11, 12])
    # Constant standard dims stay out of the picker (noise, not signal).
    assert "las_user_data" not in extras, "all-zero user_data should not be carried"
    # x/y/z handled as positions, never duplicated as a scalar.
    for skipped in ("X", "Y", "Z", "intensity", "las_X", "las_intensity"):
        assert skipped not in extras
    # The label is the clean LAS name; the slug carries the prefix.
    meta_by_slug = {ed["slug"]: ed["label"] for ed in extra_dims_meta}
    assert meta_by_slug.get("las_classification") == "classification"
    assert meta_by_slug.get("las_point_source_id") == "point_source_id"


def test_carried_standard_dims_survive_session_to_las(tmp_path):
    """The carried standard dims must round-trip through `_session_to_las` (which
    re-adds every extra-dim slug to the rebuilt octree LAS). This is why the slug
    is prefixed: an extra dim named 'classification' collides with the reserved
    LAS standard schema and hard-crashes laspy's bit-packer. Regression guard —
    a unit test that only checks `_read_las_into_arrays` would miss the crash."""
    src = tmp_path / "rich.las"
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    las = laspy.LasData(header)
    las.x = np.array([0.1, 0.3, 0.5, 0.7])
    las.y = np.array([0.2, 0.4, 0.6, 0.8])
    las.z = np.array([1.0, 1.5, 0.5, 0.9])
    las.classification = np.array([2, 5, 5, 2], dtype=np.uint8)
    las.point_source_id = np.array([10, 10, 11, 12], dtype=np.uint16)
    las.write(str(src))

    positions, colors, intensity, extras, extra_dims_meta = main._read_las_into_arrays(src)
    sess = _session_from_arrays(positions, colors, intensity, extras, extra_dims_meta)

    out = tmp_path / "rebuilt.las"
    n = main._session_to_las(sess, out)
    assert n == 4

    back = laspy.read(str(out))
    back_dims = {d.name for d in back.point_format.extra_dimensions}
    assert {"las_classification", "las_point_source_id"} <= back_dims
    np.testing.assert_allclose(np.asarray(back["las_classification"]), [2, 5, 5, 2])
    np.testing.assert_allclose(np.asarray(back["las_point_source_id"]), [10, 10, 11, 12])


# ---------------------------------------------------------------------------
# LAD in-RAM array accessor (feeds Helios via addHitPointsWithData — no ASCII)
# ---------------------------------------------------------------------------

def test_session_to_lad_arrays_emits_multireturn_columns(tmp_path):
    f = tmp_path / "scan.xyz"
    _write_multireturn_xyz(f)
    sess = _session_from_xyz(f, tmp_path)

    xyz, dirs, labels, vals, flags = main._session_to_lad_arrays(sess, [0, 0, 5])

    assert flags["multi"] is True
    assert flags["has_timestamp"] is True
    assert labels == ["timestamp", "target_index", "target_count"]
    assert xyz.shape == (len(_MULTI_ROWS), 3)
    assert dirs.shape == (len(_MULTI_ROWS), 3)
    assert vals.shape == (len(_MULTI_ROWS), 3)
    # The 3-return pulse is present in target_count (last label).
    assert vals[:, 2].max() == pytest.approx(3.0)
    # x/y/z round-trip from the session positions.
    np.testing.assert_allclose(xyz[:, 0], [r[0] for r in _MULTI_ROWS], atol=1e-5)


def test_session_to_lad_arrays_degrades_to_xyz_only(tmp_path):
    """A positions-only session (no multi-return extras) yields no data map."""
    positions = np.array([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]], dtype=np.float64)
    sess = _session_from_arrays(positions, None, None, {}, [])

    xyz, dirs, labels, vals, flags = main._session_to_lad_arrays(sess, [0, 0, 5])

    assert flags["multi"] is False
    assert flags["has_timestamp"] is False
    assert flags["has_misses"] is False
    assert labels == []
    assert vals is None
    assert xyz.shape == (2, 3)


def test_session_to_lad_arrays_honors_deletions(tmp_path):
    """Only surviving (non-deleted) points are emitted."""
    f = tmp_path / "scan.xyz"
    _write_multireturn_xyz(f)
    sess = _session_from_xyz(f, tmp_path)
    sess.deleted = sess.positions[:, 2] < 0.6  # drop the last row

    xyz, dirs, labels, vals, flags = main._session_to_lad_arrays(sess, [0, 0, 5])
    assert flags["multi"] is True
    survivors = int((~sess.deleted).sum())
    assert xyz.shape[0] == survivors
    assert vals.shape[0] == survivors


def test_session_to_lad_arrays_reports_existing_misses(tmp_path):
    """A session carrying is_miss=1 points reports has_misses and includes the
    is_miss column in the LAD data map (so the inversion sees real misses and
    skips gapfilling)."""
    positions = np.array(
        [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [9.0, 9.0, 9.0]], dtype=np.float64)
    extras = {
        "timestamp": np.array([1.0, 2.0, 3.0], dtype=np.float32),
        "is_miss": np.array([0.0, 0.0, 1.0], dtype=np.float32),
    }
    meta = [{"slug": "timestamp", "label": "Timestamp"},
            {"slug": "is_miss", "label": "Miss"}]
    sess = _session_from_arrays(positions, None, None, extras, meta)

    xyz, dirs, labels, vals, flags = main._session_to_lad_arrays(sess, [0, 0, 5])
    assert flags["has_misses"] is True
    assert flags["has_timestamp"] is True
    assert "is_miss" in labels
    # The miss column carries the per-point flag aligned to xyz.
    miss_col = vals[:, labels.index("is_miss")]
    assert miss_col.tolist() == [0.0, 0.0, 1.0]


def test_session_to_lad_arrays_forwards_is_miss_even_with_no_misses(tmp_path):
    """When a cloud carries an is_miss column but NOTHING is currently flagged a
    miss, the column is STILL forwarded (every return tagged 0.0). The C++
    calculateLeafArea fail-fast check reads is_miss per hit, so returns must be
    explicitly 0.0 rather than relying on the label being absent. has_misses is
    False (so gapfill still runs if a timestamp is present)."""
    positions = np.array([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]], dtype=np.float64)
    extras = {"is_miss": np.array([0.0, 0.0], dtype=np.float32)}
    meta = [{"slug": "is_miss", "label": "Miss"}]
    sess = _session_from_arrays(positions, None, None, extras, meta)

    xyz, dirs, labels, vals, flags = main._session_to_lad_arrays(sess, [0, 0, 5])
    assert "is_miss" in labels                 # forwarded despite no misses
    assert flags["has_misses"] is False        # ...but nothing is flagged
    assert vals[:, labels.index("is_miss")].tolist() == [0.0, 0.0]


def test_session_to_lad_arrays_no_is_miss_column_not_synthesised(tmp_path):
    """A plain cloud with no is_miss column does NOT get one synthesised — those
    clouds recover misses via gapfillMisses() (which sets the flag C++-side)."""
    positions = np.array([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]], dtype=np.float64)
    sess = _session_from_arrays(positions, None, None, {}, [])

    xyz, dirs, labels, vals, flags = main._session_to_lad_arrays(sess, [0, 0, 5])
    assert "is_miss" not in labels
    assert flags["has_misses"] is False
