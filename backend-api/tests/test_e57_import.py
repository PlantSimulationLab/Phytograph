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

from tests.binframe import decode_misses

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


def _write_e57_zeroed_misses(path: Path) -> int:
    """Write a structured cartesian E57 where invalid cells are ZEROED (no
    recoverable direction) but carry rowIndex/columnIndex — the common real-
    scanner layout (mirrors libE57's pumpARowColumnIndex.e57). Returns miss count.
    """
    # 2x3 grid = 6 cells; 2 misses with all-zero coords.
    rows = np.array([0, 0, 0, 1, 1, 1], dtype=np.uint16)
    cols = np.array([0, 1, 2, 0, 1, 2], dtype=np.uint16)
    inv = np.array([0, 1, 0, 0, 0, 1], dtype=np.int8)
    x = np.where(inv == 1, 0.0, np.array([5.0, 0, 5.0, 4.0, 5.0, 0]))
    y = np.where(inv == 1, 0.0, np.array([0.0, 0, 1.0, 1.0, 2.0, 0]))
    z = np.where(inv == 1, 0.0, np.array([0.0, 0, 0.0, 1.0, 0.0, 0]))
    data = {
        "cartesianX": x, "cartesianY": y, "cartesianZ": z,
        "cartesianInvalidState": inv,
        "rowIndex": rows, "columnIndex": cols,
        "intensity": np.array([0.40, 0.0, 0.55, 0.62, 0.70, 0.0], dtype=np.float64),
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


def test_e57_zeroed_misses_kept_flagged_not_dropped(tmp_path):
    """Zeroed-coordinate misses (no recoverable direction) must be KEPT and
    flagged — not dropped — with the grid indices preserved so Helios C++ can
    recover their direction from the raster. Regression for the real-world
    pumpARowColumnIndex.e57 case where all misses were silently dropped."""
    src = tmp_path / "scan.e57"
    expected_misses = _write_e57_zeroed_misses(src)
    out = tmp_path / "out.las"

    n, extra_dims = main._e57_to_las(src, out)
    slugs = {ed["slug"] for ed in extra_dims}

    # All 6 cells survive (nothing dropped); grid indices carried for C++.
    assert n == 6
    assert main._MISS_SLUG in slugs
    assert {"row_index", "column_index"} <= slugs

    pos, _, _, extras, _ = main._read_las_into_arrays(out)
    is_miss = extras[main._MISS_SLUG]
    assert int((is_miss == 1).sum()) == expected_misses == 2

    # Unplaceable misses sit AT the scanner origin (awaiting C++ recovery), not
    # at 20 km — and definitely not dropped.
    miss_pos = pos[is_miss == 1]
    assert np.allclose(miss_pos, _ORIGIN)

    meta = main._e57_scan_meta.get(str(out.resolve()))
    assert meta["unplaceable_miss_count"] == 2
    assert meta["has_misses"] is True

    # row/column indices round-trip for the surviving cells.
    assert extras["row_index"].tolist() == [0, 0, 0, 1, 1, 1]
    assert extras["column_index"].tolist() == [0, 1, 2, 0, 1, 2]


def test_e57_intensity_normalised_from_valid_range(tmp_path):
    """E57 intensity is often 0..1 float; it must be normalised to the LAS uint16
    range from the VALID cells' span, not flat-clipped to ~0. Misses get 0."""
    src = tmp_path / "scan.e57"
    _write_e57_zeroed_misses(src)  # intensity 0.40..0.70 on valid cells
    out = tmp_path / "out.las"

    main._e57_to_las(src, out)
    _, _, intensity, extras, _ = main._read_las_into_arrays(out)
    is_miss = extras[main._MISS_SLUG]

    assert intensity is not None
    valid_int = intensity[is_miss == 0]
    # The valid span (0.40..0.70) stretches across the full uint16 range, so the
    # min maps near 0 and the max near 65535 — NOT all crushed to 0.
    assert int(valid_int.min()) == 0
    assert int(valid_int.max()) >= 60000
    # Misses carry no real return -> zero intensity.
    assert np.all(intensity[is_miss == 1] == 0)


def test_e57_multiscan_uses_per_scan_pose(tmp_path):
    """Each scan is transformed by ITS OWN pose; a two-scan E57's points land at
    their respective origins, and per-scan origins are recorded."""
    src = tmp_path / "multi.e57"
    o0 = np.array([0.0, 0.0, 0.0])
    o1 = np.array([100.0, 0.0, 0.0])
    common = dict(
        cartesianX=np.array([1.0, 2.0]), cartesianY=np.array([0.0, 0.0]),
        cartesianZ=np.array([0.0, 0.0]),
        cartesianInvalidState=np.array([0, 0], dtype=np.int8),
    )
    with pye57.E57(str(src), mode="w") as e:
        e.write_scan_raw({**common}, translation=o0)
        e.write_scan_raw({**common}, translation=o1)
    out = tmp_path / "out.las"

    n, _ = main._e57_to_las(src, out)
    pos, _, _, _, _ = main._read_las_into_arrays(out)
    assert n == 4
    # Scan 0's points are near o0; scan 1's are shifted by ~100 m (its own pose).
    near_o0 = pos[np.linalg.norm(pos - o0, axis=1) < 10]
    near_o1 = pos[np.linalg.norm(pos - o1, axis=1) < 10]
    assert len(near_o0) == 2
    assert len(near_o1) == 2

    meta = main._e57_scan_meta.get(str(out.resolve()))
    assert len(meta["scan_origins"]) == 2
    assert np.allclose(meta["scan_origins"][0], o0)
    assert np.allclose(meta["scan_origins"][1], o1)


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
async def test_misses_endpoint_projects_just_beyond_farthest_hit(tmp_path, monkeypatch):
    """With a scanner origin supplied, misses are projected onto a sphere centred
    on that origin at a radius JUST BEYOND the farthest hit (so they always clear
    the cloud), using the stored beam direction. The fixture's hits sit 5.0 from
    the origin; misses must land at 5.0 * the 5% margin."""
    src = tmp_path / "scan.e57"
    _write_e57(src, with_misses=True)
    monkeypatch.setattr(
        main, "_build_octree_from_las",
        lambda las_path, ed: ("fakecache", tmp_path / "cache", {"point_count": 0}),
    )
    req = main.CloudSessionCreateRequest(source_path=str(src))
    res = await main.create_cloud_session(req)
    sid = res["session_id"]

    out = await decode_misses(await main.get_cloud_misses(
        sid, origin_x=_ORIGIN[0], origin_y=_ORIGIN[1], origin_z=_ORIGIN[2]))
    assert out["count"] == 2
    # Radius clears the farthest hit by a depth-scaled margin so the miss shell
    # reads as a distinct halo well outside the cloud, not a band hugging its far
    # surface: radius = max(far + depth, far*1.4, far + 1.0). All hits here sit at
    # exactly 5.0 from the origin (depth == 0), so the far*1.4 floor wins → 7.0.
    far = 5.0
    assert out["radius"] == pytest.approx(far * 1.4, rel=1e-4)
    pos = np.array(out["positions"]).reshape(-1, 3)
    dist = np.linalg.norm(pos - _ORIGIN, axis=1)
    assert np.allclose(dist, out["radius"], rtol=1e-4)
    assert float(dist.min()) > far  # strictly outside the farthest hit


@pytest.mark.asyncio
async def test_misses_endpoint_no_origin_returns_true_coords(tmp_path, monkeypatch):
    """With NO scanner origin (scan has no params yet), misses come back at their
    TRUE stored coordinates — the array is the source of truth, no relocation.
    The E57 import places misses at the far-field gap distance (~20 km) along the
    real beam direction; they must come back THERE, NOT collapsed onto the hit
    sphere (~5.0 from the origin)."""
    src = tmp_path / "scan.e57"
    _write_e57(src, with_misses=True)
    monkeypatch.setattr(
        main, "_build_octree_from_las",
        lambda las_path, ed: ("fakecache", tmp_path / "cache", {"point_count": 0}),
    )
    res = await main.create_cloud_session(main.CloudSessionCreateRequest(source_path=str(src)))
    sid = res["session_id"]

    out = await decode_misses(await main.get_cloud_misses(sid))  # no origin params
    assert out["count"] == 2
    assert out["radius"] == 0.0  # signals "true coords, not a projection"
    pos = np.array(out["positions"]).reshape(-1, 3)
    # Misses keep their true far-field range (~20 km), NOT the hit radius (~5.0).
    dist = np.linalg.norm(pos - _ORIGIN, axis=1)
    assert np.allclose(dist, main._MISS_GAP_DISTANCE, rtol=1e-4)


@pytest.mark.asyncio
async def test_unplaceable_misses_warned_and_not_drawn(tmp_path, monkeypatch):
    """A scan whose misses are all unplaceable (zeroed cartesian, no angles):
    they're flagged in the session and the create response WARNS about them
    (never silent), but the overlay draws none (no direction yet) while still
    reporting the total."""
    src = tmp_path / "scan.e57"
    _write_e57_zeroed_misses(src)
    monkeypatch.setattr(
        main, "_build_octree_from_las",
        lambda las_path, ed: ("fakecache", tmp_path / "cache", {"point_count": 0}),
    )

    res = await main.create_cloud_session(main.CloudSessionCreateRequest(source_path=str(src)))
    assert res["has_misses"] is True
    assert res["unplaceable_miss_count"] == 2
    assert res.get("warnings") and "could not be placed" in res["warnings"][0]

    # The frontend always passes the scan origin (params.origin / scan_origin).
    o = res["scan_origin"]
    out = await decode_misses(await main.get_cloud_misses(
        res["session_id"], origin_x=o[0], origin_y=o[1], origin_z=o[2]))
    # None drawn (all unplaceable sit AT the scan origin) but total is reported.
    assert out["count"] == 0
    assert out["total"] == 2
    assert out["positions"] == []


def test_e57_preview_omits_is_miss_but_shows_intensity(tmp_path):
    """`is_miss` is a system-managed flag, not a user column — the wizard preview
    must NOT present it (showing it implied a rename the import ignores and an
    all-zero 'scalar' to colour by). Real scalars the file carries (here:
    intensity) ARE surfaced so the user can see/colour by them."""
    src = tmp_path / "scan.e57"
    _write_e57_zeroed_misses(src)  # declares intensity, no colour
    resp = main._preview_e57(str(src))
    headers = [c.header_name for c in resp.columns]
    assert "is_miss" not in headers
    assert headers == ["x", "y", "z", "intensity"]
    assert next(c for c in resp.columns if c.header_name == "intensity").detected_role == "intensity"


def _write_e57_with_color(path: Path) -> None:
    """Write a small cartesian E57 carrying per-channel RGB (uint8 0..255) and
    one miss cell, mirroring real scanners (e.g. pumpARowColumnIndex.e57)."""
    inv = np.array([0, 1, 0, 0], dtype=np.int8)
    rng = np.where(inv == 1, 1.0, 5.0)
    az = np.array([0.0, 0.5, 1.0, 1.5]); el = np.array([0.0, 0.0, 0.0, 0.0])
    data = {
        "cartesianX": rng * np.cos(el) * np.cos(az),
        "cartesianY": rng * np.cos(el) * np.sin(az),
        "cartesianZ": rng * np.sin(el),
        "cartesianInvalidState": inv,
        "colorRed": np.array([255, 100, 0, 0], dtype=np.uint8),
        "colorGreen": np.array([0, 100, 255, 0], dtype=np.uint8),
        "colorBlue": np.array([0, 100, 0, 255], dtype=np.uint8),
    }
    with pye57.E57(str(path), mode="w") as e:
        e.write_scan_raw(data, translation=np.zeros(3))


def test_e57_preview_advertises_rgb_when_present(tmp_path):
    """A colour-bearing E57 surfaces red/green/blue (mapped to the 0-255 RGB
    roles) in the wizard preview alongside x/y/z."""
    src = tmp_path / "colour.e57"
    _write_e57_with_color(src)
    resp = main._preview_e57(str(src))
    by_name = {c.header_name: c.detected_role for c in resp.columns}
    assert by_name["red"] == "r255"
    assert by_name["green"] == "g255"
    assert by_name["blue"] == "b255"


def test_e57_carries_rgb_into_las_misses_black(tmp_path):
    """RGB colour is carried into the LAS (8-bit lifted to the uint16 channel,
    matching the PLY/PCD convention); miss cells get black (no real return)."""
    src = tmp_path / "colour.e57"
    _write_e57_with_color(src)
    out = tmp_path / "out.las"
    main._e57_to_las(src, out)

    _, colors, _, extras, _ = main._read_las_into_arrays(out)
    assert colors is not None
    is_miss = extras[main._MISS_SLUG]

    # Hit colours round-trip: 8-bit value * 256 (e.g. 255 -> 65280, 100 -> 25600).
    hit = colors[is_miss == 0]
    assert hit.max() == 255 * 256
    assert set(np.unique(hit).tolist()) <= {0, 100 * 256, 255 * 256}
    # Misses are black.
    assert np.all(colors[is_miss == 1] == 0)


def test_e57_without_color_has_no_rgb(tmp_path):
    """An E57 with no colour fields produces a cloud with no RGB (the LAS RGB
    channels stay zero, so _read_las_into_arrays surfaces all-black, not garbage)."""
    src = tmp_path / "nocolour.e57"
    _write_e57(src, with_misses=False)  # cartesian + intensity, no colour
    out = tmp_path / "out.las"
    main._e57_to_las(src, out)
    _, colors, _, _, _ = main._read_las_into_arrays(out)
    # RGB channels exist (point format 3) but are all zero — no colour carried.
    assert colors is None or np.all(colors == 0)


def test_las_preview_omits_is_miss_column(tmp_path):
    """An imported LAS carrying is_miss (e.g. a previously-baked scan) likewise
    hides the flag from the wizard rather than offering it as a scalar."""
    las_path = tmp_path / "withmiss.las"
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.add_extra_dim(laspy.ExtraBytesParams(name="is_miss", type=np.float32))
    las = laspy.LasData(header)
    las.x = np.array([0.0, 1.0]); las.y = np.array([0.0, 1.0]); las.z = np.array([0.0, 1.0])
    las["is_miss"] = np.array([0.0, 1.0], dtype=np.float32)
    las.write(str(las_path))

    resp = main._preview_las(str(las_path), 20)
    assert "is_miss" not in [c.header_name for c in resp.columns]


# ---------------------------------------------------------------------------
# Scan-pattern parameter recovery (origin + angular sweep + grid resolution)
# from the E57 header, so a lone-file import auto-populates ScanParameters.
# ---------------------------------------------------------------------------

class _FakeValue:
    def __init__(self, v):
        self._v = v

    def value(self):
        return self._v


class _FakeStruct:
    """Minimal stand-in for a pye57 structure node: __getitem__ returns a node
    whose .value() yields the stored number, matching how ScanHeader reads
    sphericalBounds / indexBounds."""
    def __init__(self, d):
        self._d = d

    def __getitem__(self, key):
        if key not in self._d:
            raise KeyError(key)
        return _FakeValue(self._d[key])


class _FakeHeader:
    def __init__(self, d):
        self._d = d

    def __getitem__(self, key):
        if key not in self._d:
            raise KeyError(key)
        return _FakeStruct(self._d[key])


def test_e57_scan_params_converts_bounds_and_grid():
    """sphericalBounds (radians, elevation-from-XY) -> zenith degrees, azimuth
    degrees; indexBounds row/column min..max -> sample counts."""
    header = _FakeHeader({
        "sphericalBounds": {
            "azimuthStart": 0.0,
            "azimuthEnd": 2.0 * np.pi,          # full 360° sweep
            "elevationMinimum": -np.pi / 2,     # straight down
            "elevationMaximum": np.pi / 2,      # straight up
        },
        "indexBounds": {
            "rowMinimum": 0, "rowMaximum": 99,      # 100 rows  -> n_theta
            "columnMinimum": 0, "columnMaximum": 359,  # 360 cols -> n_phi
        },
    })
    sp = main._e57_scan_params(header, has_grid=True)

    assert sp["phi_min"] == pytest.approx(0.0)
    assert sp["phi_max"] == pytest.approx(360.0)
    # elevation [-90, +90] -> zenith = 90 - elev -> [0, 180], min/max swapped.
    assert sp["theta_min"] == pytest.approx(0.0)
    assert sp["theta_max"] == pytest.approx(180.0)
    assert sp["n_theta"] == 100
    assert sp["n_phi"] == 360


def test_e57_scan_params_elevation_to_zenith_partial_sweep():
    """A scanner that sweeps elevation 30°..60° above horizontal maps to zenith
    30°..60° from +Z (zenith = 90 - elevation, bounds swapped)."""
    header = _FakeHeader({
        "sphericalBounds": {
            "azimuthStart": np.pi / 2,   # 90°
            "azimuthEnd": np.pi,         # 180°
            "elevationMinimum": np.radians(30.0),
            "elevationMaximum": np.radians(60.0),
        },
    })
    sp = main._e57_scan_params(header, has_grid=False)
    assert sp["phi_min"] == pytest.approx(90.0)
    assert sp["phi_max"] == pytest.approx(180.0)
    assert sp["theta_min"] == pytest.approx(30.0)   # 90 - 60
    assert sp["theta_max"] == pytest.approx(60.0)   # 90 - 30
    # No indexBounds -> no sample counts populated (stays blank -> default).
    assert "n_theta" not in sp and "n_phi" not in sp


def test_e57_scan_params_absent_substructures_yield_empty():
    """When the header carries neither sphericalBounds nor indexBounds, the
    helper returns an empty dict — the file simply omitted the metadata and the
    renderer falls back to its defaults (XML-parity 'blank stays blank')."""
    sp = main._e57_scan_params(_FakeHeader({}), has_grid=True)
    assert sp == {}


@pytest.mark.asyncio
async def test_create_session_forwards_scan_params_origin(tmp_path, monkeypatch):
    """End-to-end: a lone E57 import surfaces scan_params (origin always; the
    fabricated fixture carries no bounds, so only origin is present) so the
    renderer can auto-create a Scan with populated ScanParameters."""
    src = tmp_path / "scan.e57"
    _write_e57(src, with_misses=True)
    monkeypatch.setattr(
        main, "_build_octree_from_las",
        lambda las_path, ed: ("fakecache", tmp_path / "cache", {"point_count": 0}),
    )
    res = await main.create_cloud_session(main.CloudSessionCreateRequest(source_path=str(src)))
    assert "scan_params" in res
    assert np.allclose(res["scan_params"]["origin"], _ORIGIN)


def test_e57_grid_scan_recovers_resolution_from_real_header(tmp_path):
    """Against a REAL pye57 header (not a stub): a 2x3 raster E57 (carrying
    rowIndex/columnIndex) yields grid sample counts in scan_params, while a flat
    cloud's degenerate indexBounds is correctly ignored."""
    src = tmp_path / "grid.e57"
    _write_e57_zeroed_misses(src)  # 2 rows x 3 cols, with row/column indices
    out = tmp_path / "out.las"
    main._e57_to_las(src, out)

    meta = main._e57_scan_meta.get(str(out.resolve()))
    sp = meta["scan_params"]
    assert np.allclose(sp["origin"], _ORIGIN)
    # rows -> n_theta, columns -> n_phi (grid is trusted because indices exist).
    assert sp["n_theta"] == 2
    assert sp["n_phi"] == 3


def test_e57_flat_scan_does_not_fake_grid_resolution(tmp_path):
    """A flat (non-raster) E57 carries no row/column indices. pye57 still writes
    a degenerate indexBounds (rowMaximum = point_count - 1), but we must NOT
    surface that as a zenith resolution — only origin should be populated."""
    src = tmp_path / "flat.e57"
    _write_e57(src, with_misses=False)  # 6 cells, no rowIndex/columnIndex
    out = tmp_path / "out.las"
    main._e57_to_las(src, out)

    sp = main._e57_scan_meta.get(str(out.resolve()))["scan_params"]
    assert np.allclose(sp["origin"], _ORIGIN)
    assert "n_theta" not in sp
    assert "n_phi" not in sp
