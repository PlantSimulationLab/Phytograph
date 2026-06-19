"""Chunked LAS-writer correctness for `_session_to_las` / `_miss_positions_to_las`.

Both writers were changed from materialising ONE laspy record for all N points
to writing in `_LAS_WRITE_CHUNK`-row blocks (caps the transient record to one
block instead of the whole cloud — the synthetic-scan memory blow-up). These
tests force a TINY chunk size so a small fixture spans several blocks plus a
partial final block, and assert the LAS round-trips byte-for-byte identically to
the in-RAM arrays — i.e. the chunk seams don't drop, duplicate, or reorder rows.

No PotreeConverter needed: these exercise the laspy writer directly.
"""

import numpy as np
import pytest

import main


def _make_session(n: int) -> main.CloudSession:
    """A CloudSession with positions + colors + intensity + two extra dims
    (including is_miss), enough to exercise every record field in the writer."""
    rng = np.random.RandomState(0)
    positions = rng.uniform(-5.0, 5.0, size=(n, 3)).astype(np.float64)
    colors = rng.randint(0, 65536, size=(n, 3)).astype(np.uint16)
    intensity = rng.randint(0, 65536, size=n).astype(np.uint16)
    # Alternating miss flag so exclude_misses has something to drop on a seam.
    miss = (np.arange(n) % 3 == 0).astype(np.float32)
    distance = rng.uniform(1.0, 50.0, size=n).astype(np.float32)
    extras = {main._MISS_SLUG: miss, "distance": distance}
    extra_dims_meta = [
        {"slug": main._MISS_SLUG, "label": main._MISS_LABEL},
        {"slug": "distance", "label": "distance"},
    ]
    return main.CloudSession(
        session_id="chunktest",
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=positions,
        colors=colors,
        intensity=intensity,
        extras=extras,
        extra_dims_meta=extra_dims_meta,
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=0.0,
    )


def _read_las(path):
    import laspy
    with laspy.open(str(path)) as reader:
        las = reader.read()
    xyz = np.stack([np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)], axis=1)
    return las, xyz


@pytest.mark.parametrize("n,chunk", [(2500, 1000), (1000, 1000), (1, 1000), (3000, 1)])
def test_session_to_las_chunks_round_trip(tmp_path, monkeypatch, n, chunk):
    # Force a small chunk so n spans multiple blocks (+ a partial tail), the
    # n==chunk exact-fit boundary, the single-point case, and the degenerate
    # 1-row-per-chunk case.
    monkeypatch.setattr(main, "_LAS_WRITE_CHUNK", chunk)
    sess = _make_session(n)
    out = tmp_path / "s.las"
    written = main._session_to_las(sess, out)
    assert written == n

    las, xyz = _read_las(out)
    assert xyz.shape[0] == n
    # 1 mm scale → positions round-trip to within half a scale unit.
    assert np.allclose(xyz, sess.positions, atol=6e-4)
    assert np.array_equal(np.asarray(las.intensity, dtype=np.uint16), sess.intensity)
    rgb = np.stack([np.asarray(las.red), np.asarray(las.green), np.asarray(las.blue)], axis=1)
    assert np.array_equal(rgb.astype(np.uint16), sess.colors)
    assert np.allclose(np.asarray(las[main._MISS_SLUG]), sess.extras[main._MISS_SLUG])
    assert np.allclose(np.asarray(las["distance"]), sess.extras["distance"], atol=1e-3)


def test_session_to_las_exclude_misses_across_chunk_seam(tmp_path, monkeypatch):
    # exclude_misses drops is_miss!=0 rows; with a small chunk the survivors are
    # gathered by index (np.flatnonzero(keep)) and sliced per block — verify the
    # survivor count and that NO miss leaked through any seam.
    monkeypatch.setattr(main, "_LAS_WRITE_CHUNK", 250)
    n = 2000
    sess = _make_session(n)
    expected_keep = int((sess.extras[main._MISS_SLUG] == 0).sum())
    out = tmp_path / "hits.las"
    written = main._session_to_las(sess, out, exclude_misses=True)
    assert written == expected_keep

    las, _ = _read_las(out)
    # Every written point must be a hit (is_miss == 0) — a leaked miss would be 1.
    assert np.all(np.asarray(las[main._MISS_SLUG]) == 0)


@pytest.mark.parametrize("n,chunk", [(2500, 1000), (1, 1000), (0, 1000)])
def test_miss_positions_to_las_chunks_round_trip(tmp_path, monkeypatch, n, chunk):
    monkeypatch.setattr(main, "_LAS_WRITE_CHUNK", chunk)
    rng = np.random.RandomState(1)
    positions = rng.uniform(-10.0, 10.0, size=(n, 3)).astype(np.float64)
    out = tmp_path / "misses.las"
    written = main._miss_positions_to_las(positions, out)
    assert written == n
    _, xyz = _read_las(out)
    assert xyz.shape[0] == n
    if n:
        assert np.allclose(xyz, positions, atol=6e-4)
