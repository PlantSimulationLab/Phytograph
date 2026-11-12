"""One-shot mode: run one recipe in this process and exit. No server, no socket.

    phytograph_backend --run-recipe tree_qsm --in CLOUD --out DIR --work DIR \\
        [--record PATH] [--param k=v ...] [--import k=v ...] [--threads N] [--ml-device cpu]

Usually reached through ``python -m phytograph run ...``, which finds the
installed engine (never downloading it) and execs this. Built for a confined
harness: no network (not even loopback), a read-only engine, one writable
work directory, a thread budget, and nothing left running afterwards.

The recipe runs against the FastAPI app through a starlette ``TestClient``,
which calls the ASGI app directly, so the client code (``phytograph.recipes``)
is the same code a script runs against a server.

Two phases, because of import order:

* :func:`prepare` runs at the very top of ``backend_wrapper.py``, before
  anything imports numpy. It parses the arguments and points every location
  the engine writes at the work directory, and sets the thread cap, both of
  which native libraries read only when they load. Standard library only.
* :func:`run` runs once ``main.app`` is imported.

Exit status: 0 success; 2 bad usage or a bad parameter; 3 the recipe's check
failed (``RecipeError``; the record is still written, with ``status:
"failed"``); 1 anything else. Each advisory is also printed to stderr as one
line, ``PHYTOGRAPH ADVISORY [code] (step): message``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

FLAG = "--run-recipe"

EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_RECIPE = 0, 1, 2, 3

# Recipes `run` can execute, and the files each writes into --out.
SUPPORTED = {
    "tree_qsm": ("qsm_treeqsm.csv", "qsm.json"),
    "plot_inventory": ("inventory.csv",),
}


class UsageError(Exception):
    pass


def requested(argv: List[str]) -> bool:
    return len(argv) > 1 and argv[1] == FLAG


def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="phytograph_backend --run-recipe",
        description="Run one Phytograph recipe in-process and exit (no server, no network).")
    ap.add_argument("recipe", help=f"one of: {', '.join(sorted(SUPPORTED))}")
    ap.add_argument("--in", dest="input", required=True, type=Path, help="point cloud file")
    ap.add_argument("--out", required=True, type=Path, help="folder for the outputs")
    ap.add_argument("--work", required=True, type=Path,
                    help="writable folder for everything else the engine writes "
                         "(temp files, logs, caches)")
    ap.add_argument("--record", type=Path,
                    help="where to write the RecipeRecord JSON (default: OUT/record.json)")
    ap.add_argument("--param", action="append", default=[], metavar="K=V",
                    help="a recipe keyword; V is parsed as JSON, else taken as a string")
    ap.add_argument("--import", dest="import_opts", action="append", default=[], metavar="K=V",
                    help="an import option for the cloud file (e.g. source_units=mm)")
    ap.add_argument("--threads", type=int,
                    help="cap on every thread pool (default: PHYTOGRAPH_THREADS, else uncapped)")
    ap.add_argument("--ml-device", default=None, choices=("cpu", "auto"),
                    help="ML segmentation device; default cpu, for reproducible numbers")
    return ap


def _kv(items: List[str], what: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for item in items:
        if "=" not in item:
            raise UsageError(f"{what} {item!r} is not K=V")
        k, v = item.split("=", 1)
        try:
            out[k.strip()] = json.loads(v)
        except ValueError:
            out[k.strip()] = v
    return out


def prepare(argv: List[str]) -> argparse.Namespace:
    """Parse ``argv`` (everything after ``--run-recipe``) and set up the
    environment. Exits with status 2 on bad usage."""
    try:
        opts = _parser().parse_args(argv)
        if opts.recipe not in SUPPORTED:
            raise UsageError(f"recipe {opts.recipe!r} is not supported by run; "
                             f"supported: {', '.join(sorted(SUPPORTED))}")
        opts.params = _kv(opts.param, "--param")
        opts.imports = _kv(opts.import_opts, "--import")
        if opts.threads is not None and opts.threads < 1:
            raise UsageError("--threads must be a positive integer")
        if not opts.input.is_file():
            raise UsageError(f"--in: no such file: {opts.input}")
    except UsageError as e:
        sys.stderr.write(f"phytograph run: error: {e}\n")
        sys.exit(EXIT_USAGE)

    work = opts.work.expanduser().resolve()
    opts.work = work
    opts.input = opts.input.expanduser().resolve()
    opts.out = opts.out.expanduser().resolve()
    opts.record = (opts.record.expanduser().resolve() if opts.record
                   else opts.out / "record.json")
    for sub in ("tmp", "logs", "octrees", "ml_models", "numba", "cache", "riegl"):
        (work / sub).mkdir(parents=True, exist_ok=True)
    opts.out.mkdir(parents=True, exist_ok=True)

    env = os.environ
    env["TMPDIR"] = env["TEMP"] = env["TMP"] = str(work / "tmp")
    env["PHYTOGRAPH_LOG_DIR"] = str(work / "logs")
    env["PHYTOGRAPH_OCTREE_CACHE_ROOT"] = str(work / "octrees")
    env["PHYTOGRAPH_ML_MODELS_DIR"] = str(work / "ml_models")
    env["NUMBA_CACHE_DIR"] = str(work / "numba")
    env["XDG_CACHE_HOME"] = str(work / "cache")
    env["PHYTOGRAPH_RIEGL_EXTRACT_ROOT"] = str(work / "riegl" / "extracts")
    env["PHYTOGRAPH_RXP_SHIM_CACHE"] = str(work / "riegl" / "shim")
    if opts.threads is not None:
        env["PHYTOGRAPH_THREADS"] = str(opts.threads)
    if opts.ml_device != "auto":
        env["PHYTOGRAPH_ML_DEVICE"] = "cpu"
    env["PHYTOGRAPH_ONESHOT"] = "1"   # children stay in the caller's process group
    # In-process: no token to check, and no parent pipe to watch (the process
    # the caller started IS the engine).
    for k in ("PHYTOGRAPH_BACKEND_TOKEN", "PHYTOGRAPH_EXIT_WITH_PARENT",
              "PHYTOGRAPH_DEV_BACKEND", "PHYTOGRAPH_RENDERER_PORT"):
        env.pop(k, None)
    os.chdir(work)
    return opts


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_outputs(recipe: str, result: Any, out: Path) -> List[Path]:
    if recipe == "tree_qsm":
        csv_name, json_name = SUPPORTED[recipe]
        q = result
        q.to_treeqsm_csv(out / csv_name)
        (out / json_name).write_text(json.dumps(
            {"cylinders": q.cylinders, "shoots": q.shoots, "metrics": q.metrics},
            indent=1, default=_json_default))
        return [out / csv_name, out / json_name]
    if recipe == "plot_inventory":
        (name,) = SUPPORTED[recipe]
        result.to_csv(out / name)
        return [out / name]
    raise AssertionError(recipe)


def _json_default(o: Any) -> Any:
    import numpy as np
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(f"{type(o).__name__} is not JSON serializable")


def _ensure_client_importable() -> None:
    """The client package ships inside the frozen bundle; in a dev checkout
    it is the sibling python/ folder."""
    if getattr(sys, "frozen", False):
        return
    here = Path(__file__).resolve().parent
    client = here.parent / "python"
    if (client / "phytograph" / "__init__.py").is_file() and str(client) not in sys.path:
        sys.path.insert(0, str(client))


def _emit(advisories: List[Dict[str, Any]]) -> None:
    from phytograph.advisories import Advisory
    for a in advisories:
        sys.stderr.write(Advisory(a["code"], a["message"], a.get("step")).line() + "\n")
    sys.stderr.flush()


def run(app: Any, opts: argparse.Namespace) -> int:
    """Run the recipe against ``app`` in-process; write outputs and the record."""
    _ensure_client_importable()
    import logging
    import thread_cap
    # One line per in-process request is server-log noise on the caller's stderr.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    from starlette.testclient import TestClient

    import phytograph as pg
    from phytograph import recipes
    from phytograph._identity import running_identity

    fn = getattr(recipes, opts.recipe)
    identity = running_identity()
    status, code, record, error = "ok", EXIT_OK, None, None
    outputs: List[Path] = []
    # raise_server_exceptions=False: an endpoint's 500 must reach the client as
    # an HTTP error (PhytographError), exactly as it does over a socket.
    with TestClient(app, base_url="http://127.0.0.1",
                    raise_server_exceptions=False) as client:
        be = pg.Backend._in_process(client, identity=identity)
        try:
            try:
                cloud = be.open(opts.input, **opts.imports)
            except TypeError as e:
                raise UsageError(f"--import: {e}") from None
            with cloud:
                try:
                    out = fn(cloud, **opts.params)
                except TypeError as e:
                    if "keyword" in str(e) or "argument" in str(e):
                        raise UsageError(f"--param: {e}") from None
                    raise
                result, rec = out if isinstance(out, tuple) else (None, out)
                record = rec.to_dict()
                outputs = _write_outputs(opts.recipe, result, opts.out)
        except UsageError as e:
            sys.stderr.write(f"phytograph run: error: {e}\n")
            return EXIT_USAGE
        except recipes.RecipeError as e:
            status, code, error = "failed", EXIT_RECIPE, str(e)
            record = e.detail if isinstance(e.detail, dict) else {"recipe": opts.recipe}
        except Exception as e:
            status, code, error = "error", EXIT_ERROR, f"{type(e).__name__}: {e}"
            traceback.print_exc()
            record = record or {"recipe": opts.recipe}
        finally:
            be.close()

    record = dict(record or {})
    record.setdefault("engine", identity)
    record["status"] = status
    if error is not None:
        record["error"] = error
    record["runtime"] = {"threads": thread_cap.report(),
                         "ml_device": os.environ.get("PHYTOGRAPH_ML_DEVICE", "auto")}
    record.setdefault("input", {})["path"] = str(opts.input)
    record["input_sha256"] = _sha256(opts.input)
    record["outputs"] = {p.name: _sha256(p) for p in outputs}
    opts.record.parent.mkdir(parents=True, exist_ok=True)
    opts.record.write_text(json.dumps(record, indent=2, sort_keys=True, default=_json_default))
    _emit(record.get("advisories") or [])
    if error is not None:
        sys.stderr.write(f"phytograph run: {status}: {error}\n")
    return code
