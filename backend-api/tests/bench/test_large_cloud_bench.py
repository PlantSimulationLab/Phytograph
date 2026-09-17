"""Large-cloud benchmark: wall time and peak memory per stage of the workflow.

A MEASUREMENT harness, not a correctness suite (the correctness of every stage
is pinned elsewhere on small fixtures). It drives the real HTTP API through
the TestClient on a synthetic cloud from `tools/make_big_cloud.py` and records,
per stage, wall time and the peak resident set of this process PLUS its
children (the killable segmentation worker and PotreeConverter hold most of
the working set of the stages that matter). Results go to `perf/` as JSON so
successive phases of the large-cloud plan can be compared against the same
inputs on the same machine.

Gated behind PHYTO_BENCH=1 so the normal suite / CI never runs it. Run with:

    PHYTO_BENCH=1 PHYTO_BENCH_POINTS=10e6,30e6 \\
        backend-api/venv/bin/python -m pytest tests/bench -s --no-cov

`PHYTO_BENCH_POINTS` is a comma-separated list of point counts (default
10e6); `PHYTO_BENCH_MISSES` the miss fraction (default 0.1). The generated
LAS is cached under `tmp/bench/` next to the repo so a second run pays only
the pipeline, not the generator.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
REPO_ROOT = BACKEND_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

_BENCH = os.environ.get("PHYTO_BENCH") == "1"
pytestmark = pytest.mark.skipif(not _BENCH, reason="set PHYTO_BENCH=1 to run the large-cloud benchmark")


def _point_counts() -> list[int]:
    raw = os.environ.get("PHYTO_BENCH_POINTS", "10e6")
    return [int(float(x)) for x in raw.split(",") if x.strip()]


class PeakRss:
    """Sample RSS of this process + children at 5 Hz; keep the peak."""

    def __init__(self):
        import memory_budget
        self._mb = memory_budget
        self.peak = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.is_set():
            self.peak = max(self.peak, self._mb.rss_bytes(include_children=True))
            self._stop.wait(0.2)

    def __enter__(self):
        self.peak = self._mb.rss_bytes(include_children=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(2)
        self.peak = max(self.peak, self._mb.rss_bytes(include_children=True))
        return False


def _decode(res):
    """JSON tail of a possibly-streamed (PHP1) response."""
    from tests.binframe import decode_streamed_json

    assert res.status_code == 200, res.text[:2000]
    body = res.content
    if body[:1].isspace() or body[:4] == b"PHP1":
        return decode_streamed_json(body)
    return res.json()


@pytest.fixture(scope="module")
def bench_root(tmp_path_factory):
    return tmp_path_factory.mktemp("bench")


@pytest.fixture(params=_point_counts(), ids=lambda n: f"{n // 1_000_000}M")
def big_las(request):
    n = request.param
    misses = float(os.environ.get("PHYTO_BENCH_MISSES", "0.1"))
    cache = REPO_ROOT / "tmp" / "bench"
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / f"bench_{n}_{misses:g}.las"
    if not path.exists():
        t = time.perf_counter()
        subprocess.run([sys.executable, str(BACKEND_DIR / "tools" / "make_big_cloud.py"),
                        "--points", str(n), "--misses", str(misses), "--out", str(path), "--quiet"],
                       check=True)
        print(f"\n[bench] generated {path.name} in {time.perf_counter() - t:.0f}s", flush=True)
    return n, path


def test_large_cloud_workflow(client, big_las, bench_root, monkeypatch):
    import main
    import memory_budget

    n, las_path = big_las
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(bench_root / "octrees"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_SPILL_ROOT", str(bench_root / "sessions"))
    monkeypatch.setattr(main, "_COST_WARNING_SECONDS", 1e9)   # measure, never prompt
    stages: dict[str, dict] = {}
    baseline = memory_budget.rss_bytes(include_children=True)

    def stage(name):
        class _S:
            def __enter__(self_):
                self_.t = time.perf_counter()
                self_.peak = PeakRss().__enter__()
                return self_

            def __exit__(self_, *exc):
                self_.peak.__exit__(*exc)
                stages[name] = {
                    "seconds": round(time.perf_counter() - self_.t, 2),
                    "peak_rss_bytes": int(self_.peak.peak),
                    "peak_rss_over_baseline_bytes": int(self_.peak.peak - baseline),
                }
                print(f"[bench {n // 1_000_000}M] {name}: {stages[name]['seconds']}s, "
                      f"peak {memory_budget.fmt_bytes(self_.peak.peak)} "
                      f"(+{memory_budget.fmt_bytes(self_.peak.peak - baseline)})", flush=True)
                return False
        return _S()

    with stage("import"):
        res = client.post("/api/cloud/session/create", json={"source_path": str(las_path)})
        created = _decode(res)
    sid = created["session_id"]
    assert created["point_count"] > 0

    with stage("segment_ground"):
        res = client.post(f"/api/cloud/session/{sid}/segment_ground",
                          json={"cloth_resolution": 0.5, "class_threshold": 0.1,
                                "rigidness": 3, "defer_octree": True})
        assert res.status_code == 200, res.text[:500]

    with stage("estimate_normals"):
        # The whole scalability story of Compute Normals in one number. Expect
        # ~0.45 M pts/s in-process (10 M points in 20.8 s on 12 cores), or ~38 s
        # through this endpoint once the worker start-up, the `input.npy`
        # staging and the five-column scatter are counted. NOT the product of
        # the cache-locality and parallelism figures — see normals.py, which
        # explains why multiplying them overstates the result ~5x.
        # `defer_octree` keeps the octree rebuild out of this measurement — it
        # is measured on its own by `delete_region_and_rebuild` below.
        res = client.post(f"/api/cloud/session/{sid}/compute_normals",
                          json={"k": 30, "orientation": "origin",
                                "defer_octree": True, "acknowledge_cost": True})
        assert res.status_code == 200, res.text[:500]
        nmeta = _decode(res)
        assert nmeta["analyzed_points"] > 0
        # Peak RSS must be bounded by one buffered tile per worker, not by the
        # cloud: a regression that stops tiling shows up here as memory, not
        # only as time.
        assert nmeta.get("tiled") is True, "a bench-scale cloud must tile"

    with stage("dem_dtm"):
        # Ground column already present from the stage above, so this is the
        # pre-bin + TIN on the ground subset, no CSF and no rebuild.
        res = client.post(f"/api/cloud/session/{sid}/dem",
                          json={"surface_type": "dtm", "auto_segment_ground": False,
                                "cell_size": 0.5, "method": "tin"})
        assert res.status_code == 200, res.text[:500]
        from tests.binframe import decode_bin_frame
        dem_meta, _ = decode_bin_frame(res.content)
        assert dem_meta.get("success", True), dem_meta

    with stage("split_by_ground_class"):
        res = client.post(f"/api/cloud/session/{sid}/extract_by_column",
                          json={"slug": main.GROUND_CLASS_SLUG, "include_misses": True,
                                "rebuild_parent": True})
        split = _decode(res)
    assert len(split.get("children", [])) == 2

    with stage("delete_region_and_rebuild"):
        res = client.post(f"/api/cloud/session/{sid}/delete_region",
                          json={"region": {"kind": "box", "min": [0, 0, -10], "max": [10, 10, 10],
                                           "invert": False}})
        assert res.status_code == 200, res.text[:500]
        res = client.post(f"/api/cloud/session/{sid}/rebuild_octree")
        assert res.status_code == 200, res.text[:500]

    with stage("export_laz"):
        dest = bench_root / "export.laz"
        res = client.post("/api/pointcloud/export",
                          json={"source": {"session_id": sid, "source_path": str(las_path)},
                                "format": "laz", "dest_path": str(dest)})
        out = _decode(res)
        assert out.get("success", True), out
    assert dest.exists() and dest.stat().st_size > 0

    # Ground-truth agreement, so a future tiled ground path can be checked
    # against the same number: fraction of hits whose CSF class matches the
    # generator's label.
    sess = main._get_cloud_session(sid)
    with main._cloud_session_lock:
        truth = sess.extras.get("ground_truth")
        got = sess.extras.get(main.GROUND_CLASS_SLUG)
        miss = sess.extras.get(main._MISS_SLUG)
        if truth is not None and got is not None:
            hits = (miss == 0) if miss is not None else np.ones(len(truth), bool)
            agree = float(np.mean((got[hits] == main.GROUND_CLASS_GROUND) == (truth[hits] == 1)))
        else:
            agree = None

    result = {
        "points": n,
        "las": str(las_path),
        "machine": {"physical_bytes": memory_budget.physical_ram_bytes(),
                    "cpu_count": os.cpu_count(),
                    "budget_bytes": memory_budget.budget_bytes()},
        "baseline_rss_bytes": int(baseline),
        "session_bytes": int(memory_budget.estimate_session_bytes(sess)),
        "ground_truth_agreement": agree,
        "stages": stages,
        "sampling_method": main._potree_sampling_method(n),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    perf = REPO_ROOT / "perf"
    perf.mkdir(exist_ok=True)
    out_path = perf / f"bench-large-{n // 1_000_000}M-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out_path.write_text(json.dumps(result, indent=2))
    print(f"[bench] wrote {out_path}", flush=True)
    print(json.dumps(result, indent=2), flush=True)
