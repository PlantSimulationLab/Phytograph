"""Build the training cache from the corpus (``ml.data.cache``).

    PYTHONPATH=backend-api python -u backend-api/research/ml/preprocess.py \\
        --out /group/.../ml_cache --workers 16 [--only lewos,weiser] [--force]
        [--corpus trees|organ]

Run it as a Slurm job (``jobs/preprocess.sbatch``): parsing the corpus's ~25 GB
of ASCII is tens of CPU-minutes and needs ~10 GB per worker for the biggest
Wan plot. Items are independent and each is written atomically (to a
temporary name, then renamed), so a re-run skips finished items, and a
pre-empted job loses at most the items in flight.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import corpus  # noqa: E402
import organ_corpus  # noqa: E402
from corpus import Entry  # noqa: E402
from ml.data.cache import write_item  # noqa: E402
from ml.data.readers import READERS  # noqa: E402


CORPORA = {"trees": corpus.entries, "organ": organ_corpus.entries}


def build_one(e: Entry, out_root: str, force: bool, voxel: float, cell: float) -> str:
    dest = Path(out_root) / e.dataset / e.name
    if (dest / "meta.json").exists() and not force:
        return f"skip  {e.dataset}/{e.name}"
    t0 = time.time()
    cloud = READERS[e.reader](*e.args, **e.kwargs)
    tmp = dest.with_name(dest.name + ".tmp")
    if tmp.exists():
        shutil.rmtree(tmp)
    meta = write_item(cloud, tmp, {
        "dataset": e.dataset, "name": e.name, "split": e.split, "noisy": e.noisy,
        "domain": e.domain, "reader": e.reader, "source": [str(a) for a in e.args],
    }, voxel=voxel, cell=cell)
    if dest.exists():
        shutil.rmtree(dest)
    tmp.rename(dest)
    counts = ", ".join(f"{k} {v:,}" for k, v in meta["counts"].items() if v)
    return (f"done  {e.dataset}/{e.name}: {meta['n_source_points']:,} -> {meta['n_points']:,} pts, "
            f"{counts}, {meta['n_instances']} instances ({time.time() - t0:.0f}s)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--only", default="", help="comma-separated dataset names")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--corpus", default="trees", choices=sorted(CORPORA))
    ap.add_argument("--voxel", type=float, default=None,
                    help="cache grid (m); default 5 mm for trees, 1 mm for organ")
    ap.add_argument("--cell", type=float, default=None,
                    help="bucket size (m); default 0.5 m for trees, 0.1 m for organ")
    args = ap.parse_args()

    es = CORPORA[args.corpus]()
    herb = args.corpus == "organ"
    voxel = args.voxel or (0.001 if herb else 0.005)
    cell = args.cell or (0.1 if herb else 0.5)
    if args.only:
        keep = set(args.only.split(","))
        es = [e for e in es if e.dataset in keep]
    # Biggest first, so the long poles start early rather than finishing last.
    es.sort(key=lambda e: -sum(Path(a).stat().st_size for a in e.args if isinstance(a, str) and Path(a).exists()))
    Path(args.out).mkdir(parents=True, exist_ok=True)
    failures = []
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(build_one, e, args.out, args.force, voxel, cell): e for e in es}
        for f in as_completed(futs):
            e = futs[f]
            try:
                print(f.result(), flush=True)
            except Exception:
                failures.append(f"{e.dataset}/{e.name}")
                print(f"FAIL  {e.dataset}/{e.name}\n{traceback.format_exc()}", flush=True)
    index = sorted(str(p.parent.relative_to(args.out)) for p in Path(args.out).glob("*/*/meta.json"))
    (Path(args.out) / "index.json").write_text(json.dumps(index, indent=1) + "\n")
    print(f"{len(index)} items cached, {len(failures)} failed: {failures}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
