"""Point-cloud export to .asc, .pts and .pcd — and the import side that reads
them back.

Phytograph could already IMPORT all three, but not export any of them, so a
cloud brought in as `.pts` could never leave as one. Closing that gap turned up
two importer bugs that had to be fixed for the round-trip to mean anything, and
both are pinned here because they are silent — neither raises, both just lose
data:

* A canonical `.pts` opens with a bare point-COUNT line. `_ascii_skiprows` only
  skipped a leading line containing a LETTER, so the count line read as data.
  Worse, `_autodetect_xyz_columns` sampled it for the column count, saw ONE
  column, and short-circuited the whole layout to a bare x/y/z — discarding the
  file's colour and intensity columns entirely.
* Canonical PTS orders columns `x y z intensity r g b`, with intensity BEFORE
  colour. The generic autodetect only recognises an RGB triple directly after
  xyz, so a real 7-column PTS resolved to ['x','y','z','skip','skip','skip',
  'skip'] — colour AND intensity dropped.

The measured before/after on a 4-point canonical PTS: colours `None` and
intensity `None`, versus both recovered exactly.
"""
import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json


# Distinct per-point values so a mis-ordered or truncated column is detectable
# rather than coincidentally right.
POINTS = np.array(
    [[1.5, 2.5, 3.5], [2.5, 3.5, 4.5], [3.5, 4.5, 5.5], [4.5, 5.5, 6.5]],
    dtype=float,
)
COLORS = np.array([[1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0], [0.5, 0.5, 0.5]])
INTENSITY = np.array([-1200.0, -900.0, -600.0, -300.0])


# --- the importer fixes ------------------------------------------------------

def test_pts_count_header_is_not_read_as_a_point(tmp_path):
    """The leading count line is a header, not data."""
    p = tmp_path / "cloud.pts"
    p.write_text("3\n1.5 2.5 3.5\n2.5 3.5 4.5\n3.5 4.5 5.5\n")

    assert main._is_pts_count_header(str(p)) is True
    assert main._ascii_skiprows(str(p)) == 1

    positions, _, _ = main._load_xyz_arrays(str(p), None)
    assert len(positions) == 3
    np.testing.assert_allclose(positions[0], [1.5, 2.5, 3.5])


def test_count_header_detection_is_narrow(tmp_path):
    """A false positive would EAT A REAL POINT, so the rule stays tight."""
    # Not .pts — the same shape under another extension is left alone.
    other = tmp_path / "cloud.xyz"
    other.write_text("3\n1.5 2.5 3.5\n2.5 3.5 4.5\n")
    assert main._is_pts_count_header(str(other)) is False

    # A genuine first point, not a count: more than one token.
    real = tmp_path / "real.pts"
    real.write_text("1.5 2.5 3.5\n2.5 3.5 4.5\n")
    assert main._is_pts_count_header(str(real)) is False

    # Negative / fractional leading values are not counts.
    for text in ("-3\n1.5 2.5 3.5\n", "3.5\n1.5 2.5 3.5\n"):
        f = tmp_path / "n.pts"
        f.write_text(text)
        assert main._is_pts_count_header(str(f)) is False

    # A single-column file has nothing to shift, so it is left alone.
    one_col = tmp_path / "one.pts"
    one_col.write_text("3\n1.5\n2.5\n")
    assert main._is_pts_count_header(str(one_col)) is False


def test_canonical_pts_layout_keeps_colour_and_intensity(tmp_path):
    """`x y z intensity r g b` — the ordering the generic autodetect misses.

    Before the fix this returned ['x','y','z','skip','skip','skip','skip'].
    """
    p = tmp_path / "cloud.pts"
    p.write_text(
        "4\n"
        "1.5 2.5 3.5 -1200 255 0 0\n"
        "2.5 3.5 4.5 -900 0 255 0\n"
        "3.5 4.5 5.5 -600 0 0 255\n"
        "4.5 5.5 6.5 -300 128 128 128\n"
    )
    assert main._autodetect_xyz_columns(str(p)) == [
        "x", "y", "z", "intensity", "r255", "g255", "b255"]

    positions, colors, intensity = main._load_xyz_arrays(str(p), None)
    assert len(positions) == 4
    assert colors is not None, "colour was dropped"
    assert intensity is not None, "intensity was dropped"
    np.testing.assert_allclose(colors[0], [1.0, 0.0, 0.0], atol=1 / 255)
    np.testing.assert_allclose(intensity, [-1200, -900, -600, -300])


def test_pts_layout_rule_is_scoped_to_pts(tmp_path):
    """The same 7 columns under .xyz keep their old meaning.

    The PTS branch must not change how any other ASCII file is read — an
    `x y z i r g b` .xyz was ambiguous before and stays ambiguous.
    """
    p = tmp_path / "cloud.xyz"
    p.write_text("1.5 2.5 3.5 -1200 255 0 0\n2.5 3.5 4.5 -900 0 255 0\n")
    assert main._autodetect_xyz_columns(str(p)) == [
        "x", "y", "z", "skip", "skip", "skip", "skip"]


def test_pts_written_in_the_other_order_still_resolves(tmp_path):
    """A .pts with RGB directly after xyz falls to the generic rule.

    The new PTS branch is checked FIRST, so this guards that it doesn't shadow
    the existing layout for files that don't match canonical PTS.
    """
    p = tmp_path / "cloud.pts"
    p.write_text("1.5 2.5 3.5 255 0 0 -1200\n2.5 3.5 4.5 0 255 0 -900\n")
    assert main._autodetect_xyz_columns(str(p)) == [
        "x", "y", "z", "r255", "g255", "b255", "intensity"]


# --- the writers -------------------------------------------------------------

def test_pts_writer_emits_count_line_and_canonical_order(tmp_path):
    dest = tmp_path / "out.pts"
    main._write_points_as_text(dest, "pts", POINTS, COLORS, INTENSITY)

    lines = dest.read_text().splitlines()
    assert lines[0] == "4", "canonical PTS opens with the point count"
    assert len(lines) == 5
    # x y z intensity r g b — intensity BEFORE colour.
    first = lines[1].split()
    assert len(first) == 7
    np.testing.assert_allclose([float(v) for v in first[:3]], [1.5, 2.5, 3.5])
    assert float(first[3]) == pytest.approx(-1200.0)
    assert [int(v) for v in first[4:]] == [255, 0, 0]


def test_pts_ignores_a_column_selection(tmp_path):
    """PTS is a FIXED schema; a subset would be read wrong, not read short.

    Drop intensity and a conforming reader takes column 3 as red. The UI hides
    the picker for PTS; this is the backstop for a direct API call.
    """
    dest = tmp_path / "out.pts"
    main._write_points_as_text(
        dest, "pts", POINTS, COLORS, INTENSITY, columns=["x", "y", "z"])
    assert len(dest.read_text().splitlines()[1].split()) == 7


def test_asc_writer_has_no_header_line(tmp_path):
    """ASC is bare positional ASCII — a legend line would be read as a point."""
    dest = tmp_path / "out.asc"
    main._write_points_as_text(dest, "asc", POINTS, None, None)

    lines = dest.read_text().splitlines()
    assert len(lines) == 4, "no header expected"
    np.testing.assert_allclose([float(v) for v in lines[0].split()], [1.5, 2.5, 3.5])


def test_pcd_writer_emits_a_valid_header_and_packed_rgb(tmp_path):
    dest = tmp_path / "out.pcd"
    main._write_points_as_pcd(dest, POINTS, COLORS)

    text = dest.read_text()
    assert text.startswith("# .PCD v0.7")
    assert "FIELDS x y z rgb" in text
    assert "POINTS 4" in text
    assert "DATA ascii" in text

    # Colour is a float32 BIT PATTERN holding packed 24-bit RGB, not a number.
    body = text.split("DATA ascii\n")[1].splitlines()
    assert len(body) == 4
    packed = np.float32(float(body[0].split()[3])).view(np.uint32)
    assert [(int(packed) >> 16) & 0xFF, (int(packed) >> 8) & 0xFF,
            int(packed) & 0xFF] == [255, 0, 0]


def test_pcd_without_colour_omits_the_rgb_field(tmp_path):
    dest = tmp_path / "out.pcd"
    main._write_points_as_pcd(dest, POINTS, None)
    text = dest.read_text()
    assert "FIELDS x y z\n" in text
    assert "rgb" not in text.split("DATA ascii")[0].replace("# .PCD", "")


# --- round trips -------------------------------------------------------------

def test_pts_round_trips_through_our_own_importer(tmp_path):
    """Write PTS, read it back: geometry, colour and intensity all survive.

    This is the test the whole feature hangs on — a PTS export that our importer
    cannot read back would be a format we ship and cannot consume.
    """
    dest = tmp_path / "rt.pts"
    main._write_points_as_text(dest, "pts", POINTS, COLORS, INTENSITY)

    positions, colors, intensity = main._load_xyz_arrays(str(dest), None)
    assert len(positions) == len(POINTS), "the count line must not cost a point"
    np.testing.assert_allclose(positions, POINTS)
    np.testing.assert_allclose(colors, COLORS, atol=1 / 255)
    np.testing.assert_allclose(intensity, INTENSITY)


def test_asc_round_trips_through_our_own_importer(tmp_path):
    dest = tmp_path / "rt.asc"
    main._write_points_as_text(dest, "asc", POINTS, None, None)
    positions, _, _ = main._load_xyz_arrays(str(dest), None)
    np.testing.assert_allclose(positions, POINTS)


def test_pcd_round_trips_through_our_own_importer(tmp_path):
    """open3d reads back the packed-RGB field we wrote."""
    dest = tmp_path / "rt.pcd"
    main._write_points_as_pcd(dest, POINTS, COLORS)

    positions, colors, _ = main._load_ply_pcd_arrays(str(dest))
    np.testing.assert_allclose(positions, POINTS)
    assert colors is not None, "colour was lost"
    np.testing.assert_allclose(colors, COLORS, atol=1 / 255)


# --- the endpoint ------------------------------------------------------------

@pytest.fixture
def cloud_session(make_file_session, tmp_path):
    src = tmp_path / "src.xyz"
    with open(src, "w") as f:
        f.write("# x y z r255 g255 b255 intensity\n")
        for (x, y, z), (r, g, b), i in zip(POINTS, COLORS, INTENSITY):
            f.write(f"{x} {y} {z} {int(r*255)} {int(g*255)} {int(b*255)} {i}\n")
    return make_file_session(src, "x y z r255 g255 b255 intensity")


@pytest.mark.parametrize("fmt", ["asc", "pts", "pcd"])
def test_export_endpoint_writes_each_new_format(client, cloud_session, tmp_path, fmt):
    """The real endpoint, not just the writer function."""
    dest = tmp_path / f"out.{fmt}"
    resp = client.post("/api/pointcloud/export", json={
        "source": {"session_id": cloud_session},
        "format": fmt,
        "dest_path": str(dest),
    })
    assert resp.status_code == 200, resp.text
    out = decode_streamed_json(resp.content)
    assert out["success"] is True, out.get("error")
    assert dest.exists()
    assert out["point_count"] == len(POINTS)


def test_unknown_export_format_is_rejected(client, cloud_session, tmp_path):
    """An unrecognised format used to fall through and SILENTLY write a LAS.

    A request for `format:"bogus"` produced a LAS file under the requested name —
    a wrong file rather than an error, which is the failure mode most likely to
    be shipped unnoticed.
    """
    dest = tmp_path / "out.bogus"
    resp = client.post("/api/pointcloud/export", json={
        "source": {"session_id": cloud_session},
        "format": "bogus",
        "dest_path": str(dest),
    })
    assert resp.status_code == 400
    assert "Unsupported point cloud export format" in resp.text
    assert not dest.exists()


# --- the batch / per-scan writer ---------------------------------------------

@pytest.mark.parametrize("fmt,check", [
    ("asc", lambda t: len(t.splitlines()) == 4 and not t.startswith("#")),
    ("pts", lambda t: t.splitlines()[0] == "4"),
    ("pcd", lambda t: t.startswith("# .PCD v0.7")),
])
def test_scan_writer_supports_each_new_format(fmt, check):
    """`_write_scan_to_bytes` is the batch/Data-only path — a separate writer
    from the cloud export, so it needs its own coverage."""
    resolved = dict(positions=POINTS, colors=COLORS, intensity=INTENSITY,
                    scalars={}, ordered=[])
    name, data = main._write_scan_to_bytes(resolved, fmt, "scan1")
    assert name == f"scan1.{fmt}"
    assert check(data.decode("utf-8")), f"{fmt} body not in the expected shape"


def test_scan_pts_puts_intensity_before_colour():
    """The canonical order matters in the batch writer too."""
    resolved = dict(positions=POINTS, colors=COLORS, intensity=INTENSITY,
                    scalars={}, ordered=[])
    _, data = main._write_scan_to_bytes(resolved, "pts", "scan1")
    row = data.decode("utf-8").splitlines()[1].split()
    assert len(row) == 7
    assert float(row[3]) == pytest.approx(-1200.0)   # intensity
    assert [int(v) for v in row[4:]] == [255, 0, 0]  # then colour
