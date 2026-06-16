"""Triangulation must drop sky/miss points before meshing.

Regression for the reported hang: loading `example-datasets/leafcube_multi.xyz`
(a full-waveform multi-return scan, 9301 points of which 2779 are sky/misses
placed ~1001 m out) and running Ball Pivoting hung forever on a cloud of only
~6500 real surface points.

Cause: a miss is a ray that hit nothing, projected to the scanner's far range.
It is not a surface point. The hits-only octree already excludes `is_miss != 0`
(see `_session_to_las(exclude_misses=True)`), but `_read_points_from_source` —
the single chokepoint every compute op reads through — only applied the
`deleted` mask, so triangulate/skeleton/LAD/export still saw the misses. Ball
pivoting then tried to span a dense mm-scale cube AND a phantom shell a kilometre
away; the auto-radius (mean NN distance, ~1.2 m, dragged up by the far points)
made BPA explode combinatorially.

The fix excludes misses at that chokepoint. These tests pin BOTH halves:

  - the chokepoint hands triangulation hits only (6522, not 9301), AND
  - every method finishes and meshes the real ~1 m geometry, not the far field.

No PotreeConverter needed: the session is built in-process with misses tagged by
the real `_autodetect_misses` helper, then driven through the live
`/api/triangulate` endpoint (no mocking).
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
        session_id="leafcube-misses-test",
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


def test_read_chokepoint_drops_misses(leafcube_session):
    """`_read_points_from_source` on a session source returns hits only — the
    misses never reach any compute op."""
    src = main.PointSource(source_path=str(LEAFCUBE_XYZ), session_id=leafcube_session)
    pts, _, _ = main._read_points_from_source(src)
    assert len(pts) == EXPECTED_HITS
    # The surviving points are the ~1 m leaf cube, NOT the ~1001 m far field.
    span = float(np.max(pts.max(axis=0) - pts.min(axis=0)))
    assert span < 2.0, f"span {span} m — misses leaked into the compute path"


def test_include_misses_opt_in_preserves_them(leafcube_session):
    """`include_misses=True` (the export path) keeps the misses — the exclusion
    is the default, not unconditional, so a round-tripping export is lossless."""
    src = main.PointSource(
        source_path=str(LEAFCUBE_XYZ), session_id=leafcube_session, include_misses=True
    )
    pts, _, _ = main._read_points_from_source(src)
    assert len(pts) == EXPECTED_TOTAL  # all 9301, misses included


def test_ball_pivot_session_finishes_on_misses_cloud(client, leafcube_session):
    """The reported case: Ball Pivoting on the multi-return scan completes and
    meshes the real surface (hits only), instead of hanging on the far field."""
    res = client.post(
        "/api/triangulate",
        json={
            "method": "ball_pivoting",
            "source": {"source_path": str(LEAFCUBE_XYZ), "session_id": leafcube_session},
        },
    )
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    # Hits only were triangulated — the 2779 misses were excluded upstream.
    assert body["points_used"] == EXPECTED_HITS
    # A real surface came out, not an empty/degenerate mesh.
    assert body["num_triangles"] > 1000, body["num_triangles"]


@pytest.mark.parametrize("method", ["ball_pivoting", "alpha_shape", "poisson"])
def test_all_methods_use_hits_only(client, leafcube_session, method):
    """Every triangulation method reads through the same chokepoint, so all of
    them mesh hits only — none re-introduces the far-field misses."""
    res = client.post(
        "/api/triangulate",
        json={
            "method": method,
            "source": {"source_path": str(LEAFCUBE_XYZ), "session_id": leafcube_session},
        },
    )
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    assert body["points_used"] == EXPECTED_HITS
