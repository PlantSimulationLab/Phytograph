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
  IN   request.json     {"tool": "ground|wood|trees|denoise|skeleton|poisson|normals|ml_device|ml_import", "params": {...}}
       input.npy        (N, 3) float64 points
       reflectance.npy  optional (N,) float64           (wood only)
       seeds.npy        optional (S, 3) float64          (trees only)
       normals.npy      optional (N, 3) float64          (poisson only)
       origins.npy      optional (N, 3) float64          (normals only; per-point
                                                          beam origins)
  OUT  output.npy       (N,) int labels                  (ground/wood/trees/denoise)
                        (N, 5) float32                   (normals)
       result.json      skeleton's structured result dict (skeleton only);
                        the device probe (ml_device); the installed model's
                        summary or a readable error (ml_import)
       vertices.npy     (V, 3) float64                   (poisson only)
       triangles.npy    (T, 3) int32                     (poisson only)
       densities.npy    (V,) float64                     (poisson only)
       error.txt        traceback on failure (exit code 1)

`poisson` is here for a different reason than the segmentation tools: not
cancellability but CRASH ISOLATION. Open3D 0.19.0's
`create_from_point_cloud_poisson` segfaults inside its own OpenMP microtask on
roughly 6% of calls (measured on macOS/arm64 over 30 single-call trials, and
independent of pyhelios, thread affinity, OMP_NUM_THREADS and input size). In
the parent that SIGSEGV kills the whole backend; in a child it is just a
non-zero exit the endpoint reports as a normal triangulation failure.

The worker imports the EXISTING compute functions from main (segment_ground,
segment_wood, segment_trees, compute_skeleton) and from denoise (denoise_labels)
so there is exactly one implementation per tool. Importing main is cheap here: it only defines the
FastAPI app + functions (no server bind), and its pyhelios import-time guard is
a no-op once the parent backend has already built libhelios.
"""

import os
import sys
import json
import traceback
import threading
import time


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
        input_path = os.path.join(workdir, "input.npy")
        points = np.load(input_path)
        # The tiled tools can fan their tiles out to a spawn pool; the children
        # memory-map THIS file rather than receiving the points by pickle.
        os.environ["PHYTOGRAPH_TILE_POINTS_NPY"] = input_path

        if tool == "poisson":
            # Deliberately does NOT `import main`: the whole point is to run the
            # crash-prone Open3D call in a minimal process. Importing main would
            # drag libhelios (and its GLFW/OpenMP runtime) into the child for no
            # benefit. Normals are computed in the parent and shipped in, so this
            # child does exactly one thing.
            import open3d as o3d

            pcd = o3d.geometry.PointCloud()
            pcd.points = o3d.utility.Vector3dVector(points)
            normals_path = os.path.join(workdir, "normals.npy")
            if os.path.exists(normals_path):
                pcd.normals = o3d.utility.Vector3dVector(np.load(normals_path))
            mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
                pcd, depth=int(params.get("depth", 8))
            )
            np.save(os.path.join(workdir, "vertices.npy"),
                    np.asarray(mesh.vertices, dtype=np.float64))
            np.save(os.path.join(workdir, "triangles.npy"),
                    np.asarray(mesh.triangles, dtype=np.int32))
            np.save(os.path.join(workdir, "densities.npy"),
                    np.asarray(densities, dtype=np.float64))
            return 0

        if tool in ("ml_device", "ml_import"):
            # ML housekeeping. Here, not in the server, so torch is never
            # imported into the backend process (see _ML_DEVICE_CACHE in
            # main.py). Neither needs main.
            if tool == "ml_device":
                from ml.device import probe
                result = probe()
            else:
                from ml import registry
                from ml.package import PackageError
                try:
                    pkg = registry.import_package(params["path"])
                    result = {"success": True, "model": {**pkg.summary(), "origin": "user"}}
                except PackageError as e:
                    # A readable reason for the user, not a traceback.
                    result = {"success": False, "error": str(e)}
            with open(os.path.join(workdir, "result.json"), "w") as f:
                json.dump(result, f, default=_json_default)
            return 0

        # Import the compute functions lazily, AFTER args are staged, so a
        # malformed request fails fast without paying the import cost.
        import main

        if tool == "ground":
            # `meta` carries back the class_threshold actually applied (the
            # caller may have asked for it to be auto-derived from the cloth).
            gmeta: dict = {}
            labels = main.segment_ground(points, meta=gmeta, **params)
            np.save(os.path.join(workdir, "output.npy"), np.asarray(labels))
            with open(os.path.join(workdir, "result.json"), "w") as f:
                json.dump(gmeta, f, default=_json_default)

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

        elif tool == "denoise":
            # Noise classification (SOR / ROR / voxel-count). Runs here for the
            # same reason as the segmentations: a single cKDTree.query is a
            # monolithic C call that can't poll a cancel flag, so the only way to
            # stop it is to kill the process running it.
            #
            # `meta` carries back the resolved auto parameters, the flagged
            # fraction and any warnings, all of which the panel displays before
            # the user commits a destructive removal.
            import denoise as _denoise
            dmeta: dict = {}
            labels = _denoise.denoise_labels(points, meta=dmeta, **params)
            np.save(os.path.join(workdir, "output.npy"), np.asarray(labels))
            with open(os.path.join(workdir, "result.json"), "w") as f:
                json.dump(dmeta, f, default=_json_default)

        elif tool == "normals":
            # Normal estimation. Here for the multi-core path above all: the
            # tile pool refuses to open unless PHYTOGRAPH_SEG_WORKER is set
            # (tiled.worker_count), because multiprocessing forks before it
            # execs and a forked copy of a process holding open3d or libhelios
            # dies. Cancellability comes along for free -- an open3d
            # estimate_normals call is a monolithic C++ loop that cannot poll a
            # flag, so killing the process is the only way to stop it.
            #
            # Deliberately does NOT `import main`: like `poisson`, this needs
            # only its own module, and skipping main saves dragging libhelios
            # into the child.
            import normals as _normals
            origins_path = os.path.join(workdir, "origins.npy")
            origin = (np.load(origins_path) if os.path.exists(origins_path)
                      else params.pop("origin", None))
            params.pop("origin", None)
            nmeta: dict = {}
            values = _normals.compute_normals(points, origin=origin, meta=nmeta,
                                              **params)
            np.save(os.path.join(workdir, "output.npy"),
                    np.asarray(values, dtype=np.float32))
            with open(os.path.join(workdir, "result.json"), "w") as f:
                json.dump(nmeta, f, default=_json_default)

        elif tool == "trees":
            seeds_path = os.path.join(workdir, "seeds.npy")
            seeds = np.load(seeds_path) if os.path.exists(seeds_path) else None
            ti_params = main._treeiso_params_from_dict(params)
            main._auto_treeiso_decimation(points, ti_params)
            labels = main.segment_trees(points, ti_params, seeds)
            np.save(os.path.join(workdir, "output.npy"), np.asarray(labels))

        elif tool == "anchors":
            # Per-plant landmark extraction for coarse registration. Runs here
            # rather than in the request handler because it drives CSF and
            # TreeIso — the same heavyweight CPU work every other tool in this
            # dispatch isolates, and CSF can segfault on degenerate input, which
            # would otherwise take down the whole backend.
            from anchor_extraction import extract_anchors

            # Both clouds are extracted in ONE worker call. Starting a worker
            # costs ~4.3 s (it re-imports main.py and the native pyhelios
            # library), so doing target and source separately paid that twice —
            # ~8.6 s of pure overhead on a job whose actual compute is ~4 s.
            xyz, feats = extract_anchors(
                points, params["method"], float(params["extent"]))
            np.save(os.path.join(workdir, "output.npy"), np.asarray(xyz))
            np.save(os.path.join(workdir, "features.npy"), np.asarray(feats))

            second = os.path.join(workdir, "input2.npy")
            if os.path.exists(second):
                xyz2, feats2 = extract_anchors(
                    np.load(second), params["method"], float(params["extent"]))
                np.save(os.path.join(workdir, "output2.npy"), np.asarray(xyz2))
                np.save(os.path.join(workdir, "features2.npy"), np.asarray(feats2))

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


def _watch_parent(poll_s: float = 2.0) -> None:
    """Exit if the backend that spawned us dies.

    `_SegProc` spawns each worker with `posix_spawn(..., setpgroup=0)`, i.e. into
    its OWN process group, so a Cancel can killpg the worker without taking down
    the backend. That is load-bearing and must not be undone — but it also means
    the supervisor's `process.kill(-pid)` (the BACKEND's group) never reaches us,
    and the only other cleanup, `atexit.register(reap_seg_workers)`, needs a
    graceful Python exit.

    So on every path where the backend dies abruptly we were orphaned:
      * the supervisor SIGKILLs after its 1.5 s grace, which any in-flight
        segmentation blows through (uvicorn's SIGTERM waits for the request);
      * the backend is OOM-killed or segfaults;
      * the machine kills it for any other reason.
    Each orphan holds the staged cloud plus its own compute copies — multi-GB on
    a real scan — with no parent, no terminal, and a name the user will not
    recognise, and they stack across launches.

    A `getppid()` poll rather than `prctl(PR_SET_PDEATHSIG)` because the latter
    is Linux-only and, being per-process, would not survive the tiled tools'
    spawn pool either. Cheap: one syscall every couple of seconds, on a daemon
    thread that can never hold up a normal exit.
    """
    original = os.getppid()

    def _poll() -> None:
        while True:
            time.sleep(poll_s)
            try:
                now = os.getppid()
            except OSError:  # pragma: no cover - platform without getppid
                return
            # Reparented (POSIX gives us to init/launchd) or the pid changed:
            # either way the backend that owns this work is gone, so the result
            # has nobody to return to. os._exit, not sys.exit: we may be deep in
            # a C extension holding the GIL, and this thread must not run
            # interpreter shutdown under it.
            if now != original or now == 1:
                sys.stderr.write(
                    f"seg_worker: parent {original} is gone (ppid now {now}); exiting\n")
                sys.stderr.flush()
                os._exit(3)

    threading.Thread(target=_poll, name="parent-watchdog", daemon=True).start()


if __name__ == "__main__":
    _workdir = os.environ.get("PHYTOGRAPH_SEG_WORKER") or (
        sys.argv[1] if len(sys.argv) > 1 else None
    )
    if not _workdir:
        sys.stderr.write("seg_worker: no workdir (set PHYTOGRAPH_SEG_WORKER)\n")
        sys.exit(2)
    _watch_parent()
    sys.exit(run(_workdir))
