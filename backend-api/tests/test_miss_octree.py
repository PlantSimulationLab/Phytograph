"""Miss octree: the projected sky/miss points are built into their OWN potree
octree (cached by sha1, served via app://octree/), replacing the flat,
stride-subsampled overlay. These tests assert the build is correct end-to-end:
the full miss set reaches the octree (no cap), the projection geometry matches
the documented radius, the no-origin path keeps true coordinates, an empty miss
set builds nothing, a crop excludes misses (and flags backfilled ones stale),
and bake reprojects the survivors.

The leafcube fixture is a real Helios scan with 2779 sky/miss points and no
explicit is_miss column (they're auto-detected), so it exercises the same path a
user hits on import.
"""
import json
from pathlib import Path

import numpy as np
import pytest

import main


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


pytestmark = pytest.mark.skipif(
    not _converter_available() or not LEAFCUBE_XYZ.is_file(),
    reason="PotreeConverter binary or leafcube fixture not available",
)


@pytest.fixture
def cache_root(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


def _octree_points(cache_root: Path, cache_id: str) -> int:
    """Point count baked into an octree's metadata.json."""
    meta = json.loads((cache_root / cache_id / "metadata.json").read_text())
    return int(meta["points"])


def _create(client) -> dict:
    res = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(LEAFCUBE_XYZ), "ascii_format": LEAFCUBE_FORMAT},
    )
    assert res.status_code == 200, res.text
    return res.json()


def test_create_builds_miss_octree_with_full_count(client, cache_root):
    """Create builds a SECOND octree from the (projected) misses. Its cache id is
    a 40-char sha1, the three potree files exist, and it holds the FULL placeable
    miss count — proving the old 200k overlay cap is gone (no subsampling)."""
    body = _create(client)
    mid = body["miss_octree_cache_id"]
    assert mid and len(mid) == 40 and all(c in "0123456789abcdef" for c in mid)

    octree_dir = cache_root / mid
    for fn in ("metadata.json", "hierarchy.bin", "octree.bin"):
        assert (octree_dir / fn).is_file(), f"missing {fn}"

    # The full miss population reaches the octree — not a capped subsample.
    assert _octree_points(cache_root, mid) == EXPECTED_MISS_COUNT
    # Sanity: the hits octree is a DIFFERENT cache id (hits-only).
    assert body["cache_id"] != mid


def test_miss_octree_disjoint_from_hits_octree(client, cache_root):
    """The miss octree's bbox must NOT poison the hits octree — they're separate
    cache dirs, and the hits octree holds only the 6522 hits."""
    body = _create(client)
    assert _octree_points(cache_root, body["cache_id"]) == EXPECTED_TOTAL - EXPECTED_MISS_COUNT


def test_gather_projection_radius_matches_formula(client, cache_root):
    """The projected misses sit on a sphere at radius = 1.4 * far, where far is the
    max HIT distance from the scanner origin. The 1.4x (40%) margin is INTENTIONAL
    and load-bearing: it parks the sky/miss halo clearly outside the returns so it
    reads as a distinct surrounding shell. Do NOT replace it with a small
    `far + 0.05*...` margin — that change keeps getting reintroduced and merges the
    shell into the cloud. This test is the guard against that regression."""
    body = _create(client)
    sess = main._cloud_sessions[body["session_id"]]
    pos, radius = main._gather_miss_positions(sess, LEAFCUBE_ORIGIN)
    assert pos.shape[0] == EXPECTED_MISS_COUNT

    origin = np.asarray(LEAFCUBE_ORIGIN)
    hits = sess.positions[sess.extras[main._MISS_SLUG] == 0]
    hd = np.linalg.norm(hits - origin, axis=1)
    far = float(hd.max())
    assert radius == pytest.approx(far * 1.4, rel=1e-6)

    d = np.linalg.norm(pos - origin, axis=1)
    assert np.allclose(d, radius, rtol=1e-6)   # all misses on the shell
    assert d.min() > far                        # strictly outside the cloud


def test_no_origin_keeps_true_coords(client, cache_root):
    """No origin → the miss octree is built at TRUE coordinates (no projection).
    The gathered positions match the stored far-field misses, radius 0."""
    body = _create(client)
    sess = main._cloud_sessions[body["session_id"]]
    pos, radius = main._gather_miss_positions(sess, None)
    assert radius == 0.0
    assert pos.shape[0] == EXPECTED_MISS_COUNT
    stored = sess.positions[sess.extras[main._MISS_SLUG] != 0]
    assert np.allclose(np.sort(pos, axis=0), np.sort(stored, axis=0))


def test_create_origin_reprojects_misses(client, cache_root):
    """Regression: an imported Helios scan XML bundle carries the scanner
    `<origin>`, which the renderer now forwards as `origin` on the create request.
    The backend must thread it onto `sess.miss_octree_origin` so the misses are
    PROJECTED onto the thin shell — not left at far-field (the bug where re-imported
    scans showed misses ~1 km out instead of hugging the hits).

    Without the origin (the prior behavior) `miss_octree_origin` is None and the
    misses keep their true far-field coords; with it, the stored origin matches and
    the gathered positions sit on the projection shell."""
    res = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(LEAFCUBE_XYZ), "ascii_format": LEAFCUBE_FORMAT,
              "origin": LEAFCUBE_ORIGIN},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    sess = main._cloud_sessions[body["session_id"]]
    # The request origin landed on the session (no world_shift here, so verbatim).
    assert sess.miss_octree_origin == LEAFCUBE_ORIGIN
    # And the misses were projected: gathered positions sit on a thin shell at a
    # radius hugging the hits, NOT at their stored far-field coordinates.
    pos, radius = main._gather_miss_positions(sess, sess.miss_octree_origin)
    assert radius > 0.0
    stored = sess.positions[sess.extras[main._MISS_SLUG] != 0]
    far_field = np.linalg.norm(stored - np.asarray(LEAFCUBE_ORIGIN), axis=1)
    shell = np.linalg.norm(pos - np.asarray(LEAFCUBE_ORIGIN), axis=1)
    assert shell.max() < far_field.min()  # pulled IN from far-field
    assert np.allclose(shell, radius, rtol=1e-6)


def test_empty_miss_set_builds_no_octree(client, cache_root, tmp_path):
    """A session with NO misses builds no miss octree (cache id None) and runs no
    PotreeConverter for it — only the hits octree dir exists in the cache."""
    # Hits-only XYZ: a few points, no is_miss column, no far-field returns.
    src = tmp_path / "hits_only.xyz"
    src.write_text("0 0 0\n1 0 0\n0 1 0\n1 1 1\n")
    res = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(src), "ascii_format": "x y z"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["has_misses"] is False
    assert body["miss_octree_cache_id"] is None
    # Exactly one octree dir (the hits octree) in the cache.
    dirs = [d for d in cache_root.iterdir()
            if d.is_dir() and len(d.name) == 40 and not d.name.endswith(".staging")]
    assert len(dirs) == 1
    assert dirs[0].name == body["cache_id"]


def test_crop_excludes_misses_and_flags_backfilled_stale(client, cache_root):
    """delete_region must (a) never delete is_miss points even when the crop box
    spatially contains them, and (b) flag a separate backfilled-miss buffer stale
    when a crop removes hits (warn-but-keep)."""
    body = _create(client)
    sid = body["session_id"]
    sess = main._cloud_sessions[sid]
    miss_before = int((sess.extras[main._MISS_SLUG] != 0).sum())

    # Attach a backfilled buffer so we can observe the stale flag.
    sess.backfilled_misses = {
        "positions": np.array([[100.0, 0.0, 0.0], [101.0, 0.0, 0.0]]),
        "directions": np.zeros((2, 3), dtype=np.float32),
    }
    sess.backfilled_misses_stale = False

    # A huge box around everything (including the far-field misses) — proves
    # misses are excluded from the spatial select, not merely missed by geometry.
    region = {"kind": "box", "min": [-1e9, -1e9, -1e9], "max": [1e9, 1e9, 1e9],
              "invert": False}
    res = client.post(f"/api/cloud/session/{sid}/delete_region",
                      json={"region": region})
    assert res.status_code == 200, res.text
    out = res.json()

    # Misses untouched (only hits were selected); backfilled buffer flagged stale.
    assert int((sess.extras[main._MISS_SLUG] != 0).sum()) == miss_before
    assert sess.backfilled_misses is not None       # kept, not discarded
    assert sess.backfilled_misses_stale is True
    assert out["backfilled_misses_stale"] is True

    # And the staleness reaches the LAD reader's flags so LAD can warn.
    _xyz, _dirs, _labels, _vals, flags = main._session_to_lad_arrays(sess, LEAFCUBE_ORIGIN)
    assert flags.get("misses_stale") is True


def test_bake_rebuilds_miss_octree_for_survivors(client, cache_root):
    """Baking after a hit-side crop rebuilds the miss octree from the SURVIVING
    misses. The misses themselves are never croppable, so the full set survives
    the bake and the rebuilt octree still streams every one of them. (The cache id
    is content-addressed: an identical projected set yields the same sha1, which is
    correct — the invariant is that bake produces a VALID, complete miss octree.)"""
    body = _create(client)
    sid = body["session_id"]

    # Crop away a slab of hits. Misses are excluded from the crop by the new rule.
    region = {"kind": "box", "min": [-2.0, -2.0, -2.0], "max": [0.0, 2.0, 2.0],
              "invert": False}
    client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": region})

    bake = client.post(f"/api/cloud/session/{sid}/bake").json()
    assert bake["baked"] is True
    mid_after = bake["miss_octree_cache_id"]
    assert mid_after and len(mid_after) == 40
    assert (cache_root / mid_after / "metadata.json").is_file()
    # Misses were never croppable, so the full set survives the bake.
    assert _octree_points(cache_root, mid_after) == EXPECTED_MISS_COUNT
    # And the session points actually dropped (the crop did remove hits).
    sess = main._cloud_sessions[sid]
    assert len(sess.positions) < EXPECTED_TOTAL
