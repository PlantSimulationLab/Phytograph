"""Train a point-classification model headless.

    PYTHONPATH=backend-api python -m ml.train path/to/config.yaml [--steps N]

The config (YAML) names a task (``ml.tasks``), the training cache, weighted
groups of training sources, the model size and the optimiser. See
``research/ml/configs/`` for the benchmark's runs. Outputs go to
``<out>/<name>/``:

- ``package/``: the best checkpoint by validation mean IoU, as a model
  package the app can import.
- ``last.pt``: resumable state (weights, optimiser, schedule, step). A
  re-run of the same config continues from it, so a preempted or timed-out
  job loses at most ``checkpoint_every`` steps.
- ``log.jsonl``: one record per log interval and one per validation.

Validation runs whole items through :func:`ml.infer.predict`, the exact path
the app uses. The score that selects the checkpoint is therefore the score of
what ships.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader, IterableDataset, get_worker_info

from .data.cache import open_cache
from .data.crops import AugConfig, CropConfig, CropSampler, Source
from .data.readers import SEM
from .hierarchy import HierarchySpec, collate
from .infer import predict, to_torch
from .metrics import confusion, scores
from .package import KNOWN_CHANNELS, ModelPackage, save
from .tasks import TASKS, task_map


def _select(items: dict, sel: dict) -> list:
    """Cache items matching a selector: any of ``datasets``, ``splits``,
    ``domain`` (all given keys must match)."""
    out = []
    for key, it in items.items():
        m = it.meta
        if "datasets" in sel and m["dataset"] not in sel["datasets"]:
            continue
        if "splits" in sel and m["split"] not in sel["splits"]:
            continue
        if "domain" in sel and m.get("domain") != sel["domain"]:
            continue
        if "exclude" in sel and key in sel["exclude"]:
            continue
        out.append(it)
    return out


def build_sources(items: dict, groups: list[dict], task_lut) -> list[Source]:
    """Each group gets its ``weight`` share of crops, split among its items by
    the square root of their labelled point count. Square root rather than
    linear, so one 17 M-point scene cannot drown fifty small trees."""
    sources = []
    for g in groups:
        members = _select(items, g)
        if not members:
            raise ValueError(f"training group {g} matched no cached items")
        sizes = []
        for it in members:
            c = it.meta["counts"]
            labelled = sum(v for k, v in c.items() if task_lut[SEM[k]] >= 0)
            sizes.append(max(labelled, 1))
        w = np.sqrt(np.array(sizes, dtype=np.float64))
        w = w / w.sum() * float(g.get("weight", 1.0))
        for it, wi in zip(members, w):
            sources.append(Source(it, float(wi), bool(it.meta.get("noisy", True)), g.get("name", "")))
    return sources


def make_package(cfg: dict, spec: HierarchySpec) -> ModelPackage:
    task = TASKS[cfg["task"]]
    channels = list(cfg.get("channels", ["dxyz"]))
    variant = cfg.get("model", {}).get("variant", "S")
    hp = {
        "in_channels": sum(KNOWN_CHANNELS[c] for c in channels),
        "num_classes": len(task["classes"]),
        "radii": [spec.level_radius(i) for i in range(spec.levels)],
        "variant": variant,
    }
    for k in ("width", "blocks", "dropout"):
        if k in cfg.get("model", {}):
            hp[k] = cfg["model"][k]
    crop = cfg.get("crop", {})
    return ModelPackage(
        id=cfg.get("package_id", cfg["name"].lower().replace(".", "-")),
        name=cfg.get("package_name", cfg["name"]),
        description=cfg.get("description", ""),
        task=cfg["task"], arch="pointnext", hparams=hp, hierarchy=spec,
        channels=channels, classes=task["classes"], output_slug=task["output_slug"],
        crop_max_points=int(crop.get("max_points", 24000)),
        crop_inner_fraction=float(crop.get("inner_fraction", 0.7)),
    )


def evaluate(model, pkg: ModelPackage, items: list, lut: np.ndarray, device: str,
             max_points: int | None = None) -> dict:
    """Score whole cached items. Returns per-item scores plus pooled totals."""
    names = [c["name"] for c in pkg.classes]
    n = len(names)
    index_of = np.full(256, -1, np.int64)
    for j, c in enumerate(pkg.classes):
        index_of[c["value"]] = j
    per_item = {}
    pooled = np.zeros((n, n), np.int64)
    for it in items:
        xyz = np.asarray(it.xyz, dtype=np.float64)
        truth = lut[np.asarray(it.sem)]
        if max_points and len(xyz) > max_points:
            # A contiguous spatial block, not a random subset: a random subset
            # would change the point density the model sees.
            centre = xyz[np.argmin(np.abs(xyz[:, 2] - np.median(xyz[:, 2])))]
            keep = np.argsort(((xyz - centre) ** 2).sum(axis=1))[:max_points]
            xyz, truth = xyz[keep], truth[keep]
        t0 = time.time()
        values = predict(model, pkg, xyz, device=device, batch_crops=16)
        pred = index_of[values]
        cm = confusion(truth, pred, n)
        pooled += cm
        s = scores(cm, names)
        s["seconds"] = round(time.time() - t0, 1)
        per_item[f"{it.meta['dataset']}/{it.meta['name']}"] = s
    out = {"items": per_item, "pooled": scores(pooled, names)}
    mious = [s["miou"] for s in per_item.values() if not math.isnan(s["miou"])]
    out["mean_item_miou"] = float(np.mean(mious)) if mious else float("nan")
    return out


def _git_commit() -> str | None:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True,
                              cwd=Path(__file__).parent, timeout=5).stdout.strip() or None
    except Exception:
        return None


class CropStream(IterableDataset):
    """An endless stream of training crops. Module-level so it pickles under
    the spawn start method that macOS and Windows use for DataLoader workers."""

    def __init__(self, sampler: CropSampler, seed: int):
        self.sampler, self.seed = sampler, seed

    def __iter__(self):
        wi = get_worker_info()
        # Time in the seed: a resumed run must not replay the crops it already
        # trained on.
        rng = np.random.default_rng(
            [self.seed, wi.id if wi else 0, int(time.time() * 1e3) % (2**31)])
        while True:
            yield self.sampler.sample(rng)


def train(cfg: dict, steps_override: int | None = None) -> Path:
    from .models import build_model

    seed = int(cfg.get("seed", 0))
    torch.manual_seed(seed)
    out = Path(cfg["out"]) / cfg["name"]
    out.mkdir(parents=True, exist_ok=True)
    (out / "config.json").write_text(json.dumps(cfg, indent=2) + "\n")

    spec = HierarchySpec.from_dict(cfg.get("hierarchy", {}))
    pkg = make_package(cfg, spec)
    tmap = task_map(cfg["task"])
    lut = tmap.lut()
    items = open_cache(cfg["cache"])
    sources = build_sources(items, cfg["train"], lut)
    val_cfg = cfg.get("val", {})
    val_items = _select(items, val_cfg)[: int(val_cfg.get("max_items", 1_000_000))]
    crop_cfg = CropConfig(max_points=pkg.crop_max_points,
                          minority_codes=tuple(TASKS[cfg["task"]]["minority_codes"]),
                          **{k: v for k, v in cfg.get("crop", {}).items()
                             if k not in ("max_points", "inner_fraction")})
    aug_cfg = AugConfig(**{k: (tuple(v) if isinstance(v, list) else v)
                           for k, v in cfg.get("aug", {}).items()})
    sampler = CropSampler(sources, tmap, spec, pkg.channels, crop_cfg, aug_cfg, augment=True)
    print(f"{len(sources)} training sources, {len(val_items)} validation items", flush=True)

    opt_cfg = cfg.get("optim", {})
    batch = int(opt_cfg.get("batch", 8))
    steps = int(steps_override or opt_cfg.get("steps", 40000))
    workers = int(cfg.get("workers", max(1, (os.cpu_count() or 2) - 2)))
    loader = DataLoader(CropStream(sampler, seed), batch_size=batch, collate_fn=collate, num_workers=workers,
                        persistent_workers=workers > 0, prefetch_factor=4 if workers else None)

    from .device import best_device
    device = best_device(cfg.get("device"))
    model = build_model(pkg.arch, **pkg.hparams).to(device)
    if cfg.get("init"):
        state = torch.load(Path(cfg["init"]) / "weights.pt", map_location="cpu", weights_only=True)
        model.load_state_dict(state)
        print(f"initialised from {cfg['init']}", flush=True)
    print(f"device {device}, {sum(p.numel() for p in model.parameters()):,} parameters", flush=True)

    lr = float(opt_cfg.get("lr", 2e-3))
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=float(opt_cfg.get("weight_decay", 0.05)))
    warmup = int(opt_cfg.get("warmup", 1000))

    def lr_at(step):
        if step < warmup:
            return lr * (step + 1) / warmup
        t = (step - warmup) / max(1, steps - warmup)
        return lr * (0.01 + 0.99 * 0.5 * (1 + math.cos(math.pi * t)))

    start, best = 0, -1.0
    last = out / "last.pt"
    if last.exists():
        ck = torch.load(last, map_location="cpu", weights_only=True)
        model.load_state_dict(ck["model"])
        opt.load_state_dict(ck["opt"])
        start, best = int(ck["step"]), float(ck["best"])
        print(f"resumed at step {start} (best val mIoU {best:.4f})", flush=True)

    ls = float(opt_cfg.get("label_smoothing", 0.1))
    ce = torch.nn.CrossEntropyLoss(ignore_index=-1, reduction="none", label_smoothing=ls)
    amp = device == "cuda"
    log = open(out / "log.jsonl", "a")
    eval_every = int(cfg.get("eval_every", 2000))
    ck_every = int(cfg.get("checkpoint_every", 500))
    log_every = int(cfg.get("log_every", 50))
    it = iter(loader)
    t_log, loss_acc, n_acc, wait_acc = time.time(), 0.0, 0, 0.0
    model.train()
    for step in range(start, steps):
        t_wait = time.time()
        b = to_torch(next(it), device)
        wait_acc += time.time() - t_wait
        for g in opt.param_groups:
            g["lr"] = lr_at(step)
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=amp):
            logits = model(b)
        loss_pt = ce(logits.float(), b["label"])
        w = b["weight"] * (b["label"] >= 0)
        loss = (loss_pt * w).sum() / w.sum().clamp_min(1.0)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 10.0)
        opt.step()
        loss_acc += loss.detach().item()
        n_acc += 1

        if (step + 1) % log_every == 0:
            dt = time.time() - t_log
            rec = {"step": step + 1, "loss": loss_acc / n_acc, "lr": lr_at(step),
                   "s_per_step": dt / n_acc, "data_wait_frac": wait_acc / dt}
            print(json.dumps(rec), flush=True)
            log.write(json.dumps(rec) + "\n"); log.flush()
            t_log, loss_acc, n_acc, wait_acc = time.time(), 0.0, 0, 0.0

        final = step + 1 == steps
        if val_items and ((step + 1) % eval_every == 0 or final):
            model.eval()
            ev = evaluate(model, pkg, val_items, lut, device,
                          max_points=val_cfg.get("max_points_per_item"))
            model.train()
            score = ev["mean_item_miou"]
            rec = {"step": step + 1, "val_mean_item_miou": score, "val_pooled": ev["pooled"]}
            print(json.dumps(rec), flush=True)
            log.write(json.dumps({**rec, "val_items": ev["items"]}) + "\n"); log.flush()
            if score > best:
                best = score
                pkg.metrics = {"val_mean_item_miou": score, "val_pooled": ev["pooled"], "step": step + 1}
                pkg.training = {"config": cfg["name"], "task": cfg["task"], "steps": step + 1,
                                "train_groups": cfg["train"], "commit": _git_commit()}
                save(pkg, model.state_dict(), out / "package")
                print(f"new best {best:.4f} -> {out / 'package'}", flush=True)
        if (step + 1) % ck_every == 0 or final:
            tmp = last.with_suffix(".tmp")
            torch.save({"model": model.state_dict(), "opt": opt.state_dict(),
                        "step": step + 1, "best": best}, tmp)
            os.replace(tmp, last)
    if not val_items:
        pkg.training = {"config": cfg["name"], "task": cfg["task"], "steps": steps,
                        "train_groups": cfg["train"], "commit": _git_commit()}
        save(pkg, model.state_dict(), out / "package")
    return out / "package"


def main():
    import yaml

    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--steps", type=int, default=None, help="override optim.steps (smoke tests)")
    ap.add_argument("--set", action="append", default=[],
                    help="override a top-level key, e.g. --set name=foo --set workers=4")
    args = ap.parse_args()
    cfg = yaml.safe_load(Path(args.config).read_text())
    for kv in args.set:
        k, v = kv.split("=", 1)
        cfg[k] = yaml.safe_load(v)
    train(cfg, args.steps)


if __name__ == "__main__":
    main()
