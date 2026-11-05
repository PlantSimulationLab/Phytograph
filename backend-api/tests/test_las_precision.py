"""LAS quantization: one adaptive choice, never a hard-coded 1 mm grid.

The 1 mm constant (`header.scales = [0.001]*3`) was copied into a dozen writers
and kept resurfacing; a 0.5 mm-spacing handheld scan exported snapped to a grid
as coarse as its points. These tests pin the chooser (`las_precision`) and fail
the build if any writer in the shipped backend hard-codes a scale again.
"""
from __future__ import annotations

import re
from pathlib import Path

import laspy
import numpy as np
import pytest

import las_precision as lp

REPO = Path(__file__).resolve().parents[2]


def _roundtrip(xyz: np.ndarray, tmp_path: Path, **kw) -> np.ndarray:
    scales, offsets = lp.las_scale_offset(xyz.min(0), xyz.max(0), xyz, **kw)
    h = laspy.LasHeader(point_format=3, version="1.4")
    h.scales, h.offsets = scales, offsets
    las = laspy.LasData(h)
    las.x, las.y, las.z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    p = tmp_path / "t.las"
    las.write(str(p))
    back = laspy.read(str(p))
    return np.c_[back.x, back.y, back.z]


def test_float_cloud_keeps_10_micron_precision(tmp_path):
    rng = np.random.default_rng(0)
    xyz = rng.uniform(-0.5, 2.5, size=(50_000, 3))  # a plant, in meters
    back = _roundtrip(xyz, tmp_path)
    assert np.abs(back - xyz).max() <= lp.FINEST_SCALE / 2 + 1e-12
    # The regression this module exists for: 1 mm would be off by up to 0.5 mm.
    assert np.abs(back - xyz).max() < 1e-4


@pytest.mark.parametrize("scale", [0.01, 0.001, 0.00025, 0.0001])
def test_data_on_a_las_grid_keeps_that_grid_exactly(tmp_path, scale):
    rng = np.random.default_rng(1)
    # A LAS read back: integers times the file's scale plus a non-round offset,
    # then a UTM-sized world shift added in float64.
    ints = rng.integers(0, 2_000_000, size=(20_000, 3))
    xyz = ints * scale + np.array([612_345.678, 4_271_000.25, 12.3])
    scales, offsets = lp.las_scale_offset(xyz.min(0), xyz.max(0), xyz)
    assert np.allclose(scales, scale)
    back = _roundtrip(xyz, tmp_path)
    assert np.abs(back - xyz).max() < scale * 1e-3


def test_millimeter_las_converted_to_meters_is_lossless(tmp_path):
    rng = np.random.default_rng(2)
    xyz = rng.integers(-2_000_000, 2_000_000, size=(10_000, 3)) * 0.001 * 0.001
    back = _roundtrip(xyz, tmp_path)
    assert np.abs(back - xyz).max() < 1e-9


def test_huge_extent_coarsens_instead_of_overflowing(tmp_path):
    rng = np.random.default_rng(3)
    xyz = rng.uniform(0, 60_000, size=(5_000, 3))  # 60 km: 10 µm would overflow int32
    scales, _ = lp.las_scale_offset(xyz.min(0), xyz.max(0), xyz)
    assert np.all(scales > lp.FINEST_SCALE)
    assert np.all(60_001 / scales < 2 ** 31 - 1)
    back = _roundtrip(xyz, tmp_path)
    assert np.abs(back - xyz).max() <= scales.max() / 2 + 1e-9


def test_explicit_scale_is_honored(tmp_path):
    xyz = np.random.default_rng(4).uniform(0, 10, size=(1000, 3))
    scales, _ = lp.las_scale_offset(xyz.min(0), xyz.max(0), xyz, scale=0.001)
    assert np.allclose(scales, 0.001)
    with pytest.raises(ValueError):
        lp.las_scale_offset(xyz.min(0), xyz.max(0), xyz, scale=0)


def test_no_positions_and_degenerate_bounds():
    s, o = lp.las_scale_offset([np.inf] * 3, [-np.inf] * 3)
    assert np.all(np.isfinite(s)) and np.all(np.isfinite(o))
    s, o = lp.las_scale_offset([1, 1, 1], [1, 1, 1], np.ones((5, 3)))
    assert np.allclose(s, lp.FINEST_SCALE)


def test_extra_dim_dtype_keeps_integers_integer():
    assert lp.extra_dim_dtype(np.array([1, 2, 3], np.uint8)) == np.int32
    assert lp.extra_dim_dtype(np.array([-1, 89], np.int8), declared="int32") == np.int32
    assert lp.extra_dim_dtype(np.array([0.5], np.float32)) == np.float32
    assert lp.extra_dim_dtype(np.array([0.5], np.float64)) == np.float64
    # A declared type that cannot hold the values is ignored, not wrapped.
    assert lp.extra_dim_dtype(np.array([300], np.uint16), declared="uint8") == np.int32
    assert lp.extra_dim_dtype(np.array([True, False])) == np.int32
    assert lp.extra_dim_dtype(np.array([True, False]), declared="uint8") == np.uint8


def test_reading_dtype_is_stable_across_clouds():
    # Storage narrows per cloud (int8 here, uint8 there); readers see one type.
    a = lp.column_dtype_for_reading(np.array([-1, 89], np.int8))
    b = lp.column_dtype_for_reading(np.array([64, 91], np.uint8))
    assert a == b == np.int32
    assert lp.column_dtype_for_reading(np.array([64, 91], np.uint8), declared="int16") == np.int16
    assert lp.column_dtype_for_reading(np.array([2 ** 31], np.int64)) == np.int64


# ── the chokepoint ──────────────────────────────────────────────────────────

_SHIPPED = [
    *sorted((REPO / "backend-api").glob("*.py")),
    REPO / "docker" / "riegl" / "rxp_reader.py",
    REPO / "tools" / "gapfill_las_misses.py",
]
# A header scale is assigned in exactly two shapes: from `las_precision`'s
# result (`header.scales = scales`) or, in the reader image, from its mirror
# (`_las_scale_for`). Any right-hand side holding a numeric literal or an
# ALL-CAPS constant is a hard-coded quantum, however it is spelled
# (`[0.001]*3`, `np.full(3, 0.001)`, `(_LAS_SCALE,)*3`).
_SCALES_ASSIGN = re.compile(r"\.scales\s*=(?!=)(?P<rhs>.*)")
_HARDCODED_RHS = re.compile(r"\b\d*\.\d+|\b\d+e-?\d+|\b_?[A-Z][A-Z0-9_]{2,}\b")


@pytest.mark.parametrize("path", _SHIPPED, ids=lambda p: p.name)
def test_no_writer_hard_codes_a_las_scale(path):
    if path.name == "las_precision.py":
        return
    hits = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        code = line.split("#", 1)[0]
        m = _SCALES_ASSIGN.search(code)
        if m and _HARDCODED_RHS.search(m.group("rhs")):
            hits.append(f"{path.name}:{i}: {line.strip()}")
    assert not hits, ("a LAS writer hard-codes its coordinate scale; use "
                      "las_precision.las_scale_offset instead:\n" + "\n".join(hits))


def test_guard_catches_every_spelling():
    for line in ("h.scales = [0.001, 0.001, 0.001]", "h.scales = np.full(3, 0.001)",
                 "h.scales = np.array([_LAS_SCALE] * 3)", "h.scales = (1e-3,) * 3"):
        m = _SCALES_ASSIGN.search(line)
        assert m and _HARDCODED_RHS.search(m.group("rhs")), line
    for line in ("h.scales = scales", "header.scales, header.offsets = lp.f(a, b)",
                 "header.scales = np.full(3, _scale, dtype=np.float64)",
                 "assert h.scales == x"):
        m = _SCALES_ASSIGN.search(line)
        assert not (m and _HARDCODED_RHS.search(m.group("rhs"))), line


def test_riegl_reader_mirror_matches_las_precision():
    """The reader image cannot import `las_precision`; its copy of the rule must
    give the same scale for data on no grid (RiVLib coordinates are float32)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "_rxp_reader_mirror", REPO / "docker" / "riegl" / "rxp_reader.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod._LAS_FINEST_SCALE == lp.FINEST_SCALE
    rng = np.random.default_rng(5)
    for extent in (3.0, 150.0, 19_000.0, 30_000.0, 60_000.0, 900_000.0):
        xyz = rng.uniform(0, extent, size=(2_000, 3)) + 0.123456789
        want, _ = lp.las_scale_offset(xyz.min(0), xyz.max(0), xyz)
        assert mod._las_scale_for(xyz.min(0), xyz.max(0)) == pytest.approx(want[0]), extent


# ── end to end: import → session → /arrays → export ────────────────────────

def _create(client, body):
    from tests.binframe import decode_streamed_json
    res = client.post("/api/cloud/session/create", json=body)
    assert res.status_code == 200, res.text
    return decode_streamed_json(res.content)["session_id"]


def _arrays(client, sid):
    import io
    res = client.get(f"/api/cloud/session/{sid}/arrays")
    assert res.status_code == 200, res.text
    with np.load(io.BytesIO(res.content)) as z:
        return {k: z[k] for k in z.files}


def _export(client, sid, dest=None, **kw):
    from tests.binframe import decode_streamed_json
    body = {"source": {"session_id": sid}, "format": "laz", "filename": "out.laz", **kw}
    if dest is not None:
        body["dest_path"] = str(dest)
    res = client.post("/api/pointcloud/export", json=body)
    assert res.status_code == 200, res.text
    out = decode_streamed_json(res.content) if res.content[:1] != b"{" else res.json()
    assert out["success"], out
    return out


def _write_mm_ply(path: Path, n: int = 4000) -> dict:
    """A handheld-scanner-like PLY: float32 coordinates in MILLIMETERS with
    sub-mm detail, an int32 id above 2**24, a rank with a -1 sentinel, and a
    float64 column whose detail float32 cannot hold."""
    from plyfile import PlyData, PlyElement
    rng = np.random.default_rng(7)
    v = np.empty(n, dtype=[("x", "f4"), ("y", "f4"), ("z", "f4"),
                           ("red", "u1"), ("green", "u1"), ("blue", "u1"),
                           ("rank", "i4"), ("instance_id", "i4"), ("weight", "f8")])
    v["x"] = rng.uniform(-1660, 180, n)
    v["y"] = rng.uniform(-750, 140, n)
    v["z"] = rng.uniform(340, 2150, n)
    v["red"], v["green"], v["blue"] = 68, 119, 242
    v["rank"] = rng.integers(-1, 90, n)
    v["instance_id"] = 30_000_001 + rng.integers(0, 50, n) * 3  # odd, > 2**24
    v["weight"] = 1.0 + rng.integers(0, 10 ** 9, n) * 1e-9
    PlyData([PlyElement.describe(v, "vertex")], text=False).write(str(path))
    return {k: v[k].copy() for k in v.dtype.names}


@pytest.fixture
def mm_ply_session(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    src = _write_mm_ply(tmp_path / "plant_mm.ply")
    sid = _create(client, {"source_path": str(tmp_path / "plant_mm.ply"), "source_units": "mm"})
    return sid, src, tmp_path


def test_info_reports_the_import_unit(client, mm_ply_session):
    sid, _, _ = mm_ply_session
    info = client.get(f"/api/cloud/session/{sid}/info").json()
    assert info["source_units"] == "mm"
    assert info["source_unit_scale"] == pytest.approx(0.001)
    types = {m["slug"]: m.get("dtype") for m in info["extra_dims"]}
    assert types["instance_id"] == "int32" and types["weight"] == "float64"


def test_arrays_are_exact_and_typed_as_declared(client, mm_ply_session):
    sid, src, _ = mm_ply_session
    a = _arrays(client, sid)
    want = np.c_[src["x"], src["y"], src["z"]].astype(np.float64) * 0.001
    assert np.abs(a["positions"] - want).max() < 1e-9
    # int32 in the file -> int32 out, whatever storage narrowed it to; the id
    # above 2**24 is exact (float32 would have rounded the odd values).
    assert a["rank"].dtype == np.int32 and np.array_equal(a["rank"], src["rank"])
    assert a["instance_id"].dtype == np.int32
    assert np.array_equal(a["instance_id"], src["instance_id"])
    assert a["weight"].dtype == np.float64 and np.array_equal(a["weight"], src["weight"])


@pytest.mark.parametrize("streamed", [True, False], ids=["to-file", "inline"])
def test_laz_export_keeps_detail_and_integer_columns(client, mm_ply_session, streamed):
    import base64
    sid, src, tmp = mm_ply_session
    dest = tmp / "out.laz"
    if streamed:
        _export(client, sid, dest=dest)
    else:
        # No dest_path: the generic whole-cloud path, returned inline.
        out = _export(client, sid)
        dest.write_bytes(base64.b64decode(out["data"]))
    las = laspy.read(str(dest))
    assert np.all(las.header.scales <= lp.FINEST_SCALE + 1e-15)
    want = np.c_[src["x"], src["y"], src["z"]].astype(np.float64) * 0.001
    got = np.c_[las.x, las.y, las.z]
    assert np.abs(got - want).max() <= lp.FINEST_SCALE / 2 + 1e-12
    assert las["rank"].dtype == np.int32 and np.array_equal(las["rank"], src["rank"])
    assert las["instance_id"].dtype == np.int32
    assert np.array_equal(las["instance_id"], src["instance_id"])
    assert las["weight"].dtype == np.float64 and np.array_equal(las["weight"], src["weight"])


def test_explicit_las_scale_is_applied(client, mm_ply_session):
    sid, _, tmp = mm_ply_session
    _export(client, sid, dest=tmp / "coarse.laz", las_scale=0.001)
    assert np.allclose(laspy.read(str(tmp / "coarse.laz")).header.scales, 0.001)


def test_millimeter_las_reexports_bit_for_bit(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    rng = np.random.default_rng(8)
    hdr = laspy.LasHeader(point_format=3, version="1.4")
    hdr.scales, hdr.offsets = [0.001] * 3, [612_000.0, 4_271_000.0, 10.0]
    las = laspy.LasData(hdr)
    las.X = rng.integers(0, 40_000, 3000)
    las.Y = rng.integers(0, 40_000, 3000)
    las.Z = rng.integers(0, 20_000, 3000)
    src = tmp_path / "plot.las"
    las.write(str(src))
    sid = _create(client, {"source_path": str(src), "world_shift": [612_000.0, 4_271_000.0, 0.0]})
    _export(client, sid, dest=tmp_path / "again.laz")
    back = laspy.read(str(tmp_path / "again.laz"))
    assert np.allclose(back.header.scales, 0.001)
    assert np.array_equal(np.c_[back.x, back.y, back.z], np.c_[las.x, las.y, las.z])


def test_e57_session_positions_are_not_read_back_from_a_grid(client, tmp_path, monkeypatch):
    pye57 = pytest.importorskip("pye57")
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    rng = np.random.default_rng(9)
    local = rng.uniform(-3, 3, size=(500, 3)).astype(np.float32)
    origin = np.array([10.25, -4.5, 1.75])
    src = tmp_path / "scan.e57"
    with pye57.E57(str(src), mode="w") as e:
        e.write_scan_raw({"cartesianX": local[:, 0].astype(np.float64),
                          "cartesianY": local[:, 1].astype(np.float64),
                          "cartesianZ": local[:, 2].astype(np.float64),
                          "cartesianInvalidState": np.zeros(500, dtype=np.int8)},
                         translation=origin)
    sid = _create(client, {"source_path": str(src)})
    got = _arrays(client, sid)["positions"]
    want = local.astype(np.float64) + origin
    order = np.lexsort(want.T)
    assert np.abs(got[np.lexsort(got.T)] - want[order]).max() < 1e-6
