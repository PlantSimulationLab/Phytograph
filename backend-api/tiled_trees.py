"""Tree segmentation over buffered XY tiles, stitched into one set of trees.

Method specification: docs/docs/concepts/stem-detection-and-tiling.md#tiled-
segmentation. The generic tile engine (`tiled.py`) keeps each tile's CORE
points; a tree crosses tile lines, so here "the core's result" means whole
trees:

  * anchor  - a tree's seed, or the x, y centroid of its lowest 1 m of points;
  * owner   - the one tile whose core contains the anchor keeps the tree;
  * claims  - a kept tree claims all its points; where two kept trees claim a
              point, the claim from the tile in which the point lay deepest
              inside the buffer (farthest from an INTERIOR buffer edge) wins;
  * ids     - kept trees are numbered 1..N, or carry their seed's number.

A kept tree touching an interior buffer edge may have been cut off there; the
count of such trees is reported so the caller can widen the buffer.

Runs inside the killable segmentation worker (seg_worker.py), which is where
the spawn pool is allowed to open. `main` is imported lazily: the pool
children import this module, and the segmentation itself lives in main.
"""
from __future__ import annotations

import math
import multiprocessing as _mp
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

import tiled

DEFAULT_BUFFER_M = 10.0
# Decimated voxels per BUFFERED tile the plan aims for. The whole-cloud
# guideline is 2 M; a tile well under it keeps the O(groups^2) merge cheap and
# lets several tiles run at once.
DEFAULT_TILE_NODES = 600_000
try:  # override for tests and tuning (the worker inherits the backend's env)
    import os as _os
    DEFAULT_TILE_NODES = int(_os.environ.get("PHYTOGRAPH_TREEISO_TILE_NODES", DEFAULT_TILE_NODES))
except ValueError:
    pass
TRUNCATION_MARGIN_M = 0.5
# A tree counts as possibly cut off when at least this many of its final
# points were seen only from within TRUNCATION_MARGIN_M of a buffer edge.
TRUNCATION_MIN_POINTS = 20
ANCHOR_BASE_M = 1.0


def resolve_params(points: np.ndarray, p) -> Tuple[object, Optional[float]]:
    """Set the voxel sizes ONCE for every tile, from the point spacing alone:
    3x the median spacing for stage 1 and twice that for stage 2, raised only
    from the paper defaults (as `_auto_treeiso_decimation` does), but without
    its whole-cloud node-count coarsening - each tile is bounded instead.
    Measured on a spatially compact sample (the centre of the plot), since
    spacing is a local property and a full-plot KD-tree is what tiling avoids.
    Returns (p, spacing or None)."""
    import main

    xy = points[:, :2]
    c = np.median(xy, axis=0)
    d = np.max(np.abs(xy - c), axis=1)
    k = min(len(points), 400_000)
    near = np.argpartition(d, k - 1)[:k] if k < len(points) else np.arange(len(points))
    probe = main._treeiso_spacing_probe(points[near])
    if probe is None:
        return p, None
    spacing = probe[0]
    if p.decimate_res1 <= 0.051 and 3.0 * spacing > p.decimate_res1:
        p.decimate_res1 = round(3.0 * spacing, 3)
    if p.decimate_res2 <= 0.101 and 2.0 * p.decimate_res1 > p.decimate_res2:
        p.decimate_res2 = round(2.0 * p.decimate_res1, 3)
    return p, spacing


def plan_tiles(points: np.ndarray, nodes_total: int, *, buffer_m: float,
               tile_nodes: int = DEFAULT_TILE_NODES) -> tiled.TilePlan:
    """Tiles sized so a BUFFERED tile holds about `tile_nodes` voxels at the
    plot's mean voxel density, never narrower than the buffer."""
    xy = points[:, :2]
    ext = np.nanmax(xy, axis=0) - np.floor(np.nanmin(xy, axis=0))
    area = max(float(ext[0]) * float(ext[1]), 1e-6)
    density = max(nodes_total, 1) / area
    buffered_side = math.sqrt(tile_nodes / density)
    tile_m = max(buffer_m, buffered_side - 2.0 * buffer_m, 1.0)
    tile_m = min(tile_m, max(float(ext[0]), float(ext[1]), buffer_m))
    return tiled.TilePlan(xy, tile_m, min(buffer_m, tile_m))


def _anchors(chunk: np.ndarray, labels: np.ndarray) -> Dict[int, np.ndarray]:
    """{local id: x, y centroid of its lowest ANCHOR_BASE_M of points}."""
    out: Dict[int, np.ndarray] = {}
    for k in np.unique(labels):
        if k <= 0:
            continue
        pts = chunk[labels == k]
        base = pts[pts[:, 2] <= pts[:, 2].min() + ANCHOR_BASE_M]
        out[int(k)] = base[:, :2].mean(axis=0)
    return out


def tile_job(chunk: np.ndarray, params: dict, seeds: Optional[np.ndarray],
             seed_ids: Optional[np.ndarray]) -> Tuple[np.ndarray, Dict[int, np.ndarray]]:
    """Segment one buffered tile. Returns (labels for every chunk point,
    {label: anchor x, y}). With seeds, labels are the seeds' GLOBAL ids and
    each anchor is its seed; without, labels are tile-local 1..k."""
    import main

    p = main._treeiso_params_from_dict(params)
    if seeds is not None and len(seeds):
        local = main.segment_trees(chunk, p, seeds)          # 1..len(seeds)
        labels = np.where(local > 0, np.asarray(seed_ids)[np.maximum(local - 1, 0)], 0)
        anchors = {int(g): np.asarray(s[:2], dtype=np.float64) for g, s in zip(seed_ids, seeds)}
        present = set(np.unique(labels).tolist())
        anchors = {g: a for g, a in anchors.items() if g in present}
        return labels.astype(np.int64), anchors
    labels = main.segment_trees(chunk, p, None)
    return labels.astype(np.int64), _anchors(chunk, labels)


def _pool_task(args):
    (points_path, file_idx, params, seeds, seed_ids, tile_no) = args
    points = np.load(points_path, mmap_mode="r")
    chunk = np.array(points[file_idx], dtype=np.float64, order="C")
    labels, anchors = tile_job(chunk, params, seeds, seed_ids)
    return tile_no, labels, anchors


def _interior_depth(xy: np.ndarray, tile: tiled.Tile, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    """Distance of each point to its tile's nearest INTERIOR buffer edge; a
    buffer side lying on the plot's own edge is not a cut-off and counts as
    infinitely far."""
    d = np.full(len(xy), np.inf)
    for axis in (0, 1):
        if tile.buf_min[axis] > lo[axis]:
            d = np.minimum(d, xy[:, axis] - tile.buf_min[axis])
        if tile.buf_max[axis] < hi[axis]:
            d = np.minimum(d, tile.buf_max[axis] - xy[:, axis])
    return d


def _owns(tile: tiled.Tile, plan: tiled.TilePlan, a: np.ndarray) -> bool:
    """Half-open core membership; the outermost tiles' cores extend without
    bound so every anchor has exactly one owner."""
    for axis, (i, n) in enumerate(((tile.ix, plan.nx), (tile.iy, plan.ny))):
        lo = -np.inf if i == 0 else tile.core_min[axis]
        hi = np.inf if i == n - 1 else tile.core_max[axis]
        if not (lo <= a[axis] < hi):
            return False
    return True


def segment_tiled(points: np.ndarray, params: dict, seeds: Optional[np.ndarray], *,
                  plan: tiled.TilePlan, workers: int = 1, points_path: Optional[str] = None,
                  progress: Optional[Callable[[float, str], None]] = None) -> Tuple[np.ndarray, dict]:
    """Tree ids for every point (0 = unassigned) and a meta dict."""
    n = len(points)
    tiles = plan.tiles()
    lo, hi = np.nanmin(points[:, :2], axis=0), np.nanmax(points[:, :2], axis=0)
    seeds = None if seeds is None or len(seeds) == 0 else np.asarray(seeds, dtype=np.float64)[:, :3]
    seed_ids = None if seeds is None else np.arange(1, len(seeds) + 1)

    tasks = []
    for t_no, tile in enumerate(tiles):
        idx, _core = plan.gather(tile)
        if idx.size == 0:
            continue
        s_loc = ids_loc = None
        if seeds is not None:
            inb = ((seeds[:, 0] >= tile.buf_min[0]) & (seeds[:, 0] < tile.buf_max[0])
                   & (seeds[:, 1] >= tile.buf_min[1]) & (seeds[:, 1] < tile.buf_max[1]))
            s_loc, ids_loc = seeds[inb], seed_ids[inb]
            if len(s_loc) == 0:
                continue            # no seed reaches this tile: nothing to keep
        tasks.append((t_no, idx, s_loc, ids_loc))

    out = np.zeros(n, dtype=np.int64)
    best = np.full(n, -np.inf)
    next_id = 1
    kept = truncated = 0
    done = 0

    def _merge(t_no: int, idx: np.ndarray, labels: np.ndarray, anchors: Dict[int, np.ndarray]):
        nonlocal next_id, kept, truncated, done
        tile = tiles[t_no]
        depth = _interior_depth(points[idx, :2], tile, lo, hi)
        for k, a in anchors.items():
            if not _owns(tile, plan, a):
                continue
            m = labels == k
            if not m.any():
                continue
            gid = k if seeds is not None else next_id
            if seeds is None:
                next_id += 1
            kept += 1
            rows, d = idx[m], depth[m]
            better = d > best[rows]
            out[rows[better]] = gid
            best[rows[better]] = d[better]
        done += 1
        if progress is not None:
            progress(done / max(1, len(tasks)), f"Tile {done} of {len(tasks)}")

    if workers > 1 and points_path is not None and len(tasks) > 1:
        ctx = _mp.get_context("spawn")
        jobs = [(points_path, idx, params, s, ids, t_no) for t_no, idx, s, ids in tasks]
        by_no = {t_no: idx for t_no, idx, _s, _i in tasks}
        with ctx.Pool(processes=int(workers)) as pool:
            for t_no, labels, anchors in pool.imap_unordered(_pool_task, jobs):
                _merge(t_no, by_no[t_no], labels, anchors)
    else:
        for t_no, idx, s, ids in tasks:
            labels, anchors = tile_job(np.ascontiguousarray(points[idx]), params, s, ids)
            _merge(t_no, idx, labels, anchors)

    # Truncation is judged on the OUTCOME, not on the claims: inside a tile the
    # segmenter routinely attaches neighbours' crown pieces, cut off at the
    # buffer, to the tree it keeps, and those points are then won by their own
    # tree's claim from deeper inside its tile. A tree is at risk only if
    # points it finally KEEPS were seen solely from near a buffer edge.
    at_edge = (out > 0) & (best < TRUNCATION_MARGIN_M)
    if at_edge.any():
        ids_e, counts_e = np.unique(out[at_edge], return_counts=True)
        truncated = int((counts_e >= TRUNCATION_MIN_POINTS).sum())
    if seeds is None and kept:
        # Renumber densely in spatial order, so ids do not depend on which tile
        # finished first in the pool.
        ids = np.unique(out[out > 0])
        cen = np.array([points[out == g, :2].mean(axis=0) for g in ids])
        order = np.lexsort((cen[:, 1], cen[:, 0]))
        remap = np.zeros(int(ids.max()) + 1, dtype=np.int64)
        remap[ids[order]] = np.arange(1, len(ids) + 1)
        out = remap[out]
    meta = {**plan.describe(), "tiles_run": len(tasks), "trees_kept": int(kept),
            "trees_truncated": int(truncated), "workers": int(workers)}
    return out, meta


def segment(points: np.ndarray, params: dict, seeds: Optional[np.ndarray], *,
            tiling: str = "auto", buffer_m: float = DEFAULT_BUFFER_M,
            tile_nodes: int = DEFAULT_TILE_NODES,
            points_path: Optional[str] = None,
            progress: Optional[Callable[[float, str], None]] = None) -> Tuple[np.ndarray, dict]:
    """Tree segmentation, tiled when `tiling` says so. 'off' is exactly the
    untiled path (`_auto_treeiso_decimation` + `segment_trees`); 'on' always
    tiles; 'auto' tiles when the plot's voxel count at the spacing-derived
    voxel size exceeds the untiled guideline."""
    import main
    import memory_budget

    if tiling not in ("auto", "on", "off"):
        raise ValueError(f"tiling must be 'auto', 'on' or 'off', got {tiling!r}")
    if not (buffer_m > 0):
        raise ValueError("tile buffer must be positive")
    ti_keys = set(main._TREEISO_PARAM_FIELDS)
    base = {k: v for k, v in params.items() if k in ti_keys}

    if tiling != "off":
        p = main._treeiso_params_from_dict(dict(base))
        p, _spacing = resolve_params(points, p)
        nodes = main._count_treeiso_nodes(points, p) or 0
        if tiling == "on" or nodes > main._TREEISO_MAX_NODES:
            resolved = dict(base, decimate_res1=p.decimate_res1, decimate_res2=p.decimate_res2)
            plan = plan_tiles(points, nodes, buffer_m=buffer_m, tile_nodes=tile_nodes)
            per_worker = int(tile_nodes * 2000)
            workers = tiled.worker_count(len(plan.tiles()), per_worker_bytes=per_worker,
                                         budget_bytes=memory_budget.budget_bytes())
            labels, meta = segment_tiled(points, resolved, seeds, plan=plan,
                                         workers=workers if points_path else 1,
                                         points_path=points_path, progress=progress)
            meta.update(tiled=True, nodes=int(nodes), buffer_m=float(buffer_m),
                        decimate_res1=p.decimate_res1, decimate_res2=p.decimate_res2)
            return labels, meta

    p = main._treeiso_params_from_dict(dict(base))
    main._auto_treeiso_decimation(points, p)
    return main.segment_trees(points, p, seeds), {"tiled": False}
