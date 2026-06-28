#!/usr/bin/env python3
"""Killable segmentation worker — runs ONE segmentation compute in a child
process and exits, so the parent can SIGKILL it the instant the user clicks
Cancel (a monolithic numpy/scipy/open3d/C-extension call can't be interrupted
in-thread; a separate process can be reclaimed by the OS, even mid-hang).

Invoked by `_run_killable` in main.py via the same backend binary/interpreter
with `PHYTOGRAPH_SEG_WORKER=<workdir>` set; `backend_wrapper.py` dispatches here
before importing uvicorn so the frozen PyInstaller binary can re-enter as a
worker. NOT imported by the FastAPI server — it only runs in the child.

Protocol (all files live in `workdir`):
  IN   request.json     {"tool": "ground|wood|trees|skeleton", "params": {...}}
       input.npy        (N, 3) float64 points
       reflectance.npy  optional (N,) float64           (wood only)
       seeds.npy        optional (S, 3) float64          (trees only)
  OUT  output.npy       (N,) int labels                  (ground/wood/trees)
       result.json      skeleton's structured result dict (skeleton only)
       error.txt        traceback on failure (exit code 1)

The worker imports the EXISTING compute functions from main (segment_ground,
segment_wood, segment_trees, compute_skeleton) so there is exactly one
implementation per tool. Importing main is cheap here: it only defines the
FastAPI app + functions (no server bind), and its pyhelios import-time guard is
a no-op once the parent backend has already built libhelios.
"""

import os
import sys
import json
import traceback


def _json_default(o):
    """Coerce numpy scalars/arrays in a result dict to plain Python so json.dump
    accepts them (compute_skeleton returns numpy ints/floats/arrays)."""
    import numpy as np
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")


def run(workdir: str) -> int:
    """Run the one segmentation request staged in `workdir`. Returns an exit
    code (0 = success, 1 = failure with error.txt written)."""
    import numpy as np

    try:
        with open(os.path.join(workdir, "request.json"), "r") as f:
            request = json.load(f)
        tool = request["tool"]
        params = request.get("params", {})
        points = np.load(os.path.join(workdir, "input.npy"))

        # Import the compute functions lazily, AFTER args are staged, so a
        # malformed request fails fast without paying the import cost.
        import main

        if tool == "ground":
            labels = main.segment_ground(points, **params)
            np.save(os.path.join(workdir, "output.npy"), np.asarray(labels))

        elif tool == "wood":
            refl_path = os.path.join(workdir, "reflectance.npy")
            reflectance = np.load(refl_path) if os.path.exists(refl_path) else None
            # `warnings` is collected in-worker and shipped back via result.json
            # so the endpoint can surface advisories (e.g. ground-not-removed).
            warns: list = []
            labels = main.segment_wood(points, reflectance=reflectance,
                                       warnings=warns, **params)
            np.save(os.path.join(workdir, "output.npy"), np.asarray(labels))
            with open(os.path.join(workdir, "result.json"), "w") as f:
                json.dump({"warnings": warns}, f)

        elif tool == "trees":
            seeds_path = os.path.join(workdir, "seeds.npy")
            seeds = np.load(seeds_path) if os.path.exists(seeds_path) else None
            ti_params = main._treeiso_params_from_dict(params)
            main._auto_treeiso_decimation(points, ti_params)
            labels = main.segment_trees(points, ti_params, seeds)
            np.save(os.path.join(workdir, "output.npy"), np.asarray(labels))

        elif tool == "skeleton":
            result = main.compute_skeleton(points, params)
            with open(os.path.join(workdir, "result.json"), "w") as f:
                json.dump(result, f, default=_json_default)

        else:
            raise ValueError(f"Unknown segmentation tool: {tool!r}")

        return 0

    except Exception:
        with open(os.path.join(workdir, "error.txt"), "w") as f:
            f.write(traceback.format_exc())
        return 1


if __name__ == "__main__":
    _workdir = os.environ.get("PHYTOGRAPH_SEG_WORKER") or (
        sys.argv[1] if len(sys.argv) > 1 else None
    )
    if not _workdir:
        sys.stderr.write("seg_worker: no workdir (set PHYTOGRAPH_SEG_WORKER)\n")
        sys.exit(2)
    sys.exit(run(_workdir))
