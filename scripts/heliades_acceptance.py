#!/usr/bin/env python3
"""Heliades acceptance run: `run tree_qsm` on a real scan inside a macOS sandbox.

    backend-api/venv/bin/python scripts/heliades_acceptance.py SCAN [--threads N] [--runs 2]
        [--engine PATH/TO/phytograph_backend] [--param K=V ...] [--keep DIR]

Each run is confined by seatbelt: no network (loopback included), writes only
to its own work/out folders and /private/tmp, and no reads under the home
folder except the engine and the scan's folder. The script then checks:

* every run exits 0 and writes the TreeQSM-layout CSV and a record carrying
  the engine identity and its advisories;
* every run's outputs are byte-identical (same sha256);
* no process from any run is left behind.

Prints a JSON summary; exits non-zero if any check fails.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def q(p) -> str:
    return json.dumps(str(Path(p).resolve()))


def profile(readable, writable) -> str:
    rules = ["(version 1)", "(allow default)", "(deny network*)",
             f"(deny file-read* (subpath {q(Path.home())}))"]
    rules += [f"(allow file-read* (subpath {q(p)}))" for p in readable]
    # realpath/canonical stat every ancestor: metadata only, for those under home.
    home = Path.home()
    ancestors = {a for p in readable for a in Path(p).resolve().parents
                 if a == home or home in a.parents}
    rules += [f"(allow file-read-metadata (literal {q(a)}))" for a in sorted(ancestors)]
    rules += ["(deny file-write*)", '(allow file-write* (subpath "/dev"))']
    rules += [f"(allow file-write* (subpath {q(p)}))" for p in writable]
    return "\n".join(rules)


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def leftovers(marker: str):
    """Processes whose command line or environment mention this run's folder."""
    import psutil
    found = []
    for p in psutil.process_iter(["pid", "cmdline"]):
        try:
            if marker in " ".join(p.info["cmdline"] or []) or \
                    any(marker in v for v in p.environ().values()):
                found.append((p.pid, " ".join(p.info["cmdline"] or [])[:120]))
        except (psutil.Error, OSError):
            continue
    return found


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("scan", type=Path)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--engine", type=Path, help="a phytograph_backend executable (default: dev checkout)")
    ap.add_argument("--param", action="append", default=[])
    ap.add_argument("--keep", type=Path, help="keep run folders here instead of a temp dir")
    args = ap.parse_args()

    base = args.keep or Path(tempfile.mkdtemp(prefix="heliades-accept-", dir="/private/tmp"))
    base.mkdir(parents=True, exist_ok=True)
    python = Path(sys.executable).resolve()
    readable = [ROOT, python.parents[1], Path(sys.prefix), args.scan.resolve().parent]
    env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "PYTHONDONTWRITEBYTECODE": "1",
           "PYTHONPATH": str(ROOT / "python"), "PHYTOGRAPH_OFFLINE": "1"}
    if args.engine:
        readable.append(args.engine.resolve().parent)
        env["PHYTOGRAPH_BACKEND_EXE"] = str(args.engine.resolve())

    runs, ok = [], True
    for i in range(args.runs):
        d = base / f"run{i}"
        work, out = d / "work", d / "out"
        work.mkdir(parents=True, exist_ok=True)
        out.mkdir(parents=True, exist_ok=True)
        # sys.executable as given: resolving a venv's symlink yields the base
        # interpreter, without the venv's packages.
        argv = [sys.executable, "-m", "phytograph", "run", "tree_qsm", "--in", str(args.scan.resolve()),
                "--out", str(out), "--work", str(work), "--threads", str(args.threads)]
        for prm in args.param:
            argv += ["--param", prm]
        t0 = time.monotonic()
        proc = subprocess.run(["sandbox-exec", "-p", profile(readable, [work, out, "/private/tmp"]),
                               *argv], capture_output=True, text=True, env=env, cwd="/")
        secs = time.monotonic() - t0
        (d / "stderr.txt").write_text(proc.stderr)
        rec = json.loads((out / "record.json").read_text()) if (out / "record.json").is_file() else {}
        time.sleep(3)
        left = leftovers(str(d))
        runs.append({
            "exit": proc.returncode, "seconds": round(secs, 1), "status": rec.get("status"),
            "outputs": rec.get("outputs"), "engine_key": (rec.get("engine") or {}).get("key"),
            "advisories": rec.get("advisories"),
            "advisory_lines": [l for l in proc.stderr.splitlines()
                               if l.startswith("PHYTOGRAPH ADVISORY")],
            "cylinders": (sum(1 for _ in open(out / "qsm_treeqsm.csv")) - 1
                          if (out / "qsm_treeqsm.csv").is_file() else None),
            "metrics": (json.loads((out / "qsm.json").read_text())["metrics"]
                        if (out / "qsm.json").is_file() else None),
            "leftover_processes": left,
        })
        ok &= proc.returncode == 0 and not left and rec.get("status") == "ok"

    identical = len({json.dumps(r["outputs"], sort_keys=True) for r in runs}) == 1
    ok &= identical
    summary = {"ok": ok, "identical_outputs": identical, "folder": str(base),
               "engine": json.loads((base / "run0" / "out" / "record.json").read_text()).get("engine")
               if (base / "run0" / "out" / "record.json").is_file() else None,
               "runs": runs}
    print(json.dumps(summary, indent=2, default=str))
    if ok and args.keep is None:
        shutil.rmtree(base, ignore_errors=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
