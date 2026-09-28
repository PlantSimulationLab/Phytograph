"""Whole-cloud inference by overlapping crops.

A network sees one crop of at most ``crop_max_points`` voxels at a time: the
k nearest voxels of a seed point. The cloud is covered crop by crop:

1. Grid-sample the input at the model's voxel size (``ml.grid``) and keep the
   inverse map.
2. Take the next uncovered voxel as a seed, crop its k nearest voxels, and
   mark the crop's inner ``inner_fraction`` (by distance) as covered. Crops
   are batched.
3. Accumulate each crop's softmax into its voxels, weighted by closeness to
   the crop center, since predictions near a crop's rim have seen only half a
   neighborhood.
4. Take the argmax per voxel and scatter it back to every input point through
   the inverse map.

A model with an offset head (organ instances) has its per-point centroid
offsets averaged the same way. They are metric vectors in the cloud's frame,
so votes from different crops agree wherever the network does.

Every voxel is at the inner part of at least one crop, so none is predicted
only from a crop's edge. Crops are the same shape training sampled: a kNN ball
around a real point, centered on it. :func:`crop_features` is shared with the
trainer, so the network's input is built one way only.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import os

import numpy as np
from scipy.spatial import cKDTree

from . import hierarchy as H
from .grid import grid_sample
from .package import ModelPackage


class Canceled(Exception):
    """Raised when the cancel callback returns True between batches."""


def crop_features(dxyz: np.ndarray, reflectance: np.ndarray | None, channels: list[str]) -> np.ndarray:
    """The network's per-point input for one crop: the channels in ``channels``
    order. ``dxyz`` is the offset from the crop center in meters."""
    cols = []
    for c in channels:
        if c == "dxyz":
            cols.append(dxyz.astype(np.float32))
        elif c == "reflectance":
            if reflectance is None:
                raise ValueError("this model needs a reflectance channel and the cloud has none")
            cols.append(reflectance.astype(np.float32).reshape(-1, 1))
        else:
            raise ValueError(f"unknown channel {c!r}")
    return np.concatenate(cols, axis=1)


def normalize_reflectance(r: np.ndarray) -> np.ndarray:
    """Map a reflectance column to roughly [-1, 1] by its own 2nd/98th
    percentiles. Instruments disagree on units (dB, raw DN, [0, 1]), so only
    the within-cloud contrast is meaningful to the network."""
    r = np.asarray(r, dtype=np.float64)
    lo, hi = np.nanpercentile(r, [2, 98])
    scale = (hi - lo) / 2 or 1.0
    return np.nan_to_num(np.clip((r - (lo + hi) / 2) / scale, -3, 3)).astype(np.float32)


def to_torch(batch: dict, device) -> dict:
    """Move a collated batch to ``device``: positions and features as float32,
    indices as int64."""
    import torch

    out = {}
    for key, val in batch.items():
        if isinstance(val, list):
            if key in ("pos", "up_w"):
                out[key] = [None if v is None else torch.from_numpy(v).to(device) for v in val]
            else:
                out[key] = [None if v is None else torch.from_numpy(v.astype(np.int64)).to(device)
                            for v in val]
        elif key in ("feat", "weight", "offset", "log_radius"):
            out[key] = torch.from_numpy(val.astype(np.float32)).to(device)
        elif key in ("allowed", "has_offset"):
            out[key] = torch.from_numpy(val.astype(bool)).to(device)
        elif key == "label":
            out[key] = torch.from_numpy(val.astype(np.int64)).to(device)
        else:
            out[key] = val
    return out


def predict(
    model,
    pkg: ModelPackage,
    xyz: np.ndarray,
    reflectance: np.ndarray | None = None,
    device: str = "cpu",
    batch_crops: int = 8,
    progress=None,
    cancel=None,
    return_probs: bool = False,
    threads: int | None = None,
    return_offsets: bool = False,
):
    """Classify every point of ``xyz`` (N, 3).

    Returns ``values``, an (N,) int32 array of class values (``pkg.classes[i]
    ["value"]``, never output indices). With ``return_probs`` it returns
    ``(values, probs)``, where ``probs`` is (N, C) float32. With
    ``return_offsets`` (a model with an offset head) the per-point centroid
    offsets, (N, 3) float32 meters, and instance radii, (N,) float32 meters,
    are appended to whatever is returned.

    ``progress(fraction)`` is called after each batch, and ``cancel()`` is
    polled before each batch (raising :class:`Canceled`).
    """
    import torch

    xyz = np.asarray(xyz, dtype=np.float64)
    n = len(xyz)
    n_cls = len(pkg.classes)
    values_of = np.array([c["value"] for c in pkg.classes], dtype=np.int32)
    has_offset = getattr(model, "offset_head", None) is not None
    if return_offsets and not has_offset:
        raise ValueError(f"model {pkg.id!r} has no offset head")

    def pack(values, probs, offsets):
        out = [values]
        if return_probs:
            out.append(probs)
        if return_offsets:
            out.extend(offsets)
        return out[0] if len(out) == 1 else tuple(out)

    if n == 0:
        return pack(np.empty(0, np.int32), np.empty((0, n_cls), np.float32),
                    (np.empty((0, 3), np.float32), np.empty(0, np.float32)))

    # Center in float64 before narrowing: georeferenced clouds (UTM) would
    # lose millimeters in float32 otherwise.
    center = (xyz.min(axis=0) + xyz.max(axis=0)) / 2
    p = xyz - center
    keep, inverse = grid_sample(p, pkg.hierarchy.voxel)
    vox = p[keep].astype(np.float32)
    vrefl = None
    if "reflectance" in pkg.channels:
        if reflectance is None:
            raise ValueError(f"model {pkg.id!r} needs reflectance and the cloud has none")
        vrefl = normalize_reflectance(np.asarray(reflectance)[keep])

    m = len(vox)
    tree = cKDTree(vox)
    k_crop = int(min(pkg.crop_max_points, m))
    acc = np.zeros((m, n_cls), dtype=np.float32)
    acc_off = np.zeros((m, 4), dtype=np.float32) if has_offset else None
    wsum = np.zeros(m, dtype=np.float32)
    claimed = np.zeros(m, dtype=bool)
    # A fixed shuffled order makes seeds spread over the cloud rather than
    # sweeping it along the grid's key order, and keeps the result deterministic.
    order = np.random.default_rng(0).permutation(m)
    cursor = 0
    done = 0
    threads = threads or max(1, min(8, (os.cpu_count() or 2) - 1))
    pool = ThreadPoolExecutor(max_workers=threads)

    def build_one(seed):
        d, idx = tree.query(vox[seed], k=k_crop, workers=1)
        d, idx = np.atleast_1d(d), np.atleast_1d(idx)
        dxyz = vox[idx] - vox[seed]
        item = H.build(dxyz, pkg.hierarchy)
        item["feat"] = crop_features(dxyz, None if vrefl is None else vrefl[idx], pkg.channels)
        return idx, d, item

    try:
        with torch.inference_mode():
            while True:
                if cancel is not None and cancel():
                    raise Canceled()
                seeds = []
                while len(seeds) < batch_crops and cursor < m:
                    s = order[cursor]
                    cursor += 1
                    if claimed[s]:
                        continue
                    # Claim this seed's inner region now, so the next seed in
                    # the same batch lands elsewhere. The crop query is
                    # repeated in build_one, which is cheaper than holding it.
                    d, idx = tree.query(vox[s], k=k_crop, workers=-1)
                    d, idx = np.atleast_1d(d), np.atleast_1d(idx)
                    claimed[idx[d <= pkg.crop_inner_fraction * d[-1]]] = True
                    claimed[s] = True
                    seeds.append(s)
                if not seeds:
                    break
                built = list(pool.map(build_one, seeds))
                batch = to_torch(H.collate([b[2] for b in built]), device)
                out = model(batch)
                offs = None
                if has_offset:
                    out, offs, logr = out
                    offs = torch.cat([offs.float(), logr.float()[:, None]], dim=1).cpu().numpy()
                probs = torch.softmax(out.float(), dim=-1).cpu().numpy()
                off = 0
                for idx, d, _ in built:
                    k = len(idx)
                    dmax = max(float(d[-1]), 1e-6)
                    w = np.clip(1.0 - d / dmax, 0.05, 1.0).astype(np.float32)
                    acc[idx] += probs[off:off + k] * w[:, None]
                    if offs is not None:
                        acc_off[idx] += offs[off:off + k] * w[:, None]
                    wsum[idx] += w
                    off += k
                done = int(claimed.sum())
                if progress is not None:
                    progress(done / m)
    finally:
        pool.shutdown(wait=False)

    vox_probs = acc / np.maximum(wsum, 1e-12)[:, None]
    values = values_of[vox_probs.argmax(axis=1)][inverse]
    offsets = None
    if return_offsets:
        # A voxel's offset points from the voxel's representative; the other
        # points in the voxel are at most a voxel away, which is the
        # clustering's own resolution.
        o = (acc_off / np.maximum(wsum, 1e-12)[:, None])[inverse]
        # Log radii are averaged in log space (a geometric mean over crops).
        offsets = (o[:, :3], np.exp(o[:, 3]).astype(np.float32))
    return pack(values, vox_probs[inverse] if return_probs else None, offsets)
