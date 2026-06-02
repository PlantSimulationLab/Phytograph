"""Tests for carrying arbitrary scalar columns into octree-backed clouds.

Pure-helper unit tests (no PotreeConverter needed) for the column-plan /
name-sanitisation logic.

The committed fixture `fixtures/scalars.xyz` is a comma-headered,
space-delimited XYZ with two named scalar columns (Reflectance[dB],
Deviation[]) — the shape produced by terrestrial-scanner exports.
"""
from pathlib import Path

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
