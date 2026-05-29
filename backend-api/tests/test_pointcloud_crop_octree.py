"""Tests for /api/pointcloud/crop_octree.

Mirrors the structure of test_pointcloud_convert_to_octree.py — needs a real
PotreeConverter binary and isolates cache state per-test via
PHYTOGRAPH_OCTREE_CACHE_ROOT. The crop endpoint is the M3 path for
replacing flat-array crop apply: the renderer hot-swaps to the returned
cache id rather than receiving a PHX1 binary.

Acceptance shape:
  - Box crops produce a new octree whose point count matches NumPy's
    boolean-mask count of the same predicate.
  - Polygon crops project via the renderer's frozen camera matrices; the
    NumPy implementation must agree with the renderer's pointInPolygon /
    projectWorldToCanvasPixel helpers on every point.
  - Identical (source + region + translation) requests hit cache; any
    change to those three inputs misses.
  - Empty result returns HTTP 200 with point_count=0 and no cache entry
    (the renderer raises a delete-confirmation rather than 4xx-ing).
"""

import json
import os
from pathlib import Path

import numpy as np
import pytest

import main


def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _converter_available(),
    reason="PotreeConverter binary not found; build it via npm run build:potree-converter",
)


@pytest.fixture
def cache_root(tmp_path, monkeypatch) -> Path:
    """Per-test isolated cache root so tests don't share state."""
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


@pytest.fixture
def grid_xyz(tmp_path) -> Path:
    """A 10×10×10 grid of points spanning [0, 0.9]^3 in 0.1 steps.

    1000 points total. Predictable enough that a NumPy reference filter
    can produce the expected post-crop count exactly. RGB and reflectance
    columns are present so the BPPtree ascii_format ("x y z r255 g255 b255
    reflectance") parses cleanly.
    """
    f = tmp_path / "grid.xyz"
    lines = []
    for i in range(10):
        for j in range(10):
            for k in range(10):
                x = i * 0.1
                y = j * 0.1
                z = k * 0.1
                r = (i * 17) % 256
                g = (j * 23) % 256
                b = (k * 31) % 256
                refl = ((i + j + k) * 0.01) % 1.0
                lines.append(f"{x:.4f} {y:.4f} {z:.4f} {r} {g} {b} {refl:.4f}")
    f.write_text("\n".join(lines) + "\n")
    return f


@pytest.fixture
def grid_points(grid_xyz) -> np.ndarray:
    """NumPy reference for the same grid as grid_xyz. Used to compute
    the expected post-crop count without re-implementing the parser.

    Read the fixture file back rather than reconstructing the values via
    `i * 0.1`. The endpoint parses through pandas, which round-trips
    "0.7000" → exactly 0.7 (the closest float64). Reconstructing
    arithmetically gives 0.7000000000000001 for some entries, which
    flips boundary-inclusion at the crop limits and disagrees with the
    endpoint's predicate by a few points on every axis."""
    import pandas as pd_local
    df = pd_local.read_csv(
        grid_xyz,
        sep=r"\s+",
        header=None,
        names=["x", "y", "z", "r", "g", "b", "refl"],
        engine="c",
    )
    return df[["x", "y", "z"]].to_numpy(dtype=np.float64)


GRID_FORMAT = "x y z r255 g255 b255 reflectance"


# ---------------------------------------------------------------------------
# Box crop
# ---------------------------------------------------------------------------

def test_box_crop_count_matches_numpy_reference(
    client, cache_root, grid_xyz, grid_points,
):
    """The endpoint's kept count should equal NumPy's boolean-mask count
    over the same AABB. Any drift means the chunked filter disagrees with
    the in-memory predicate."""
    cmin = [0.2, 0.2, 0.2]
    cmax = [0.7, 0.7, 0.7]
    expected = int(np.sum(
        (grid_points[:, 0] >= cmin[0]) & (grid_points[:, 0] <= cmax[0]) &
        (grid_points[:, 1] >= cmin[1]) & (grid_points[:, 1] <= cmax[1]) &
        (grid_points[:, 2] >= cmin[2]) & (grid_points[:, 2] <= cmax[2])
    ))
    assert expected > 0  # sanity

    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {"kind": "box", "min": cmin, "max": cmax, "invert": False},
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["point_count"] == expected
    assert body["cached"] is False
    assert (Path(body["cache_dir"]) / "octree.bin").is_file()


def test_box_crop_invert_keeps_complement(
    client, cache_root, grid_xyz, grid_points,
):
    cmin = [0.2, 0.2, 0.2]
    cmax = [0.7, 0.7, 0.7]
    inside = (
        (grid_points[:, 0] >= cmin[0]) & (grid_points[:, 0] <= cmax[0]) &
        (grid_points[:, 1] >= cmin[1]) & (grid_points[:, 1] <= cmax[1]) &
        (grid_points[:, 2] >= cmin[2]) & (grid_points[:, 2] <= cmax[2])
    )
    expected = int(np.sum(~inside))

    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {"kind": "box", "min": cmin, "max": cmax, "invert": True},
        },
    )
    body = res.json()
    assert body["point_count"] == expected


def test_box_crop_with_translation_bakes_offset_before_test(
    client, cache_root, grid_xyz, grid_points,
):
    """Translation is applied to positions BEFORE the AABB test. So a
    crop box centred at the origin combined with a translation that shifts
    the cloud onto that origin should keep the points that *land in* the
    crop after translation."""
    translation = [-0.45, -0.45, -0.45]  # shift cloud center near origin
    cmin = [-0.2, -0.2, -0.2]
    cmax = [0.2, 0.2, 0.2]

    translated = grid_points + np.array(translation, dtype=np.float64)
    expected = int(np.sum(
        (translated[:, 0] >= cmin[0]) & (translated[:, 0] <= cmax[0]) &
        (translated[:, 1] >= cmin[1]) & (translated[:, 1] <= cmax[1]) &
        (translated[:, 2] >= cmin[2]) & (translated[:, 2] <= cmax[2])
    ))

    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {"kind": "box", "min": cmin, "max": cmax, "invert": False},
            "translation": translation,
        },
    )
    body = res.json()
    assert body["point_count"] == expected


# ---------------------------------------------------------------------------
# Cache keying
# ---------------------------------------------------------------------------

def test_identical_request_hits_cache(client, cache_root, grid_xyz):
    payload = {
        "source_path": str(grid_xyz),
        "ascii_format": GRID_FORMAT,
        "region": {"kind": "box", "min": [0.1, 0.1, 0.1], "max": [0.8, 0.8, 0.8]},
    }
    body1 = client.post("/api/pointcloud/crop_octree", json=payload).json()
    assert body1["cached"] is False
    bin_mtime = Path(body1["cache_dir"], "octree.bin").stat().st_mtime_ns

    body2 = client.post("/api/pointcloud/crop_octree", json=payload).json()
    assert body2["cached"] is True
    assert body2["cache_id"] == body1["cache_id"]
    # The converter must not have re-written the file on the cache hit.
    assert Path(body2["cache_dir"], "octree.bin").stat().st_mtime_ns == bin_mtime


def test_different_crop_min_misses_cache(client, cache_root, grid_xyz):
    base = {
        "source_path": str(grid_xyz),
        "ascii_format": GRID_FORMAT,
        "region": {"kind": "box", "min": [0.1, 0.1, 0.1], "max": [0.8, 0.8, 0.8]},
    }
    body1 = client.post("/api/pointcloud/crop_octree", json=base).json()

    shifted = dict(base)
    shifted["region"] = {"kind": "box", "min": [0.2, 0.1, 0.1], "max": [0.8, 0.8, 0.8]}
    body2 = client.post("/api/pointcloud/crop_octree", json=shifted).json()

    assert body2["cache_id"] != body1["cache_id"]
    assert body2["cached"] is False


def test_translation_changes_cache_id(client, cache_root, grid_xyz):
    base = {
        "source_path": str(grid_xyz),
        "ascii_format": GRID_FORMAT,
        "region": {"kind": "box", "min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 1.0]},
    }
    body_no_t = client.post("/api/pointcloud/crop_octree", json=base).json()

    with_t = dict(base)
    with_t["translation"] = [0.0, 0.0, 0.0]
    body_zero_t = client.post("/api/pointcloud/crop_octree", json=with_t).json()
    # (0,0,0) translation is canonically the same as no translation.
    assert body_zero_t["cache_id"] == body_no_t["cache_id"]

    with_t["translation"] = [0.1, 0.0, 0.0]
    body_nonzero_t = client.post("/api/pointcloud/crop_octree", json=with_t).json()
    assert body_nonzero_t["cache_id"] != body_no_t["cache_id"]


# ---------------------------------------------------------------------------
# Empty result
# ---------------------------------------------------------------------------

def test_empty_crop_returns_zero_count_no_cache_entry(
    client, cache_root, grid_xyz,
):
    """An AABB that lies entirely outside the cloud should return HTTP 200
    with point_count=0 and no cache_dir. The renderer raises a delete
    confirmation; a 4xx here would surface as a hard failure instead."""
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {"kind": "box", "min": [100.0, 100.0, 100.0], "max": [200.0, 200.0, 200.0]},
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["point_count"] == 0
    assert body["cache_id"] is None
    assert body["cache_dir"] is None


# ---------------------------------------------------------------------------
# Polygon crop
# ---------------------------------------------------------------------------

def _identity_camera_matrices():
    """A degenerate orthographic-ish setup: projection and view are both
    identity. Then NDC == world coords, and a polygon defined in
    NDC-mapped-to-canvas pixel space is testable against the cube
    [-1, 1]^3 directly. Used only by the polygon unit tests below."""
    # column-major identity
    ident = [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]
    return ident, ident


def test_polygon_crop_matches_numpy_reference(
    client, cache_root, grid_xyz, grid_points,
):
    """Project the grid through identity camera matrices; the canvas
    pixels become a linear transform of (x, y). Pick a polygon in pixel
    space that bounds a known sub-rectangle of the grid; the endpoint's
    kept count must match the NumPy reference for the same polygon."""
    projection, view = _identity_camera_matrices()
    canvas_w, canvas_h = 100, 100

    # Identity projection => NDC == world. Polygon corners at canvas
    # pixels (px, py) correspond to NDC (px/50 - 1, 1 - py/50).
    # Pick a polygon enclosing world-space rectangle x in [0.2, 0.7],
    # y in [0.2, 0.7]:
    #   world (0.2, 0.2) -> NDC (0.2, 0.2) -> pixel (60, 40)
    #   world (0.7, 0.2) -> NDC (0.7, 0.2) -> pixel (85, 40)
    #   world (0.7, 0.7) -> NDC (0.7, 0.7) -> pixel (85, 15)
    #   world (0.2, 0.7) -> NDC (0.2, 0.7) -> pixel (60, 15)
    polygon = [[60.0, 40.0], [85.0, 40.0], [85.0, 15.0], [60.0, 15.0]]

    # NumPy reference using the same helpers the endpoint uses.
    pixels = main._project_world_to_pixel(
        grid_points,
        np.array(projection, dtype=np.float64),
        np.array(view, dtype=np.float64),
        canvas_w, canvas_h,
    )
    mask = main._points_in_polygon_mask(pixels, np.array(polygon, dtype=np.float64))
    expected = int(mask.sum())
    assert expected > 0  # sanity: polygon actually contains some points

    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {
                "kind": "polygon",
                "points": polygon,
                "projection": projection,
                "view": view,
                "canvas": {"width": canvas_w, "height": canvas_h},
                "invert": False,
            },
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["point_count"] == expected


# ---------------------------------------------------------------------------
# Validation errors
# ---------------------------------------------------------------------------

def test_missing_source_returns_404(client, cache_root):
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": "/nonexistent/file.xyz",
            "region": {"kind": "box", "min": [0, 0, 0], "max": [1, 1, 1]},
        },
    )
    assert res.status_code == 404


def test_bad_region_kind_returns_400(client, cache_root, grid_xyz):
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {"kind": "circle", "min": [0, 0, 0], "max": [1, 1, 1]},
        },
    )
    assert res.status_code == 400
    assert "box" in res.text or "polygon" in res.text


def test_bad_box_min_length_returns_400(client, cache_root, grid_xyz):
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {"kind": "box", "min": [0, 0], "max": [1, 1, 1]},
        },
    )
    assert res.status_code == 400


def test_polygon_with_two_points_returns_400(client, cache_root, grid_xyz):
    projection, view = _identity_camera_matrices()
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {
                "kind": "polygon",
                "points": [[0, 0], [10, 10]],
                "projection": projection,
                "view": view,
                "canvas": {"width": 100, "height": 100},
            },
        },
    )
    assert res.status_code == 400


# ---------------------------------------------------------------------------
# Helper unit tests (no PotreeConverter needed, but still gated by the
# pytestmark above for simplicity — they're cheap to skip if the binary
# is missing).
# ---------------------------------------------------------------------------

def test_canonical_region_box_is_stable():
    r1 = {"kind": "box", "min": [0.1, 0.2, 0.3], "max": [1.1, 1.2, 1.3], "invert": False}
    r2 = {"kind": "box", "min": [0.1, 0.2, 0.3], "max": [1.1, 1.2, 1.3], "invert": False}
    assert main._canonical_region(r1) == main._canonical_region(r2)
    r3 = {"kind": "box", "min": [0.1, 0.2, 0.3], "max": [1.1, 1.2, 1.3], "invert": True}
    assert main._canonical_region(r1) != main._canonical_region(r3)


def test_canonical_translation_zero_collapses_to_none():
    assert main._canonical_translation(None) == ""
    assert main._canonical_translation([0.0, 0.0, 0.0]) == ""
    assert main._canonical_translation([0.1, 0.0, 0.0]) != ""


def test_points_in_polygon_matches_winding_reference():
    """The vectorised mask should agree with a per-point ray-cast on
    every test case — both the helper and the reference are
    implementations of the same algorithm, so divergence means a
    transcription error in one of them."""
    polygon = np.array([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]], dtype=np.float64)
    pixels = np.array([
        [5.0, 5.0],   # inside
        [-1.0, 5.0],  # outside left
        [11.0, 5.0],  # outside right
        [5.0, -1.0],  # outside below
        [5.0, 11.0],  # outside above
        [0.0001, 0.0001],  # just inside corner
    ], dtype=np.float64)
    mask = main._points_in_polygon_mask(pixels, polygon)
    assert mask.tolist() == [True, False, False, False, False, True]


def test_project_world_to_pixel_identity_round_trip():
    """With identity projection and view, the world→pixel transform
    reduces to: pixel_x = (x + 1) * w/2, pixel_y = (1 - (y+1)/2) * h."""
    projection = np.eye(4, dtype=np.float64).flatten("F")
    view = np.eye(4, dtype=np.float64).flatten("F")
    positions = np.array([
        [0.0, 0.0, 0.0],   # NDC origin -> canvas center
        [1.0, 1.0, 0.0],   # NDC top-right -> canvas top-right
        [-1.0, -1.0, 0.0], # NDC bottom-left -> canvas bottom-left
    ], dtype=np.float64)
    pixels = main._project_world_to_pixel(positions, projection, view, 100, 100)
    np.testing.assert_allclose(pixels[0], [50.0, 50.0], atol=1e-9)
    np.testing.assert_allclose(pixels[1], [100.0, 0.0], atol=1e-9)
    np.testing.assert_allclose(pixels[2], [0.0, 100.0], atol=1e-9)
