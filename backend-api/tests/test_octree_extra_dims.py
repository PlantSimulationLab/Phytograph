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
    n, eds = main._xyz_to_las(main._Path(src), None, main._Path(out))
    assert n == 4
    las = laspy.read(str(out))
    inten = np.asarray(las.intensity)
    assert inten.min() == 0 and inten.max() == 65535      # not all-zero
    assert len(np.unique(inten)) == 4                     # every distinct dB kept


def test_xyz_to_las_keeps_reflectance_when_intensity_present(tmp_path):
    """With BOTH intensity and reflectance, intensity claims the LAS field and
    reflectance must be carried as an extra dim with its RAW dB values — not
    silently dropped (it's a reserved role the column plan didn't carry)."""
    src = tmp_path / "db.xyz"
    _write_db_scan(src)
    out = tmp_path / "db.las"
    _, eds = main._xyz_to_las(main._Path(src), None, main._Path(out))
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
