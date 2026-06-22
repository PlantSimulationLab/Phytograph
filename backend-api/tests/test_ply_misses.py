"""Tests for sky/miss recovery from structured / organized PLY (_ply_to_las).

A PLY can mark misses two ways:
  - an explicit is_miss / miss / sky vertex property, or
  - non-finite (NaN/Inf) coordinates in an organized grid.

_ply_to_las normalises both into the canonical `is_miss` extra dim. A generic
PLY has no scanner origin, so a NaN-coord miss has no recoverable direction and
is dropped; an explicit flag on finite (e.g. Helios far-field) coords is kept.
"""

from pathlib import Path

import numpy as np
import pytest

import main

laspy = pytest.importorskip("laspy")
plyfile = pytest.importorskip("plyfile")
from plyfile import PlyData, PlyElement  # noqa: E402


def _write_ply(path: Path, vertices: np.ndarray) -> None:
    el = PlyElement.describe(vertices, "vertex")
    PlyData([el], text=True).write(str(path))


def test_ply_explicit_is_miss_flag_carried(tmp_path):
    # 4 finite points; 1 flagged is_miss=1 (e.g. a Helios far-field export).
    verts = np.array(
        [
            (0.0, 0.0, 0.0, 0),
            (1.0, 0.0, 0.0, 0),
            (0.0, 1.0, 0.0, 0),
            (20000.0, 0.0, 0.0, 1),
        ],
        dtype=[("x", "f4"), ("y", "f4"), ("z", "f4"), ("is_miss", "u1")],
    )
    src = tmp_path / "scan.ply"
    _write_ply(src, verts)
    out = tmp_path / "out.las"

    n, extra_dims = main._ply_to_las(src, out)
    assert n == 4
    assert main._MISS_SLUG in {ed["slug"] for ed in extra_dims}

    _r = main._read_las_into_arrays(out)
    extras = _r.extras
    is_miss = extras[main._MISS_SLUG]
    assert int((is_miss == 1).sum()) == 1
    assert int((is_miss == 0).sum()) == 3


def test_ply_miss_alias_property(tmp_path):
    # The 'sky' property is an accepted alias for the miss flag.
    verts = np.array(
        [(0.0, 0.0, 0.0, 0), (1.0, 1.0, 1.0, 1)],
        dtype=[("x", "f4"), ("y", "f4"), ("z", "f4"), ("sky", "u1")],
    )
    src = tmp_path / "scan.ply"
    _write_ply(src, verts)
    out = tmp_path / "out.las"

    main._ply_to_las(src, out)
    _r = main._read_las_into_arrays(out)
    extras = _r.extras
    # 'sky' folds into is_miss, not a generic 'sky' extra dim.
    assert main._MISS_SLUG in extras
    assert "sky" not in extras
    assert int((extras[main._MISS_SLUG] == 1).sum()) == 1


def test_ply_nan_coords_dropped_as_undirected_misses(tmp_path):
    # Organized PLY: NaN-coord cells are misses with no recoverable direction
    # (no scanner origin in a generic PLY), so they're dropped — but the
    # surviving points still get an is_miss column (all zero here).
    verts = np.array(
        [
            (0.0, 0.0, 0.0),
            (np.nan, np.nan, np.nan),
            (2.0, 0.0, 0.0),
        ],
        dtype=[("x", "f4"), ("y", "f4"), ("z", "f4")],
    )
    src = tmp_path / "scan.ply"
    _write_ply(src, verts)
    out = tmp_path / "out.las"

    n, extra_dims = main._ply_to_las(src, out)
    assert n == 2  # the NaN row was dropped
    assert main._MISS_SLUG in {ed["slug"] for ed in extra_dims}
    _r = main._read_las_into_arrays(out)
    extras = _r.extras
    assert np.all(np.isfinite(extras[main._MISS_SLUG]))


def test_plain_ply_unchanged_no_miss_dim(tmp_path):
    # A plain PLY with no miss info gets NO is_miss extra dim (behavior intact).
    verts = np.array(
        [(0.0, 0.0, 0.0), (1.0, 1.0, 1.0)],
        dtype=[("x", "f4"), ("y", "f4"), ("z", "f4")],
    )
    src = tmp_path / "scan.ply"
    _write_ply(src, verts)
    out = tmp_path / "out.las"

    n, extra_dims = main._ply_to_las(src, out)
    assert n == 2
    assert main._MISS_SLUG not in {ed["slug"] for ed in extra_dims}
