"""Tests for sky/miss auto-detection at import (`_autodetect_misses`).

Helios synthetic scans place sky/miss returns at a far-field distance
(LIDAR_RAYTRACE_MISS_T = 1001 m) and tag them with the sentinel
`target_index == 99` (LiDAR.cpp:5607-5615). When such a scan is exported to bare
ASCII (e.g. `x y z timestamp target_index target_count`) the canonical `is_miss`
column is lost, so the octree/overlay/LAD infrastructure — all keyed off
`is_miss` — never sees the misses and their far-field coordinates poison the
bounding box (the ground grid then z-fights near the origin).

`create_cloud_session` recovers the flag at the single file-read point so every
downstream consumer works unchanged. Two real assertions:

  - misses are tagged (`has_misses`, correct count), AND
  - they are EXCLUDED from the hits-only octree, so `tight_bounds` is the real
    ~metre-scale geometry, NOT the ~1001 m far field.

The end-to-end case uses the committed `example-datasets/leafcube_multi.xyz`
fixture (the exact file the bug was reported against). Unit cases cover the
distance fallback and the no-signal control via the helper directly.
"""

from pathlib import Path

import numpy as np
import pytest

import main


# leafcube_multi.xyz: x y z timestamp target_index target_count. 9301 rows,
# 2779 of them misses (target_index == 99) placed at 1001 m from origin
# (-5, 0, 0.5); the real leaf-cube geometry sits ~4.5-5.5 m out.
LEAFCUBE_XYZ = (Path(__file__).resolve().parents[2]
                / "example-datasets" / "leafcube_multi.xyz")
LEAFCUBE_FORMAT = "x y z timestamp target_index target_count"
LEAFCUBE_ORIGIN = [-5.0, 0.0, 0.5]
EXPECTED_MISS_COUNT = 2779
EXPECTED_TOTAL = 9301


def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Unit tests for the helper — no octree / converter needed.
# ---------------------------------------------------------------------------

@pytest.fixture
def leafcube_arrays():
    """Positions + target_index read straight from the fixture."""
    data = np.loadtxt(LEAFCUBE_XYZ)
    assert data.shape[0] == EXPECTED_TOTAL
    return data[:, :3].astype(np.float64), data[:, 4].astype(np.float32)


def test_target_index_sentinel_is_primary_signal(leafcube_arrays):
    positions, tindex = leafcube_arrays
    extras = {"target_index": tindex.copy()}
    meta = []
    count = main._autodetect_misses(positions, extras, meta, origin=LEAFCUBE_ORIGIN)
    assert count == EXPECTED_MISS_COUNT
    # The synthesised flag is exactly target_index == 99.
    assert np.array_equal(extras[main._MISS_SLUG], (tindex == 99).astype(np.float32))
    # And the is_miss dim is registered so the LAS/octree pipeline carries it.
    assert any(ed["slug"] == main._MISS_SLUG for ed in meta)


def test_distance_fallback_when_no_target_index(leafcube_arrays):
    positions, tindex = leafcube_arrays
    extras = {}  # no target_index → fall back to far-field distance
    meta = []
    count = main._autodetect_misses(
        positions, extras, meta, origin=LEAFCUBE_ORIGIN, distance_threshold=1001.0,
    )
    # The distance fallback must agree with the sentinel on EVERY point — the two
    # conventions are consistent (misses at 1001 m carry index 99).
    assert np.array_equal(extras[main._MISS_SLUG] != 0, (tindex == 99))
    assert count == EXPECTED_MISS_COUNT


def test_custom_threshold_changes_distance_classification(leafcube_arrays):
    positions, _ = leafcube_arrays
    # A threshold of 5 m (0.98x = 4.9 m) cuts THROUGH the real geometry, which
    # sits 4.5-5.5 m out, so points beyond 4.9 m get flagged too — many more than
    # the 2779 true far-field misses. Proves the threshold knob has real effect.
    extras = {}
    main._autodetect_misses(positions, extras, [], origin=LEAFCUBE_ORIGIN,
                            distance_threshold=5.0)
    flagged_low = int(np.count_nonzero(extras[main._MISS_SLUG]))
    assert flagged_low > EXPECTED_MISS_COUNT  # the threshold knob has real effect


def test_no_signal_tags_nothing(leafcube_arrays):
    positions, _ = leafcube_arrays
    extras = {}  # no is_miss, no target_index, no origin → can't guess
    meta = []
    count = main._autodetect_misses(positions, extras, meta, origin=None)
    assert count == 0
    assert main._MISS_SLUG not in extras


def test_explicit_miss_column_is_never_overridden(leafcube_arrays):
    positions, tindex = leafcube_arrays
    # An explicit (and deliberately WRONG) is_miss must win — we never re-classify
    # a column the source already provided.
    explicit = np.zeros_like(tindex)
    explicit[0] = 1.0  # exactly one flagged miss, unrelated to the sentinel
    extras = {main._MISS_SLUG: explicit.copy(), "target_index": tindex.copy()}
    count = main._autodetect_misses(positions, extras, [], origin=LEAFCUBE_ORIGIN)
    assert count == 0
    assert np.array_equal(extras[main._MISS_SLUG], explicit)


# ---------------------------------------------------------------------------
# End-to-end: real import through the create endpoint (needs PotreeConverter).
# ---------------------------------------------------------------------------

@pytest.fixture
def cache_root(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


@pytest.mark.skipif(not _converter_available(),
                    reason="PotreeConverter binary not found; npm run build:potree-converter")
def test_import_autodetects_misses_and_keeps_bbox_tight(client, cache_root):
    """Importing the real leafcube scan (no is_miss column) tags its 2779 misses
    AND keeps them out of the octree, so the bounding box is metre-scale — the
    fix for the ground-grid flicker."""
    res = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(LEAFCUBE_XYZ), "ascii_format": LEAFCUBE_FORMAT},
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # Misses were recovered (the scan carried no is_miss column).
    assert body["has_misses"] is True
    assert body["miss_count"] == EXPECTED_MISS_COUNT
    assert body["autodetected_misses"] == EXPECTED_MISS_COUNT
    # And reported, not silent.
    assert any("sky/miss" in w for w in body.get("warnings", []))

    # The session holds ALL points (hits + misses); the octree excludes misses.
    sess = main._cloud_sessions[body["session_id"]]
    assert sess.positions.shape[0] == EXPECTED_TOTAL
    assert int(np.count_nonzero(sess.extras[main._MISS_SLUG] != 0)) == EXPECTED_MISS_COUNT

    # The hits-only octree's tight bounds must be the ~5 m geometry, NOT the
    # 1001 m far field. Diagonal of a ~1 m leaf cube + ~5 m standoff is a few
    # metres; assert it's well under 50 m (a 1001 m miss would blow it to ~2000).
    tb = body["tight_bounds"]
    span = max(tb["max"][i] - tb["min"][i] for i in range(3))
    assert span < 50.0, f"bbox span {span} m — misses leaked into the octree"
    # Point count on the octree == hits only.
    assert body["point_count"] == EXPECTED_TOTAL - EXPECTED_MISS_COUNT


@pytest.mark.skipif(not _converter_available(),
                    reason="PotreeConverter binary not found; npm run build:potree-converter")
def test_miss_overlay_projects_beyond_all_hits_as_thin_shell(client, cache_root):
    """The projected misses (origin supplied) must land on a sphere that sits
    CLEARLY beyond the farthest hit — not abutting/interleaving the cloud — and
    the shell must be geometrically thin. Regression for the reported "misses sit
    on the hit points" + "shell has thickness" bugs. The projection now feeds the
    miss octree via `_gather_miss_positions` (no /misses overlay endpoint), so we
    assert the geometry directly on that helper."""
    create = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(LEAFCUBE_XYZ), "ascii_format": LEAFCUBE_FORMAT},
    ).json()
    sid = create["session_id"]

    sess = main._cloud_sessions[sid]
    pos, radius = main._gather_miss_positions(sess, list(LEAFCUBE_ORIGIN))
    assert pos.shape[0] == EXPECTED_MISS_COUNT

    origin = np.array(LEAFCUBE_ORIGIN)
    r = np.linalg.norm(pos - origin, axis=1)

    # Farthest hit distance from the origin (the cloud's outer radius).
    sess = main._cloud_sessions[sid]
    hits = sess.positions[sess.extras[main._MISS_SLUG] == 0]
    far_hit = float(np.max(np.linalg.norm(hits - origin, axis=1)))

    # Every projected miss sits on a sphere at 1.4x the farthest hit distance — a
    # fixed 40% margin that parks the sky/miss halo clearly OUTSIDE the returns so
    # it reads as a distinct surrounding shell (the intended look; see
    # test_gather_projection_radius_matches_formula). Strictly beyond the cloud,
    # and a geometrically thin sphere (one radius, not a slab).
    assert r.min() > far_hit, "misses interleave with the hit cloud"
    assert radius == pytest.approx(far_hit * 1.4, rel=1e-6)
    # All misses share one radius (a sphere, not a slab).
    assert (r.max() - r.min()) < 1e-3
