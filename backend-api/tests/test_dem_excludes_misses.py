"""DEM generation must drop sky/miss points before gridding/CSF.

Regression for the reported hang: generating a DEM on a synthetic-scan cloud that
carries sky/misses (`is_miss != 0`, projected ~1 km out) hung forever. The session
DEM worker (`_do_session_dem`) read `positions[~deleted]` but did NOT exclude
misses, so the ~1 km far field inflated the cloud extent ~1000×. The auto-CSF
ground extraction then built a multi-million-node cloth (an (ext/cloth)² grid
simulated ~500×), which effectively never returns.

The fix mirrors the Helios-triangulation feed: exclude `is_miss != 0` at the
point the session points are assembled. These tests pin BOTH halves:

  - the session DEM grids hits only (the far field never reaches CSF/gridding), AND
  - it FINISHES quickly on a misses-bearing cloud instead of hanging.

Plus the backend `_auto_csf_params` node-count backstop (a defensive floor, not
the fix) keeps a contaminated cloud finite even if misses ever slip through.

Built in-process with misses tagged by the real `_autodetect_misses` helper, then
driven through the live `/api/cloud/session/{id}/dem` endpoint (no mocking).
"""

from pathlib import Path

import numpy as np
import pytest

import main
from tests.binframe import decode_bin_frame


LEAFCUBE_XYZ = (Path(__file__).resolve().parents[2]
                / "example-datasets" / "leafcube_multi.xyz")
LEAFCUBE_ORIGIN = [-5.0, 0.0, 0.5]
EXPECTED_TOTAL = 9301
EXPECTED_MISSES = 2779
EXPECTED_HITS = EXPECTED_TOTAL - EXPECTED_MISSES  # 6522

# leafcube_multi.xyz is a large, local-only dataset (not committed — see
# example-datasets/README.md); skip when absent (e.g. CI).
pytestmark = pytest.mark.skipif(
    not LEAFCUBE_XYZ.is_file(),
    reason="leafcube_multi.xyz fixture not available (local-only example dataset)",
)


@pytest.fixture
def leafcube_session():
    """Register an in-RAM CloudSession for the real fixture with its sky/misses
    tagged exactly as import does, and yield its id. Cleaned up after the test."""
    data = np.loadtxt(LEAFCUBE_XYZ)
    assert data.shape[0] == EXPECTED_TOTAL
    positions = data[:, :3].astype(np.float64)
    extras = {"target_index": data[:, 4].astype(np.float32)}
    meta: list[dict] = []
    n = main._autodetect_misses(positions, extras, meta, origin=LEAFCUBE_ORIGIN)
    assert n == EXPECTED_MISSES, n  # guards the fixture against silent drift

    sess = main.CloudSession(
        session_id="leafcube-dem-misses-test",
        source_path=str(LEAFCUBE_XYZ),
        ascii_format=None,
        column_plan=None,
        positions=positions,
        colors=None,
        intensity=None,
        extras={main._MISS_SLUG: extras[main._MISS_SLUG]},
        extra_dims_meta=meta,
        deleted=np.zeros(len(positions), bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=0.0,
    )
    main._cloud_sessions[sess.session_id] = sess
    try:
        yield sess.session_id
    finally:
        main._cloud_sessions.pop(sess.session_id, None)


def test_session_dem_finishes_and_grids_hits_only(client, leafcube_session):
    """The reported case: a DEM on the misses-bearing scan COMPLETES (rather than
    hanging) and grids the real ~1 m surface, not the ~1 km far field."""
    res = client.post(
        f"/api/cloud/session/{leafcube_session}/dem",
        json={"cell_size": 0.1, "method": "tin", "auto_segment_ground": True},
    )
    assert res.status_code == 200
    body, buffers = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    # A real surface mesh came out over the ~1 m cube, not a kilometre-wide grid.
    verts = buffers["vertices"].reshape(-1, 3)
    span = float(np.max(verts.max(axis=0)[:2] - verts.min(axis=0)[:2]))
    assert span < 3.0, f"DEM spans {span} m — misses leaked into the grid"
    # The grid cell count is bounded (a misses-inflated extent at 0.1 m would have
    # tripped the 4 M-cell cap and failed instead).
    assert body["grid_nx"] * body["grid_ny"] < 4_000_000


@pytest.mark.parametrize("surface_type", ["dsm", "chm"])
def test_session_dsm_chm_finish_and_grid_hits_only(client, leafcube_session, surface_type):
    """DSM and CHM must exclude sky/misses exactly as the DTM does: a surface built
    over the ~1 km far field would inflate the extent and either hang (CSF) or blow
    past the cell cap. Both COMPLETE over the ~1 m cube. (The DTM's density/intensity
    LAYERS grid the same hits-only points, covered by the DTM case above.)"""
    res = client.post(
        f"/api/cloud/session/{leafcube_session}/dem",
        json={"cell_size": 0.1, "method": "tin", "auto_segment_ground": True,
              "surface_type": surface_type},
    )
    assert res.status_code == 200
    body, buffers = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    assert body["surface_type"] == surface_type
    verts = buffers["vertices"].reshape(-1, 3)
    span = float(np.max(verts.max(axis=0)[:2] - verts.min(axis=0)[:2]))
    assert span < 3.0, f"{surface_type} spans {span} m — misses leaked into the grid"
    assert body["grid_nx"] * body["grid_ny"] < 4_000_000


def test_session_dem_hag_aligns_to_full_survivors(client, leafcube_session):
    """With height-above-ground requested, the per-point HAG column is scattered
    back over ALL survivors (misses → 0), so the rebuilt octree's column length
    matches the cloud — the miss exclusion must not desync the HAG buffer."""
    res = client.post(
        f"/api/cloud/session/{leafcube_session}/dem",
        json={"cell_size": 0.1, "method": "tin", "auto_segment_ground": True,
              "add_height_column": True},
    )
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    # The HAG column rode into a rebuilt octree (hits-only point_count).
    assert body.get("cache_id")
    assert body["point_count"] == EXPECTED_HITS

    # The session now carries a full-length HAG column (one value per ORIGINAL
    # point); the excluded misses are 0, the hits carry real heights.
    sess = main._cloud_sessions[leafcube_session]
    hag = sess.extras[main.HEIGHT_ABOVE_GROUND_SLUG]
    assert hag.shape[0] == EXPECTED_TOTAL
    miss = sess.extras[main._MISS_SLUG] != 0
    assert np.allclose(hag[miss], 0.0)       # sky points → 0 height
    assert np.any(hag[~miss] != 0.0)         # real canopy carries height
