"""Tests for importing structured-scan raster indices (scan row / column index)
through the import wizard's column plan.

`row_index` / `column_index` are integer (row, column) positions within the
scanner's rectangular acquisition grid. They are carried as session `extras`
under canonical slugs so the C++ grid-based direction recovery (LiDAR.cpp, for
gap-filling unplaceable misses) finds the raster by name — exactly as the E57
structured-import path emits them. They must:
  - pin to canonical slugs when selected as a wizard role (`_plan_columns_*`),
  - auto-detect from common row/column header spellings (`_xyz_column_plan`),
  - survive the ASCII import path into a CloudSession, and
  - feed back out via `_session_to_lad_arrays` so recovery has the grid.

These exercise the in-RAM IO helpers directly (no PotreeConverter / octree).
"""

import time
from pathlib import Path

import numpy as np
import pytest

import main
from main import ColumnPlan, ColumnPlanEntry

laspy = pytest.importorskip("laspy")


# A 4-row 2x2 rasterised grid: (row, col) in {0,1}x{0,1}. Columns:
# x y z row_index column_index.
_GRID_ROWS = [
    # x     y     z     row col
    (0.10, 0.20, 1.00, 0, 0),
    (0.30, 0.40, 1.50, 0, 1),
    (0.31, 0.41, 1.20, 1, 0),
    (0.32, 0.42, 0.90, 1, 1),
]
_GRID_FORMAT = "x y z row_index column_index"


def _write_grid_xyz(path: Path) -> None:
    lines = [" ".join(str(v) for v in row) for row in _GRID_ROWS]
    path.write_text("\n".join(lines) + "\n")


def _session_from_arrays(positions, extras, extra_dims_meta):
    n = len(positions)
    return main.CloudSession(
        session_id="gridsess",
        source_path="<test>",
        ascii_format=_GRID_FORMAT,
        column_plan=None,
        positions=positions,
        colors=None,
        intensity=None,
        extras=extras,
        extra_dims_meta=extra_dims_meta,
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
    )


def _grid_plan():
    """The column plan the wizard sends when the user picks the two grid roles."""
    cols = [
        ColumnPlanEntry(index=0, role='x', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=1, role='y', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=2, role='z', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=3, role='row_index', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=4, role='column_index', slug=None, label=None, categorical=False),
    ]
    return ColumnPlan(columns=cols, rgb_is_255=True)


# --------------------------------------------------------------------------- #
# Column planning
# --------------------------------------------------------------------------- #

def test_column_plan_pins_canonical_grid_slugs():
    """The wizard's `row_index`/`column_index` roles carry as extras under their
    canonical slug + label, never categorical (they're integer grid positions)."""
    names, extras = main._plan_columns_from_column_plan(_grid_plan())
    assert names[:3] == ["x", "y", "z"]
    by_slug = {e["slug"]: e for e in extras}
    assert "row_index" in by_slug and "column_index" in by_slug
    assert by_slug["row_index"]["label"] == "Row Index"
    assert by_slug["column_index"]["label"] == "Column Index"
    assert by_slug["row_index"]["categorical"] is False
    assert by_slug["column_index"]["categorical"] is False


def test_grid_role_via_extra_slug_also_pins_canonical():
    """An 'extra' column whose slug IS a grid slug is canonicalised too, so a
    column carried as a scalar named 'row_index' still lands in the recovery
    raster (mirrors the multi-return slug handling)."""
    cols = [
        ColumnPlanEntry(index=0, role='x', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=1, role='y', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=2, role='z', slug=None, label=None, categorical=False),
        ColumnPlanEntry(index=3, role='extra', slug='column_index',
                        label='Column Index', categorical=False),
    ]
    _, extras = main._plan_columns_from_column_plan(ColumnPlan(columns=cols, rgb_is_255=True))
    ci = next(e for e in extras if e["slug"] == "column_index")
    assert ci["label"] == "Column Index"
    assert ci["categorical"] is False


def test_header_named_grid_columns_round_trip(tmp_path):
    """Auto-detect (no ascii_format): common row/column header spellings map to
    the canonical grid slugs."""
    f = tmp_path / "hdr.xyz"
    f.write_text(
        "X Y Z Row Column\n"
        "0 0 0 0 0\n"
        "1 1 1 0 1\n"
        "2 2 2 1 0\n"
    )
    names, extras = main._xyz_column_plan(f, None, None)
    assert names[:3] == ["x", "y", "z"]
    slugs = {e["slug"] for e in extras}
    assert {"row_index", "column_index"} <= slugs


@pytest.mark.parametrize("header,expected", [
    ("row_index", "row_index"),
    ("ScanRow", "row_index"),
    ("Raster Row", "row_index"),
    ("column_index", "column_index"),
    ("scan_col", "column_index"),
    ("Column", "column_index"),
])
def test_role_from_header_name_recognises_grid_aliases(header, expected):
    assert main._role_from_header_name(header) == expected


# --------------------------------------------------------------------------- #
# Preview
# --------------------------------------------------------------------------- #

def test_preview_reports_grid_roles_for_wizard(client, tmp_path):
    """The preview endpoint pre-selects the dedicated grid-index roles (not the
    generic 'extra') so the wizard dropdown lands on Scan Row/Column Index, and
    pins the canonical slug so a no-edit import carries the raster by name."""
    f = tmp_path / "grid.xyz"
    f.write_text(
        "X Y Z Row Column\n"
        "0 0 0 0 0\n"
        "1 1 1 0 1\n"
        "2 2 2 1 0\n"
    )
    res = client.post("/api/pointcloud/preview", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    cols = res.json()["columns"]
    assert [c["detected_role"] for c in cols[:3]] == ["x", "y", "z"]
    row_col = cols[3]
    assert row_col["detected_role"] == "row_index"
    assert row_col["suggested_slug"] == "row_index"
    col_col = cols[4]
    assert col_col["detected_role"] == "column_index"
    assert col_col["suggested_slug"] == "column_index"


# --------------------------------------------------------------------------- #
# ASCII import round-trip
# --------------------------------------------------------------------------- #

def test_ascii_import_preserves_grid_extras(tmp_path):
    f = tmp_path / "scan.xyz"
    _write_grid_xyz(f)
    las_path, _, _ = main._source_to_las(f, _GRID_FORMAT, tmp_path, None)
    _r = main._read_las_into_arrays(las_path)
    positions = _r.positions
    colors = _r.colors
    intensity = _r.intensity
    extras = _r.extras
    extra_dims_meta = _r.extra_dims_meta
    sess = _session_from_arrays(positions, extras, extra_dims_meta)

    assert len(sess.positions) == len(_GRID_ROWS)
    for slug in main._GRID_INDEX_SLUGS:
        assert slug in sess.extras, f"missing extra {slug}"
        assert len(sess.extras[slug]) == len(_GRID_ROWS)
    # Indices round-trip: a 2x2 grid spans 0..1 on each axis.
    np.testing.assert_allclose(sorted(set(sess.extras["row_index"].tolist())), [0.0, 1.0])
    np.testing.assert_allclose(sorted(set(sess.extras["column_index"].tolist())), [0.0, 1.0])


# --------------------------------------------------------------------------- #
# LAD in-RAM accessor: recovery raster forwarded
# --------------------------------------------------------------------------- #

def test_session_to_lad_arrays_forwards_grid_indices(tmp_path):
    """A session carrying the grid slugs emits them in the LAD data map so the
    C++ grid-based direction recovery has the raster to interpolate over."""
    positions = np.array([r[:3] for r in _GRID_ROWS], dtype=np.float64)
    extras = {
        "row_index": np.array([r[3] for r in _GRID_ROWS], dtype=np.float32),
        "column_index": np.array([r[4] for r in _GRID_ROWS], dtype=np.float32),
    }
    meta = [{"slug": "row_index", "label": "Row Index"},
            {"slug": "column_index", "label": "Column Index"}]
    sess = _session_from_arrays(positions, extras, meta)

    xyz, dirs, labels, vals, flags = main._session_to_lad_arrays(sess, [0, 0, 5])
    assert "row_index" in labels and "column_index" in labels
    np.testing.assert_allclose(
        vals[:, labels.index("row_index")], [r[3] for r in _GRID_ROWS])
    np.testing.assert_allclose(
        vals[:, labels.index("column_index")], [r[4] for r in _GRID_ROWS])


def test_session_to_lad_arrays_no_grid_indices_when_absent(tmp_path):
    """A plain cloud with no grid columns does not get phantom grid labels."""
    positions = np.array([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]], dtype=np.float64)
    sess = _session_from_arrays(positions, {}, [])
    _, _, labels, _, _ = main._session_to_lad_arrays(sess, [0, 0, 5])
    assert "row_index" not in labels and "column_index" not in labels
