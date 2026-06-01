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


def test_crop_returns_filtered_source_that_chains(
    client, cache_root, grid_xyz, grid_points,
):
    """A crop persists its kept points as `filtered_source_path`, and a SECOND
    crop on that path composes on the kept set — not the original. Regression for
    the bug where a second octree op re-read the original source and made
    previously-removed points reappear."""
    def box_count(pts, lo, hi):
        return int(np.sum(
            (pts[:, 0] >= lo[0]) & (pts[:, 0] <= hi[0]) &
            (pts[:, 1] >= lo[1]) & (pts[:, 1] <= hi[1]) &
            (pts[:, 2] >= lo[2]) & (pts[:, 2] <= hi[2])
        ))

    aMin, aMax = [0.0, 0.0, 0.0], [0.45, 0.9, 0.9]   # keep low-x half
    bMin, bMax = [0.0, 0.0, 0.0], [0.9, 0.45, 0.9]   # keep low-y half
    a_mask = (
        (grid_points[:, 0] >= aMin[0]) & (grid_points[:, 0] <= aMax[0]) &
        (grid_points[:, 1] >= aMin[1]) & (grid_points[:, 1] <= aMax[1]) &
        (grid_points[:, 2] >= aMin[2]) & (grid_points[:, 2] <= aMax[2])
    )
    intersection = (
        a_mask &
        (grid_points[:, 0] >= bMin[0]) & (grid_points[:, 0] <= bMax[0]) &
        (grid_points[:, 1] >= bMin[1]) & (grid_points[:, 1] <= bMax[1]) &
        (grid_points[:, 2] >= bMin[2]) & (grid_points[:, 2] <= bMax[2])
    )
    expected_a = int(a_mask.sum())
    expected_ab = int(intersection.sum())
    assert 0 < expected_ab < expected_a  # B genuinely narrows A

    first = client.post(
        "/api/pointcloud/crop_octree",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT,
              "region": {"kind": "box", "min": aMin, "max": aMax, "invert": False}},
    ).json()
    assert first["point_count"] == expected_a
    seg_path = first["filtered_source_path"]
    assert seg_path and Path(seg_path).is_file()
    assert Path(seg_path).suffix == ".las"

    # Second crop reads the FILTERED LAS (no ascii_format — it's a LAS). The kept
    # count must be A∩B. If chaining were broken (re-reading the original), B over
    # the full grid would keep more than A∩B.
    second = client.post(
        "/api/pointcloud/crop_octree",
        json={"source_path": seg_path,
              "region": {"kind": "box", "min": bMin, "max": bMax, "invert": False}},
    ).json()
    assert second["point_count"] == expected_ab, (
        f"expected A∩B={expected_ab}, got {second['point_count']} "
        f"(B over full grid would be {box_count(grid_points, bMin, bMax)})"
    )


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


# ---------------------------------------------------------------------------
# Scalar-attribute filtering (crop_octree `scalar_filters`)
#
# Uses the committed fixtures/scalars.xyz: a comma-headered XYZ whose
# `Deviation[]` column becomes an imported extra-dim scalar (slug "Deviation")
# under the ascii_format below. Reference counts are computed in-test via the
# same pandas read the endpoint uses, so the assertions don't hard-code values
# that could drift if the fixture changes.
# ---------------------------------------------------------------------------

SCALARS_FIXTURE = Path(__file__).parent / "fixtures" / "scalars.xyz"
SCALARS_FORMAT = "x y z reflectance deviation"


@pytest.fixture
def scalars_df():
    """The fixture read exactly as the endpoint reads it, so reference masks
    match the survivor set byte-for-byte (float32 for the scalar column, since
    that's how extra dims are stored)."""
    import pandas as pd_local
    df = pd_local.read_csv(
        SCALARS_FIXTURE,
        sep=r"\s+",
        header=None,
        skiprows=1,  # comma header row
        names=["x", "y", "z", "refl", "dev"],
        engine="c",
    )
    df["dev"] = df["dev"].astype(np.float32)
    return df


def test_scalar_only_filter_matches_numpy_reference(
    client, cache_root, scalars_df,
):
    """A scalar-only filter (no region) keeps exactly the points whose
    Deviation attribute falls in [lo, hi]."""
    lo, hi = 1.0, 2.0
    expected = int(((scalars_df["dev"] >= lo) & (scalars_df["dev"] <= hi)).sum())
    assert expected > 0  # sanity

    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(SCALARS_FIXTURE),
            "ascii_format": SCALARS_FORMAT,
            "scalar_filters": [{"slug": "Deviation", "min": lo, "max": hi}],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["point_count"] == expected
    assert body["cache_id"] is not None


def test_scalar_categorical_values_filter_matches_reference(
    client, cache_root, scalars_df,
):
    """A categorical `values` filter keeps exactly the points whose (rounded)
    Deviation equals one of the listed class ids — an OR within the field, not a
    contiguous range. This is the class-checkbox path used for ground_class /
    tree_instance."""
    classes = sorted({int(round(v)) for v in scalars_df["dev"].tolist()})
    assert len(classes) >= 2, "fixture needs >=2 distinct integer-ish dev values"
    # Pick a non-contiguous pair when possible so we prove it's set membership,
    # not a min/max range (which couldn't express a gap).
    pick = [classes[0], classes[-1]]
    rounded = np.rint(scalars_df["dev"].to_numpy()).astype(int)
    expected = int(np.isin(rounded, pick).sum())
    assert expected > 0

    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(SCALARS_FIXTURE),
            "ascii_format": SCALARS_FORMAT,
            "scalar_filters": [{"slug": "Deviation", "values": pick}],
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["point_count"] == expected


def test_scalar_categorical_and_continuous_cache_keys_differ(
    client, cache_root, scalars_df,
):
    """A categorical `values` filter and a continuous min/max filter over the
    same slug must not collide in the cache (they select different points)."""
    classes = sorted({int(round(v)) for v in scalars_df["dev"].tolist()})
    cat = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(SCALARS_FIXTURE),
            "ascii_format": SCALARS_FORMAT,
            "scalar_filters": [{"slug": "Deviation", "values": [classes[0]]}],
        },
    ).json()
    cont = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(SCALARS_FIXTURE),
            "ascii_format": SCALARS_FORMAT,
            "scalar_filters": [{"slug": "Deviation", "min": classes[0], "max": classes[0]}],
        },
    ).json()
    # Distinct cache ids (the canonical form encodes set-vs-range differently).
    if cat["cache_id"] and cont["cache_id"]:
        assert cat["cache_id"] != cont["cache_id"]


def test_scalar_and_box_intersection(client, cache_root, scalars_df):
    """A scalar filter AND a box region keep only the intersection. The box
    excludes the high-x points (cloud x spans {0..2}), so the intersection is a
    strict subset of both the box-only and scalar-only survivors."""
    cmin = [0.0, -1.0, -1.0]
    cmax = [1.0, 1.0, 2.0]
    lo, hi = 3.0, 4.0
    box_mask = (
        (scalars_df["x"] >= cmin[0]) & (scalars_df["x"] <= cmax[0]) &
        (scalars_df["y"] >= cmin[1]) & (scalars_df["y"] <= cmax[1]) &
        (scalars_df["z"] >= cmin[2]) & (scalars_df["z"] <= cmax[2])
    )
    dev_mask = (scalars_df["dev"] >= lo) & (scalars_df["dev"] <= hi)
    expected = int((box_mask & dev_mask).sum())
    assert expected > 0

    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(SCALARS_FIXTURE),
            "ascii_format": SCALARS_FORMAT,
            "region": {"kind": "box", "min": cmin, "max": cmax, "invert": False},
            "scalar_filters": [{"slug": "Deviation", "min": lo, "max": hi}],
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["point_count"] == expected


def test_scalar_invert_applies_only_to_spatial_mask(
    client, cache_root, scalars_df,
):
    """The spatial `invert` flag flips only the box mask; the scalar filter is
    never inverted. Expected = (NOT in box) AND (dev in window). The box keeps a
    proper subset (low-x), so its complement is non-empty and the scalar AND
    can actually bite."""
    cmin = [0.0, -1.0, -1.0]
    cmax = [1.0, 1.0, 1.0]
    lo, hi = 3.0, 3.0
    box_mask = (
        (scalars_df["x"] >= cmin[0]) & (scalars_df["x"] <= cmax[0]) &
        (scalars_df["y"] >= cmin[1]) & (scalars_df["y"] <= cmax[1]) &
        (scalars_df["z"] >= cmin[2]) & (scalars_df["z"] <= cmax[2])
    )
    dev_mask = (scalars_df["dev"] >= lo) & (scalars_df["dev"] <= hi)
    expected = int((~box_mask & dev_mask).sum())
    assert expected > 0

    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(SCALARS_FIXTURE),
            "ascii_format": SCALARS_FORMAT,
            "region": {"kind": "box", "min": cmin, "max": cmax, "invert": True},
            "scalar_filters": [{"slug": "Deviation", "min": lo, "max": hi}],
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["point_count"] == expected


def test_unknown_scalar_slug_returns_400(client, cache_root):
    """An unknown slug fails loudly rather than silently keeping all points."""
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(SCALARS_FIXTURE),
            "ascii_format": SCALARS_FORMAT,
            "scalar_filters": [{"slug": "does_not_exist", "min": 0, "max": 1}],
        },
    )
    assert res.status_code == 400
    assert "does_not_exist" in res.text or "Unknown scalar" in res.text


def test_scalar_empty_window_returns_zero_no_cache(client, cache_root):
    """A scalar window matching no points → HTTP 200, point_count=0, no cache."""
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(SCALARS_FIXTURE),
            "ascii_format": SCALARS_FORMAT,
            "scalar_filters": [{"slug": "Deviation", "min": 1000, "max": 2000}],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["point_count"] == 0
    assert body["cache_id"] is None
    assert body["cache_dir"] is None


def test_scalar_filter_cache_key_folds_bounds(client, cache_root):
    """Identical scalar filters hit cache; changing a bound misses (proves the
    cache key folds scalar filters)."""
    base = {
        "source_path": str(SCALARS_FIXTURE),
        "ascii_format": SCALARS_FORMAT,
        "scalar_filters": [{"slug": "Deviation", "min": 0, "max": 2}],
    }
    body1 = client.post("/api/pointcloud/crop_octree", json=base).json()
    assert body1["cached"] is False
    body2 = client.post("/api/pointcloud/crop_octree", json=base).json()
    assert body2["cached"] is True
    assert body2["cache_id"] == body1["cache_id"]

    shifted = {
        "source_path": str(SCALARS_FIXTURE),
        "ascii_format": SCALARS_FORMAT,
        "scalar_filters": [{"slug": "Deviation", "min": 0, "max": 3}],
    }
    body3 = client.post("/api/pointcloud/crop_octree", json=shifted).json()
    assert body3["cache_id"] != body1["cache_id"]
    assert body3["cached"] is False


def test_scalar_filter_order_independent_cache_key():
    """Two scalar filters in different order produce the same canonical string
    (and thus the same cache id) — order doesn't change survivors."""
    a = [{"slug": "Deviation", "min": 0, "max": 2}, {"slug": "Other", "min": 1, "max": 5}]
    b = [{"slug": "Other", "min": 1, "max": 5}, {"slug": "Deviation", "min": 0, "max": 2}]
    assert main._canonical_scalar_filters(a) == main._canonical_scalar_filters(b)
    assert main._canonical_scalar_filters(None) == ""
    assert main._canonical_scalar_filters([]) == ""


def test_crop_octree_requires_region_or_scalar(client, cache_root):
    """A request with neither region nor scalar_filters is rejected."""
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(SCALARS_FIXTURE),
            "ascii_format": SCALARS_FORMAT,
        },
    )
    assert res.status_code == 400


# ---------------------------------------------------------------------------
# invert_all — the true complement of the kept set (filter tool "Segment").
# ---------------------------------------------------------------------------

def test_invert_all_is_exact_complement(client, cache_root, scalars_df):
    """The inverted call keeps exactly the points the non-inverted call drops:
    kept + inverted == total, with no overlap."""
    lo, hi = 1.0, 2.0
    total = len(scalars_df)
    in_range = int(((scalars_df["dev"] >= lo) & (scalars_df["dev"] <= hi)).sum())

    base = {
        "source_path": str(SCALARS_FIXTURE),
        "ascii_format": SCALARS_FORMAT,
        "scalar_filters": [{"slug": "Deviation", "min": lo, "max": hi}],
    }
    kept = client.post("/api/pointcloud/crop_octree", json=base).json()
    inv = client.post(
        "/api/pointcloud/crop_octree",
        json={**base, "invert_all": True},
    ).json()

    assert kept["point_count"] == in_range
    assert inv["point_count"] == total - in_range
    assert kept["point_count"] + inv["point_count"] == total


def test_invert_all_complements_box_and_scalar(client, cache_root, scalars_df):
    """invert_all complements the FULL combined mask (box AND scalar), not just
    one part. Expected inverted count = total - intersection."""
    cmin = [0.0, -1.0, -1.0]
    cmax = [1.0, 1.0, 2.0]
    lo, hi = 3.0, 4.0
    box = (
        (scalars_df["x"] >= cmin[0]) & (scalars_df["x"] <= cmax[0]) &
        (scalars_df["y"] >= cmin[1]) & (scalars_df["y"] <= cmax[1]) &
        (scalars_df["z"] >= cmin[2]) & (scalars_df["z"] <= cmax[2])
    )
    dev = (scalars_df["dev"] >= lo) & (scalars_df["dev"] <= hi)
    intersection = int((box & dev).sum())
    total = len(scalars_df)

    req = {
        "source_path": str(SCALARS_FIXTURE),
        "ascii_format": SCALARS_FORMAT,
        "region": {"kind": "box", "min": cmin, "max": cmax, "invert": False},
        "scalar_filters": [{"slug": "Deviation", "min": lo, "max": hi}],
        "invert_all": True,
    }
    inv = client.post("/api/pointcloud/crop_octree", json=req).json()
    assert inv["point_count"] == total - intersection


def test_invert_all_changes_cache_id(client, cache_root):
    """A request differing only in invert_all must miss the cache (different
    survivor set) — proves invert_all is folded into the cache key."""
    base = {
        "source_path": str(SCALARS_FIXTURE),
        "ascii_format": SCALARS_FORMAT,
        "scalar_filters": [{"slug": "Deviation", "min": 0, "max": 2}],
    }
    a = client.post("/api/pointcloud/crop_octree", json=base).json()
    b = client.post(
        "/api/pointcloud/crop_octree",
        json={**base, "invert_all": True},
    ).json()
    assert a["cache_id"] != b["cache_id"]


# ---------------------------------------------------------------------------
# squares_union region — the erase brush. The frontend paints screen-space
# square stamps under one frozen camera and sends them as one region; erase
# keeps the COMPLEMENT (invert=True), i.e. every point whose pixel falls outside
# ALL squares. The test is purely 2D (project-to-pixel + |dx|,|dy| <= half), so a
# square removes points at every depth behind it — a stamp that extrudes through
# the cloud, like the polygon path. Overlapping squares must not double-count.
# ---------------------------------------------------------------------------

# Identity projection => NDC == world, and pixel = ((x+1)*w/2, (1-(y+1)/2)*h).
# So world (x, y) maps linearly to canvas pixels, letting us place square
# stamps at known pixel positions that bound known world rectangles.
SQ_CANVAS_W, SQ_CANVAS_H = 100, 100


def _squares_reference(pts, projection, view, canvas_w, canvas_h, squares):
    """NumPy reference using the same projection helper the endpoint uses:
    boolean mask of points whose pixel falls inside ANY square. `squares` is a
    list of ((cx, cy), half)."""
    pixels = main._project_world_to_pixel(
        pts,
        np.array(projection, dtype=np.float64),
        np.array(view, dtype=np.float64),
        canvas_w, canvas_h,
    )
    inside = np.zeros(len(pts), dtype=bool)
    for (cx, cy), half in squares:
        inside |= (np.abs(pixels[:, 0] - cx) <= half) & (np.abs(pixels[:, 1] - cy) <= half)
    return inside


def test_squares_union_erase_keeps_complement(client, cache_root, grid_xyz, grid_points):
    """Erase = squares_union region with invert=True. The survivor count must
    equal NumPy's count of points whose pixel is OUTSIDE the union of squares."""
    projection, view = _identity_camera_matrices()
    # world (0.2, 0.2) -> pixel (60, 40); world (0.7, 0.7) -> pixel (85, 15).
    squares = [((60.0, 40.0), 10.0), ((85.0, 15.0), 8.0)]
    inside = _squares_reference(grid_points, projection, view, SQ_CANVAS_W, SQ_CANVAS_H, squares)
    expected = int(np.sum(~inside))
    assert 0 < int(inside.sum()) < len(grid_points)  # non-trivial, non-total

    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {
                "kind": "squares_union",
                "centers": [list(c) for c, _ in squares],
                "half_sizes": [h for _, h in squares],
                "projection": projection,
                "view": view,
                "canvas": {"width": SQ_CANVAS_W, "height": SQ_CANVAS_H},
                "invert": True,
            },
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["point_count"] == expected
    assert (Path(body["cache_dir"]) / "octree.bin").is_file()


def test_squares_union_extrudes_through_depth(client, cache_root, grid_xyz, grid_points):
    """A single square must remove points at EVERY z (the infinite-extrusion
    property). With identity projection the square at a fixed (px, py) selects a
    column of the grid spanning all 10 z-layers; erasing it removes exactly that
    column, so the survivor count drops by a multiple of 10."""
    projection, view = _identity_camera_matrices()
    squares = [((50.0, 50.0), 12.0)]  # centered on the grid in screen space
    inside = _squares_reference(grid_points, projection, view, SQ_CANVAS_W, SQ_CANVAS_H, squares)
    removed = int(inside.sum())
    assert removed > 0 and removed % 10 == 0, (
        f"a screen-space square should remove whole z-columns (×10); got {removed}"
    )
    expected = len(grid_points) - removed

    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {
                "kind": "squares_union",
                "centers": [[50.0, 50.0]],
                "half_sizes": [12.0],
                "projection": projection,
                "view": view,
                "canvas": {"width": SQ_CANVAS_W, "height": SQ_CANVAS_H},
                "invert": True,
            },
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["point_count"] == expected


def test_squares_union_overlapping_no_double_count(client, cache_root, grid_xyz, grid_points):
    """Two overlapping squares remove their union, not the sum of their
    individual point counts."""
    projection, view = _identity_camera_matrices()
    squares = [((48.0, 50.0), 10.0), ((54.0, 50.0), 10.0)]
    union = _squares_reference(grid_points, projection, view, SQ_CANVAS_W, SQ_CANVAS_H, squares)
    union_count = int(union.sum())
    sum_individual = sum(
        int(_squares_reference(grid_points, projection, view, SQ_CANVAS_W, SQ_CANVAS_H, [s]).sum())
        for s in squares
    )
    assert union_count < sum_individual  # overlap → union < sum

    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {
                "kind": "squares_union",
                "centers": [list(c) for c, _ in squares],
                "half_sizes": [h for _, h in squares],
                "projection": projection,
                "view": view,
                "canvas": {"width": SQ_CANVAS_W, "height": SQ_CANVAS_H},
                "invert": True,
            },
        },
    )
    assert res.status_code == 200, res.text
    assert len(grid_points) - res.json()["point_count"] == union_count


def test_squares_union_empty_list_returns_400(client, cache_root, grid_xyz):
    projection, view = _identity_camera_matrices()
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {
                "kind": "squares_union", "centers": [], "half_sizes": [],
                "projection": projection, "view": view,
                "canvas": {"width": SQ_CANVAS_W, "height": SQ_CANVAS_H},
            },
        },
    )
    assert res.status_code == 400


def test_squares_union_mismatched_lengths_returns_400(client, cache_root, grid_xyz):
    projection, view = _identity_camera_matrices()
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {
                "kind": "squares_union",
                "centers": [[50.0, 50.0], [60.0, 60.0]],
                "half_sizes": [10.0],
                "projection": projection, "view": view,
                "canvas": {"width": SQ_CANVAS_W, "height": SQ_CANVAS_H},
            },
        },
    )
    assert res.status_code == 400


def test_squares_union_negative_half_size_returns_400(client, cache_root, grid_xyz):
    projection, view = _identity_camera_matrices()
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": str(grid_xyz),
            "ascii_format": GRID_FORMAT,
            "region": {
                "kind": "squares_union",
                "centers": [[50.0, 50.0]],
                "half_sizes": [-10.0],
                "projection": projection, "view": view,
                "canvas": {"width": SQ_CANVAS_W, "height": SQ_CANVAS_H},
            },
        },
    )
    assert res.status_code == 400


def test_canonical_region_squares_union_is_stable():
    proj, view = _identity_camera_matrices()
    base = {
        "kind": "squares_union", "centers": [[50.0, 50.0]], "half_sizes": [10.0],
        "projection": proj, "view": view, "canvas": {"width": 100, "height": 100},
        "invert": True,
    }
    assert main._canonical_region(dict(base)) == main._canonical_region(dict(base))
    # A different half-size produces a different key (different survivor set).
    other = {**base, "half_sizes": [12.0]}
    assert main._canonical_region(base) != main._canonical_region(other)


# ──────────────────────────────────────────────────────────────────────────
# Non-ASCII sources — PLY/PCD/LAS now import as octrees, so crop/filter must
# work for them too (they route through _source_to_las → _filtered_las_to_las).
# ──────────────────────────────────────────────────────────────────────────


@pytest.fixture
def line_ply(tmp_path) -> Path:
    """30 collinear points, x=y=z=i*0.1, carrying a custom scalar `deviation`
    equal to the index. Predictable for box + scalar crop counts."""
    f = tmp_path / "line.ply"
    n = 30
    lines = [
        "ply", "format ascii 1.0", f"element vertex {n}",
        "property float x", "property float y", "property float z",
        "property float deviation", "end_header",
    ]
    for i in range(n):
        lines.append(f"{i * 0.1:.4f} {i * 0.1:.4f} {i * 0.1:.4f} {float(i):.4f}")
    f.write_text("\n".join(lines) + "\n")
    return f


@pytest.fixture
def line_las(tmp_path) -> Path:
    """30 collinear LAS points with a native extra dimension `refl` = index."""
    import laspy

    f = tmp_path / "line.las"
    n = 30
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    header.add_extra_dim(laspy.ExtraBytesParams(name="refl", type=np.float32))
    record = laspy.ScaleAwarePointRecord.zeros(n, header=header)
    coords = np.arange(n) * 0.1
    record.x, record.y, record.z = coords, coords, coords
    record["refl"] = np.arange(n, dtype=np.float32)
    with laspy.open(str(f), mode="w", header=header) as w:
        w.write_points(record)
    return f


def test_crop_ply_box_region(client, cache_root, line_ply):
    """Box crop on a PLY source keeps the points inside the box. i*0.1 in
    [0.5, 1.5] → i in 5..15 inclusive → 11 points."""
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={"source_path": str(line_ply),
              "region": {"kind": "box", "min": [0.5, 0.5, 0.5], "max": [1.5, 1.5, 1.5]}},
    )
    assert res.status_code == 200, res.text
    assert res.json()["point_count"] == 11


def test_crop_ply_scalar_filter_preserves_attribute(client, cache_root, line_ply):
    """Scalar filter on a PLY's custom `deviation` field works and the cropped
    octree still exposes that attribute — proves PLY scalars survive the
    _source_to_las → _filtered_las_to_las round-trip."""
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={"source_path": str(line_ply),
              "scalar_filters": [{"slug": "deviation", "min": 10, "max": 20}]},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["point_count"] == 11  # deviation 10..20 inclusive
    assert "deviation" in {a["name"] for a in body["attributes"]}


@pytest.fixture
def line_laz(tmp_path) -> Path:
    """30 collinear LAZ-compressed points, x=y=z=i*0.1."""
    import laspy

    f = tmp_path / "line.laz"
    n = 30
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    record = laspy.ScaleAwarePointRecord.zeros(n, header=header)
    coords = np.arange(n) * 0.1
    record.x, record.y, record.z = coords, coords, coords
    with laspy.open(str(f), mode="w", header=header) as w:
        w.write_points(record)
    return f


def test_crop_laz_box_region(client, cache_root, line_laz):
    """Box crop on a LAZ source: i*0.1 in [0.5, 1.5] → i in 5..15 → 11 points.
    Proves LAZ decompresses and chunk-filters through _filtered_las_to_las."""
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={"source_path": str(line_laz),
              "region": {"kind": "box", "min": [0.5, 0.5, 0.5], "max": [1.5, 1.5, 1.5]}},
    )
    assert res.status_code == 200, res.text
    assert res.json()["point_count"] == 11


def test_crop_las_scalar_filter(client, cache_root, line_las):
    """Scalar filter on a native LAS extra dimension produces a cropped octree
    — LAS sources are no longer rejected by crop_octree."""
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={"source_path": str(line_las),
              "scalar_filters": [{"slug": "refl", "min": 10, "max": 20}]},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["point_count"] == 11
    assert "refl" in {a["name"] for a in body["attributes"]}
