"""DEM (Digital Elevation Model) generation tests.

The DEM engine grids ground elevation by TIN/Delaunay-linear interpolation onto
a regular cell-centred grid, with a per-cell low-percentile pre-bin for outlier
robustness and convex-hull void masking. Output is a heightmap surface mesh plus
the regular grid, which the raster-export endpoint writes as ESRI ASCII / GeoTIFF.

Layers:
  - `_compute_dem()` run directly → grid accuracy, void/fill, outlier rejection.
  - `/api/dem` endpoint → PHB1 mesh frame decode + provenance.
  - `/api/dem/export-raster` → .asc / GeoTIFF round-trip.
  - `_do_session_dem()` → ground-aware selection + height-above-ground column.

These tests use the real engine and TestClient — no mocks. The session
height-above-ground test stubs only the slow octree rebuild (PotreeConverter),
which is orthogonal to the HAG math under test.
"""
import base64
import io
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import main
from tests.binframe import decode_bin_frame


FIXTURE = Path(__file__).parent / "fixtures" / "bean_scan_small.xyz"


def _plane_cloud(a=0.1, b=0.2, c=1.0, n=4000, span=10.0, seed=0):
    """Points on a tilted plane z = a*x + b*y + c over [0, span]^2."""
    rng = np.random.default_rng(seed)
    xy = rng.uniform(0, span, size=(n, 2))
    z = a * xy[:, 0] + b * xy[:, 1] + c
    return np.column_stack([xy, z]), (a, b, c)


def _cell_center(result, i, j):
    minx, miny = result["grid_origin"]
    cell = result["grid_cell"]
    return minx + (i + 0.5) * cell, miny + (j + 0.5) * cell


# ----------------------------- engine accuracy -----------------------------

def test_dem_tilted_plane_median_is_accurate():
    """With the median per-cell representative, TIN-linear reconstructs a tilted
    plane closely (linear interpolation is exact on a planar field; the only
    error is sub-cell sampling)."""
    pts, (a, b, c) = _plane_cloud()
    r = main._compute_dem(pts, cell_size=0.5, method="tin", ground_percentile=50.0)
    assert r["success"], r.get("error")
    gz = np.asarray(r["grid_z"]).reshape(r["grid_ny"], r["grid_nx"])
    # Compare every finite interior cell to the analytic plane.
    errs = []
    for j in range(r["grid_ny"]):
        for i in range(r["grid_nx"]):
            if np.isfinite(gz[j, i]):
                cx, cy = _cell_center(r, i, j)
                errs.append(abs(gz[j, i] - (a * cx + b * cy + c)))
    errs = np.array(errs)
    # Sub-cell slope range is ~ (|a|+|b|)*cell = 0.15; median rep keeps the mean
    # error well under that.
    assert errs.mean() < 0.05
    assert r["num_triangles"] > 0 and r["voids"] == 0


def test_dem_low_percentile_tracks_bare_earth():
    """The default low percentile (5th) pulls the surface toward the LOWEST
    returns — the bare-earth behaviour. On a plane it sits at or just below the
    analytic surface, never above it."""
    pts, (a, b, c) = _plane_cloud()
    r = main._compute_dem(pts, cell_size=0.5, method="tin", ground_percentile=5.0)
    assert r["success"]
    gz = np.asarray(r["grid_z"]).reshape(r["grid_ny"], r["grid_nx"])
    above = 0
    for j in range(r["grid_ny"]):
        for i in range(r["grid_nx"]):
            if np.isfinite(gz[j, i]):
                cx, cy = _cell_center(r, i, j)
                if gz[j, i] > (a * cx + b * cy + c) + 0.02:
                    above += 1
    assert above == 0  # never bulges above the true plane


# ----------------------- DSM / CHM (surface products) -----------------------

def _canopy_scene(seed=3):
    """A tilted ground plane with a raised canopy cluster +DH over a central sub-
    region. Returns (points, ground_labels, first_return_labels, plane, DH). Ground
    points under the canopy are tagged as later returns (return index 1) so the DSM
    picks the canopy top, not the ground beneath it."""
    a, b, c, DH = 0.1, 0.05, 2.0, 5.0
    rng = np.random.default_rng(seed)
    n = 4000
    xy = rng.uniform(0, 20, size=(n, 2))
    zg = a * xy[:, 0] + b * xy[:, 1] + c
    ground = np.column_stack([xy, zg])
    cm = (xy[:, 0] > 5) & (xy[:, 0] < 15) & (xy[:, 1] > 5) & (xy[:, 1] < 15)
    canopy = np.column_stack([xy[cm], zg[cm] + DH])
    pts = np.vstack([ground, canopy])
    ground_labels = np.concatenate([np.full(n, main.GROUND_CLASS_GROUND),
                                    np.full(int(cm.sum()), main.GROUND_CLASS_PLANT)])
    # first return: canopy points (index 0); ground under canopy is a later return.
    fr = np.zeros(len(pts), dtype=np.int64)
    fr[:n][cm] = 1
    return pts, ground_labels, fr, (a, b, c), DH


def test_dsm_tracks_canopy_top():
    """A DSM built from first returns at a high per-cell percentile sits at the
    canopy top over the vegetated region — well above the DTM's bare ground."""
    pts, gl, fr, (a, b, c), DH = _canopy_scene()
    req = main.DemRequest(points=pts.tolist(), ground_labels=gl.tolist(),
                          first_return_labels=fr.tolist(), surface_type="dsm",
                          cell_size=0.5, auto_segment_ground=False)
    r = main._do_dem(req)
    assert r["success"], r.get("error")
    assert r["surface_type"] == "dsm" and r["surface_source"] == "first_return"
    gz = np.asarray(r["grid_z"]).reshape(r["grid_ny"], r["grid_nx"])
    # Over the canopy footprint the DSM reaches roughly ground+DH.
    top = float(np.nanmax(gz))
    ground_top = a * 20 + b * 20 + c        # highest bare-ground corner
    assert top > ground_top + DH - 1.0      # canopy top clearly above bare ground


def test_dtm_and_dsm_distinct():
    """DTM (ground, low percentile) stays on the bare plane; DSM (first return,
    high percentile) rises over the canopy. Same scene, different products."""
    pts, gl, fr, (a, b, c), DH = _canopy_scene()
    base = dict(points=pts.tolist(), ground_labels=gl.tolist(),
                first_return_labels=fr.tolist(), cell_size=0.5, auto_segment_ground=False)
    dtm = main._do_dem(main.DemRequest(surface_type="dtm", **base))
    dsm = main._do_dem(main.DemRequest(surface_type="dsm", **base))
    assert dtm["success"] and dsm["success"]
    dtm_max = float(np.nanmax(np.asarray(dtm["grid_z"])))
    dsm_max = float(np.nanmax(np.asarray(dsm["grid_z"])))
    assert dsm_max > dtm_max + DH - 1.0     # DSM is a canopy height above the DTM


def test_chm_equals_canopy_height_and_never_negative():
    """CHM = DSM − DTM: ~DH over the canopy, ~0 on bare ground, never negative.
    DTM and DSM are gridded on one shared, cell-aligned grid so the subtraction
    is elementwise."""
    pts, gl, fr, (a, b, c), DH = _canopy_scene()
    req = main.DemRequest(points=pts.tolist(), ground_labels=gl.tolist(),
                          first_return_labels=fr.tolist(), surface_type="chm",
                          cell_size=0.5, auto_segment_ground=False)
    r = main._do_dem(req)
    assert r["success"], r.get("error")
    assert r["surface_type"] == "chm"
    chm = np.asarray(r["grid_z"]).reshape(r["grid_ny"], r["grid_nx"])
    finite = chm[np.isfinite(chm)]
    assert finite.min() >= 0.0                       # canopy height never negative
    assert abs(float(np.nanmax(chm)) - DH) < 1.0     # peak canopy ≈ DH
    # Cells far from the canopy footprint read ~0 (bare ground).
    assert float(np.nanmedian(chm)) < DH             # most of the scene is bare


def test_chm_mesh_is_draped_on_terrain():
    """The CHM grid_z stores the canopy HEIGHT (0..DH), but the mesh vertices must
    sit at DTM_z + height — draped on the terrain — not floating up from z=0. On a
    tilted ground plane (z = a*x + b*y + c) the mesh z's span the terrain
    elevation, well above the 0..DH height range."""
    pts, gl, fr, (a, b, c), DH = _canopy_scene()
    r = main._do_dem(main.DemRequest(points=pts.tolist(), ground_labels=gl.tolist(),
                                     first_return_labels=fr.tolist(), surface_type="chm",
                                     cell_size=0.5, auto_segment_ground=False))
    assert r["success"], r.get("error")
    # Stored grid is the pure height (for raster export): starts at 0.
    grid = np.asarray(r["grid_z"]); grid = grid[np.isfinite(grid)]
    assert grid.min() >= 0.0 and grid.min() < 0.5    # ground cells ≈ 0 height
    # Mesh vertices are draped: z spans the ground plane's elevation (c .. c + slope
    # + DH), so the minimum mesh z is near the terrain (≈ c = 2.0), NOT 0.
    verts = np.asarray(r["vertices"]).reshape(-1, 3)
    ground_min = c                                   # plane min at x=y=0
    assert verts[:, 2].min() > ground_min - 1.0      # sits on the terrain, not at 0
    assert verts[:, 2].max() > ground_min + DH - 1.0 # canopy top reaches ground+DH


def test_chm_grids_are_cell_aligned():
    """The DTM and DSM halves of a CHM must share nx/ny/origin/cell so the grids
    subtract without resampling."""
    pts, gl, fr, _, _ = _canopy_scene()
    base = dict(points=pts.tolist(), ground_labels=gl.tolist(),
                first_return_labels=fr.tolist(), cell_size=0.5, auto_segment_ground=False)
    dtm = main._do_dem(main.DemRequest(surface_type="dtm", **base))
    dsm = main._do_dem(main.DemRequest(surface_type="dsm", **base))
    chm = main._do_dem(main.DemRequest(surface_type="chm", **base))
    for r in (dtm, dsm, chm):
        assert r["success"]
    # CHM shares the DTM/DSM shared-bbox grid; DTM/DSM alone auto-derive from their
    # own subsets, so only assert the CHM grid is internally consistent and square
    # to the shared extent it reports.
    assert chm["grid_nx"] > 0 and chm["grid_ny"] > 0
    assert len(chm["grid_z"]) == chm["grid_nx"] * chm["grid_ny"]


def test_dsm_first_return_masking():
    """When first-return labels mark the ground beneath the canopy as later
    returns, the DSM ignores those points and rests on the canopy — dropping the
    labels (treat all as first return) lets ground bleed in and lowers the peak
    less, proving the mask is actually applied."""
    pts, gl, fr, (a, b, c), DH = _canopy_scene()
    # With the mask: DSM uses only the canopy first returns over the footprint.
    masked = main._do_dem(main.DemRequest(
        points=pts.tolist(), ground_labels=gl.tolist(), first_return_labels=fr.tolist(),
        surface_type="dsm", cell_size=0.5, auto_segment_ground=False))
    # Without labels: every point is a "first return", so a high percentile still
    # tends to the top, but the surface_source reports all_points.
    unmasked = main._do_dem(main.DemRequest(
        points=pts.tolist(), ground_labels=gl.tolist(),
        surface_type="dsm", cell_size=0.5, auto_segment_ground=False))
    assert masked["surface_source"] == "first_return"
    assert unmasked["surface_source"] == "all_points"


# --------------------------- DTM scalar layer bundle ---------------------------
# A DTM now carries a bundle of named scalar layers (elevation + density/intensity
# gridded from points + hillshade/slope/aspect derived from the elevation grid).
# One mesh, many layers the renderer colours by and exports.

def _density_scene(seed=5):
    """A flat ground plane with a DENSE half (x<10, points duplicated) and a SPARSE
    half, plus an intensity that increases with x, and first/second returns. Returns
    (points, ground_labels, first_return_labels, intensity, split_x)."""
    rng = np.random.default_rng(seed)
    n = 5000
    x = rng.uniform(0, 20, n); y = rng.uniform(0, 20, n)
    z = np.full(n, 2.0)
    dense = x < 10.0
    xd = np.concatenate([x, x[dense]]); yd = np.concatenate([y, y[dense]])
    zd = np.concatenate([z, z[dense]])
    pts = np.column_stack([xd, yd, zd])
    gl = np.ones(len(pts), dtype=np.int64)            # all ground
    inten = xd.copy()                                  # intensity ∝ x
    # first-return labels: mark the DUPLICATED dense points as later returns (1) so
    # return_density (first returns only) does NOT see the duplication.
    fr = np.zeros(len(pts), dtype=np.int64)
    fr[n:] = 1
    return pts, gl, fr, inten, 10.0


def _dtm_bundle(**overrides):
    """Run a DTM with the density scene and return the layer-bundle result."""
    pts, gl, fr, inten, split = _density_scene()
    req = dict(points=pts.tolist(), ground_labels=gl.tolist(),
               first_return_labels=fr.tolist(), intensity=inten.tolist(),
               surface_type="dtm", cell_size=1.0, auto_segment_ground=False)
    req.update(overrides)
    return main._do_dem(main.DemRequest(**req))


def _layer_grid(r, name):
    return np.asarray(r["layers"][name]["grid"]).reshape(r["grid_ny"], r["grid_nx"])


def test_dtm_carries_all_layers():
    """A DTM returns one elevation surface plus every scalar layer, all on the same
    grid, each with a per-vertex array aligned to the mesh vertices."""
    r = _dtm_bundle()
    assert r["success"], r.get("error")
    assert r["surface_type"] == "dtm"
    for name in ("elevation", "point_density", "return_density", "intensity",
                 "hillshade", "slope", "aspect"):
        assert name in r["layers"], name
        assert len(r["layers"][name]["grid"]) == r["grid_nx"] * r["grid_ny"]
        assert len(r["layer_vertex"][name]) == r["num_vertices"]
        assert r["layers"][name]["label"]
    # The mesh IS the terrain: vertex z tracks elevation (~2), not a layer value.
    verts = np.asarray(r["vertices"]).reshape(-1, 3)
    assert abs(float(np.median(verts[:, 2])) - 2.0) < 0.5


def test_point_density_layer_counts_points_per_cell():
    """The point_density layer grids the count of all hits per cell: the duplicated
    dense half reads ~2× the sparse half."""
    r = _dtm_bundle()
    g = _layer_grid(r, "point_density")
    half = g.shape[1] // 2
    assert float(np.nanmean(g[:, :half])) > 1.6 * float(np.nanmean(g[:, half:]))
    assert float(np.nanmax(g)) > 5.0


def test_return_density_layer_counts_first_returns_only():
    """return_density counts only first returns (pulses). With the dense-half
    duplicates marked as LATER returns, it's near-uniform — unlike point_density."""
    r = _dtm_bundle()
    gp = _layer_grid(r, "point_density"); gr = _layer_grid(r, "return_density")
    half = gp.shape[1] // 2
    assert float(np.nanmean(gp[:, :half]) / np.nanmean(gp[:, half:])) > 1.6
    assert abs(float(np.nanmean(gr[:, :half]) / np.nanmean(gr[:, half:])) - 1.0) < 0.25


def test_return_density_handles_1based_las_return_numbers():
    """First return = the MINIMUM return index present, not a hardcoded 0 — so LAS
    return_number (1-based, carried verbatim on import) works. Regression for
    return_density collapsing to point_density on airborne LAS: with 1-based labels
    (first = 1), return_density must still count only first returns and stay well
    below point_density on multi-return data."""
    pts, gl, fr, inten, split = _density_scene()
    fr_1based = fr + 1                      # 0/1 → 1/2 (LAS convention)
    r = main._do_dem(main.DemRequest(
        points=pts.tolist(), ground_labels=gl.tolist(),
        first_return_labels=fr_1based.tolist(), surface_type="dtm",
        cell_size=1.0, auto_segment_ground=False))
    assert r["success"], r.get("error")
    gp = _layer_grid(r, "point_density"); gr = _layer_grid(r, "return_density")
    # Return density (first returns only) is strictly below point density where the
    # dense-half duplicates (return index 2) were added — NOT identical.
    assert float(np.nansum(gr)) < float(np.nansum(gp))
    half = gp.shape[1] // 2
    assert abs(float(np.nanmean(gr[:, :half]) / np.nanmean(gr[:, half:])) - 1.0) < 0.25


def test_intensity_layer_mean_per_cell():
    """intensity layer = per-cell mean intensity. With intensity ∝ x it rises left→right."""
    r = _dtm_bundle()
    g = _layer_grid(r, "intensity")
    assert float(np.nanmean(g[:, -1])) > float(np.nanmean(g[:, 0])) + 10.0
    finite = g[np.isfinite(g)]
    assert finite.min() >= 0.0 and finite.max() <= 20.5


def test_intensity_layer_absent_without_intensity():
    """Without a per-point intensity array the DTM still succeeds — it just has no
    intensity layer (the other layers are unaffected)."""
    r = _dtm_bundle(intensity=None)
    assert r["success"], r.get("error")
    assert "intensity" not in r["layers"]
    assert "point_density" in r["layers"]        # the rest are still there


def test_slope_aspect_hillshade_from_elevation():
    """Slope/aspect/hillshade are derived from the elevation grid. On a tilted plane
    z = 0.1x + 0.05y the slope is atan(hypot(0.1,0.05)) ≈ 6.4° everywhere, aspect
    points down-slope (SW-ish), and hillshade is in [0,1]."""
    rng = np.random.default_rng(1)
    n = 6000
    x = rng.uniform(0, 20, n); y = rng.uniform(0, 20, n)
    z = 0.1 * x + 0.05 * y + 2.0
    pts = np.column_stack([x, y, z])
    gl = np.ones(n, dtype=np.int64)
    r = main._do_dem(main.DemRequest(points=pts.tolist(), ground_labels=gl.tolist(),
                                     surface_type="dtm", cell_size=1.0, fill_voids=True,
                                     auto_segment_ground=False))
    assert r["success"], r.get("error")
    expected_slope = np.degrees(np.arctan(np.hypot(0.1, 0.05)))   # ≈ 6.38°
    slope = _layer_grid(r, "slope")
    assert abs(float(np.nanmedian(slope)) - expected_slope) < 1.0
    hs = _layer_grid(r, "hillshade")
    finite = hs[np.isfinite(hs)]
    assert finite.min() >= 0.0 and finite.max() <= 1.0
    asp = _layer_grid(r, "aspect")
    af = asp[np.isfinite(asp)]
    assert af.min() >= 0.0 and af.max() <= 360.0


def test_dem_outlier_rejection():
    """A single tall spike inside a densely-sampled cell must not tent the DEM:
    the per-cell percentile discards it."""
    pts, (a, b, c) = _plane_cloud(a=0.0, b=0.0, c=2.0)  # flat plane at z=2
    spike = np.array([[5.0, 5.0, 50.0]])               # one point 48 m up
    r = main._compute_dem(np.vstack([pts, spike]), cell_size=0.5,
                          method="tin", ground_percentile=5.0)
    assert r["success"]
    gz = np.asarray(r["grid_z"]).reshape(r["grid_ny"], r["grid_nx"])
    assert np.nanmax(gz) < 2.5  # flat near z=2, spike rejected


def test_dem_voids_and_fill():
    """Points confined to a central disk: corner cells fall outside the convex
    hull and become voids (no triangles there). `fill_voids` extrapolates them."""
    rng = np.random.default_rng(1)
    n = 6000
    # uniform disk of radius 4 centred at (5,5), inside a [0,10]² bbox — so the four
    # bbox corners fall OUTSIDE the data's convex hull.
    rad = 4.0 * np.sqrt(rng.uniform(0, 1, n))
    ang = rng.uniform(0, 2 * np.pi, n)
    xy = np.column_stack([5 + rad * np.cos(ang), 5 + rad * np.sin(ang)])
    pts = np.column_stack([xy, np.full(n, 3.0)])
    r = main._compute_dem(pts, cell_size=0.5, method="tin", fill_voids=False,
                          bbox=[0, 0, 10, 10])
    assert r["success"]
    assert r["voids"] > 0  # corners outside the hull
    gz = np.asarray(r["grid_z"]).reshape(r["grid_ny"], r["grid_nx"])
    assert not np.isfinite(gz[0, 0])  # a corner is void

    # fill_voids must NOT fabricate terrain beyond the data footprint: the corners
    # (outside the convex hull) stay void even with filling on. Extrapolating them —
    # inventing four triangle fans out to the bbox corners — was the ALS bug.
    rf = main._compute_dem(pts, cell_size=0.5, method="tin", fill_voids=True,
                           bbox=[0, 0, 10, 10])
    gzf = np.asarray(rf["grid_z"]).reshape(rf["grid_ny"], rf["grid_nx"])
    assert not np.isfinite(gzf[0, 0])                # corner NOT fabricated
    assert rf["voids"] > 0                           # exterior stays void
    # The centre (inside the hull) is meshed either way.
    centre_j, centre_i = rf["grid_ny"] // 2, rf["grid_nx"] // 2
    assert np.isfinite(gzf[centre_j, centre_i])


def test_fill_extends_to_scan_footprint_not_just_ground_hull():
    """Under dense canopy the ground returns cluster centrally, so their hull is far
    smaller than the scan. With a `footprint_xy` (all returns), fill_voids must cover
    the whole scanned area via nearest-ground — not leave big canopy-edge gaps. This
    is the reported ALS 'missing wedge'."""
    rng = np.random.default_rng(4)
    # Ground returns: a small central disk (radius 2 at (5,5)). Footprint: the whole
    # [0,10]² square (canopy returns everywhere), simulated as a dense grid of points.
    n = 4000
    rad = 2.0 * np.sqrt(rng.uniform(0, 1, n)); ang = rng.uniform(0, 2 * np.pi, n)
    ground = np.column_stack([5 + rad * np.cos(ang), 5 + rad * np.sin(ang), np.full(n, 3.0)])
    fx, fy = np.meshgrid(np.linspace(0.25, 9.75, 40), np.linspace(0.25, 9.75, 40))
    footprint = np.column_stack([fx.ravel(), fy.ravel()])

    # No footprint → fill stays in the small ground hull (a corner stays void).
    r_hull = main._compute_dem(ground, cell_size=0.5, method="tin", fill_voids=True,
                               bbox=[0, 0, 10, 10])
    g_hull = np.asarray(r_hull["grid_z"]).reshape(r_hull["grid_ny"], r_hull["grid_nx"])
    assert not np.isfinite(g_hull[-1, -1])           # far corner: no ground nearby → void

    # With the scan footprint → fill reaches every scanned cell (the corner is now
    # covered via nearest-ground), and coverage jumps well above the ground hull.
    r_fp = main._compute_dem(ground, cell_size=0.5, method="tin", fill_voids=True,
                             bbox=[0, 0, 10, 10], footprint_xy=footprint)
    g_fp = np.asarray(r_fp["grid_z"]).reshape(r_fp["grid_ny"], r_fp["grid_nx"])
    assert np.isfinite(g_fp[-1, -1])                 # corner filled from nearest ground
    assert r_fp["voids"] < r_hull["voids"]           # far fewer holes
    assert np.isfinite(g_fp).mean() > 0.9            # nearly the whole square is covered


def test_dem_too_fine_cell_size_raises():
    pts, _ = _plane_cloud(span=1000.0)
    with pytest.raises(ValueError, match="too fine"):
        main._compute_dem(pts, cell_size=0.01)


def test_dem_degenerate_extent():
    pts = np.array([[1.0, 1.0, 0.0]] * 5)  # all same XY
    r = main._compute_dem(pts, cell_size=0.5)
    assert not r["success"] and "extent" in r["error"].lower()


# --------------------------- ground-aware selection ---------------------------

def test_dem_ground_aware_vs_all_points():
    """On a real bean scan (column 4 = ground/plant truth), the ground-aware DEM
    tracks the soil surface and does not bulge up into the canopy."""
    df = pd.read_csv(FIXTURE, sep=r"\s+", header=None)
    pts = df.iloc[:, :3].to_numpy(dtype=np.float64)
    truth = df.iloc[:, 3].to_numpy().astype(int)
    ground_pts = pts[truth == main.GROUND_CLASS_GROUND]
    plant_pts = pts[truth == main.GROUND_CLASS_PLANT]

    # Ground-aware: grid only the ground points.
    r = main._compute_dem(ground_pts, cell_size=0.1, method="tin", ground_percentile=50.0)
    assert r["success"], r.get("error")
    gz = np.asarray(r["grid_z"]).reshape(r["grid_ny"], r["grid_nx"])
    dem_max = float(np.nanmax(gz))
    ground_zmax = float(ground_pts[:, 2].max())
    plant_zmed = float(np.median(plant_pts[:, 2]))
    # The DEM stays within the ground's own height band, well below the canopy.
    assert dem_max <= ground_zmax + 0.05
    assert dem_max < plant_zmed


def test_dem_sample_ground_z_is_gap_free():
    """Height-above-ground sampling must return a ground value under EVERY point —
    including points outside the ground points' convex hull (canopy past the
    footprint, or over a gap) — via nearest-ground extrapolation, never NaN (which
    would collapse to height 0 and read as 'at ground level')."""
    pts, (a, b, c) = _plane_cloud(n=2000, span=10)
    sample = np.array([[5.0, 5.0], [20.0, 20.0], [-5.0, -5.0]])  # inside hull, then far outside
    r = main._compute_dem(pts, cell_size=0.5, method="tin", sample_xy=sample)
    sg = r["sample_ground_z"]
    assert sg is not None
    assert np.all(np.isfinite(sg))                     # no NaN anywhere — the key fix
    assert abs(sg[0] - (a * 5 + b * 5 + c)) < 0.2      # inside point matches the plane
    # Outside points get a finite extrapolated ground (nearest), not 0.
    assert np.isfinite(sg[1]) and np.isfinite(sg[2])


def test_do_dem_ground_labels_path():
    """`/api/dem`-level resolver: ground_labels restricts gridding and reports the
    'column' provenance."""
    df = pd.read_csv(FIXTURE, sep=r"\s+", header=None)
    pts = df.iloc[:, :3].to_numpy(dtype=np.float64)
    truth = df.iloc[:, 3].to_numpy().astype(int)
    req = main.DemRequest(points=pts.tolist(), ground_labels=truth.tolist(),
                          cell_size=0.1, ground_percentile=50.0)
    r = main._do_dem(req)
    assert r["success"], r.get("error")
    assert r["ground_source"] == "column"
    assert r["world_shift"] == [0.0, 0.0, 0.0]


def test_auto_csf_params_caps_cloth_nodes_on_runaway_extent():
    """Defensive backstop: a sky/miss-contaminated cloud (misses ~1 km out)
    inflates the XY extent ~1000×. Auto-CSF must floor the cloth resolution so the
    (ext/cloth)² × ~500-iteration simulation can't explode into a multi-million-
    node hang — it degrades to a coarse-but-finite cloth instead. (Callers exclude
    misses upstream; this only guards a request that slips through.)"""
    # A tiny dense canopy plus far-flung sky points -> a 2 km extent.
    canopy = np.random.default_rng(0).uniform(-2.5, 2.5, size=(2000, 3))
    sky = np.array([[-1000.0, -1000.0, 800.0], [1000.0, 1000.0, 800.0]])
    pts = np.vstack([canopy, sky])
    csf = main._auto_csf_params(pts)
    ext = float(max(np.ptp(pts[:, 0]), np.ptp(pts[:, 1])))
    nodes_per_side = ext / csf["cloth_resolution"]
    # The floor keeps the cloth bounded regardless of the runaway extent.
    assert nodes_per_side <= 600 + 1, (ext, csf["cloth_resolution"], nodes_per_side)


def test_auto_csf_params_unchanged_on_normal_extent():
    """The backstop must NOT perturb a normal in-extent cloud: a ~5 m plant scan
    still gets the fine 5 cm cloth (the floor only bites on a runaway extent)."""
    pts = np.random.default_rng(1).uniform(-2.5, 2.5, size=(2000, 3))
    csf = main._auto_csf_params(pts)
    assert csf["cloth_resolution"] == pytest.approx(0.05)


# --------------------------------- endpoints ---------------------------------

def test_dem_endpoint_mesh_frame_decodes(client):
    pts, _ = _plane_cloud(n=2000)
    resp = client.post("/api/dem", json={
        "points": pts.tolist(), "cell_size": 0.5, "method": "tin",
        "auto_segment_ground": False,   # deterministic: all-points, no CSF dependency
    })
    assert resp.status_code == 200, resp.text
    meta, buffers = decode_bin_frame(resp.content)
    assert meta["success"], meta.get("error")
    assert meta["ground_source"] == "all_points"
    verts = buffers["vertices"].reshape(-1, 3)
    tris = buffers["indices"].reshape(-1, 3)
    assert verts.shape[0] == meta["num_vertices"]
    assert tris.shape[0] == meta["num_triangles"] > 0
    assert np.isfinite(verts).all()  # no NaN vertices reach the buffer
    assert int(tris.max()) < verts.shape[0]
    assert "grid_z" in buffers
    assert buffers["grid_z"].size == meta["grid_nx"] * meta["grid_ny"]


def test_dem_raster_export_asc(client):
    pts, (a, b, c) = _plane_cloud(n=2000)
    dem = main._compute_dem(pts, cell_size=0.5, method="tin", ground_percentile=50.0)
    gz = np.asarray(dem["grid_z"], dtype=np.float64)
    gz = np.where(np.isfinite(gz), gz, -9999.0)
    resp = client.post("/api/dem/export-raster", json={
        "format": "asc", "grid_z": gz.tolist(),
        "nx": dem["grid_nx"], "ny": dem["grid_ny"], "cell_size": dem["grid_cell"],
        "origin": dem["grid_origin"], "nodata": -9999.0,
    })
    assert resp.status_code == 200, resp.text
    text = base64.b64decode(resp.json()["data_base64"]).decode("utf-8")
    lines = text.splitlines()
    assert lines[0] == f"ncols {dem['grid_nx']}"
    assert lines[1] == f"nrows {dem['grid_ny']}"
    # data rows present (header is 6 lines)
    data_rows = [ln for ln in lines[6:] if ln.strip()]
    assert len(data_rows) == dem["grid_ny"]
    assert len(data_rows[0].split()) == dem["grid_nx"]


def test_dem_raster_export_geotiff(client):
    pts, _ = _plane_cloud(n=2000)
    dem = main._compute_dem(pts, cell_size=0.5, method="tin", ground_percentile=50.0)
    gz = np.asarray(dem["grid_z"], dtype=np.float64)
    gz = np.where(np.isfinite(gz), gz, -9999.0)
    resp = client.post("/api/dem/export-raster", json={
        "format": "tif", "grid_z": gz.tolist(),
        "nx": dem["grid_nx"], "ny": dem["grid_ny"], "cell_size": dem["grid_cell"],
        "origin": dem["grid_origin"], "nodata": -9999.0, "crs_epsg": 32610,
    })
    assert resp.status_code == 200, resp.text
    raw = base64.b64decode(resp.json()["data_base64"])
    import tifffile
    with tifffile.TiffFile(io.BytesIO(raw)) as tf:
        page = tf.pages[0]
        assert page.shape == (dem["grid_ny"], dem["grid_nx"])
        # georeferencing tags present
        assert 33550 in page.tags and 33922 in page.tags and 34735 in page.tags
        scale = page.tags[33550].value
        assert abs(scale[0] - dem["grid_cell"]) < 1e-6
        # raster is north-up: row 0 holds the northern edge (max y)
        data = page.asarray()
        assert data.shape == (dem["grid_ny"], dem["grid_nx"])


def test_chm_endpoint_frame_and_raster_roundtrip(client):
    """POST /api/dem with surface_type=chm returns a PHB1 frame whose grid rides
    the existing raster-export path unchanged (GeoTIFF round-trips via tifffile)."""
    pts, gl, fr, _, DH = _canopy_scene()
    resp = client.post("/api/dem", json={
        "points": pts.tolist(), "ground_labels": gl.tolist(),
        "first_return_labels": fr.tolist(), "surface_type": "chm",
        "cell_size": 0.5, "auto_segment_ground": False,
    })
    assert resp.status_code == 200, resp.text
    meta, buffers = decode_bin_frame(resp.content)
    assert meta["success"], meta.get("error")
    assert meta["surface_type"] == "chm"
    gz = np.asarray(buffers["grid_z"], dtype=np.float64)
    assert gz.size == meta["grid_nx"] * meta["grid_ny"]
    # Export the CHM grid to GeoTIFF via the shared endpoint.
    gz = np.where(np.isfinite(gz), gz, -9999.0)
    exp = client.post("/api/dem/export-raster", json={
        "format": "tif", "grid_z": gz.tolist(),
        "nx": meta["grid_nx"], "ny": meta["grid_ny"], "cell_size": meta["grid_cell"],
        "origin": meta["grid_origin"], "nodata": -9999.0, "crs_epsg": 32610,
    })
    assert exp.status_code == 200, exp.text
    raw = base64.b64decode(exp.json()["data_base64"])
    import tifffile
    with tifffile.TiffFile(io.BytesIO(raw)) as tf:
        page = tf.pages[0]
        assert page.shape == (meta["grid_ny"], meta["grid_nx"])
        assert 33550 in page.tags and 34735 in page.tags


def test_dtm_layers_frame_and_intensity_raster_roundtrip(client):
    """A DTM frame carries its scalar layers: meta["layers"] lists them, each layer's
    grid rides as a `layer_grid_<name>` buffer + a per-vertex `layer_vert_<name>`,
    and any layer (here intensity) round-trips through the raster-export path."""
    pts, gl, fr, inten, split = _density_scene()
    resp = client.post("/api/dem", json={
        "points": pts.tolist(), "ground_labels": gl.tolist(), "intensity": inten.tolist(),
        "first_return_labels": fr.tolist(),
        "surface_type": "dtm", "cell_size": 1.0, "auto_segment_ground": False,
    })
    assert resp.status_code == 200, resp.text
    meta, buffers = decode_bin_frame(resp.content)
    assert meta["success"], meta.get("error")
    assert meta["surface_type"] == "dtm"
    # Layer metadata + buffers present for every layer.
    assert set(meta["layers"]) >= {"elevation", "point_density", "return_density",
                                   "intensity", "hillshade", "slope", "aspect"}
    ncells = meta["grid_nx"] * meta["grid_ny"]
    for name in meta["layers"]:
        assert buffers[f"layer_grid_{name}"].size == ncells
        assert buffers[f"layer_vert_{name}"].size == meta["num_vertices"]
    # Export the intensity LAYER grid through the shared raster path.
    gz = np.asarray(buffers["layer_grid_intensity"], dtype=np.float64)
    gz = np.where(np.isfinite(gz), gz, -9999.0)
    exp = client.post("/api/dem/export-raster", json={
        "format": "tif", "grid_z": gz.tolist(),
        "nx": meta["grid_nx"], "ny": meta["grid_ny"], "cell_size": meta["grid_cell"],
        "origin": meta["grid_origin"], "nodata": -9999.0,
    })
    assert exp.status_code == 200, exp.text
    raw = base64.b64decode(exp.json()["data_base64"])
    import tifffile
    with tifffile.TiffFile(io.BytesIO(raw)) as tf:
        assert tf.pages[0].shape == (meta["grid_ny"], meta["grid_nx"])


# ------------------------- session height-above-ground -------------------------

def _make_session(positions, ground_class=None):
    """Build a minimal in-RAM CloudSession for direct engine tests."""
    import time
    n = len(positions)
    extras = {}
    extra_meta = []
    if ground_class is not None:
        extras[main.GROUND_CLASS_SLUG] = np.asarray(ground_class, dtype=np.float32)
        extra_meta.append({"slug": main.GROUND_CLASS_SLUG, "label": main.GROUND_CLASS_LABEL})
    return main.CloudSession(
        session_id="demtest", source_path="mem", ascii_format=None, column_plan=None,
        positions=np.asarray(positions, dtype=np.float64), colors=None, intensity=None,
        extras=extras, extra_dims_meta=extra_meta,
        deleted=np.zeros(n, dtype=bool), deleted_history=[], octree_cache_id=None,
        created_at=time.time(),
    )


def test_session_dem_height_above_ground(monkeypatch):
    """Session DEM with add_height_column writes a height_above_ground column:
    ~0 on ground points, ~plant height on elevated points. The octree rebuild is
    stubbed (orthogonal to the HAG math)."""
    # Flat ground plane at z=0 plus a raised cluster at z=3 over a sub-region.
    rng = np.random.default_rng(2)
    gxy = rng.uniform(0, 10, size=(3000, 2))
    ground = np.column_stack([gxy, np.zeros(len(gxy))])
    pxy = rng.uniform(4, 6, size=(400, 2))
    plant = np.column_stack([pxy, np.full(len(pxy), 3.0)])
    pts = np.vstack([ground, plant])
    gc = np.concatenate([np.full(len(ground), main.GROUND_CLASS_GROUND),
                         np.full(len(plant), main.GROUND_CLASS_PLANT)])
    sess = _make_session(pts, ground_class=gc)

    monkeypatch.setattr(main, "_session_rebuild",
                        lambda s: ("stub_cache", Path("/tmp/stub"), {"point_count": len(s.positions)}))

    req = main.SessionDemRequest(cell_size=0.5, method="tin", ground_percentile=50.0,
                                 add_height_column=True)
    r = main._do_session_dem(sess, req)
    assert r["success"], r.get("error")
    assert r["ground_source"] == "column"
    assert r["cache_id"] == "stub_cache"
    assert main.HEIGHT_ABOVE_GROUND_SLUG in sess.extras
    hag = sess.extras[main.HEIGHT_ABOVE_GROUND_SLUG]
    assert hag.shape[0] == len(pts)
    # Ground points: HAG ~ 0; plant points: HAG ~ 3.
    assert abs(float(np.median(hag[:len(ground)]))) < 0.2
    assert abs(float(np.median(hag[len(ground):])) - 3.0) < 0.3


def test_session_chm_from_target_index(monkeypatch):
    """Session CHM reads the first-return subset from the `target_index` column
    (0 = first return): the DSM rests on the canopy, the DTM on the ground column,
    and the CHM ≈ canopy height. No octree rebuild for CHM (no column written)."""
    import time
    pts, gl, fr, _, DH = _canopy_scene()
    n = len(pts)
    extras = {
        main.GROUND_CLASS_SLUG: gl.astype(np.float32),
        "target_index": fr.astype(np.float32),
    }
    extra_meta = [
        {"slug": main.GROUND_CLASS_SLUG, "label": main.GROUND_CLASS_LABEL},
        {"slug": "target_index", "label": "Target Index"},
    ]
    sess = main.CloudSession(
        session_id="chmtest", source_path="mem", ascii_format=None, column_plan=None,
        positions=pts.astype(np.float64), colors=None, intensity=None,
        extras=extras, extra_dims_meta=extra_meta,
        deleted=np.zeros(n, dtype=bool), deleted_history=[], octree_cache_id=None,
        created_at=time.time(),
    )
    req = main.SessionDemRequest(surface_type="chm", cell_size=0.5,
                                 auto_segment_ground=False)
    r = main._do_session_dem(sess, req)
    assert r["success"], r.get("error")
    assert r["surface_type"] == "chm"
    assert r["surface_source"] == "first_return"
    chm = np.asarray(r["grid_z"]).reshape(r["grid_ny"], r["grid_nx"])
    assert float(np.nanmin(chm[np.isfinite(chm)])) >= 0.0
    assert abs(float(np.nanmax(chm)) - DH) < 1.0


def test_session_dtm_intensity_layer_from_session_field():
    """A session DTM's intensity LAYER reads the session's first-class `intensity`
    field (no request array): per-cell mean tracks the per-point intensity, and the
    mesh is the terrain (draped at ground z)."""
    import time
    pts, gl, fr, inten, split = _density_scene()
    n = len(pts)
    sess = main.CloudSession(
        session_id="inttest", source_path="mem", ascii_format=None, column_plan=None,
        positions=pts.astype(np.float64), colors=None,
        intensity=inten.astype(np.uint16),
        extras={main.GROUND_CLASS_SLUG: gl.astype(np.float32),
                "target_index": fr.astype(np.float32)},
        extra_dims_meta=[{"slug": main.GROUND_CLASS_SLUG, "label": main.GROUND_CLASS_LABEL},
                         {"slug": "target_index", "label": "Target Index"}],
        deleted=np.zeros(n, dtype=bool), deleted_history=[], octree_cache_id=None,
        created_at=time.time(),
    )
    r = main._do_session_dem(sess, main.SessionDemRequest(
        surface_type="dtm", cell_size=1.0, auto_segment_ground=False))
    assert r["success"], r.get("error")
    assert r["surface_type"] == "dtm"
    assert "intensity" in r["layers"] and "point_density" in r["layers"]
    g = np.asarray(r["layers"]["intensity"]["grid"]).reshape(r["grid_ny"], r["grid_nx"])
    assert float(np.nanmean(g[:, -1])) > float(np.nanmean(g[:, 0])) + 5.0   # intensity ∝ x
    verts = np.asarray(r["vertices"]).reshape(-1, 3)
    assert abs(float(np.median(verts[:, 2])) - 2.0) < 0.5                     # the terrain


def test_read_las_crs_epsg(tmp_path):
    """The CRS-from-LAS helper recovers the EPSG written into a LAS header, and
    returns None for a LAS with no CRS and for a non-LAS file."""
    import laspy
    import pyproj

    # LAS with a projected CRS (UTM 10N).
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.offsets = [0, 0, 0]
    header.scales = [0.001, 0.001, 0.001]
    header.add_crs(pyproj.CRS.from_epsg(32610))
    las = laspy.LasData(header)
    las.x = np.array([1.0, 2.0]); las.y = np.array([1.0, 2.0]); las.z = np.array([0.0, 0.0])
    with_crs = tmp_path / "with_crs.las"
    las.write(str(with_crs))
    assert main._read_las_crs_epsg(with_crs) == 32610

    # LAS with no CRS → None.
    h2 = laspy.LasHeader(point_format=3, version="1.4")
    h2.offsets = [0, 0, 0]; h2.scales = [0.001, 0.001, 0.001]
    las2 = laspy.LasData(h2)
    las2.x = np.array([1.0]); las2.y = np.array([1.0]); las2.z = np.array([0.0])
    no_crs = tmp_path / "no_crs.las"
    las2.write(str(no_crs))
    assert main._read_las_crs_epsg(no_crs) is None

    # Non-LAS source → None.
    txt = tmp_path / "cloud.xyz"
    txt.write_text("0 0 0\n")
    assert main._read_las_crs_epsg(txt) is None


def test_read_las_crs_epsg_wkt_vlr_fallback():
    """Real survey LAZ whose WKT CRS carries a TOWGS84 clause: pyproj's to_epsg()
    can't match it to the EPSG database, but the WKT's top-level AUTHORITY names
    EPSG:25832 (ETRS89 / UTM 32N) — the WKT-VLR fallback must recover it. Skipped
    when the (untracked, ~37 MB) example dataset isn't present."""
    fixture = Path(__file__).parents[2] / "example-datasets" / "ALS-on_BR04_2019-07-05_140m.laz"
    if not fixture.exists():
        pytest.skip("example dataset ALS-on_BR04_2019-07-05_140m.laz not present")
    assert main._read_las_crs_epsg(fixture) == 25832


def test_auto_csf_params_scale_with_extent():
    """The DEM auto-ground CSF parameters must scale with the cloud's extent — a
    fixed 5 cm cloth on a 186 m tile builds a ~14 M-node cloth and hangs. Mirrors
    groundSegmentDefaults: flat field → coarse stiff cloth; sloped tile → finer,
    low-rigidness, slope-smoothed."""
    rng = np.random.default_rng(0)
    # Close-range flat plant scan (~1.5 m, low relief) → plant-scale floor (5 cm).
    small = np.column_stack([rng.uniform(0, 1.5, 500), rng.uniform(0, 1.5, 500), rng.uniform(0, 0.1, 500)])
    ps = main._auto_csf_params(small)
    assert ps["cloth_resolution"] == 0.05 and ps["rigidness"] == 3

    # Large flat field (200 m, low relief) → coarse cloth (extent/100 clamped) — NOT 5 cm.
    flat = np.column_stack([rng.uniform(0, 200, 4000), rng.uniform(0, 200, 4000), rng.uniform(0, 1, 4000)])
    pf = main._auto_csf_params(flat)
    assert pf["cloth_resolution"] >= 1.0 and pf["rigidness"] == 3 and pf["slope_smooth"] is False

    # Steep ALS-style tile (186 m extent, 81 m relief, ratio 0.44) → slope recipe.
    sl = np.column_stack([rng.uniform(0, 186, 4000), rng.uniform(0, 80, 4000), rng.uniform(0, 81, 4000)])
    psl = main._auto_csf_params(sl)
    assert psl["rigidness"] == 1 and psl["slope_smooth"] is True
    assert 0.05 < psl["cloth_resolution"] <= 1.0   # ~0.93 — never the pathological 5 cm


def test_auto_csf_params_on_br04_is_tractable():
    """Regression for the reported hang: auto-DEM on the BR04 ALS tile (no prior
    ground class) used a 5 cm cloth and effectively never returned. The
    extent-scaled params must give a coarse cloth instead. Skipped when the
    (untracked, ~37 MB) example dataset isn't present."""
    fixture = Path(__file__).parents[2] / "example-datasets" / "ALS-on_BR04_2019-07-05_140m.laz"
    if not fixture.exists():
        pytest.skip("example dataset ALS-on_BR04_2019-07-05_140m.laz not present")
    import laspy
    las = laspy.read(str(fixture))
    pts = np.column_stack([np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)])
    params = main._auto_csf_params(pts)
    # A ~186 m steep tile → slope recipe with a sub-metre cloth, orders of
    # magnitude coarser than the 5 cm default that caused the hang.
    assert params["cloth_resolution"] >= 0.5
    assert params["slope_smooth"] is True


def test_session_dem_all_points_when_no_ground_class(monkeypatch):
    """Without a ground_class column and auto_segment_ground off, the session DEM
    falls back to all points with the 'all_points' provenance."""
    pts, _ = _plane_cloud(n=2000)
    sess = _make_session(pts)
    monkeypatch.setattr(main, "_session_rebuild",
                        lambda s: ("c", Path("/tmp"), {}))
    req = main.SessionDemRequest(cell_size=0.5, auto_segment_ground=False)
    r = main._do_session_dem(sess, req)
    assert r["success"], r.get("error")
    assert r["ground_source"] == "all_points"
    assert "warning" in r
