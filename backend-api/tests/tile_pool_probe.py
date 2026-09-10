"""Subprocess harness for the pool tests: runs one tiled computation with the
requested worker count and writes the result to an .npy.

Run in a FRESH interpreter with PHYTOGRAPH_SEG_WORKER set, so `main` skips
its libhelios load and multiprocessing's fork-then-exec launcher is safe -
the same conditions the real seg worker gives the pool. Never import this
from pytest.

    python tile_pool_probe.py <tool> <points.npy> <workers> <out.npy> [<meta.json>]

tool: ground | ror | voxel_count | mean_z
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)
sys.path.insert(0, HERE)


def mean_z_job(chunk, core):
    return np.full(len(chunk), int(round(chunk[:, 2].mean() * 1000)), dtype=np.int32)


def main(argv):
    tool, points_path, workers, out_path = argv[:4]
    meta_path = argv[4] if len(argv) > 4 else None
    os.environ["PHYTOGRAPH_TILE_WORKERS"] = str(int(workers))
    os.environ["PHYTOGRAPH_TILE_POINTS_NPY"] = points_path
    pts = np.load(points_path)
    meta: dict = {}
    if tool == "ground":
        import main as backend
        os.environ.setdefault("PHYTOGRAPH_GROUND_TILE_MIN_POINTS", "0")
        os.environ.setdefault("PHYTOGRAPH_GROUND_TILE_TARGET_POINTS", "10000")
        out = backend.segment_ground(pts, cloth_resolution=0.1, class_threshold=0.1, meta=meta)
    elif tool in ("ror", "voxel_count"):
        import denoise
        os.environ.setdefault("PHYTOGRAPH_DENOISE_TILE_MIN_POINTS", "0")
        os.environ.setdefault("PHYTOGRAPH_DENOISE_TILE_TARGET_POINTS", "5000")
        keep, stats = denoise.denoise_mask(pts, tool, {})
        out = keep
        meta = stats
    elif tool == "mean_z":
        import tiled
        plan = tiled.TilePlan.build(pts[:, :2], tile_m=10.0, buffer_m=1.0)
        if int(workers) > 1:
            with tiled.staged_points(pts) as (path, rows):
                out = tiled.run_tiled_parallel(plan, path, ("tile_pool_probe", "mean_z_job"),
                                               workers=int(workers), file_rows=rows)
        else:
            out = tiled.run_tiled(plan, pts, mean_z_job)
        meta = {"tiled": {"workers": int(workers), "tiles": len(plan.tiles())}}
    else:
        raise SystemExit(f"unknown tool {tool}")
    np.save(out_path, np.asarray(out))
    if meta_path:
        with open(meta_path, "w") as f:
            json.dump(meta.get("tiled", meta), f, default=lambda o: o.item() if hasattr(o, "item") else str(o))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
