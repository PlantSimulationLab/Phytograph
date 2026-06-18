"""Tests for using a Helios <ASCII_format> as the column legend when the
referenced point file has no header comment.

A Helios scan XML may carry an <ASCII_format> tag (e.g.
'row col x y z r255 g255 b255 reflectance') that names each column of the
referenced .xyz. When that .xyz has no header line of its own, the ASCII_format
is the only source of column meaning, so it must:

  - resolve each token through the same alias set a real header column would
    (`row`->row_index, `col`->column_index, `red`->r255, `reflectivity`->
    reflectance, ...) rather than dropping unrecognised spellings to 'skip';
  - carry an unrecognised legend word (a custom scalar like 'deviation') as a
    labelled extra dimension named from the word, not a positional 'Column N';
  - surface those same labels in the wizard preview so the suggestion matches
    what import produces.

This mirrors the real example-datasets/BPPtree_scaninds.xml, whose
<ASCII_format> is 'row col x y z r255 g255 b255 reflectance' and whose .xyz
(BPP_tree.3_Scan_000.xyz) is headerless.
"""

from pathlib import Path

import numpy as np
import pytest

import main


# The exact ASCII_format from example-datasets/BPPtree_scaninds.xml, against a
# headerless .xyz (no '#'-commented legend line).
_BPP_FORMAT = "row col x y z r255 g255 b255 reflectance"
_BPP_ROWS = [
    # row col   x      y      z       r    g    b   refl
    (1, 433, -0.17, 0.00, 134.28, 82, 95, 201, 255),
    (2, 7890, -0.02, -0.01, 127.13, 83, 96, 206, 151),
    (3, 2269, -0.16, 0.04, 129.01, 82, 94, 206, 243),
]


def _write_headerless(path: Path, rows) -> None:
    path.write_text("\n".join(" ".join(str(v) for v in r) for r in rows) + "\n")


# --------------------------------------------------------------------------- #
# Tokeniser: legend words resolve through the header-alias set
# --------------------------------------------------------------------------- #

def test_tokenize_resolves_row_col_aliases():
    """'row'/'col' are scan-raster aliases — they map to the canonical grid
    slugs, not 'skip' (which is what bare _XYZ_KNOWN_ROLES membership gave)."""
    roles = main._tokenize_ascii_format(_BPP_FORMAT)
    assert roles == [
        "row_index", "column_index", "x", "y", "z",
        "r255", "g255", "b255", "reflectance",
    ]


@pytest.mark.parametrize("token,expected", [
    ("row", "row_index"),
    ("col", "column_index"),
    ("red", "r255"),
    ("reflectivity", "reflectance"),
    ("easting", "x"),
    ("northing", "y"),
])
def test_tokenize_uses_header_alias_set(token, expected):
    """A single legend token resolves the same way the matching header name
    would (`_role_from_header_name`)."""
    assert main._tokenize_ascii_format(f"x y z {token}")[-1] == expected


def test_tokenize_passes_unknown_word_through_not_skip():
    """An unrecognised legend word is carried verbatim (lower-cased), so the
    column can be labelled from it — not dropped to 'skip'."""
    assert main._tokenize_ascii_format("x y z Deviation") == [
        "x", "y", "z", "deviation",
    ]


# --------------------------------------------------------------------------- #
# Column plan: legend labels the columns when the file has no header
# --------------------------------------------------------------------------- #

def test_plan_labels_extras_from_legend_without_header():
    """With no file header, an unrecognised legend word becomes an extra dim
    labelled/slugged from the word (not a positional 'Column N')."""
    roles = main._tokenize_ascii_format("x y z deviation amplitude")
    names, extras = main._plan_columns(roles, None)
    assert names[:3] == ["x", "y", "z"]
    by_slug = {e["slug"]: e for e in extras}
    assert by_slug["deviation"]["label"] == "deviation"
    assert by_slug["amplitude"]["label"] == "amplitude"


def test_bpp_format_plan_carries_grid_and_colour(tmp_path):
    """The full BPP legend over a headerless file maps colour/reflectance to
    reserved roles and carries row/col as the canonical grid-index extras."""
    f = tmp_path / "headerless.xyz"
    _write_headerless(f, _BPP_ROWS)
    names, extras = main._xyz_column_plan(f, _BPP_FORMAT, None)
    # x y z + r255 g255 b255 + reflectance keep reserved role tokens.
    assert "x" in names and "reflectance" in names and "r255" in names
    slugs = {e["slug"] for e in extras}
    assert {"row_index", "column_index"} <= slugs


# --------------------------------------------------------------------------- #
# Preview: the wizard sees the legend-derived labels
# --------------------------------------------------------------------------- #

def test_preview_uses_legend_for_headerless_file(client, tmp_path):
    """The preview endpoint, given the ASCII_format hint for a headerless file,
    pre-selects grid roles for row/col and labels colour/reflectance — matching
    what a no-edit import produces."""
    f = tmp_path / "headerless.xyz"
    _write_headerless(f, _BPP_ROWS)
    res = client.post("/api/pointcloud/preview",
                      json={"file_path": str(f), "ascii_format": _BPP_FORMAT})
    assert res.status_code == 200, res.text
    cols = res.json()["columns"]
    roles = [c["detected_role"] for c in cols]
    assert roles == [
        "row_index", "column_index", "x", "y", "z",
        "r255", "g255", "b255", "reflectance",
    ]
    # The grid columns carry canonical slugs so a no-edit import finds the raster.
    assert cols[0]["suggested_slug"] == "row_index"
    assert cols[1]["suggested_slug"] == "column_index"
    # Each column's heading is the raw legend token (the wizard renders this as
    # the column's name), mirroring a commented '# row col x y z ...' header.
    assert [c["header_name"] for c in cols] == _BPP_FORMAT.split()
    # The file itself still has no header row — the legend names the columns for
    # display only, so every data row is read (none skipped as a header).
    assert res.json()["has_header"] is False
    assert len(res.json()["sample_rows"]) == len(_BPP_ROWS)


def test_preview_labels_unknown_legend_word(client, tmp_path):
    """An unrecognised legend word over a headerless file is shown as a labelled
    'extra' column named from the word, not 'Column N'."""
    f = tmp_path / "dev.xyz"
    _write_headerless(f, [(0.1, 0.2, 1.0, 5.0), (0.3, 0.4, 1.5, 6.0)])
    res = client.post("/api/pointcloud/preview",
                      json={"file_path": str(f), "ascii_format": "x y z deviation"})
    assert res.status_code == 200, res.text
    last = res.json()["columns"][3]
    assert last["detected_role"] == "extra"
    assert last["suggested_label"] == "deviation"
    assert last["suggested_slug"] == "deviation"
    # The column heading reads the legend word, not a 'column N' placeholder.
    assert last["header_name"] == "deviation"


# --------------------------------------------------------------------------- #
# Round-trip: the legend-named columns survive import into a session
# --------------------------------------------------------------------------- #

def test_bpp_legend_round_trips_grid_extras(tmp_path):
    """A headerless file imported with the BPP legend carries row/col into the
    session as the canonical grid-index extras (the LAD recovery raster)."""
    f = tmp_path / "scan.xyz"
    _write_headerless(f, _BPP_ROWS)
    las_path, _, _ = main._source_to_las(f, _BPP_FORMAT, tmp_path, None)
    positions, colors, intensity, extras, extra_dims_meta = main._read_las_into_arrays(las_path)

    assert len(positions) == len(_BPP_ROWS)
    for slug in main._GRID_INDEX_SLUGS:
        assert slug in extras, f"missing extra {slug}"
    # Colours came through the colour channel, not as extras.
    assert colors is not None
    np.testing.assert_allclose(
        sorted(extras["row_index"].tolist()), [1.0, 2.0, 3.0])
