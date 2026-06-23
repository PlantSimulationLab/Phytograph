"""Tests for carrying arbitrary scalar columns into octree-backed clouds.

Pure-helper unit tests (no PotreeConverter needed) for the column-plan /
name-sanitisation logic.

The committed fixture `fixtures/scalars.xyz` is a comma-headered,
space-delimited XYZ with two named scalar columns (Reflectance[dB],
Deviation[]) — the shape produced by terrestrial-scanner exports.
"""
from pathlib import Path

import numpy as np
import laspy
import pytest

import main


FIXTURE = Path(__file__).parent / "fixtures" / "scalars.xyz"


# --- Pure helpers (always run) ---------------------------------------------

def test_sanitize_extra_dim_name_slugs_headers():
    assert main._sanitize_extra_dim_name("Reflectance[dB]") == "Reflectance_dB"
    assert main._sanitize_extra_dim_name("Target Index[]") == "Target_Index"
    assert main._sanitize_extra_dim_name("Deviation[]") == "Deviation"
    assert main._sanitize_extra_dim_name("XYZ[0][m]") == "XYZ_0_m"


def test_sanitize_extra_dim_name_caps_at_32_chars():
    long = "A" * 50
    assert len(main._sanitize_extra_dim_name(long)) == 32


def test_sanitize_extra_dim_name_empty_falls_back():
    assert main._sanitize_extra_dim_name("[]") == "field"
    assert main._sanitize_extra_dim_name("///") == "field"


def test_humanize_extra_dim_label():
    assert main._humanize_extra_dim_label("Reflectance[dB]") == "Reflectance [dB]"
    assert main._humanize_extra_dim_label("Deviation[]") == "Deviation"
    assert main._humanize_extra_dim_label("Target Index[]") == "Target Index"


def test_read_ascii_header_names_comma_header():
    names = main._read_ascii_header_names(str(FIXTURE))
    assert names == [
        "XYZ[0][m]", "XYZ[1][m]", "XYZ[2][m]", "Reflectance[dB]", "Deviation[]",
    ]


def test_read_ascii_header_names_none_when_no_header(tmp_path):
    f = tmp_path / "nohdr.xyz"
    f.write_text("0 0 0 1.5\n1 1 1 2.5\n")
    assert main._read_ascii_header_names(str(f)) is None


def test_xyz_column_plan_promotes_unmapped_to_extras():
    # Explicit format: reflectance is reserved (→ intensity); timestamp,
    # deviation, target_index, target_count are unmapped → extra dims.
    names, extras = main._xyz_column_plan(
        FIXTURE, "x y z reflectance deviation"
    )
    assert names[:4] == ["x", "y", "z", "reflectance"]
    # The 5th column ('deviation') is a known-but-unreserved role → extra dim,
    # named from the file header (Deviation[]).
    slugs = [e["slug"] for e in extras]
    labels = {e["slug"]: e["label"] for e in extras}
    assert "Deviation" in slugs
    assert labels["Deviation"] == "Deviation"


def test_xyz_column_plan_dedupes_slug_collisions(tmp_path):
    f = tmp_path / "dup.xyz"
    # Two headers that sanitise to the same slug.
    f.write_text("A[],A[]\n0 0\n1 1\n")
    # Format marks both columns as unmapped via tokens not in known roles.
    names, extras = main._xyz_column_plan(f, "foo bar")
    slugs = [e["slug"] for e in extras]
    assert len(slugs) == len(set(slugs)), f"slugs not unique: {slugs}"


# --- LAS intensity normalisation (round-trips via laspy, no PotreeConverter) -


def test_intensity_to_las_uint16_normalises_db_scale():
    """dB reflectance is all-negative; a fixed `* 256` + clip(0,…) would crush it
    to a uniform 0. Normalising the range must spread it across the uint16 span."""
    db = np.array([-14.8, -7.4, -0.001, -2.0], dtype=np.float64)
    out = main._intensity_to_las_uint16(db)
    assert out.dtype == np.uint16
    assert out.min() == 0 and out.max() == 65535     # endpoints hit the full range
    assert len(np.unique(out)) == 4                  # gradient preserved, not flattened


def test_intensity_to_las_uint16_constant_and_nonfinite():
    assert (main._intensity_to_las_uint16(np.full(5, -3.0)) == 0).all()  # zero-width → 0
    out = main._intensity_to_las_uint16(np.array([np.nan, 1.0, 2.0]))
    assert out[0] == 0 and out[2] == 65535           # NaN → 0, finite range spans


def test_intensity_to_las_uint16_global_range_overrides_array():
    # A chunk holding only part of the global range maps against the passed
    # lo/hi, so chunk seams stay consistent (not rescaled per-chunk).
    chunk = np.array([-7.0, -5.0], dtype=np.float64)
    out = main._intensity_to_las_uint16(chunk, lo=-10.0, hi=0.0)
    assert out.tolist() == [int(3.0 / 10 * 65535), int(5.0 / 10 * 65535)]


def _write_db_scan(path: Path) -> None:
    """A Helios-style ASCII scan whose intensity AND reflectance are in dB
    (negative), with extra label columns — the reported failing shape."""
    path.write_text(
        "# x y z intensity reflectance is_miss point_class\n"
        "0.0 0.0 0.0 -0.62 -2.06 0 1\n"
        "1.0 0.0 0.0 -0.51 -2.93 0 1\n"
        "2.0 0.0 0.0 -0.99 -14.8 0 2\n"
        "3.0 0.0 0.0 -0.03 -0.001 0 2\n"
    )


def test_xyz_to_las_db_intensity_not_clamped_to_zero(tmp_path):
    """The reported bug: dB intensity/reflectance imported as a uniform 0 because
    the LAS writer assumed a 0-255 scale. Intensity must span the uint16 range."""
    src = tmp_path / "db.xyz"
    _write_db_scan(src)
    out = tmp_path / "db.las"
    n, eds, _ = main._xyz_to_las(main._Path(src), None, main._Path(out))
    assert n == 4
    las = laspy.read(str(out))
    inten = np.asarray(las.intensity)
    assert inten.min() == 0 and inten.max() == 65535      # not all-zero
    assert len(np.unique(inten)) == 4                     # every distinct dB kept


def test_xyz_to_las_large_utm_coordinates_survive(tmp_path):
    """Regression: clouds in a projected CRS (UTM northings ~5.4e6 m) used to
    overflow the LAS writer — a coordinate is stored as a 32-bit int
    (value-offset)/scale, and with offset 0 + 1 mm scale only ±2.1 km fits.
    The writer must offset to the data min so the absolute magnitude doesn't
    matter; laspy re-applies the offset on read, so coordinates round-trip."""
    src = tmp_path / "utm.xyz"
    # A few points at a realistic UTM easting/northing (well beyond ±2.1 km).
    pts = [
        (476769.123, 5429145.250, 250.0),
        (476772.456, 5429147.880, 258.4),
        (476775.001, 5429149.500, 265.5),
    ]
    src.write_text("".join(f"{x:.4f} {y:.4f} {z:.4f}\n" for x, y, z in pts))
    out = tmp_path / "utm.las"
    n, _, _ = main._xyz_to_las(main._Path(src), "x y z", main._Path(out))
    assert n == len(pts)
    las = laspy.read(str(out))
    # Coordinates come back at full magnitude, within the 1 mm scale tolerance.
    np.testing.assert_allclose(np.asarray(las.x), [p[0] for p in pts], atol=1e-3)
    np.testing.assert_allclose(np.asarray(las.y), [p[1] for p in pts], atol=1e-3)
    np.testing.assert_allclose(np.asarray(las.z), [p[2] for p in pts], atol=1e-3)


def test_xyz_to_las_keeps_reflectance_when_intensity_present(tmp_path):
    """With BOTH intensity and reflectance, intensity claims the LAS field and
    reflectance must be carried as an extra dim with its RAW dB values — not
    silently dropped (it's a reserved role the column plan didn't carry)."""
    src = tmp_path / "db.xyz"
    _write_db_scan(src)
    out = tmp_path / "db.las"
    _, eds, _ = main._xyz_to_las(main._Path(src), None, main._Path(out))
    las = laspy.read(str(out))
    assert "reflectance" in las.point_format.extra_dimension_names
    refl = np.asarray(las["reflectance"])
    # Raw dB preserved (extra dims aren't normalised; the renderer scales by range).
    assert refl.min() == pytest.approx(-14.8)
    assert refl.max() == pytest.approx(-0.001)
    assert any(e["slug"] == "reflectance" for e in eds)


def test_xyz_to_las_db_intensity_consistent_across_chunks(tmp_path, monkeypatch):
    """A multi-chunk file must normalise intensity against the GLOBAL range, so
    the gradient doesn't band at chunk seams. Force a tiny chunk size to split a
    small file across chunks and assert the global extremes still map to 0/65535."""
    src = tmp_path / "big.xyz"
    lines = ["# x y z intensity\n"]
    # Intensity ramps -10 -> 0 over 10 rows; with chunk_rows=3 that's 4 chunks.
    for i in range(10):
        lines.append(f"{i} 0 0 {-10.0 + i:.3f}\n")
    src.write_text("".join(lines))

    real_read_csv = main.pd.read_csv

    def small_chunks(*a, **kw):
        if "chunksize" in kw:
            kw["chunksize"] = 3
        return real_read_csv(*a, **kw)

    monkeypatch.setattr(main.pd, "read_csv", small_chunks)
    out = tmp_path / "big.las"
    main._xyz_to_las(main._Path(src), None, main._Path(out))
    inten = np.asarray(laspy.read(str(out)).intensity)
    assert inten.min() == 0 and inten.max() == 65535
    # Monotonic ramp in → monotonic ramp out (would be banded if per-chunk).
    assert np.all(np.diff(inten.astype(np.int64)) > 0)


def test_ply_to_las_db_intensity_not_clamped(tmp_path):
    """The PLY converter had the same `* 256` clamp; a dB intensity property must
    spread across the uint16 range rather than collapsing to 0."""
    from plyfile import PlyData, PlyElement

    verts = np.array(
        [(0.0, 0.0, 0.0, -14.0), (1.0, 0.0, 0.0, -7.0), (2.0, 0.0, 0.0, -0.5)],
        dtype=[("x", "f4"), ("y", "f4"), ("z", "f4"), ("intensity", "f4")],
    )
    src = tmp_path / "db.ply"
    PlyData([PlyElement.describe(verts, "vertex")], text=True).write(str(src))
    out = tmp_path / "db.las"
    main._ply_to_las(main._Path(src), main._Path(out))
    inten = np.asarray(laspy.read(str(out)).intensity)
    assert inten.min() == 0 and inten.max() == 65535
    assert len(np.unique(inten)) == 3


# --- '//'-commented (CloudCompare) header handling -------------------------

def test_ascii_skiprows_double_slash_header():
    """The reported bug: a '//X //Y //Z' header (CloudCompare's convention)
    survives pandas's comment='#' and would be parsed as a data row, crashing
    the float cast with `could not convert string to float: '//X'`. It must be
    counted as a skip. A '#'-commented header must NOT (pandas drops it), and a
    bare uncommented text header must be skipped exactly once."""
    import tempfile, os

    def _skiprows(text: str) -> int:
        fd, path = tempfile.mkstemp(suffix=".xyz")
        os.write(fd, text.encode())
        os.close(fd)
        try:
            return main._ascii_skiprows(path)
        finally:
            os.unlink(path)

    assert _skiprows("//X //Y //Z\n0 0 0\n1 1 1\n") == 1   # '//' header: skip
    assert _skiprows("# x y z\n0 0 0\n1 1 1\n") == 0       # '#' header: pandas drops
    assert _skiprows("X Y Z\n0 0 0\n1 1 1\n") == 1         # bare header: skip
    assert _skiprows("0 0 0\n1 1 1\n") == 0                # no header: skip nothing


def test_xyz_to_las_double_slash_header_imports(tmp_path):
    """End-to-end through `_xyz_to_las`: a '//'-headered CloudCompare export
    must import cleanly (header dropped, every data row kept) rather than
    crashing on the '//X' token. Regression for the 'N of M imports failed'
    bulk-import report."""
    src = tmp_path / "cc.xyz"
    src.write_text("//X //Y //Z\n0 0 0\n1 2 3\n4 5 6\n")
    out = tmp_path / "cc.las"
    n, _, _ = main._xyz_to_las(main._Path(str(src)), None, main._Path(str(out)))
    assert n == 3
    las = laspy.read(str(out))
    # Coordinates round-trip (0.001 LAS scale → mm precision is ample here).
    np.testing.assert_allclose(np.asarray(las.x), [0, 1, 4], atol=1e-3)
    np.testing.assert_allclose(np.asarray(las.y), [0, 2, 5], atol=1e-3)
    np.testing.assert_allclose(np.asarray(las.z), [0, 3, 6], atol=1e-3)


def test_ascii_pandas_sep_matches_detected_delimiter(tmp_path):
    """The loader's pandas `sep` must agree with the wizard's sniffed delimiter,
    or comma/tab/semicolon files collapse into column 0 and `usecols` fails."""
    def _sep(text: str) -> str:
        f = tmp_path / "s.txt"
        f.write_text(text)
        return main._ascii_pandas_sep(str(f))

    assert _sep("0,0,0\n1,2,3\n") == ","
    assert _sep("0\t0\t0\n1\t2\t3\n") == "\t"
    assert _sep("0;0;0\n1;2;3\n") == ";"
    assert _sep("0 0 0\n1 2 3\n") == r"\s+"


def test_xyz_to_las_comma_delimited_cloudcompare_export(tmp_path):
    """Regression: a comma-delimited CloudCompare export ('//X,Y,Z,R,G,B,...'
    header, comma-separated data) must import through `_xyz_to_las`. The loaders
    previously hardcoded `sep=r'\\s+'`, so the whole row landed in column 0 and
    `usecols=[1, 2, ...]` raised 'Usecols do not match columns, columns expected
    but not found: [1, 2]' — even though the wizard preview parsed it fine."""
    src = tmp_path / "redbud.txt"
    src.write_text(
        "//X,Y,Z,R,G,B,Scalar field,Illuminance (PCV)\n"
        "9.71,-10.25,-13.15,1,1,2,996.51,0.21\n"
        "9.69,-10.26,-13.14,3,1,1,996.51,0.24\n"
        "9.64,-10.24,-13.15,15,1,1,996.48,0.02\n"
    )
    out = tmp_path / "redbud.las"
    cp = main.ColumnPlan(columns=[
        main.ColumnPlanEntry(index=0, role='x'),
        main.ColumnPlanEntry(index=1, role='y'),
        main.ColumnPlanEntry(index=2, role='z'),
        main.ColumnPlanEntry(index=3, role='r255'),
        main.ColumnPlanEntry(index=4, role='g255'),
        main.ColumnPlanEntry(index=5, role='b255'),
        main.ColumnPlanEntry(index=6, role='extra:Scalar field'),
        main.ColumnPlanEntry(index=7, role='extra:Illuminance (PCV)'),
    ], rgb_is_255=True)
    n, eds, _ = main._xyz_to_las(main._Path(str(src)), None, main._Path(str(out)), cp)
    assert n == 3
    assert len(eds) == 2  # the two extra scalar columns are carried
    las = laspy.read(str(out))
    np.testing.assert_allclose(np.asarray(las.x), [9.71, 9.69, 9.64], atol=1e-3)
    np.testing.assert_allclose(np.asarray(las.y), [-10.25, -10.26, -10.24], atol=1e-3)
    np.testing.assert_allclose(np.asarray(las.z), [-13.15, -13.14, -13.15], atol=1e-3)
    # RGB survives the comma split (0-255 ints scaled to LAS 0-65535).
    np.testing.assert_allclose(np.asarray(las.red) / 257.0, [1, 3, 15], atol=1)


def test_xyz_to_las_format_mismatch_raises_actionable_400(tmp_path):
    """When the chosen column format doesn't match the file (a non-numeric token
    reaches the x/y/z cast — exactly what a bulk import that applies one file's
    layout to another produces), the failure must be a clean 400 naming the file
    and the chosen columns, not an uncaught 500."""
    from fastapi import HTTPException

    src = tmp_path / "labels.xyz"
    # A stray non-numeric token in the x column on a DATA row (not the first
    # line, which would be skipped as a header). This is the shape of a
    # genuine format mismatch the skiprows heuristic can't rescue.
    src.write_text("0 0 0\ntree_alpha 2 3\n")
    out = tmp_path / "out.las"
    cp = main.ColumnPlan(columns=[
        main.ColumnPlanEntry(index=0, role='x'),
        main.ColumnPlanEntry(index=1, role='y'),
        main.ColumnPlanEntry(index=2, role='z'),
    ], rgb_is_255=True)
    with pytest.raises(HTTPException) as exc:
        main._xyz_to_las(main._Path(str(src)), None, main._Path(str(out)), cp)
    assert exc.value.status_code == 400
    assert "labels.xyz" in exc.value.detail
    assert "column format" in exc.value.detail
