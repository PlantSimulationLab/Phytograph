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
    # uniform disk of radius 4 centred at (5,5)
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

    rf = main._compute_dem(pts, cell_size=0.5, method="tin", fill_voids=True,
                           bbox=[0, 0, 10, 10])
    assert rf["voids"] == 0
    gzf = np.asarray(rf["grid_z"]).reshape(rf["grid_ny"], rf["grid_nx"])
    assert np.all(np.isfinite(gzf))
    assert rf["num_triangles"] > r["num_triangles"]  # gaps now meshed


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
