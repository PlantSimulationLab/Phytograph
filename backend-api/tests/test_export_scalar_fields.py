"""Scalar fields must survive a point-cloud export, in every format.

The bug these guard: an export wrote geometry and (sometimes) colour, and
silently dropped every other field the user imported.

* `_read_points_from_source` returned a 3-tuple by signature — positions,
  colours, intensity — so no caller could reach the session's `extras` at all.
* The text writers hardcoded X/Y/Z + optional R/G/B + optional Intensity, and
  ignored the ordered column list the export modal's picker had collected.
* The LAS writer chose point format `2 if has_colors else 0`. Neither format has
  an intensity dimension, and neither carries extra dimensions, so reflectance /
  class labels / target_index / is_miss were absent from the file rather than
  merely blank.

The user-visible symptom was an export dialog that offered only x/y/z columns
for a normally-imported cloud, and LAS/LAZ files that quietly lost data.
"""
import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json


@pytest.fixture
def scalar_cloud(tmp_path):
    """A 5-point ASCII cloud on disk. Positions only — the scalars are attached
    to the SESSION (below), which is where a real import keeps them."""
    pts = np.array(
        [[0.0, 0.0, 0.0], [1.0, 2.0, 3.0], [-4.5, 5.5, 6.25],
         [7.0, -8.0, 9.5], [2.5, 2.5, 2.5]],
        dtype=float,
    )
    p = tmp_path / "cloud.xyz"
    with open(p, "w") as f:
        f.write("# x y z\n")
        np.savetxt(f, pts, fmt="%.6f")
    return p


# The scalars a real scan carries: a continuous one, an integer class label, and
# the miss flag. Distinct values per point so a mis-ordered or truncated column
# is detectable rather than coincidentally right.
REFLECTANCE = np.array([0.5, 1.5, 2.5, 3.5, 4.5], dtype=np.float32)
GROUND_CLASS = np.array([2, 2, 5, 5, 1], dtype=np.float32)


@pytest.fixture
def scalar_session(make_file_session, scalar_cloud):
    sid = make_file_session(scalar_cloud, "x y z", extras={
        "reflectance": REFLECTANCE.copy(),
        "ground_class": GROUND_CLASS.copy(),
    })
    # `extra_dims_meta` is what fixes column ORDER for the export (dict order is
    # not a contract), so populate it as a real import does.
    with main._cloud_session_lock:
        main._cloud_sessions[sid].extra_dims_meta = [
            {"slug": "reflectance", "label": "Reflectance"},
            {"slug": "ground_class", "label": "Ground class"},
        ]
    return sid


def _export(client, session_id, fmt, dest, columns=None):
    body = {"source": {"session_id": session_id}, "format": fmt, "dest_path": str(dest)}
    if columns is not None:
        body["columns"] = columns
    resp = client.post("/api/pointcloud/export", json=body)
    assert resp.status_code == 200, resp.text
    out = decode_streamed_json(resp.content)
    assert out["success"] is True, out.get("error")
    return out


# --- the read chokepoint -----------------------------------------------------

def test_read_points_and_extras_surfaces_scalars_only_when_asked(scalar_session):
    """`want_extras` gates the copy: compute consumers pay nothing, export opts in."""
    off = main._read_points_and_extras(
        main.PointSource(session_id=scalar_session, include_misses=True))
    assert off[3] == {}, "extras must not be copied unless requested"

    _, _, _, extras = main._read_points_and_extras(
        main.PointSource(session_id=scalar_session, want_extras=True, include_misses=True))
    assert set(extras) == {"reflectance", "ground_class"}
    np.testing.assert_allclose(extras["reflectance"], REFLECTANCE)
    np.testing.assert_allclose(extras["ground_class"], GROUND_CLASS)


def test_extras_are_filtered_in_lockstep_with_positions(scalar_session):
    """A deleted point must drop out of every scalar column at the same index.

    This is the property that makes scalars trustworthy: a column that keeps its
    original length after positions were filtered doesn't just carry a stale
    value, it shifts every label past the deletion onto the wrong point.
    """
    with main._cloud_session_lock:
        main._cloud_sessions[scalar_session].deleted[1] = True  # drop [1,2,3]

    pos, _, _, extras = main._read_points_and_extras(
        main.PointSource(session_id=scalar_session, want_extras=True, include_misses=True))

    assert len(pos) == 4
    for slug, col in extras.items():
        assert col.shape == (4,), f"{slug} desynced from positions"
    # Index 1 is gone from the scalars too — not merely shorter at the tail.
    np.testing.assert_allclose(extras["reflectance"], [0.5, 2.5, 3.5, 4.5])
    np.testing.assert_allclose(extras["ground_class"], [2, 5, 5, 1])


def test_read_points_from_source_keeps_its_three_tuple(scalar_session):
    """The 3-tuple facade stays intact — 13 compute call sites unpack it."""
    result = main._read_points_from_source(
        main.PointSource(session_id=scalar_session, want_colors=True))
    assert len(result) == 3


# --- text formats ------------------------------------------------------------

def test_csv_export_writes_selected_scalar_columns(client, scalar_session, tmp_path):
    """The picker's slug list becomes the file's columns, in the chosen order."""
    dest = tmp_path / "out.csv"
    _export(client, scalar_session, "csv", dest,
            columns=["x", "y", "z", "ground_class", "reflectance"])

    lines = dest.read_text().splitlines()
    assert lines[0] == "X,Y,Z,ground_class,reflectance"
    assert len(lines) == 6  # header + 5 points

    first = lines[1].split(",")
    assert [float(v) for v in first[:3]] == pytest.approx([0.0, 0.0, 0.0])
    # Integer-valued scalars print as ints, not 2.000000.
    assert first[3] == "2"
    assert float(first[4]) == pytest.approx(0.5)

    # Column ORDER is honored, so the last row's two scalars are (class, refl).
    last = lines[-1].split(",")
    assert last[3] == "1"
    assert float(last[4]) == pytest.approx(4.5)


def test_column_order_is_the_users_order(client, scalar_session, tmp_path):
    """Reordering the picker reorders the file — the columns aren't just sorted."""
    dest = tmp_path / "reordered.csv"
    _export(client, scalar_session, "csv", dest,
            columns=["reflectance", "z", "y", "x", "ground_class"])

    lines = dest.read_text().splitlines()
    assert lines[0] == "reflectance,Z,Y,X,ground_class"
    row = lines[2].split(",")  # point [1,2,3], reflectance 1.5, class 2
    assert float(row[0]) == pytest.approx(1.5)
    assert [float(v) for v in row[1:4]] == pytest.approx([3.0, 2.0, 1.0])
    assert row[4] == "2"


def test_deselected_scalar_is_omitted(client, scalar_session, tmp_path):
    """Unchecking a column must actually remove it, not blank it."""
    dest = tmp_path / "subset.txt"
    _export(client, scalar_session, "txt", dest, columns=["x", "y", "z", "reflectance"])

    lines = dest.read_text().splitlines()
    # Scalars keep their SLUG verbatim as the header (only the fixed geometry /
    # colour / intensity slugs get a pretty name), so a re-import matches columns
    # by the same token the picker showed.
    assert lines[0] == "X Y Z reflectance"
    assert "ground_class" not in dest.read_text()
    assert len(lines[1].split()) == 4


def test_xyz_export_carries_scalars_as_extra_columns(client, scalar_session, tmp_path):
    """Bare XYZ has no header, but the selected scalars still ride as columns —
    the same whitespace convention the importer's ASCII_format reads back."""
    dest = tmp_path / "out.xyz"
    _export(client, scalar_session, "xyz", dest, columns=["x", "y", "z", "reflectance"])

    lines = [l for l in dest.read_text().splitlines() if l.strip()]
    assert len(lines) == 5
    for line in lines:
        assert len(line.split()) == 4
    assert float(lines[0].split()[3]) == pytest.approx(0.5)


def test_ply_declares_selected_scalars_as_properties(client, scalar_session, tmp_path):
    """PLY's header must declare each scalar it writes, or the file is unreadable."""
    dest = tmp_path / "out.ply"
    _export(client, scalar_session, "ply", dest, columns=["x", "y", "z", "reflectance"])

    text = dest.read_text()
    header = text.split("end_header")[0].splitlines()
    assert "property float x" in header
    assert "property float reflectance" in header
    assert f"element vertex 5" in header
    body = text.split("end_header\n")[1].splitlines()
    assert len(body) == 5
    assert len(body[0].split()) == 4


def test_no_columns_requested_keeps_the_legacy_layout(client, scalar_session, tmp_path):
    """Omitting `columns` must produce exactly the pre-change output, so older
    callers and the flat-cloud path are unaffected."""
    dest = tmp_path / "legacy.csv"
    _export(client, scalar_session, "csv", dest)

    lines = dest.read_text().splitlines()
    assert lines[0] == "X,Y,Z"
    assert len(lines[1].split(",")) == 3


def test_unknown_slug_is_dropped_not_written_as_zeros(client, scalar_session, tmp_path):
    """The picker is built from octree metadata, which can name a scalar the
    session no longer holds. A zero column would read as real data."""
    dest = tmp_path / "ghost.csv"
    _export(client, scalar_session, "csv", dest,
            columns=["x", "y", "z", "not_a_real_field", "reflectance"])

    lines = dest.read_text().splitlines()
    assert lines[0] == "X,Y,Z,reflectance"
    assert len(lines[1].split(",")) == 4


def test_obj_ignores_columns(client, scalar_session, tmp_path):
    """An OBJ `v` line takes exactly x/y/z; a scalar selection cannot apply."""
    dest = tmp_path / "out.obj"
    _export(client, scalar_session, "obj", dest, columns=["x", "y", "z", "reflectance"])

    body = [l for l in dest.read_text().splitlines() if l.startswith("v ")]
    assert len(body) == 5
    assert len(body[0].split()) == 4  # 'v' + 3 coords


# --- LAS / LAZ ---------------------------------------------------------------

@pytest.mark.parametrize("fmt", ["las", "laz"])
def test_las_writes_scalars_as_extra_dimensions(client, scalar_session, tmp_path, fmt):
    """LAS/LAZ carry every scalar as a named extra dimension.

    The format has a fixed schema, so there is no column picker for it — which is
    exactly why it must write everything rather than silently narrowing to xyz.
    """
    laspy = pytest.importorskip("laspy")
    dest = tmp_path / f"out.{fmt}"
    _export(client, scalar_session, fmt, dest)

    las = laspy.read(str(dest))
    assert len(las.points) == 5

    dims = set(las.point_format.dimension_names)
    assert "reflectance" in dims, f"scalar lost; got {sorted(dims)}"
    assert "ground_class" in dims

    np.testing.assert_allclose(np.asarray(las["reflectance"]), REFLECTANCE, atol=1e-6)
    np.testing.assert_allclose(np.asarray(las["ground_class"]), GROUND_CLASS, atol=1e-6)
    # And the geometry is still right (offset/scale round-trip).
    np.testing.assert_allclose(las.x[0], 0.0, atol=1e-3)
    np.testing.assert_allclose(las.y[3], -8.0, atol=1e-3)


def test_las_point_format_matches_the_importer(client, scalar_session, tmp_path):
    """Export must pick the same point format the importer writes.

    `_xyz_to_las` uses 3-with-colour / 1-without; those two carry GPS time (a
    scan's per-point timestamp needs it) where 0/2 do not. Worth pinning because
    it is otherwise invisible: `intensity` lives in the core point record of
    EVERY format and laspy accepts extra dimensions on any of them, so a wrong
    format here loses only GPS time and nothing in this file's other assertions
    would notice.
    """
    laspy = pytest.importorskip("laspy")
    dest = tmp_path / "fmt.las"
    _export(client, scalar_session, "las", dest)
    las = laspy.read(str(dest))
    # No colour in this fixture -> format 1.
    assert las.point_format.id == 1, f"expected format 1, got {las.point_format.id}"
    assert "gps_time" in set(las.point_format.dimension_names)


def test_las_point_format_carries_intensity(client, make_file_session, tmp_path):
    """Intensity must reach the file's standard dimension with its value intact."""
    laspy = pytest.importorskip("laspy")
    pts = np.array([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [2.0, 2.0, 2.0]])
    src = tmp_path / "i.txt"
    with open(src, "w") as f:
        f.write("# x y z intensity\n")
        for (x, y, z), i in zip(pts, [0.25, 0.5, 0.75]):
            f.write(f"{x} {y} {z} {i}\n")

    sid = make_file_session(src, "x y z intensity")
    dest = tmp_path / "i.las"
    _export(client, sid, "las", dest)

    las = laspy.read(str(dest))
    assert "intensity" in set(las.point_format.dimension_names)
    # Session stores intensity at uint16 scale; export scales 0-1 back up.
    np.testing.assert_allclose(
        np.asarray(las.intensity) / 65535.0, [0.25, 0.5, 0.75], atol=1e-3)


# --- LAS column selection ----------------------------------------------------
#
# LAS extra dimensions are an explicitly declared list, so writing a SUBSET is
# exactly as valid as writing all of them. The endpoint used to ignore `columns`
# for LAS/LAZ on the premise that a "fixed schema" left nothing to choose — true
# only of the STANDARD dimensions. These pin the real contract: scalars are
# freely omittable, RGB is omittable via the point format, and intensity is not
# omittable at all (it is in the core record of every format).

@pytest.mark.parametrize("fmt", ["las", "laz"])
def test_las_honors_a_scalar_column_selection(client, scalar_session, tmp_path, fmt):
    """A deselected scalar must be ABSENT from the file, not zeroed."""
    laspy = pytest.importorskip("laspy")
    dest = tmp_path / f"subset.{fmt}"
    _export(client, scalar_session, fmt, dest, columns=["x", "y", "z", "reflectance"])

    las = laspy.read(str(dest))
    dims = set(las.point_format.dimension_names)
    assert "reflectance" in dims
    assert "ground_class" not in dims, "deselected scalar was still declared"
    # The kept one still carries its real values.
    np.testing.assert_allclose(np.asarray(las["reflectance"]), REFLECTANCE, atol=1e-6)
    assert len(las.points) == 5


def test_las_deselecting_every_scalar_writes_none(client, scalar_session, tmp_path):
    laspy = pytest.importorskip("laspy")
    dest = tmp_path / "bare.las"
    _export(client, scalar_session, "las", dest, columns=["x", "y", "z"])

    las = laspy.read(str(dest))
    dims = set(las.point_format.dimension_names)
    assert "reflectance" not in dims
    assert "ground_class" not in dims
    # Geometry is intact — this is a valid LAS, just without the extras.
    assert len(las.points) == 5
    np.testing.assert_allclose(las.x[0], 0.0, atol=1e-3)


def test_las_omitting_rgb_drops_the_colour_dimensions(client, make_file_session, tmp_path):
    """Deselecting r/g/b picks point format 1, which has no RGB dimension.

    This is the one standard dimension that IS omittable — but only as a bundle:
    the point format menu couples RGB with GPS time, so dropping RGB drops both.
    """
    laspy = pytest.importorskip("laspy")
    src = tmp_path / "rgb.txt"
    with open(src, "w") as f:
        f.write("# x y z r g b\n")
        f.write("0 0 0 255 0 0\n1 1 1 0 255 0\n2 2 2 0 0 255\n")
    sid = make_file_session(src, "x y z r g b")

    with_rgb = tmp_path / "with.las"
    _export(client, sid, "las", with_rgb, columns=["x", "y", "z", "r", "g", "b"])
    las = laspy.read(str(with_rgb))
    assert "red" in set(las.point_format.dimension_names)
    assert las.point_format.id == 3

    without = tmp_path / "without.las"
    _export(client, sid, "las", without, columns=["x", "y", "z"])
    las2 = laspy.read(str(without))
    assert "red" not in set(las2.point_format.dimension_names)
    assert las2.point_format.id == 1
    # Geometry unaffected by dropping colour.
    np.testing.assert_allclose(las2.x, [0, 1, 2], atol=1e-3)


def test_las_response_reports_the_colour_actually_written(client, make_file_session, tmp_path):
    """has_colors must describe the FILE, not the cloud — the renderer's toast
    and any caller branching on it would otherwise be wrong."""
    src = tmp_path / "rgb2.txt"
    with open(src, "w") as f:
        f.write("# x y z r g b\n0 0 0 255 0 0\n1 1 1 0 255 0\n")
    sid = make_file_session(src, "x y z r g b")

    out = _export(client, sid, "las", tmp_path / "a.las",
                  columns=["x", "y", "z", "r", "g", "b"])
    assert out["has_colors"] is True

    out2 = _export(client, sid, "las", tmp_path / "b.las", columns=["x", "y", "z"])
    assert out2["has_colors"] is False


def test_las_no_columns_still_writes_everything(client, scalar_session, tmp_path):
    """The default export stays lossless — selection is opt-in."""
    laspy = pytest.importorskip("laspy")
    dest = tmp_path / "all.las"
    _export(client, scalar_session, "las", dest)

    dims = set(laspy.read(str(dest)).point_format.dimension_names)
    assert "reflectance" in dims
    assert "ground_class" in dims


def test_las_intensity_cannot_be_omitted_only_zeroed(client, make_file_session, tmp_path):
    """Intensity is in the core point record of EVERY LAS format, so deselecting
    it leaves a zeroed dimension rather than removing it.

    Pinned because it is the one case where the UI must explain a limit instead
    of offering a checkbox: a control that silently meant "write zeros" would be
    worse than saying the field is always present.
    """
    laspy = pytest.importorskip("laspy")
    src = tmp_path / "i2.txt"
    with open(src, "w") as f:
        f.write("# x y z intensity\n0 0 0 0.25\n1 1 1 0.5\n")
    sid = make_file_session(src, "x y z intensity")

    kept = tmp_path / "kept.las"
    _export(client, sid, "las", kept, columns=["x", "y", "z", "intensity"])
    las = laspy.read(str(kept))
    np.testing.assert_allclose(
        np.asarray(las.intensity) / 65535.0, [0.25, 0.5], atol=1e-3)

    dropped = tmp_path / "dropped.las"
    _export(client, sid, "las", dropped, columns=["x", "y", "z"])
    las2 = laspy.read(str(dropped))
    # The dimension still EXISTS (it cannot be removed) but carries no data.
    assert "intensity" in set(las2.point_format.dimension_names)
    assert np.all(np.asarray(las2.intensity) == 0)


def test_las_export_round_trips_through_our_own_importer(
    client, scalar_session, tmp_path
):
    """The real contract: export a cloud, re-import it, get the scalars back.

    Asserting through `_load_pointcloud_arrays`/laspy rather than only on the
    dimension names proves the values survive the float32 extra-dim encoding at
    the precision a user would notice.
    """
    laspy = pytest.importorskip("laspy")
    dest = tmp_path / "roundtrip.las"
    _export(client, scalar_session, "las", dest)

    reread = laspy.read(str(dest))
    assert len(reread.points) == 5
    # Every scalar came back, aligned to the right point: pair each re-read
    # position with its scalars and compare against the source pairing.
    order = np.lexsort((reread.z, reread.y, reread.x))
    refl = np.asarray(reread["reflectance"])[order]
    cls = np.asarray(reread["ground_class"])[order]

    src_pos = np.array([[0.0, 0.0, 0.0], [1.0, 2.0, 3.0], [-4.5, 5.5, 6.25],
                        [7.0, -8.0, 9.5], [2.5, 2.5, 2.5]])
    src_order = np.lexsort((src_pos[:, 2], src_pos[:, 1], src_pos[:, 0]))
    np.testing.assert_allclose(refl, REFLECTANCE[src_order], atol=1e-6)
    np.testing.assert_allclose(cls, GROUND_CLASS[src_order], atol=1e-6)


def test_las_offset_is_floored_for_large_coordinates(client, make_file_session, tmp_path):
    """A projected/UTM cloud must not overflow the scaled int32 coordinate."""
    laspy = pytest.importorskip("laspy")
    pts = np.array([[624999.7315, 4271234.5678, 12.345],
                    [625010.1234, 4271240.9876, 15.5]])
    src = tmp_path / "utm.xyz"
    np.savetxt(src, pts, fmt="%.4f")

    sid = make_file_session(src, "x y z")
    dest = tmp_path / "utm.las"
    _export(client, sid, "las", dest)

    las = laspy.read(str(dest))
    np.testing.assert_allclose(las.x, pts[:, 0], atol=1e-3)
    np.testing.assert_allclose(las.y, pts[:, 1], atol=1e-3)


# --- misses ------------------------------------------------------------------

def test_miss_flag_is_exportable_as_a_column(client, make_file_session, scalar_cloud, tmp_path):
    """`is_miss` is a scalar like any other for export — the one consumer that
    must PRESERVE misses rather than drop them."""
    sid = make_file_session(scalar_cloud, "x y z", extras={
        main._MISS_SLUG: np.array([0, 0, 1, 0, 1], dtype=np.float32),
    })
    dest = tmp_path / "misses.csv"
    _export(client, sid, "csv", dest, columns=["x", "y", "z", main._MISS_SLUG])

    lines = dest.read_text().splitlines()
    assert lines[0] == f"X,Y,Z,{main._MISS_SLUG}"
    # All 5 points, misses included — export round-trips what was imported.
    assert len(lines) == 6
    flags = [row.split(",")[3] for row in lines[1:]]
    assert flags == ["0", "0", "1", "0", "1"]
