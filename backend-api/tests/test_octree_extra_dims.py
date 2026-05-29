"""Tests for carrying arbitrary scalar columns into octree-backed clouds.

Two layers:
  - Pure-helper unit tests (no PotreeConverter needed) for the column-plan /
    name-sanitisation logic.
  - An end-to-end conversion test (gated on a real PotreeConverter binary, like
    test_pointcloud_convert_to_octree.py) that asserts the extra dimensions and
    their human-readable labels survive into the octree metadata.

The committed fixture `fixtures/scalars.xyz` is a comma-headered,
space-delimited XYZ with two named scalar columns (Reflectance[dB],
Deviation[]) — the shape produced by terrestrial-scanner exports.
"""
from pathlib import Path

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


# --- End-to-end conversion (needs PotreeConverter) --------------------------

def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


requires_converter = pytest.mark.skipif(
    not _converter_available(),
    reason="PotreeConverter binary not found; build it via npm run build:potree-converter",
)


@pytest.fixture
def cache_root(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


@requires_converter
def test_extra_dims_survive_into_octree_metadata(client, cache_root):
    res = client.post(
        "/api/pointcloud/convert_to_octree",
        json={
            "source_path": str(FIXTURE),
            "ascii_format": "x y z reflectance deviation",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["point_count"] == 20

    # The extra dimension carried from 'deviation' should appear in the
    # octree's attribute list with a sane min/max and its display label.
    attrs = {a["name"]: a for a in body["attributes"]}
    assert "Deviation" in attrs, f"attributes were: {list(attrs)}"
    dev = attrs["Deviation"]
    assert dev.get("label") == "Deviation"
    assert "min" in dev and "max" in dev
    assert dev["min"][0] >= 0.0
    assert dev["max"][0] <= 3.0
    assert dev["max"][0] > dev["min"][0]

    # The slug→label sidecar should have been written into the cache dir.
    sidecar = Path(body["cache_dir"]) / main._OCTREE_LABELS_FILENAME
    assert sidecar.is_file()
