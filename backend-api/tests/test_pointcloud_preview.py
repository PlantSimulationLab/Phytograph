"""Tests for the import-wizard preview endpoint (/api/pointcloud/preview) and
the structured column_plan that the wizard sends back to import/convert.

Preview is read-only and cheap (header + a few rows). column_plan is the
explicit column layout the wizard produces; these tests pin the parts that are
easy to get wrong: extra-dim slug/label parity with import, the categorical
type hint, RGB-scale handling, and that distinct plans don't share an octree
cache key.
"""

import struct
from pathlib import Path

import numpy as np

import main
from main import ColumnPlan, ColumnPlanEntry


HEADER_SIZE = 32


def _unpack_header(body: bytes) -> dict:
    magic, count, has_colors, has_intensity = struct.unpack_from('<4sIBB', body, 0)
    return {"magic": magic, "count": count,
            "has_colors": bool(has_colors), "has_intensity": bool(has_intensity)}


def _colors(body: bytes, count: int):
    offset = HEADER_SIZE + count * 3 * 4
    return np.frombuffer(body, dtype=np.float32, count=count * 3, offset=offset).reshape(count, 3)


# --------------------------------------------------------------------------- #
# Preview: ASCII
# --------------------------------------------------------------------------- #

def test_preview_headered_xyz_with_extra_scalars(client, tmp_path: Path):
    # Comma header over whitespace data (a common terrestrial-scanner export).
    # Target Index is small non-negative integers → categorical hint.
    f = tmp_path / "scalars.xyz"
    f.write_text(
        "XYZ[0][m],XYZ[1][m],XYZ[2][m],Reflectance[dB],Target Index[]\n"
        "0.0 0.0 0.0 1.5 2\n"
        "0.2 0.0 0.15 2.5 3\n"
        "0.4 0.0 0.30 3.5 2\n"
    )
    res = client.post("/api/pointcloud/preview", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["kind"] == "ascii"
    assert body["has_header"] is True
    cols = body["columns"]
    assert [c["detected_role"] for c in cols[:3]] == ["x", "y", "z"]
    # Reflectance maps to the reflectance role (reserved). "Target Index" is a
    # per-pulse multi-return column, so it's carried as an extra pinned to its
    # CANONICAL slug (target_index) and label — not a header-derived slug — so
    # the full-waveform LAD path can recover it by name. (Carrying it as
    # 'Target_Index' would silently break multi-return LAD: the accessor looks
    # up the three canonical slugs only.)
    refl = cols[3]
    assert refl["detected_role"] == "reflectance"
    ti = cols[4]
    assert ti["detected_role"] == "extra"
    assert ti["suggested_slug"] == "target_index"
    assert ti["suggested_label"] == "Target Index"
    assert ti["type_hint"] == "categorical"
    assert all(c["remappable"] for c in cols)
    # A few sample rows come back as raw string tokens.
    assert body["sample_rows"][0][:3] == ["0.0", "0.0", "0.0"]


def test_preview_commented_header_recovers_labels_and_roles(client, tmp_path: Path):
    # A '#'-commented column legend (some exporters write the header as a comment
    # so loaders that honour comment='#' skip it as data). Preview must recover
    # the labels, map each to a role, and NOT consume the first data row.
    f = tmp_path / "commented.xyz"
    f.write_text(
        "# x y z r255 g255 b255 row column is_miss\n"
        "1.0 2.0 3.0 51 65 49 267 0 0\n"
        "1.1 2.1 3.1 54 70 55 268 0 1\n"
    )
    res = client.post("/api/pointcloud/preview", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["has_header"] is True
    cols = body["columns"]
    assert [c["header_name"] for c in cols] == [
        "x", "y", "z", "r255", "g255", "b255", "row", "column", "is_miss"]
    roles = [c["detected_role"] for c in cols]
    # x/y/z + RGB (r255 spelling recognised) + grid indices; is_miss reports the
    # dedicated 'is_miss' role token (pre-selects the wizard's 'Miss Flag' option)
    # pinned to the canonical is_miss slug.
    assert roles[:6] == ["x", "y", "z", "r255", "g255", "b255"]
    assert roles[6:8] == ["row_index", "column_index"]
    assert cols[8]["detected_role"] == "is_miss"
    assert cols[8]["suggested_slug"] == "is_miss"
    assert cols[8]["suggested_label"] == "Miss"
    # The commented header is dropped by comment='#', so the FIRST sample row must
    # be the first real data row — not silently lost to a phantom header skip.
    assert body["sample_rows"][0][:3] == ["1.0", "2.0", "3.0"]
    assert len(body["sample_rows"]) == 2


def test_commented_header_does_not_trigger_skiprows(tmp_path: Path):
    # pandas is told comment='#', which already drops a commented header. The
    # skiprows heuristic must therefore NOT also skip a data row, or row one
    # vanishes from every import.
    f = tmp_path / "commented.xyz"
    f.write_text("# x y z\n1 2 3\n4 5 6\n")
    assert main._first_data_row_has_letters(str(f)) is False
    assert main._read_ascii_header_names(str(f)) == ["x", "y", "z"]


def test_plain_prose_comment_is_not_treated_as_header(tmp_path: Path):
    # A '#' remark that doesn't resolve to an x/y/z layout is just a comment, not
    # a header — header recovery declines and positional auto-detect still works.
    f = tmp_path / "prose.xyz"
    f.write_text("# exported by FooScan v2.1 on 2026-01-01\n0 0 0\n1 1 1\n")
    assert main._read_ascii_header_names(str(f)) is None
    assert main._autodetect_xyz_columns(str(f)) == ["x", "y", "z"]


def test_commented_header_import_carries_canonical_slugs(client, tmp_path: Path):
    # End-to-end auto-detect import of a commented-header cloud: every data row
    # parses and the scan-structure columns land under their canonical slugs so
    # the LAD / grid-recovery paths find them by name.
    f = tmp_path / "scan.xyz"
    f.write_text(
        "# x y z r255 g255 b255 row column is_miss\n"
        "0.0 0.0 0.0 10 20 30 0 0 0\n"
        "0.1 0.1 0.1 11 21 31 0 1 0\n"
        "0.2 0.2 0.2 12 22 32 1 0 1\n"
    )
    names, extra = main._xyz_column_plan(main._Path(str(f)), None, None)
    assert names[:6] == ["x", "y", "z", "r255", "g255", "b255"]
    slugs = {e["slug"] for e in extra}
    assert {"row_index", "column_index", "is_miss"} <= slugs
    # Import all three rows (none lost to a phantom header skip).
    res = client.post("/api/pointcloud/import_by_path", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    hdr = _unpack_header(res.content)
    assert hdr["count"] == 3
    assert hdr["has_colors"] is True


def test_miss_alias_spellings_normalise_to_is_miss(tmp_path: Path):
    # 'sky' / 'miss' header spellings (and a column_plan slug) all canonicalise
    # to the is_miss slug so the LAD path finds the flag regardless of source.
    assert main._role_from_header_name("sky") == "is_miss"
    assert main._role_from_header_name("Miss") == "is_miss"
    assert main._normalise_miss_alias("Sky") == "is_miss"
    cp = _plan([
        {"index": 0, "role": "x"}, {"index": 1, "role": "y"}, {"index": 2, "role": "z"},
        {"index": 3, "role": "extra", "slug": "sky", "label": "Sky"},
    ])
    _, extra = main._xyz_column_plan(None, None, cp)
    assert [e["slug"] for e in extra] == ["is_miss"]


def test_explicit_is_miss_role_token_pins_canonical_slug(tmp_path: Path):
    # The wizard's dedicated 'Miss Flag' option emits an explicit 'is_miss' role
    # token (not 'extra'). It must plan to the canonical is_miss extra dim, never
    # categorical, regardless of the column's header text.
    cp = _plan([
        {"index": 0, "role": "x"}, {"index": 1, "role": "y"}, {"index": 2, "role": "z"},
        {"index": 3, "role": "is_miss"},
    ])
    names, extra = main._xyz_column_plan(None, None, cp)
    assert names == ["x", "y", "z", "extra:is_miss"]
    assert len(extra) == 1
    assert extra[0]["slug"] == "is_miss"
    assert extra[0]["label"] == main._MISS_LABEL
    assert extra[0]["categorical"] is False


def test_preview_headerless_xyz_positional(client, tmp_path: Path):
    # No header; 4 columns → x y z + a small-integer class column.
    f = tmp_path / "plants.xyz"
    f.write_text("0.1 0.2 0.3 1\n0.4 0.5 0.6 2\n0.7 0.8 0.9 1\n")
    res = client.post("/api/pointcloud/preview", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["has_header"] is False
    roles = [c["detected_role"] for c in body["columns"]]
    assert roles[:3] == ["x", "y", "z"]
    # The 4th column auto-detects as intensity positionally, but its values look
    # categorical — the wizard surfaces that so the user can switch it to a
    # categorical scalar.
    assert body["columns"][3]["type_hint"] == "categorical"


def test_preview_headerless_six_col_rgb_detected(client, tmp_path: Path):
    # No header; 6 columns whose 4th-6th look like 8-bit colour (0-255 ints) →
    # the positional fallback assigns r255/g255/b255.
    f = tmp_path / "rgb.xyz"
    f.write_text(
        "0.1 0.2 0.3 200 100 50\n"
        "0.4 0.5 0.6 12 250 0\n"
        "0.7 0.8 0.9 255 0 128\n"
    )
    res = client.post("/api/pointcloud/preview", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    roles = [c["detected_role"] for c in res.json()["columns"]]
    assert roles[:6] == ["x", "y", "z", "r255", "g255", "b255"]


def test_preview_headerless_multireturn_not_mistaken_for_rgb(client, tmp_path: Path):
    # Helios multi-return XYZ (`x y z timestamp intensity return#`), no header.
    # Column 4 is a GPS timestamp of order 1e5 — far outside 0-255 — so the
    # positional fallback must NOT tag cols 4-6 as r255/g255/b255. Instead they
    # drop to 'skip', which the wizard surfaces as reassignable scalars.
    f = tmp_path / "leafcube_multi.xyz"
    f.write_text(
        "984.2437 108.2988 108.5248 297972.0000 99 1\n"
        "984.6583 108.3442 104.6110 297973.0000 99 1\n"
        "985.0575 108.3879 100.6957 297974.0000 99 1\n"
    )
    res = client.post("/api/pointcloud/preview", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    cols = res.json()["columns"]
    roles = [c["detected_role"] for c in cols]
    assert roles[:3] == ["x", "y", "z"]
    # No RGB mislabel — cols 4-6 are reassignable scalars, not colour.
    assert "r255" not in roles and "g255" not in roles and "b255" not in roles
    for i in (3, 4, 5):
        assert cols[i]["detected_role"] == "skip"
        assert cols[i]["remappable"] is True
        assert cols[i]["suggested_slug"] == f"col_{i + 1}"


def test_columns_look_like_rgb255_unit():
    # In range (0-255 ints) → RGB.
    assert main._columns_look_like_rgb255(
        [[0.0, 0.0, 0.0, 200, 100, 50], [0.0, 0.0, 0.0, 255, 0, 128]], (3, 4, 5))
    # A timestamp column (>255) disqualifies it.
    assert not main._columns_look_like_rgb255(
        [[0.0, 0.0, 0.0, 297972.0, 99, 1]], (3, 4, 5))
    # Non-integer (0-1 float colour) is not 8-bit RGB either.
    assert not main._columns_look_like_rgb255(
        [[0.0, 0.0, 0.0, 0.5, 0.2, 0.1]], (3, 4, 5))
    # Negative disqualifies.
    assert not main._columns_look_like_rgb255(
        [[0.0, 0.0, 0.0, -1, 10, 20]], (3, 4, 5))
    # No sample → don't guess.
    assert not main._columns_look_like_rgb255([], (3, 4, 5))


def test_preview_never_500s_on_garbage(client, tmp_path: Path):
    f = tmp_path / "junk.xyz"
    f.write_bytes(b"\x00\x01\x02 not really a point cloud \xff")
    res = client.post("/api/pointcloud/preview", json={"file_path": str(f)})
    # Preview must degrade gracefully so the wizard can offer auto-detect.
    assert res.status_code == 200, res.text


def test_preview_missing_file_404(client):
    res = client.post("/api/pointcloud/preview", json={"file_path": "/no/such/file.xyz"})
    assert res.status_code == 404


# --------------------------------------------------------------------------- #
# Preview: in-file formats (not remappable)
# --------------------------------------------------------------------------- #

def test_preview_ascii_ply_fields(client, tmp_path: Path):
    f = tmp_path / "tiny.ply"
    f.write_text(
        "ply\nformat ascii 1.0\nelement vertex 2\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property float reflectance\nproperty float deviation\nend_header\n"
        "0 0 0 1.0 0.1\n1 1 1 2.0 0.2\n"
    )
    res = client.post("/api/pointcloud/preview", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["kind"] == "ply"
    assert all(not c["remappable"] for c in body["columns"])
    roles = [c["detected_role"] for c in body["columns"]]
    assert roles[:3] == ["x", "y", "z"]
    # reflectance maps to the intensity role; deviation is an unrecognised
    # property carried as a scalar field.
    assert "intensity" in roles
    assert "extra" in roles


# --------------------------------------------------------------------------- #
# column_plan: import honours rename + categorical + RGB scale
# --------------------------------------------------------------------------- #

def _plan(columns, rgb_is_255=True):
    return ColumnPlan(columns=[ColumnPlanEntry(**c) for c in columns], rgb_is_255=rgb_is_255)


def test_extra_dim_slug_colliding_with_reserved_las_name_is_renamed():
    # A scalar field whose name sanitises onto a built-in LAS dimension
    # ('intensity', 'classification', 'x', …) must be renamed, or laspy's
    # header build crashes with "field '<name>' occurs more than once".
    for raw in ('intensity', 'Intensity', 'classification', 'X', 'red'):
        slug = main._sanitize_extra_dim_name(raw)
        assert slug.lower() not in main._LAS_RESERVED_DIM_NAMES, raw
    # A non-reserved name passes through untouched.
    assert main._sanitize_extra_dim_name('Deviation') == 'Deviation'


def test_xyz_to_las_with_reserved_extra_dim_slug_does_not_crash(tmp_path: Path):
    # End-to-end: a column plan that maps a column to an extra dim named
    # 'intensity' used to crash the octree converter. It must now build cleanly,
    # carrying the renamed slug while keeping the user's display label.
    f = tmp_path / "scan.xyz"
    f.write_text("0 0 0 5\n1 1 1 6\n2 2 2 7\n")
    cp = ColumnPlan(columns=[
        ColumnPlanEntry(index=0, role='x'),
        ColumnPlanEntry(index=1, role='y'),
        ColumnPlanEntry(index=2, role='z'),
        ColumnPlanEntry(index=3, role='extra', slug='intensity', label='Intensity'),
    ], rgb_is_255=True)
    out = tmp_path / "out.las"
    n, extra = main._xyz_to_las(main._Path(str(f)), None, main._Path(str(out)), cp)
    assert n == 3
    assert len(extra) == 1
    assert extra[0]["slug"].lower() not in main._LAS_RESERVED_DIM_NAMES
    assert extra[0]["label"] == "Intensity"


def test_column_plan_renames_extra_dim_label_and_slug():
    cp = _plan([
        {"index": 0, "role": "x"},
        {"index": 1, "role": "y"},
        {"index": 2, "role": "z"},
        {"index": 3, "role": "extra", "slug": "tree_id", "label": "Tree ID", "categorical": True},
    ])
    names, extra = main._xyz_column_plan(None, None, cp)
    assert names == ["x", "y", "z", "extra:tree_id"]
    assert extra == [{"col": "extra:tree_id", "slug": "tree_id",
                      "label": "Tree ID", "categorical": True}]


def test_import_by_path_rgb_0_255_vs_0_1(client, tmp_path: Path):
    # Same RGB tokens, two scales. With rgb_is_255=False the loader treats r/g/b
    # as already 0-1; with True it divides by 255. The decoded colors must differ.
    f = tmp_path / "rgb.csv"
    f.write_text("0 0 0 0.5 0.25 1.0\n1 1 1 0.5 0.25 1.0\n")

    cp01 = {
        "columns": [
            {"index": 0, "role": "x"}, {"index": 1, "role": "y"}, {"index": 2, "role": "z"},
            {"index": 3, "role": "r"}, {"index": 4, "role": "g"}, {"index": 5, "role": "b"},
        ],
        "rgb_is_255": False,
    }
    res01 = client.post("/api/pointcloud/import_by_path",
                        json={"file_path": str(f), "column_plan": cp01})
    assert res01.status_code == 200, res01.text
    h01 = _unpack_header(res01.content)
    assert h01["has_colors"] is True
    c01 = _colors(res01.content, h01["count"])
    # 0-1 input passes straight through.
    assert np.allclose(c01[0], [0.5, 0.25, 1.0], atol=1e-6)

    cp255 = dict(cp01)
    cp255 = {"columns": [dict(c, role={"r": "r255", "g": "g255", "b": "b255"}.get(c["role"], c["role"]))
                          for c in cp01["columns"]], "rgb_is_255": True}
    res255 = client.post("/api/pointcloud/import_by_path",
                         json={"file_path": str(f), "column_plan": cp255})
    assert res255.status_code == 200, res255.text
    c255 = _colors(res255.content, h01["count"])
    # 0-255 interpretation of 0.5 ≈ 0.5/255 — very different from 0.5.
    assert not np.allclose(c255[0], c01[0], atol=1e-3)


# --------------------------------------------------------------------------- #
# Cache key: distinct plans get distinct octree cache entries
# --------------------------------------------------------------------------- #

def test_cache_key_includes_column_plan(tmp_path: Path):
    f = tmp_path / "t.xyz"
    f.write_text("0 0 0\n1 1 1\n")
    base = main._octree_cache_key(str(f), None, None)
    plan_a = _plan([
        {"index": 0, "role": "x"}, {"index": 1, "role": "y"}, {"index": 2, "role": "z"},
    ])
    plan_b = _plan([
        {"index": 0, "role": "x"}, {"index": 1, "role": "y"}, {"index": 2, "role": "z"},
    ], rgb_is_255=False)
    key_a = main._octree_cache_key(str(f), None, plan_a)
    key_b = main._octree_cache_key(str(f), None, plan_b)
    assert base != key_a          # a plan changes the identity
    assert key_a != key_b         # rgb scale changes the identity


def test_cache_key_stable_for_none_plan(tmp_path: Path):
    """A plan-less import keeps the exact key it had before column_plan existed —
    no cache churn for existing users."""
    f = tmp_path / "t.xyz"
    f.write_text("0 0 0\n")
    k1 = main._octree_cache_key(str(f), "x y z", None)
    k2 = main._octree_cache_key(str(f), "x y z")
    assert k1 == k2
