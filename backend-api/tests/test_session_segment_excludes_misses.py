"""Session segmentation must drop sky/miss points before the compute.

Regression for the same hang class as the DEM (see test_dem_excludes_misses.py):
the session segmentation endpoints read `positions[~deleted]` but did NOT exclude
misses (`is_miss != 0`, projected ~1 km out), so on a synthetic-scan cloud the
~1 km far field inflated the extent ~1000× and the per-point geometry / CSF cloth
/ cut-pursuit hung (the killable subprocess merely makes such a hang cancellable —
it must not happen in the first place).

The fix mirrors `_do_session_dem`: `_session_survivor_hit_mask` drops the
interleaved is_miss survivors, the compute runs on hits only, and the labels are
scattered back over ALL survivors (misses → 0, dropped from the octree at rebuild).

These pin BOTH halves on the LIVE endpoints (no mocking): the op FINISHES quickly
on a misses-bearing cloud, and the written column is full-length with misses
defaulted — so the miss exclusion never desyncs the label buffer.
"""

from pathlib import Path

import numpy as np
import pytest

import main


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
        session_id="leafcube-seg-misses-test",
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


def _assert_column_aligned(sess, slug):
    """The written column is full-length (one value per ORIGINAL point) and the
    sky/miss rows are the default 0 — proving the hit-only compute scattered back
    over all survivors without desyncing."""
    col = sess.extras[slug]
    assert col.shape[0] == EXPECTED_TOTAL
    miss = sess.extras[main._MISS_SLUG] != 0
    assert np.allclose(col[miss], 0.0), "miss rows must carry the default 0 label"
    assert np.any(col[~miss] != 0.0), "hit rows must carry real labels"


def test_session_segment_ground_finishes_and_excludes_misses(client, leafcube_session):
    """CSF ground segmentation COMPLETES on the misses-bearing scan (rather than
    hanging on the ~1 km far field) and writes a full-length, miss-defaulted
    ground_class column over a hits-only rebuilt octree."""
    res = client.post(
        f"/api/cloud/session/{leafcube_session}/segment_ground",
        json={"cloth_resolution": 0.1, "rigidness": 3, "class_threshold": 0.1,
              "iterations": 200},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # Compute ran on hits only; the rebuilt octree is hits-only.
    assert body["point_count"] == EXPECTED_HITS
    assert body.get("cache_id")
    _assert_column_aligned(main._cloud_sessions[leafcube_session], main.GROUND_CLASS_SLUG)


# --- The hit-mask + scatter the wood / tree session endpoints rely on ----------
# The wood (open3d) / TreeIso (cut-pursuit) workers can't be driven through
# Starlette's TestClient here: its anyio portal thread + the native libs the
# spawned worker re-imports segfault the CHILD in that harness specifically (real
# uvicorn and the Playwright E2E run them fine — see tests/e2e/). The ground
# endpoint above already pins the full subprocess path end-to-end; for wood/tree
# we pin the SHARED fix they add — `_session_survivor_hit_mask` + scatter-back —
# directly at the same fixture, without the crashing subprocess.


def test_survivor_hit_mask_drops_only_the_misses(leafcube_session):
    sess = main._cloud_sessions[leafcube_session]
    hit = main._session_survivor_hit_mask(sess)
    # No deletions in the fixture, so survivors == all points.
    assert hit.shape == (EXPECTED_TOTAL,)
    assert int(hit.sum()) == EXPECTED_HITS
    # The mask is exactly the non-miss rows.
    assert np.array_equal(hit, sess.extras[main._MISS_SLUG] == 0)


def test_survivor_hit_mask_no_miss_column_keeps_all(leafcube_session):
    """A session with no is_miss column (e.g. a plain ASCII import) is all-hits —
    the mask must not drop anything."""
    sess = main._cloud_sessions[leafcube_session]
    bare = main.CloudSession(
        session_id="bare", source_path="x", ascii_format=None, column_plan=None,
        positions=sess.positions.copy(), colors=None, intensity=None,
        extras={}, extra_dims_meta=[], deleted=np.zeros(EXPECTED_TOTAL, bool),
        deleted_history=[], octree_cache_id=None, created_at=0.0,
    )
    hit = main._session_survivor_hit_mask(bare)
    assert hit.shape == (EXPECTED_TOTAL,) and bool(hit.all())


def test_wood_hit_scatter_is_full_length_and_miss_defaulted(leafcube_session):
    """Reproduces the wood/tree endpoints' scatter: run the real compute on the
    hit-only points, scatter the labels over ALL survivors (misses → 0), and
    write the column — the same alignment the ground endpoint test pins, for the
    wood path, in-process (so no TestClient subprocess crash)."""
    sess = main._cloud_sessions[leafcube_session]
    hit = main._session_survivor_hit_mask(sess)
    pts = sess.positions[~sess.deleted][hit]
    # Hit-only ~1 m cube (extent bounded — the proof misses were excluded; with
    # them in, this would hang on the ~1 km far field).
    assert float(np.max(pts.max(0) - pts.min(0))) < 3.0
    hit_labels = main.segment_wood(pts, method="geometric", wood_bias=0.6,
                                   k_max=40, reg_iters=1)
    labels = np.zeros(len(hit), dtype=np.int64)
    labels[hit] = np.asarray(hit_labels)
    with main._cloud_session_lock:
        main._session_add_extra_column(sess, main.WOOD_CLASS_SLUG,
                                       main.WOOD_CLASS_LABEL, labels)
    _assert_column_aligned(sess, main.WOOD_CLASS_SLUG)
