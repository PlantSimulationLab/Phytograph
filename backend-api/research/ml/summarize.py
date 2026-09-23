"""Print one comparison table from any number of bench.py result files.

    python research/ml/summarize.py .../bench/*.json [--metric miou] [--markdown]

Rows are split:dataset groups and columns are methods. Each cell shows the
mean over that group's items of the chosen metric (``mean_item`` weights
every tree equally, which is the fair view when tree sizes vary 100x). The
pooled wood IoU follows in parentheses, and for real data the core score
(with the label-boundary band excluded) follows after a slash.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--metric", default="miou", help="miou | iou_wood | f1_wood | oa | recall_wood")
    ap.add_argument("--markdown", action="store_true")
    args = ap.parse_args()

    methods: dict[str, dict] = {}
    for f in args.files:
        for name, res in json.loads(Path(f).read_text()).items():
            methods[name] = res
    groups = sorted({g for r in methods.values() for g in r["groups"]})
    names = list(methods)

    def cell(r, g):
        if g not in r["groups"]:
            return ""
        items = [v for k, v in r["items"].items() if f"{v['split']}:{k.split('/')[0]}" == g]
        vals = [v["all"][args.metric] for v in items]
        core = [v["core"][args.metric] for v in items if "core" in v]
        s = f"{np.nanmean(vals):.3f}"
        if core:
            s += f"/{np.nanmean(core):.3f}"
        return s

    header = ["group (n)"] + names
    rows = []
    for g in groups:
        n = max(r["groups"].get(g, {}).get("n_items", 0) for r in methods.values())
        rows.append([f"{g} ({n})"] + [cell(methods[m], g) for m in names])
    # Tree-level real test sets, pooled across datasets with every tree equal.
    real = [g for g in groups if g.startswith("test:") and not g.endswith(":wan")]
    summary = ["ALL real test trees"]
    for m in names:
        vals = [v["all"][args.metric] for k, v in methods[m]["items"].items()
                if f"{v['split']}:{k.split('/')[0]}" in real]
        core = [v["core"][args.metric] for k, v in methods[m]["items"].items()
                if f"{v['split']}:{k.split('/')[0]}" in real and "core" in v]
        summary.append(f"{np.nanmean(vals):.3f}/{np.nanmean(core):.3f}" if vals else "")
    rows.append(summary)

    print(f"metric: {args.metric} (mean over items; all points / boundary band excluded)")
    if args.markdown:
        print("| " + " | ".join(header) + " |")
        print("|" + "---|" * len(header))
        for r in rows:
            print("| " + " | ".join(r) + " |")
    else:
        w = [max(len(str(x)) for x in col) for col in zip(header, *rows)]
        for r in [header] + rows:
            print("  ".join(str(x).ljust(wi) for x, wi in zip(r, w)))


if __name__ == "__main__":
    main()
