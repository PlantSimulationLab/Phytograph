"""Build the training cache from the corpus (``ml.data.cache``).

    PYTHONPATH=backend-api python -u backend-api/research/ml/preprocess.py \\
        --out /group/.../ml_cache --workers 16 [--only lewos,weiser] [--force]

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

from corpus import Entry, entries  # noqa: E402
from ml.data.cache import write_item  # noqa: E402
from ml.data.readers import READERS  # noqa: E402


def build_one(e: Entry, out_root: str, force: bool) -> str:
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
    })
    if dest.exists():
        shutil.rmtree(dest)
    tmp.rename(dest)
    c = meta["counts"]
    return (f"done  {e.dataset}/{e.name}: {meta['n_source_points']:,} -> {meta['n_points']:,} pts, "
            f"wood {c['wood']:,} leaf {c['leaf']:,} fruit {c['fruit']:,} ground {c['ground']:,} "
            f"({time.time() - t0:.0f}s)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--only", default="", help="comma-separated dataset names")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    es = entries()
    if args.only:
        keep = set(args.only.split(","))
        es = [e for e in es if e.dataset in keep]
    # Biggest first, so the long poles start early rather than finishing last.
    es.sort(key=lambda e: -sum(Path(a).stat().st_size for a in e.args if isinstance(a, str) and Path(a).exists()))
    Path(args.out).mkdir(parents=True, exist_ok=True)
    failures = []
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(build_one, e, args.out, args.force): e for e in es}
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
