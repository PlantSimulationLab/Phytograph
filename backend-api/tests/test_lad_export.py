"""Gridded LAD export: /api/lad/export in all four formats.

The bar these tests hold: a known LAD value must read back at the correct voxel
index in EVERY format (not "the endpoint returned 200"), and an occluded voxel
must stay distinguishable from genuinely empty air all the way to the bytes on
disk. The latter is the failure mode the voxel-LAD literature warns about — an
occluded voxel counted as zero biases mean LAD and LAI low — and it is silent,
so it gets asserted explicitly in every format rather than inferred.
"""
import base64
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client():
    return TestClient(main.app)


# Grid geometry shared by the fixtures: 2x2x2 voxels of 0.5 m, lower-left-bottom
# corner at a deliberately LARGE world origin (UTM-scale easting/northing) so a
# lost worldShift shows up as a wrong tiepoint rather than a rounding difference.
ORIGIN = [412300.0, 4512100.0, 0.0]
CELL = [0.5, 0.5, 0.5]

# The one voxel carrying leaf area, and the one voxel no beam reached.
LEAFY_IJK = (0, 0, 0)
OCCLUDED_IJK = (1, 1, 0)
KNOWN_LAD = 2.0            # m2/m3 — the leaf-cube ground truth used by the E2E spec


def _cells(origin=ORIGIN, cell=CELL, nx=2, ny=2, nz=2):
    """A grid with one leafy voxel, one occluded voxel, the rest empty-but-solved."""
    out = []
    for k in range(nz):
        for j in range(ny):
            for i in range(nx):
                solved = (i, j, k) != OCCLUDED_IJK
                lad = KNOWN_LAD if (i, j, k) == LEAFY_IJK else 0.0
                volume = cell[0] * cell[1] * cell[2]
                out.append({
                    "center": [origin[0] + cell[0] * (i + 0.5),
                               origin[1] + cell[1] * (j + 0.5),
                               origin[2] + cell[2] * (k + 0.5)],
                    "size": list(cell),
                    "lad": lad,
                    "leaf_area": lad * volume,
                    "gtheta": 0.5,
                    "hit_count": 10 if lad else 0,
                    "beam_count": 100,
                    "mean_path_length": 0.4,
                    "lad_std": 0.3,
                    "solved": solved,
                })
    return out


def _request(fmt, **overrides):
    body = {
        "format": fmt,
        "cells": _cells(),
        "nx": 2, "ny": 2, "nz": 2,
        "origin": ORIGIN,
        "cell_size": CELL,
        "variables": ["lad"],
        "crs_epsg": 32610,
    }
    body.update(overrides)
    return body


def _files(client, fmt, **overrides):
    resp = client.post("/api/lad/export", json=_request(fmt, **overrides))
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["success"] is True
    return {f["name"]: base64.b64decode(f["data_base64"]) for f in payload["files"]}


# ---------------------------------------------------------------- GeoTIFF ----

def test_geotiff_is_multiband_with_one_band_per_level(client):
    """Bands are the vertical levels — the canopyLazR / AMAPVox toRaster shape."""
    import tifffile
    raw = _files(client, "tif")["lad_lad.tif"]
    with tifffile.TiffFile(io.BytesIO(raw)) as tf:
        page = tf.pages[0]
        assert page.samplesperpixel == 2          # nz
        data = page.asarray()
    assert data.shape == (2, 2, 2)                # (nz, ny, nx)

    # Rasters are written north-up, so row 0 is max y => j is flipped.
    i, j, k = LEAFY_IJK
    assert data[k, (2 - 1) - j, i] == pytest.approx(KNOWN_LAD)


def test_geotiff_carries_georeferencing_at_the_world_corner(client):
    """The tiepoint must be the WORLD corner.

    Voxel centers reach this endpoint in the world frame (the renderer adds
    worldShift back first). If that shift is ever dropped upstream the raster
    still writes cleanly but lands hundreds of km away, so pin the actual
    coordinate rather than merely asserting the tag exists.
    """
    import tifffile
    raw = _files(client, "tif")["lad_lad.tif"]
    with tifffile.TiffFile(io.BytesIO(raw)) as tf:
        page = tf.pages[0]
        for tag in (33550, 33922, 34735, 42113):
            assert tag in page.tags, f"missing GeoTIFF tag {tag}"
        assert page.tags[33550].value[0] == pytest.approx(CELL[0])
        tiepoint = page.tags[33922].value
        assert tiepoint[3] == pytest.approx(ORIGIN[0])              # minx
        assert tiepoint[4] == pytest.approx(ORIGIN[1] + 2 * CELL[1])  # maxy (north-up)
        assert 32610 in page.tags[34735].value                      # EPSG in the GeoKeys


def test_geotiff_band_descriptions_name_the_height_range(client):
    """QGIS shows these in the band picker; without them bands read as "Band 1"."""
    import tifffile
    raw = _files(client, "tif")["lad_lad.tif"]
    with tifffile.TiffFile(io.BytesIO(raw)) as tf:
        desc = tf.pages[0].tags[42112].value
    assert "z=0.00-0.50m" in desc
    assert "z=0.50-1.00m" in desc


def test_geotiff_occluded_is_nodata_and_empty_air_is_zero(client):
    """THE distinction: NoData for occluded, a real 0.0 for genuinely empty."""
    import tifffile
    raw = _files(client, "tif")["lad_lad.tif"]
    with tifffile.TiffFile(io.BytesIO(raw)) as tf:
        data = tf.pages[0].asarray()

    oi, oj, ok = OCCLUDED_IJK
    assert data[ok, (2 - 1) - oj, oi] == pytest.approx(-9999.0)

    # An empty-but-solved voxel is genuinely zero density, NOT missing data.
    assert data[1, (2 - 1) - 1, 1] == pytest.approx(0.0)


def test_geotiff_handles_a_single_level_grid(client):
    """A 1-level grid is a ONE-band raster, and must not take the multi-band path.

    tifffile refuses planarconfig='separate' when there is only one sample per
    pixel, so keying that choice off array RANK rather than band COUNT made every
    nz=1 export fail — which is precisely the single-voxel canopy-wide LAI grid
    the LAD docs recommend, and the shape the E2E leaf-cube fixture uses.
    """
    import tifffile
    single = [c for c in _cells() if c["center"][2] < ORIGIN[2] + CELL[2]]
    raw = _files(client, "tif", cells=single, nz=1)["lad_lad.tif"]
    with tifffile.TiffFile(io.BytesIO(raw)) as tf:
        page = tf.pages[0]
        assert page.samplesperpixel == 1
        data = page.asarray()
    assert data.shape == (2, 2)                  # (ny, nx), not (1, ny, nx)
    i, j, _ = LEAFY_IJK
    assert data[(2 - 1) - j, i] == pytest.approx(KNOWN_LAD)


def test_geotiff_one_file_per_selected_variable(client):
    files = _files(client, "tif", variables=["lad", "gtheta", "hit_count"])
    assert set(files) == {"lad_lad.tif", "lad_gtheta.tif", "lad_hit_count.tif"}


# -------------------------------------------------------------------- CSV ----

def _csv_rows(blob):
    lines = blob.decode("utf-8").strip().split("\n")
    header = lines[0].split(",")
    return header, [dict(zip(header, ln.split(","))) for ln in lines[1:]]


def test_csv_header_is_the_frozen_contract(client):
    """Column order is what downstream parsers bind to — append, never reorder."""
    header, _ = _csv_rows(_files(client, "csv")["lad_voxels.csv"])
    assert header == main._LAD_CSV_HEADER
    assert header[:6] == ["i", "j", "k", "x", "y", "z"]


def test_csv_round_trips_the_known_value_at_the_right_index(client):
    _, rows = _csv_rows(_files(client, "csv")["lad_voxels.csv"])
    assert len(rows) == 8                       # every voxel, occluded included
    i, j, k = LEAFY_IJK
    leafy = [r for r in rows if (int(r["i"]), int(r["j"]), int(r["k"])) == (i, j, k)]
    assert len(leafy) == 1
    assert float(leafy[0]["lad"]) == pytest.approx(KNOWN_LAD)
    assert float(leafy[0]["x"]) == pytest.approx(ORIGIN[0] + CELL[0] * 0.5)
    assert float(leafy[0]["y"]) == pytest.approx(ORIGIN[1] + CELL[1] * 0.5)


def test_csv_leaves_occluded_lad_empty_never_zero(client):
    """An occluded voxel writes a BLANK lad with solved=false.

    Writing 0 here is the bias the whole `solved` flag exists to prevent: a
    reader averaging the column would silently pull mean LAD down.
    """
    _, rows = _csv_rows(_files(client, "csv")["lad_voxels.csv"])
    occ = [r for r in rows
           if (int(r["i"]), int(r["j"]), int(r["k"])) == OCCLUDED_IJK][0]
    assert occ["solved"] == "false"
    assert occ["lad"] == ""
    assert occ["leaf_area"] == ""

    empty = [r for r in rows
             if (int(r["i"]), int(r["j"]), int(r["k"])) == (1, 1, 1)][0]
    assert empty["solved"] == "true"
    assert float(empty["lad"]) == pytest.approx(0.0)


def test_csv_survives_a_rotated_terrain_following_grid(client):
    """CSV is the lossless format: it stores each center, so it needs no lattice."""
    files = _files(client, "csv", grid_rotation=23.5, terrain_follow=True)
    _, rows = _csv_rows(files["lad_voxels.csv"])
    assert len(rows) == 8


# ------------------------------------------------------------- AMAPVox vox ----

def test_vox_header_and_known_value(client):
    text = _files(client, "vox")["lad.vox"].decode("utf-8")
    lines = text.strip().split("\n")
    assert lines[0] == "VOXEL SPACE"
    header = {ln.split(":")[0].lstrip("#").strip(): ln.split(":", 1)[1].strip()
              for ln in lines[1:] if ln.startswith("#")}
    assert header["split"] == "2 2 2"
    assert float(header["res"]) == pytest.approx(CELL[0])
    assert [float(v) for v in header["min_corner"].split()] == pytest.approx(ORIGIN)

    cols = [ln for ln in lines if ln.startswith("i j k")][0].split()
    data = [ln.split() for ln in lines if ln and not ln.startswith(("#", "V", "i j k"))]
    pad = cols.index("PadBVTotal")
    leafy = [r for r in data if (int(r[0]), int(r[1]), int(r[2])) == LEAFY_IJK]
    assert len(leafy) == 1
    assert float(leafy[0][pad]) == pytest.approx(KNOWN_LAD)


def test_vox_omits_occluded_voxels(client):
    """AMAPVox's convention: an unsampled voxel is absent, not a zero row."""
    text = _files(client, "vox")["lad.vox"].decode("utf-8")
    data = [ln.split() for ln in text.strip().split("\n")
            if ln and not ln.startswith(("#", "V", "i j k"))]
    assert len(data) == 7                       # 8 voxels minus the occluded one
    assert OCCLUDED_IJK not in {(int(r[0]), int(r[1]), int(r[2])) for r in data}


# --------------------------------------------------------- summary text ----

def test_summary_reports_lai_and_occlusion_separately(client):
    """The summary is the only place LAI is reported, and occlusion must sit
    BESIDE it rather than being folded into it.

    An LAI that silently counts occluded voxels as zero density is biased low —
    the failure this whole export path exists to avoid — so a reader has to be
    able to see how much canopy the beams never reached.
    """
    text = _files(client, "txt")["lad_summary.txt"].decode("utf-8")
    assert "number of occluded voxels 1" in text
    assert "number of voxels containing material (detected) 1" in text
    assert "proportion of occlusion 0.1250" in text     # 1 of 8

    # LAI = leaf area over solved voxels / ground area = (2.0 * 0.125) / (1.0 * 1.0)
    lai = float([ln for ln in text.split("\n") if ln.startswith("LAI")][0].split()[1])
    assert lai == pytest.approx(0.25, abs=1e-3)
    # Total leaf area is written to one decimal, so compare at that precision.
    total = float([ln for ln in text.split("\n")
                   if ln.startswith("total leaf area")][0].split()[-1])
    assert total == pytest.approx(KNOWN_LAD * CELL[0] * CELL[1] * CELL[2], abs=0.05)


def test_summary_records_the_grid_geometry(client):
    text = _files(client, "txt")["lad_summary.txt"].decode("utf-8")
    assert "grid size: 2 2 2" in text
    assert "voxel size: 0.500 0.500 0.500" in text
    assert "number of voxels reported 8" in text


# ----------------------------------------------------------------- guards ----

@pytest.mark.parametrize("overrides,expected", [
    ({"grid_rotation": 23.5}, "rotated"),
    ({"terrain_follow": True}, "terrain"),
])
def test_raster_refuses_a_grid_with_no_regular_lattice(client, overrides, expected):
    """Better to refuse than to write a confidently mis-georeferenced file."""
    resp = client.post("/api/lad/export", json=_request("tif", **overrides))
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert expected in detail.lower()
    assert "CSV" in detail                       # names the format that does work


@pytest.mark.parametrize("body,status", [
    ({"format": "bogus"}, 400),
    ({"cells": []}, 400),
    ({"nx": 0}, 400),
    ({"origin": [1.0, 2.0]}, 400),
    ({"format": "tif", "variables": []}, 400),
    ({"format": "tif", "variables": ["not_a_variable"]}, 400),
])
def test_invalid_requests_are_rejected(client, body, status):
    resp = client.post("/api/lad/export", json=_request("csv", **body))
    assert resp.status_code == status


def test_large_grid_without_dest_dir_is_refused(client):
    """base64-in-JSON cannot carry a million-voxel grid; the caller must pick a
    folder so the backend writes the files itself (same wall the scan exporter
    hit). Faked via the cap so the test stays fast."""
    original = main._LAD_MAX_INLINE_CELLS
    main._LAD_MAX_INLINE_CELLS = 4
    try:
        resp = client.post("/api/lad/export", json=_request("csv"))
        assert resp.status_code == 400
        assert "destination folder" in resp.json()["detail"]
    finally:
        main._LAD_MAX_INLINE_CELLS = original


def test_dest_dir_writes_files_server_side(client, tmp_path):
    # Two raster variables => two files written server-side.
    resp = client.post("/api/lad/export",
                       json=_request("tif", variables=["lad", "gtheta"],
                                     dest_dir=str(tmp_path)))
    assert resp.status_code == 200, resp.text
    files = resp.json()["files"]
    assert {f["name"] for f in files} == {"lad_lad.tif", "lad_gtheta.tif"}
    for entry in files:
        assert entry["data_base64"] is None
        written = tmp_path / entry["name"]
        assert written.exists()
        assert written.stat().st_size == entry["bytes"] > 0
    # No .part left behind — the write is atomic via os.replace.
    assert not list(tmp_path.glob("*.part"))


# ------------------------------------------------------------ compute path ----

def test_lad_cells_carry_the_solved_flag():
    """The flag the exporters gate on must actually be emitted by the compute
    path — a writer keyed to a field nobody sets would void every voxel."""
    assert "lad_solved" in main.LADCell.model_fields
    assert "crs_epsg" in main.LADComputeResponse.model_fields
    # Pinned so the emit site can't be dropped while the model keeps the field.
    import inspect
    source = inspect.getsource(main._do_lad_computation)
    assert '"lad_solved": lad_solved' in source


def test_ijk_is_derived_from_geometry_not_the_sparse_index():
    """Terrain-follow drops whole columns, so the response's `index` is sparse and
    k-major and cannot be inverted by formula. Indices must come from position."""
    cells = _cells()
    # Drop a column, exactly as a dropped terrain column would.
    kept = [c for c in cells if c["center"][0] < ORIGIN[0] + CELL[0]]
    request = main.LADExportRequest(**{
        "format": "csv", "cells": kept, "nx": 2, "ny": 2, "nz": 2,
        "origin": ORIGIN, "cell_size": CELL,
    })
    for cell in request.cells:
        i, j, k = main._lad_cell_ijk(cell, ORIGIN, CELL, 2, 2, 2)
        assert i == 0                     # only the i=0 column survived
        assert 0 <= j < 2 and 0 <= k < 2


def test_single_band_dem_geotiff_is_unchanged():
    """The multi-band generalisation must not disturb the DEM path it grew from."""
    import tifffile
    grid = np.array([[1.0, 2.0], [3.0, np.nan]])
    raw = main._dem_geotiff_bytes(grid, 100.0, 200.0, 0.5, -9999.0, 32610)
    with tifffile.TiffFile(io.BytesIO(raw)) as tf:
        page = tf.pages[0]
        assert page.samplesperpixel == 1
        data = page.asarray()
    assert data.shape == (2, 2)
    assert data[0, 0] == pytest.approx(3.0)      # north-up flip
    assert data[0, 1] == pytest.approx(-9999.0)  # NaN -> nodata


# ---------------------------------------------------------------------------
# Under-sampled (occlusion-screened) voxels
# ---------------------------------------------------------------------------
#
# The NoData rule was written for occluded voxels but, in practice, never fired:
# `solved` is almost always True because Helios writes a hard leaf_area = 0 for a
# beam-starved voxel rather than NaN. `under_sampled` is the flag that actually
# fires, so every format must honour it exactly as it honours `solved`.

UNDER_IJK = (0, 1, 0)
VOLUME = CELL[0] * CELL[1] * CELL[2]
GROUND = CELL[0] * 2 * CELL[1] * 2


def _cells_with_under_sampled(filled=False):
    """The standard grid, plus one voxel flagged under-sampled but 'solved'.

    Its lad is a NON-ZERO number deliberately: if a format ignores the flag the
    inflated value leaks into the output and the assertions below catch it.
    """
    cells = _cells()
    idx = UNDER_IJK[2] * 4 + UNDER_IJK[1] * 2 + UNDER_IJK[0]
    lad = 3.0 if filled else 9.99
    cells[idx].update({
        "solved": True,            # Beer's law "converged"...
        "under_sampled": True,     # ...but the voxel was barely probed
        "lad": lad,
        "leaf_area": lad * VOLUME,
        "path_length_total": 1.2,
        "lad_filled": filled,
    })
    return cells


def test_csv_leaves_under_sampled_lad_empty_even_though_solved(client):
    """The flag that actually fires. A solved-but-under-sampled voxel must write a
    BLANK lad, never its inflated value."""
    header, rows = _csv_rows(
        _files(client, "csv", cells=_cells_with_under_sampled())["lad_voxels.csv"])
    assert header == main._LAD_CSV_HEADER      # still the frozen, append-only contract
    row = [r for r in rows
           if (int(r["i"]), int(r["j"]), int(r["k"])) == UNDER_IJK][0]
    assert row["lad"] == "", "an under-sampled voxel must not export its LAD"
    assert row["leaf_area"] == ""
    assert row["under_sampled"] == "true"
    assert row["solved"] == "false"            # not a measurement, whatever the cause
    assert row["path_length_total"] == "1.2"


def test_geotiff_under_sampled_is_nodata(client):
    """Rasters must show NoData, not a confident number, where nothing was measured."""
    import tifffile
    blob = _files(client, "tif", cells=_cells_with_under_sampled())["lad_lad.tif"]
    data = tifffile.imread(io.BytesIO(blob))
    ui, uj, uk = UNDER_IJK
    assert data[uk, (2 - 1) - uj, ui] == pytest.approx(-9999.0)


def test_vox_omits_under_sampled_voxels(client):
    blob = _files(client, "vox", cells=_cells_with_under_sampled())["lad.vox"]
    lines = [ln for ln in blob.decode("utf-8").splitlines() if ln.strip()]
    body = [ln.split() for ln in lines if ln[0].isdigit()]
    ijk = {(int(r[0]), int(r[1]), int(r[2])) for r in body}
    assert UNDER_IJK not in ijk
    assert OCCLUDED_IJK not in ijk


def test_summary_excludes_under_sampled_from_lai_and_counts_it(client):
    """The bias this whole path exists to avoid: an under-sampled voxel counted as
    data would inflate LAI (its lad is 9.99); counted as a zero it would deflate it.
    It must be excluded from LAI and reported on its own line."""
    text = _files(client, "txt",
                  cells=_cells_with_under_sampled())["lad_summary.txt"].decode("utf-8")
    assert "number of under-sampled voxels 1" in text
    # Two unmeasured of eight: the NaN-unsolved voxel and the under-sampled one.
    assert "number of occluded voxels 2" in text
    assert "proportion of occlusion 0.2500" in text
    # LAI reflects ONLY the leafy voxel.
    assert f"LAI {(KNOWN_LAD * VOLUME / GROUND):.3f}" in text


def test_filled_voxel_writes_its_value_with_the_interpolated_flag(client):
    """A filled voxel DOES export its value — withholding it would mean the fill the
    user switched on silently vanished from the file. `lad_filled` is what lets a
    reader include or drop it knowingly; a blank column could not be distinguished
    from an unfilled occluded voxel."""
    header, rows = _csv_rows(
        _files(client, "csv",
               cells=_cells_with_under_sampled(filled=True))["lad_voxels.csv"])
    row = [r for r in rows
           if (int(r["i"]), int(r["j"]), int(r["k"])) == UNDER_IJK][0]
    assert row["lad"] == "3", "a filled voxel must export the estimate it was given"
    assert row["lad_filled"] == "true"
    assert row["under_sampled"] == "true"   # still records WHY it needed filling

    # ...whereas an occluded voxel that was NOT filled still writes a blank.
    _, plain = _csv_rows(
        _files(client, "csv", cells=_cells_with_under_sampled())["lad_voxels.csv"])
    unfilled = [r for r in plain
                if (int(r["i"]), int(r["j"]), int(r["k"])) == UNDER_IJK][0]
    assert unfilled["lad"] == ""


def test_filled_voxel_is_reported_but_never_counted_as_measured(client):
    """A filled voxel holds an interpolation: excluded from LAI, and its area
    reported separately so a reader can add it deliberately."""
    text = _files(client, "txt", cells=_cells_with_under_sampled(filled=True)
                  )["lad_summary.txt"].decode("utf-8")
    # Worded as a SUBSET of the occlusion count, not a separate population to add.
    assert "number of occluded voxels that were filled 1" in text
    assert ("filled leaf area (interpolated, excluded from the total) "
            f"{3.0 * VOLUME:.1f}") in text
    assert f"LAI {(KNOWN_LAD * VOLUME / GROUND):.3f}" in text   # unchanged by the fill


def test_legacy_cells_without_the_new_flags_still_export(client):
    """Backward compatibility: a result computed before these fields existed carries
    neither flag and must keep its old meaning (measured)."""
    header, rows = _csv_rows(_files(client, "csv")["lad_voxels.csv"])
    leafy = [r for r in rows
             if (int(r["i"]), int(r["j"]), int(r["k"])) == LEAFY_IJK][0]
    assert leafy["lad"] != ""
    assert leafy["under_sampled"] == ""      # absent => not flagged
    assert leafy["lad_filled"] == ""


def test_geotiff_can_carry_the_filled_flag_as_its_own_band(client):
    """A GeoTIFF has no flag column, so without a `lad_filled` band an interpolated
    voxel is indistinguishable from a measurement in the raster — and a user summing
    it would get a number the summary file contradicts."""
    import tifffile
    files = _files(client, "tif", cells=_cells_with_under_sampled(filled=True),
                   variables=["lad", "lad_filled"])
    assert "lad_lad_filled.tif" in files, files.keys()
    data = tifffile.imread(io.BytesIO(files["lad_lad_filled.tif"]))
    ui, uj, uk = UNDER_IJK
    assert data[uk, (2 - 1) - uj, ui] == pytest.approx(1.0)      # interpolated
    # A cell that never carried the flag reads NoData, not 0.0 — "we don't know"
    # rather than a positive claim that it was measured.
    li, lj, lk = LEAFY_IJK
    assert data[lk, (2 - 1) - lj, li] == pytest.approx(-9999.0)

    # An explicit False DOES read as 0.0, so a screened result is fully self-describing.
    cells = _cells_with_under_sampled(filled=True)
    for cell in cells:
        cell.setdefault("lad_filled", False)
    files = _files(client, "tif", cells=cells, variables=["lad_filled"])
    data = tifffile.imread(io.BytesIO(files["lad_lad_filled.tif"]))
    assert data[lk, (2 - 1) - lj, li] == pytest.approx(0.0)      # measured
