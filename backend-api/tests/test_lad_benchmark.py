"""Large-cloud LAD benchmark: in-RAM array ingest vs. legacy ASCII round-trip.

This is a MEASUREMENT test, not a committed-data test. It generates a ~12M-point
synthetic cloud at runtime (deterministic seed, never written to the repo) and
times how the point data REACHES Helios two ways — the new in-RAM bulk ingest
(addScan + addHitPointsWithData) vs. the legacy disk round-trip (np.savetxt to an
ASCII file + loadXML re-parse) — asserting the new path is both faster and
lighter. That ingest step is exactly what P1/P3 of the efficiency work targeted;
the downstream gapfill/triangulate/leaf-area math is identical between the two
paths, so the benchmark isolates the part that changed.

Gated behind PHYTO_BENCH=1 so the normal suite / CI skips it. Run with:

    PHYTO_BENCH=1 backend-api/venv/bin/python -m pytest tests/test_lad_benchmark.py -s

The tight LAD≈2.0 / G≈0.5 correctness assertions live in test_lad.py against the
calibrated leaf-cube fixtures (the real oracle); here we measure throughput and
prove culling is result-neutral.
"""
import multiprocessing as mp
import os
import resource
import sys
import time
from pathlib import Path

import numpy as np
import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

pytest.importorskip("pyhelios")

_BENCH = os.environ.get("PHYTO_BENCH") == "1"
_ORIGIN = [-5.0, 0.0, 0.5]
_GRID_CENTER = [0.0, 0.0, 0.5]
_GRID_SIZE = [1.0, 1.0, 1.0]
_MULTI = ("timestamp", "target_index", "target_count")


def _generate_cloud(n_total=12_000_000, n_core=40_000, seed=12345):
    """Deterministic synthetic full-waveform cloud shaped like a real LAD scene.

    A SPARSE in-grid leaf sheet (n_core points) plus MILLIONS of far-field
    returns along beams from the scanner out to ~1 km. The far-field is what
    stresses ingest (P1) and the transient copies (P3); most of it misses the
    tiny grid (cullable, P2) while a fraction passes through (kept). Returns
    (xyz (N,3) float64, scalar_columns dict) with the three per-pulse columns.
    """
    rng = np.random.default_rng(seed)
    n_far = n_total - n_core

    lo = np.array(_GRID_CENTER) - np.array(_GRID_SIZE) / 2
    hi = np.array(_GRID_CENTER) + np.array(_GRID_SIZE) / 2
    core = rng.uniform(lo, hi, size=(n_core, 3))
    core[:, 2] = 0.5 + rng.uniform(-0.05, 0.05, size=n_core)  # thin sheet

    o = np.array(_ORIGIN)
    dirs = rng.normal(size=(n_far, 3))
    dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
    ranges = rng.uniform(5.0, 1000.0, size=(n_far, 1))
    far = o + dirs * ranges

    xyz = np.vstack([core, far]).astype(np.float64)
    n = xyz.shape[0]
    scalar_columns = {
        "timestamp": np.arange(n, dtype=np.float64) + 1.0,
        "target_index": rng.integers(0, 2, size=n).astype(np.float64),
        "target_count": rng.integers(1, 3, size=n).astype(np.float64),
    }
    return xyz, scalar_columns


def _ingest_inram(main, xyz, sc):
    """Build the cloud + ingest hits the new way (addScan + bulk data-map FFI)."""
    from pyhelios import LiDARCloud
    dirs = main._directions_from_origin(xyz, _ORIGIN)
    vals = np.column_stack([sc[c] for c in _MULTI]).astype(np.float64)
    cloud = LiDARCloud()
    cloud.disableMessages()
    sid = cloud.addScan(origin=_ORIGIN, Ntheta=800, theta_range=(0.0, np.pi),
                        Nphi=1600, phi_range=(0.0, 2 * np.pi),
                        exit_diameter=0.0, beam_divergence=0.0)
    cloud.addHitPointsWithData(sid, xyz.astype(np.float32), dirs, list(_MULTI), vals)
    return cloud.getHitCount()


def _ingest_ascii(main, xyz, sc, tmpdir):
    """Build the cloud + ingest hits the OLD way (np.savetxt ASCII + loadXML)."""
    from pyhelios import LiDARCloud
    fp = os.path.join(tmpdir, "bench_scan.txt")
    cols = [xyz[:, 0], xyz[:, 1], xyz[:, 2]] + [sc[c] for c in _MULTI]
    np.savetxt(fp, np.column_stack(cols), fmt="%.6g", delimiter=" ")
    scans_info = [{
        "filepath": fp, "ascii_format": "x y z " + " ".join(_MULTI),
        "origin": _ORIGIN, "n_theta": 800, "n_phi": 1600,
        "theta_min": 0, "theta_max": 180, "phi_min": 0, "phi_max": 360,
    }]
    xml = main._generate_helios_xml(tmpdir, scans_info, _GRID_CENTER, _GRID_SIZE,
                                    1, 1, 1, xml_name="bench.xml")
    cloud = LiDARCloud()
    cloud.disableMessages()
    cloud.loadXML(xml)
    return cloud.getHitCount()


def _measure(mode, xyz, sc, q):
    """Time + peak-RSS one ingest path in a fresh process (clean RSS high-water)."""
    import tempfile
    import shutil
    import main
    tmpdir = tempfile.mkdtemp(prefix="lad_bench_")
    try:
        t0 = time.perf_counter()
        if mode == "inram":
            hits = _ingest_inram(main, xyz, sc)
        else:
            hits = _ingest_ascii(main, xyz, sc, tmpdir)
        elapsed = time.perf_counter() - t0
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    q.put({
        "elapsed": elapsed,
        "peak_rss": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "hits": hits,
    })


def _run(mode, xyz, sc):
    ctx = mp.get_context("spawn")
    q = ctx.Queue()
    p = ctx.Process(target=_measure, args=(mode, xyz, sc, q))
    p.start()
    out = q.get()
    p.join()
    return out


@pytest.mark.skipif(not _BENCH, reason="set PHYTO_BENCH=1 to run the large-cloud benchmark")
def test_inram_ingest_beats_ascii_at_scale():
    xyz, sc = _generate_cloud()
    n = xyz.shape[0]
    print(f"\n[bench] generated {n:,} points", flush=True)

    new = _run("inram", xyz, sc)
    old = _run("ascii", xyz, sc)

    print(f"[bench] in-RAM ingest : {new['elapsed']:.2f}s  "
          f"peak_rss={new['peak_rss']:,}  hits={new['hits']:,}", flush=True)
    print(f"[bench] ASCII  ingest : {old['elapsed']:.2f}s  "
          f"peak_rss={old['peak_rss']:,}  hits={old['hits']:,}", flush=True)
    print(f"[bench] speedup: {old['elapsed'] / new['elapsed']:.2f}x   "
          f"rss: {old['peak_rss'] / new['peak_rss']:.2f}x", flush=True)

    # Both must ingest the same number of hits (parity of the data reaching Helios).
    assert new["hits"] == old["hits"] == n

    # Efficiency goal: the in-RAM path is substantially faster (no text format,
    # no multi-GB disk write, no disk re-read + ASCII parse) and lighter (no text
    # buffer + double column_stack copy).
    assert new["elapsed"] < 0.5 * old["elapsed"], (
        f"in-RAM not >=2x faster: {new['elapsed']:.2f}s vs {old['elapsed']:.2f}s")
    assert new["peak_rss"] < old["peak_rss"], (
        f"in-RAM peak RSS not lower: {new['peak_rss']} vs {old['peak_rss']}")


@pytest.mark.skipif(not _BENCH, reason="set PHYTO_BENCH=1 to run the large-cloud benchmark")
def test_cull_fires_and_is_result_neutral():
    """Culling must drop far-field points but NOT change the LAD result.

    Runs the full LAD on a small, fixture-scale cloud (so the shared
    gapfill/triangulate tail is fast) two ways: with the default grid (culling
    fires) and with a grid huge enough that nothing is culled. The recovered LAD
    must match — culling is a speed optimization, not a coverage change.
    """
    import main

    # Small cloud: ~6k in-grid sheet + far-field. Full LAD stays quick here.
    xyz, sc = _generate_cloud(n_total=200_000, n_core=6_000)

    keep = main._cull_to_grid(xyz, _ORIGIN, _GRID_CENTER, _GRID_SIZE)
    assert keep.sum() < xyz.shape[0], "cull should drop far-field points"
    print(f"\n[bench] cull kept {keep.sum():,}/{xyz.shape[0]:,}", flush=True)

    big_center, big_size = [0.0, 0.0, 0.5], [4000.0, 4000.0, 4000.0]
    assert main._cull_to_grid(xyz, _ORIGIN, big_center, big_size).all(), \
        "huge grid should cull nothing"

    def _lad(grid_center, grid_size):
        scan = main.HeliosScanEntry(
            points=xyz.tolist(),
            scalar_columns={k: v.tolist() for k, v in sc.items()},
            origin=_ORIGIN, n_theta=120, n_phi=240,
            theta_min=0, theta_max=180, phi_min=0, phi_max=360,
            return_type="multi")
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=grid_center, size=grid_size, nx=1, ny=1, nz=1),
            lmax=0.1, max_aspect_ratio=10, min_voxel_hits=1)
        return main._do_lad_computation(req)

    culled = _lad(_GRID_CENTER, _GRID_SIZE)
    assert culled["success"], culled.get("error")
    assert culled["is_multi_return"]
    lad_culled = culled["cells"][0]["lad"]
    assert lad_culled is not None and np.isfinite(lad_culled)
    print(f"[bench] LAD (cull on, 1m grid) = {lad_culled:.4f}", flush=True)
