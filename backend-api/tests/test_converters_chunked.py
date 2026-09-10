"""The PLY and E57 converters write their LAS in blocks, from one scan / a
memory map at a time, without changing the file they produce.

Pinned by invariance under the block size: the LAS written with a 7-row block
is identical (coordinates, colours, intensity, every extra dim, header
offsets and bounds) to the one written with the default block, so a chunk
boundary can never drop, duplicate or misalign a row.
"""
from pathlib import Path

import numpy as np
import pytest

import main
from tests.test_e57_import import _write_e57, _ORIGIN  # noqa: F401
from tests.test_ply_misses import _write_ply

pye57 = pytest.importorskip("pye57")


def _same_las(a_path: Path, b_path: Path):
    import laspy

    a, b = laspy.read(str(a_path)), laspy.read(str(b_path))
    assert len(a.points) == len(b.points)
    assert list(a.header.offsets) == list(b.header.offsets)
    np.testing.assert_allclose(a.header.mins, b.header.mins, atol=2e-3)
    np.testing.assert_allclose(a.header.maxs, b.header.maxs, atol=2e-3)
    for dim in a.point_format.dimension_names:
        np.testing.assert_array_equal(np.asarray(a[dim]), np.asarray(b[dim]), err_msg=dim)
    assert list(a.point_format.extra_dimension_names) == list(b.point_format.extra_dimension_names)


def test_e57_multiscan_output_is_invariant_under_block_size(tmp_path, monkeypatch):
    src = tmp_path / "two.e57"
    rng = np.random.default_rng(0)
    n = 37
    common = {
        "cartesianX": rng.uniform(-2, 2, n), "cartesianY": rng.uniform(-2, 2, n),
        "cartesianZ": rng.uniform(0, 3, n), "intensity": rng.uniform(0, 1, n),
        "colorRed": rng.integers(0, 255, n).astype(np.uint8),
        "colorGreen": rng.integers(0, 255, n).astype(np.uint8),
        "colorBlue": rng.integers(0, 255, n).astype(np.uint8),
        "rowIndex": np.arange(n) // 5, "columnIndex": np.arange(n) % 5,
        "cartesianInvalidState": (rng.random(n) < 0.2).astype(np.int8),
    }
    with pye57.E57(str(src), mode="w") as e:
        e.write_scan_raw({**common}, translation=np.array([0.0, 0.0, 1.5]))
        e.write_scan_raw({**common}, translation=np.array([10.0, -3.0, 1.5]))
    big, small = tmp_path / "big.las", tmp_path / "small.las"
    n_big, dims_big = main._e57_to_las(src, big)
    monkeypatch.setattr(main, "_LAS_WRITE_CHUNK", 7)
    n_small, dims_small = main._e57_to_las(src, small)
    assert n_big == n_small == 2 * n
    assert dims_big == dims_small
    assert {"row_index", "column_index", "is_miss"} <= {d["slug"] for d in dims_big}
    _same_las(big, small)
    meta = main._import_scan_meta[str(small.resolve())]
    assert meta["has_misses"] and meta["miss_count"] == 2 * int(common["cartesianInvalidState"].sum())
    assert len(meta["scan_origins"]) == 2


def test_e57_single_scan_matches_the_miss_fixture(tmp_path, monkeypatch):
    src = tmp_path / "m.e57"
    _write_e57(src, with_misses=True)
    big, small = tmp_path / "big.las", tmp_path / "small.las"
    main._e57_to_las(src, big)
    monkeypatch.setattr(main, "_LAS_WRITE_CHUNK", 5)
    main._e57_to_las(src, small)
    _same_las(big, small)


@pytest.mark.parametrize("text", [True, False])
def test_ply_output_is_invariant_under_block_size(tmp_path, monkeypatch, text):
    from plyfile import PlyData, PlyElement

    rng = np.random.default_rng(1)
    n = 53
    verts = np.zeros(n, dtype=[("x", "f4"), ("y", "f4"), ("z", "f4"), ("red", "u1"),
                               ("green", "u1"), ("blue", "u1"), ("reflectance", "f4"),
                               ("is_miss", "u1")])
    verts["x"] = rng.uniform(0, 5, n); verts["y"] = rng.uniform(0, 5, n); verts["z"] = rng.uniform(0, 2, n)
    verts["red"] = rng.integers(0, 255, n); verts["green"] = rng.integers(0, 255, n); verts["blue"] = rng.integers(0, 255, n)
    verts["reflectance"] = rng.uniform(-10, 0, n)
    verts["is_miss"] = (rng.random(n) < 0.1)
    verts["x"][3] = np.nan          # an undirected miss: dropped
    src = tmp_path / "p.ply"
    PlyData([PlyElement.describe(verts, "vertex")], text=text).write(str(src))
    big, small = tmp_path / "big.las", tmp_path / "small.las"
    n_big, dims_big = main._ply_to_las(src, big)
    monkeypatch.setattr(main, "_LAS_WRITE_CHUNK", 7)
    n_small, dims_small = main._ply_to_las(src, small)
    assert n_big == n_small == n - 1
    assert dims_big == dims_small
    _same_las(big, small)
