"""Tests for E57 import with sky/miss recovery (_e57_to_las).

E57 carries a structured scan grid; cells with no return are flagged via
cartesianInvalidState. _e57_to_las turns those into far-field miss points
(origin + dir * 20 km) tagged is_miss=1, while real returns become world points
tagged is_miss=0. The scanner origin (pose translation) is stashed for the
create endpoint.

These exercise the converter directly against a fabricated E57, then the
end-to-end session-create path to confirm misses live in the session but are
EXCLUDED from the octree (so far-field coords don't poison the bounding box).
"""

from pathlib import Path
import tempfile

import numpy as np
import pytest

import main

pye57 = pytest.importorskip("pye57")
laspy = pytest.importorskip("laspy")

# Scanner origin used by the fixtures.
_ORIGIN = np.array([1.0, 2.0, 3.0], dtype=np.float64)


def _write_e57(path: Path, *, with_misses: bool) -> int:
    """Write a tiny structured cartesian E57. Returns the miss count.

    6 cells; when with_misses, 2 carry cartesianInvalidState=1 and a UNIT-range
    direction (pye57's write_scan_raw only persists cartesian, so misses must
    carry a non-zero direction vector to be placeable as far-field points).
    """
    az = np.array([0.0, 0.5, 1.0, 0.0, 0.5, 1.0], dtype=np.float64)
    el = np.array([0.0, 0.0, 0.0, 0.3, 0.3, 0.3], dtype=np.float64)
    inv = (np.array([0, 1, 0, 0, 0, 1], dtype=np.int8) if with_misses
           else np.zeros(6, dtype=np.int8))
    rng = np.where(inv == 1, 1.0, 5.0)  # misses keep a unit-length direction
    x = rng * np.cos(el) * np.cos(az)
    y = rng * np.cos(el) * np.sin(az)
    z = rng * np.sin(el)
    data = {
        "cartesianX": x, "cartesianY": y, "cartesianZ": z,
        "cartesianInvalidState": inv,
        "intensity": np.array([10, 0, 12, 13, 14, 0], dtype=np.float64),
    }
    with pye57.E57(str(path), mode="w") as e:
        e.write_scan_raw(data, translation=_ORIGIN)
    return int((inv != 0).sum())


def test_e57_converter_tags_and_places_misses(tmp_path):
    src = tmp_path / "scan.e57"
    expected_misses = _write_e57(src, with_misses=True)
    out = tmp_path / "out.las"

    n, extra_dims = main._e57_to_las(src, out)

    # All 6 cells survive (2 misses + 4 hits) and is_miss is an extra dim.
    assert n == 6
    assert {ed["slug"] for ed in extra_dims} == {main._MISS_SLUG}

    pos, colors, intensity, extras, _ = main._read_las_into_arrays(out)
    is_miss = extras[main._MISS_SLUG]
    assert int((is_miss == 1).sum()) == expected_misses == 2
    assert int((is_miss == 0).sum()) == 4

    # Misses sit ~20 km from the scanner origin along their beam direction.
    miss_pos = pos[is_miss == 1]
    dist = np.linalg.norm(miss_pos - _ORIGIN, axis=1)
    assert np.allclose(dist, main._MISS_GAP_DISTANCE, rtol=1e-4)

    # Hits are real near-field points (range ~5 m from origin).
    hit_dist = np.linalg.norm(pos[is_miss == 0] - _ORIGIN, axis=1)
    assert np.all(hit_dist < 100.0)

    # Scanner origin is captured for the create endpoint.
    meta = main._e57_scan_meta.get(str(out.resolve()))
    assert meta is not None
    assert np.allclose(meta["origin"], _ORIGIN)
    assert meta["has_misses"] is True
    assert meta["miss_count"] == 2


def test_e57_without_misses_has_no_miss_points(tmp_path):
    src = tmp_path / "scan.e57"
    _write_e57(src, with_misses=False)
    out = tmp_path / "out.las"

    n, _ = main._e57_to_las(src, out)
    _, _, _, extras, _ = main._read_las_into_arrays(out)
    assert n == 6
    # is_miss extra dim is present but all zero.
    assert int((extras[main._MISS_SLUG] != 0).sum()) == 0


@pytest.mark.asyncio
async def test_create_session_keeps_misses_out_of_octree(tmp_path, monkeypatch):
    """End-to-end: session holds hits+misses, but the octree LAS is hits-only
    so its bounding box stays tight (far-field misses excluded)."""
    src = tmp_path / "scan.e57"
    _write_e57(src, with_misses=True)

    # Capture the LAS handed to PotreeConverter so we can assert it's hits-only,
    # and stub the converter (no native PotreeConverter needed for this check).
    captured = {}

    def _fake_build(las_path, extra_dims_meta):
        with laspy.open(str(las_path)) as r:
            las = r.read()
        captured["n"] = len(las.x)
        captured["bbox"] = (
            float(np.min(las.x)), float(np.max(las.x)),
            float(np.min(las.y)), float(np.max(las.y)),
            float(np.min(las.z)), float(np.max(las.z)),
        )
        return "fakecache", tmp_path / "cache", {"point_count": len(las.x)}

    monkeypatch.setattr(main, "_build_octree_from_las", _fake_build)

    req = main.CloudSessionCreateRequest(source_path=str(src))
    res = await main.create_cloud_session(req)

    # The octree got HITS ONLY (4), not the 2 far-field misses.
    assert captured["n"] == 4
    # Bounding box is tight — no 20 km coordinate leaked in.
    assert max(abs(v) for v in captured["bbox"]) < 1000.0

    # Response advertises misses + origin; session retains all 6 points.
    assert res["has_misses"] is True
    assert res["miss_count"] == 2
    assert np.allclose(res["scan_origin"], _ORIGIN)
    sess = main._cloud_sessions[res["session_id"]]
    assert len(sess.positions) == 6
    assert int((sess.extras[main._MISS_SLUG] != 0).sum()) == 2


@pytest.mark.asyncio
async def test_misses_endpoint_relocates_onto_bounding_sphere(tmp_path, monkeypatch):
    src = tmp_path / "scan.e57"
    _write_e57(src, with_misses=True)
    monkeypatch.setattr(
        main, "_build_octree_from_las",
        lambda las_path, ed: ("fakecache", tmp_path / "cache", {"point_count": 0}),
    )
    req = main.CloudSessionCreateRequest(source_path=str(src))
    res = await main.create_cloud_session(req)
    sid = res["session_id"]

    out = await main.get_cloud_misses(
        sid, origin_x=_ORIGIN[0], origin_y=_ORIGIN[1], origin_z=_ORIGIN[2])
    assert out["count"] == 2
    assert out["radius"] > 0
    pos = np.array(out["positions"]).reshape(-1, 3)
    # Relocated misses sit exactly at the hit bounding-sphere radius.
    dist = np.linalg.norm(pos - _ORIGIN, axis=1)
    assert np.allclose(dist, out["radius"], rtol=1e-4)
