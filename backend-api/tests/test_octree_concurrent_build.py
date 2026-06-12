"""Regression for the batch-import backend crash.

Octrees are cached by the hash of their hits-LAS bytes. A bulk import of N scans
whose hits-LAS bytes collide (identical / empty / synthetic scans) fires N
concurrent `create_cloud_session` requests that all resolve to the SAME cache
key — and therefore the same `<key>.staging` directory. Before the per-key build
lock, the requests raced inside `_build_octree_from_las`:

    A: staging absent  -> mkdir
    B: staging present -> rmtree(staging)        # deletes A's in-flight dir
    A: _write_octree_labels(staging, ...)         # FileNotFoundError -> 500
       -> uvicorn resets the socket mid-response -> renderer sees "Failed to
          fetch" ("could not reach the backend ... it crashed processing this
          file"), i.e. the "backend dying mid-session" symptom.

These tests stub out the real PotreeConverter (the heavy native binary isn't
needed to exercise the ordering bug) and hammer `_build_octree_from_las` from
several threads with one shared key.
"""
import threading
import time
from pathlib import Path

import pytest

import main


def _install_fake_converter(monkeypatch, barrier=None):
    """Replace `_run_potree_converter` with a stub that mimics a slow build:
    it writes a `metadata.json` into the staging dir (so the cache looks valid)
    after a small delay, optionally synchronised on a barrier so all in-flight
    builders overlap and actually contend for the staging dir."""
    def fake(input_las: Path, out_dir: Path) -> None:
        out_dir.mkdir(parents=True, exist_ok=True)
        if barrier is not None:
            # Force every builder to be mid-build simultaneously — without the
            # lock this is exactly when one rmtrees another's staging dir.
            barrier.wait(timeout=10)
        time.sleep(0.02)
        (out_dir / "metadata.json").write_text('{"points": 0}')

    monkeypatch.setattr(main, "_run_potree_converter", fake)


def _make_las(tmp_path: Path, name: str) -> Path:
    """A 1-point LAS so `_build_octree_from_las` can hash it. Content is fixed,
    so every call with the same bytes produces the SAME cache key."""
    import numpy as np
    import laspy

    header = laspy.LasHeader(point_format=3, version="1.4")
    header.offsets = np.zeros(3)
    header.scales = np.array([0.001, 0.001, 0.001])
    record = laspy.ScaleAwarePointRecord.zeros(1, header=header)
    record.x, record.y, record.z = [0.0], [0.0], [0.0]
    out = tmp_path / name
    with laspy.open(str(out), mode="w", header=header) as w:
        w.write_points(record)
    return out


@pytest.fixture(autouse=True)
def _isolate_cache(tmp_path, monkeypatch):
    """Point the octree cache at a throwaway dir and reset the per-key lock
    registry so tests don't interfere with each other or the real cache."""
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    # Guarded so the test still RUNS (and fails on the race) against a build that
    # predates the per-key lock, rather than erroring out here in setup.
    getattr(main, "_octree_build_locks", {}).clear()


def test_concurrent_same_key_builds_do_not_race(tmp_path, monkeypatch):
    """N threads build the SAME cache key at once. Pre-fix this raised
    FileNotFoundError in at least one thread; post-fix all succeed, the build
    runs exactly once, and every thread sees the same (key, dir)."""
    N = 6
    # No barrier here: the per-key lock SERIALIZES same-key builds, so they
    # can't all be in flight at once. A plain slow converter is enough to widen
    # the (now-closed) race window; pre-fix, the unserialized rmtrees collided.
    _install_fake_converter(monkeypatch)

    # Identical bytes across all builders => one shared cache key / staging dir.
    las_paths = [_make_las(tmp_path, f"hits_{i}.las") for i in range(N)]
    # Sanity: the fixtures really do collide on content hash.
    import hashlib
    digests = {hashlib.sha1(p.read_bytes()).hexdigest() for p in las_paths}
    assert len(digests) == 1, "fixtures must share a hash to trigger the race"

    results: list = []
    errors: list = []

    def worker(p):
        try:
            results.append(main._build_octree_from_las(p, []))
        except Exception as e:  # noqa: BLE001 — we want to surface ANY failure
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(p,)) for p in las_paths]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert not errors, f"concurrent same-key builds raised: {errors!r}"
    assert len(results) == N
    keys = {r[0] for r in results}
    dirs = {str(r[1]) for r in results}
    assert len(keys) == 1 and len(dirs) == 1  # all agree on the one octree
    # The installed octree exists and the staging dir was consumed (renamed).
    cache_dir = Path(next(iter(dirs)))
    assert (cache_dir / "metadata.json").is_file()
    assert not (cache_dir.parent / (cache_dir.name + ".staging")).exists()


def test_distinct_keys_still_build_in_parallel(tmp_path, monkeypatch):
    """The lock is per-key, so different clouds must NOT serialize. A barrier
    sized to the builder count only releases if every distinct-key build is in
    flight at once — proving they run concurrently, not one-at-a-time."""
    N = 4
    barrier = threading.Barrier(N, timeout=10)
    _install_fake_converter(monkeypatch, barrier=barrier)

    import numpy as np
    import laspy

    def make_unique(i):
        header = laspy.LasHeader(point_format=3, version="1.4")
        header.offsets = np.zeros(3)
        header.scales = np.array([0.001, 0.001, 0.001])
        rec = laspy.ScaleAwarePointRecord.zeros(1, header=header)
        rec.x, rec.y, rec.z = [float(i)], [0.0], [0.0]  # distinct coords => distinct hash
        out = tmp_path / f"u_{i}.las"
        with laspy.open(str(out), mode="w", header=header) as w:
            w.write_points(rec)
        return out

    paths = [make_unique(i) for i in range(N)]
    errors: list = []
    keys: list = []

    def worker(p):
        try:
            keys.append(main._build_octree_from_las(p, [])[0])
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(p,)) for p in paths]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    # If the lock serialized distinct keys, the barrier would never release and
    # the converter stub would time out -> errors. No errors => true parallelism.
    assert not errors, f"distinct-key builds failed to overlap: {errors!r}"
    assert len(set(keys)) == N  # every cloud got its own octree
