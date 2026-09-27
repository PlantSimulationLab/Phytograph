"""Buffered XY tiling for whole-cloud algorithms (the lidR / LAStools engine).

Some tools cannot stream point by point because every answer depends on a
neighbourhood: ground filtering (the cloth spans the terrain), radius
outlier removal, local PCA features, normals. Mature LiDAR software runs
them on TILES: cut the XY extent into chunks, load each chunk plus a COLLAR
(buffer) of neighbouring points so the algorithm sees a complete
neighbourhood at the chunk's edge, run it, keep only the chunk's own (core)
results, merge. lidR's `LAScatalog` engine, LAStools' `lastile -buffer` and
PDAL's `filters.splitter` all do exactly this; it bounds peak memory by one
buffered tile and makes the tiles independent, so they can run in parallel.

This module is that engine for an in-RAM (or memory-mapped) point array:

    plan   = TilePlan.build(xy, tile_m=..., buffer_m=...)   # bins points once
    labels = run_tiled(plan, points, fn, out_dtype=np.int32) # fn(chunk_pts, core_mask) -> per-chunk result

`fn` is the whole-cloud algorithm applied to one buffered chunk; it returns
one value per chunk point, and only the core points' values are written to
the output. A tool is a good fit when its answer at a point depends only on
points within `buffer_m` of it; the caller chooses the buffer from the
algorithm's own scale (a cloth resolution, a search radius) - a buffer that
is too small shows up as seams, which is what `tests/test_tiled.py` checks
against the untiled result.

Binning is one `argsort` of a per-point cell id (O(N log N), ~1 s per 10 M
points), after which every tile's core and collar are a few contiguous
ranges of the sorted order - no per-tile pass over all N points. The sorted
index is the only full-length allocation (int64, 8 B/pt).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Iterator, List, Optional, Sequence, Tuple

import numpy as np

# Points per tile the automatic tile size aims for. Chosen so one buffered
# tile of a dense TLS scan is tens of MB, not GB, and there are enough tiles
# for parallelism on clouds where tiling is worth it at all.
DEFAULT_TARGET_POINTS = 3_000_000
# Below this many points a cloud runs untiled: the collar overhead and the
# per-tile fixed costs exceed what tiling saves.
MIN_POINTS_TO_TILE = 4_000_000


def auto_tile_size(n_points: int, extent_xy: Tuple[float, float], *,
                   target_points: int = DEFAULT_TARGET_POINTS,
                   buffer_m: float = 0.0, min_tile_m: float = 1.0) -> float:
    """Tile edge (m) so an average tile holds about `target_points` points,
    never smaller than `min_tile_m` and never smaller than 4x the buffer (a
    collar wider than the core is all overhead)."""
    ex, ey = float(extent_xy[0]), float(extent_xy[1])
    area = max(ex, 1e-9) * max(ey, 1e-9)
    if n_points <= 0 or area <= 0:
        return max(ex, ey, min_tile_m)
    density = n_points / area
    tile = math.sqrt(max(1, target_points) / max(density, 1e-12))
    tile = max(tile, min_tile_m, 4.0 * float(buffer_m))
    return float(min(tile, max(ex, ey)))


@dataclass
class Tile:
    ix: int
    iy: int
    core_min: np.ndarray      # (2,)
    core_max: np.ndarray      # (2,) exclusive upper bound
    buf_min: np.ndarray       # (2,)
    buf_max: np.ndarray       # (2,)
    # (k, x0, y0, x1, y1) when this is the block [x0,x1) x [y0,y1) of a
    # k x k sub-grid of cell (ix, iy) - see TilePlan's `max_tile_points`.
    # None for a whole cell.
    sub: Optional[Tuple[int, int, int, int, int]] = None


class TilePlan:
    """Points binned into an XY grid of `tile_m` cells, plus the tile list.

    `order` sorts points by cell; `cell_start[c]:cell_start[c+1]` is cell c's
    range in that order. Tiles are cells; a tile's buffered chunk is the
    union of its 3x3 neighbourhood's ranges filtered to the buffered box.

    `max_tile_points` (opt-in) splits any cell holding more than that many
    points into sub-tiles: the cell is binned once on a fine k x k sub-grid
    and a quadtree merges sub-cells into blocks of at most that many points
    (or single sub-cells). A grid sized from the MEAN density
    is badly unbalanced on a terrestrial scan, whose density falls as 1/r^2:
    measured on a real 45.7 M-point TLS scan, one 11 m cell of the normals
    plan held 35.3 M points (77%), so one pool worker ran 14 GB and most of
    the wall time on a single core while the rest sat idle. A sub-tile edge
    never drops below `min_sub_tile_m` (default 2x the buffer), which keeps
    the collar inside a one-sub-cell ring and its overhead bounded.
    Callers whose logic depends on the uniform grid itself (tree
    segmentation's ownership rule) leave it off.
    """

    def __init__(self, xy: np.ndarray, tile_m: float, buffer_m: float, *,
                 max_tile_points: Optional[int] = None,
                 min_sub_tile_m: Optional[float] = None):
        xy = np.asarray(xy)
        if xy.ndim != 2 or xy.shape[1] < 2:
            raise ValueError("xy must be (N, >=2)")
        self.n = int(xy.shape[0])
        self.tile_m = float(tile_m)
        self.buffer_m = float(buffer_m)
        if not (self.tile_m > 0):
            raise ValueError("tile_m must be positive")
        if self.buffer_m < 0:
            raise ValueError("buffer_m must be >= 0")
        if self.buffer_m > self.tile_m:
            # The 3x3 neighbourhood gather assumes the collar fits in one
            # neighbouring cell; a wider collar needs a wider stencil.
            raise ValueError("buffer_m must not exceed tile_m")
        if self.n:
            self.origin = np.floor(np.nanmin(xy[:, :2], axis=0)).astype(np.float64)
            hi = np.nanmax(xy[:, :2], axis=0)
        else:
            self.origin = np.zeros(2)
            hi = np.zeros(2)
        # ceil of the span in tiles; a point sitting exactly on the far edge is
        # clipped into the last cell below (and `gather` treats it as core there).
        self.nx = max(1, int(math.ceil((hi[0] - self.origin[0]) / self.tile_m - 1e-9)))
        self.ny = max(1, int(math.ceil((hi[1] - self.origin[1]) / self.tile_m - 1e-9)))
        if self.n:
            cx = np.clip(((xy[:, 0] - self.origin[0]) / self.tile_m).astype(np.int64), 0, self.nx - 1)
            cy = np.clip(((xy[:, 1] - self.origin[1]) / self.tile_m).astype(np.int64), 0, self.ny - 1)
            cell = cx * self.ny + cy
            if self.nx * self.ny <= np.iinfo(np.uint16).max:
                cell = cell.astype(np.uint16)     # radix sort; see _MAX_SUB_GRID
            self.order = np.argsort(cell, kind="stable")
            counts = np.bincount(cell, minlength=self.nx * self.ny)
        else:
            self.order = np.zeros(0, dtype=np.int64)
            counts = np.zeros(self.nx * self.ny, dtype=np.int64)
        self.cell_start = np.concatenate([[0], np.cumsum(counts)]).astype(np.int64)
        # XY in CELL order, so a cell's points are one contiguous slice and a
        # gather never reads at random rows. That matters most for a split
        # cell's neighbours: each one's neighbourhood includes the dense cell,
        # and random-row gathers over it measured ~1.4 s per neighbour on a
        # real TLS scan. 16 B/pt, the same as an unsorted copy would cost.
        self._xys = (np.asarray(xy[:, :2], dtype=np.float64)[self.order] if self.n
                     else np.zeros((0, 2), dtype=np.float64))
        self.max_tile_points = int(max_tile_points) if max_tile_points else None
        self.min_sub_tile_m = (float(min_sub_tile_m) if min_sub_tile_m is not None
                               else 2.0 * self.buffer_m)
        self._tiles: Optional[List[Tile]] = None
        self._sub_index: dict = {}
        self._sub_count_cache: dict = {}

    @classmethod
    def build(cls, xy: np.ndarray, *, tile_m: Optional[float] = None, buffer_m: float = 0.0,
              target_points: int = DEFAULT_TARGET_POINTS,
              max_tile_points: Optional[int] = None) -> "TilePlan":
        xy = np.asarray(xy)
        if tile_m is None:
            if len(xy):
                # Span from the FLOORED origin the grid will actually use, so a
                # tile sized to the extent yields exactly one cell.
                ext = np.nanmax(xy[:, :2], axis=0) - np.floor(np.nanmin(xy[:, :2], axis=0))
            else:
                ext = np.zeros(2)
            tile_m = auto_tile_size(len(xy), (float(ext[0]), float(ext[1])),
                                    target_points=target_points, buffer_m=buffer_m)
        return cls(xy, tile_m, buffer_m, max_tile_points=max_tile_points)

    # ---- geometry ----------------------------------------------------------------

    def cell_range(self, ix: int, iy: int) -> Tuple[int, int]:
        c = ix * self.ny + iy
        return int(self.cell_start[c]), int(self.cell_start[c + 1])

    def tiles(self) -> List[Tile]:
        if self._tiles is not None:
            return self._tiles
        out = []
        for ix in range(self.nx):
            for iy in range(self.ny):
                a, b = self.cell_range(ix, iy)
                if b == a:
                    continue          # an empty core has nothing to label
                cmin = self.origin + np.array([ix, iy]) * self.tile_m
                cmax = cmin + self.tile_m
                k = self._split_factor(b - a)
                if k < 2:
                    out.append(Tile(ix, iy, cmin, cmax, cmin - self.buffer_m, cmax + self.buffer_m))
                    continue
                sub_m = self.tile_m / k
                for x0, y0, x1, y1 in self._quadtree(self._sub_counts(ix, iy, k)):
                    smin = cmin + np.array([x0, y0]) * sub_m
                    smax = cmin + np.array([x1, y1]) * sub_m
                    out.append(Tile(ix, iy, smin, smax, smin - self.buffer_m,
                                    smax + self.buffer_m, sub=(k, x0, y0, x1, y1)))
        self._tiles = out
        return out

    # Finest sub-grid a split cell is binned into. The quadtree below merges
    # its cells back into blocks, so this bounds only the index size.
    # 250 keeps (k + 2)^2 sub-cell ids inside uint16, which numpy's stable
    # argsort radix-sorts: measured 0.45 s vs 21.8 s for int64 keys over 36 M.
    _MAX_SUB_GRID = 250

    def _split_factor(self, count: int) -> int:
        """Sub-grid resolution k (k x k) for a cell holding `count` points, or
        1 for no split: as fine as the collar allows, since the quadtree only
        descends where the points are."""
        if not self.max_tile_points or count <= self.max_tile_points:
            return 1
        floor_m = max(self.min_sub_tile_m, self.buffer_m, 1e-9)
        k = min(int(self.tile_m // floor_m), self._MAX_SUB_GRID)
        return k if k >= 2 else 1

    def _quadtree(self, counts: np.ndarray) -> List[Tuple[int, int, int, int]]:
        """Non-empty blocks [x0,x1) x [y0,y1) of the sub-grid, halving any
        block over `max_tile_points` until it fits or is one sub-cell."""
        csum = np.zeros((counts.shape[0] + 1, counts.shape[1] + 1), dtype=np.int64)
        csum[1:, 1:] = counts.cumsum(0).cumsum(1)

        def total(x0, y0, x1, y1):
            return int(csum[x1, y1] - csum[x0, y1] - csum[x1, y0] + csum[x0, y0])

        out, stack = [], [(0, 0, counts.shape[0], counts.shape[1])]
        while stack:
            x0, y0, x1, y1 = stack.pop()
            c = total(x0, y0, x1, y1)
            if c == 0:
                continue
            if c <= self.max_tile_points or (x1 - x0 == 1 and y1 - y0 == 1):
                out.append((x0, y0, x1, y1))
                continue
            xm, ym = (x0 + x1 + 1) // 2 if x1 - x0 > 1 else x1, (y0 + y1 + 1) // 2 if y1 - y0 > 1 else y1
            for bx0, bx1 in ((x0, xm), (xm, x1)):
                for by0, by1 in ((y0, ym), (ym, y1)):
                    if bx1 > bx0 and by1 > by0:
                        stack.append((bx0, by0, bx1, by1))
        out.sort()
        return out

    def _neighbourhood(self, ix: int, iy: int, box=None):
        """(indices, xy, own) for cell (ix, iy)'s 3x3 neighbourhood, where
        `own` marks the cell's own points. With `box` = (lo, hi), neighbours'
        points are kept only inside it; the cell's own points always are."""
        parts = []
        for jx in range(max(0, ix - 1), min(self.nx, ix + 2)):
            for jy in range(max(0, iy - 1), min(self.ny, iy + 2)):
                a, b = self.cell_range(jx, jy)
                if b == a:
                    continue
                idx, xy = self.order[a:b], self._xys[a:b]
                is_own = jx == ix and jy == iy
                if box is not None and not is_own:
                    # A neighbour sharing this cell's column already lies in
                    # its x range (and likewise for rows), so only the axis it
                    # is offset along needs testing - a third of the work on
                    # the dense cell next to a split one.
                    m = None
                    for axis, off in ((0, jx != ix), (1, jy != iy)):
                        if off:
                            c = xy[:, axis]
                            t = (c >= box[0][axis]) & (c < box[1][axis])
                            m = t if m is None else (m & t)
                    idx, xy = idx[m], xy[m]
                parts.append((idx, xy, np.full(len(idx), is_own)))
        if not parts:
            return (np.zeros(0, dtype=np.int64), np.zeros((0, 2)), np.zeros(0, dtype=bool))
        return tuple(np.concatenate([p[i] for p in parts]) for i in range(3))

    def _own_sub_cells(self, ix: int, iy: int, k: int) -> np.ndarray:
        """(M, 2) sub-cell of each of cell (ix, iy)'s own points, in cell
        order, clipped into the core (see `_sub`)."""
        a, b = self.cell_range(ix, iy)
        cmin = self.origin + np.array([ix, iy]) * self.tile_m
        s = np.floor((self._xys[a:b] - cmin) / (self.tile_m / k)).astype(np.int64)
        return np.clip(s, 0, k - 1)

    def _sub_counts(self, ix: int, iy: int, k: int) -> np.ndarray:
        """k x k core point counts of a split cell, from its own points alone:
        planning needs only these, so the full neighbourhood index (`_sub`) is
        built later, one cell at a time, as its blocks are gathered."""
        key = (ix, iy, k)
        hit = self._sub_count_cache.get(key)
        if hit is None:
            s = self._own_sub_cells(ix, iy, k)
            hit = np.bincount(s[:, 0] * k + s[:, 1], minlength=k * k).reshape(k, k)
            self._sub_count_cache[key] = hit
        return hit

    def _sub(self, ix: int, iy: int, k: int) -> dict:
        """A split cell's sub-grid index, built once: its buffered
        neighbourhood sorted by k x k sub-cell, with a ring of one sub-cell
        around the core for the collar (the sub-cell edge is >= the buffer).
        A core point's sub-cell comes from ITS OWN cell's binning, clipped into
        the core, so the blocks partition the cell's points exactly, including
        points the parent grid clipped onto its far edge."""
        key = (ix, iy)
        hit = self._sub_index.get(key)
        if hit is not None:
            return hit
        sub_m = self.tile_m / k
        cmin = self.origin + np.array([ix, iy]) * self.tile_m
        idx, xy, own = self._neighbourhood(
            ix, iy, box=(cmin - self.buffer_m, cmin + self.tile_m + self.buffer_m))
        s = np.clip(np.floor((xy - cmin) / sub_m).astype(np.int64), -1, k)
        s[own] = np.clip(s[own], 0, k - 1)
        side = k + 2
        cell = ((s[:, 0] + 1) * side + (s[:, 1] + 1)).astype(np.uint16)
        order = np.argsort(cell, kind="stable")
        start = np.concatenate([[0], np.cumsum(np.bincount(cell, minlength=side * side))])
        s = s[order]
        hit = {"k": k, "side": side, "idx": idx[order], "xy": xy[order], "own": own[order],
               "sx": s[:, 0].astype(np.int32), "sy": s[:, 1].astype(np.int32),
               "start": start.astype(np.int64)}
        self._sub_index[key] = hit
        return hit

    def _gather_sub(self, tile: Tile) -> Tuple[np.ndarray, np.ndarray]:
        k, x0, y0, x1, y1 = tile.sub
        sub = self._sub(tile.ix, tile.iy, k)
        side, start = sub["side"], sub["start"]
        # Block plus a one-sub-cell ring; +1 converts to ring-offset indices.
        # A column's rows [y0-1, y1] are one contiguous range of the sort.
        spans = [(start[jx * side + y0], start[jx * side + y1 + 2]) for jx in range(x0, x1 + 2)]
        take = lambda arr: np.concatenate([arr[a:b] for a, b in spans])
        idx, xy, sx, sy = take(sub["idx"]), take(sub["xy"]), take(sub["sx"]), take(sub["sy"])
        core = take(sub["own"]) & (sx >= x0) & (sx < x1) & (sy >= y0) & (sy < y1)
        inside = core | np.all((xy >= tile.buf_min) & (xy < tile.buf_max), axis=1)
        return idx[inside], core[inside]

    def gather(self, tile: Tile) -> Tuple[np.ndarray, np.ndarray]:
        """(indices, core_mask) for a tile's buffered chunk: indices into the
        original point order, and which of them lie in the tile's core.

        The core is the cell's own binned points, exactly - which is what
        makes every point core of exactly one tile, including points the
        binning clipped onto the grid's far edge."""
        if tile.sub is not None:
            return self._gather_sub(tile)
        if self.buffer_m <= 0:
            a, b = self.cell_range(tile.ix, tile.iy)
            return self.order[a:b], np.ones(b - a, dtype=bool)
        idx, _xy, own = self._neighbourhood(tile.ix, tile.iy, box=(tile.buf_min, tile.buf_max))
        return idx, own

    def gathered(self) -> Iterator[Tuple[Tile, np.ndarray, np.ndarray]]:
        """Yield `(tile, indices, core_mask)` for every tile, lazily, dropping
        each split cell's sub-grid index once its last block is gathered (the
        index is the size of the cell's buffered neighbourhood, which for the
        cell around a TLS scanner is most of the cloud)."""
        prev = None
        for tile in self.tiles():
            key = (tile.ix, tile.iy)
            if prev is not None and key != prev:
                self._sub_index.pop(prev, None)
            prev = key
            idx, core = self.gather(tile)
            yield tile, idx, core
        if prev is not None:
            self._sub_index.pop(prev, None)

    def core_count(self, tile: Tile) -> int:
        if tile.sub is not None:
            k, x0, y0, x1, y1 = tile.sub
            return int(self._sub_counts(tile.ix, tile.iy, k)[x0:x1, y0:y1].sum())
        a, b = self.cell_range(tile.ix, tile.iy)
        return b - a

    def describe(self) -> dict:
        tiles = self.tiles()
        sizes = [self.core_count(t) for t in tiles]
        return {
            "n": self.n, "tile_m": self.tile_m, "buffer_m": self.buffer_m,
            "grid": [self.nx, self.ny], "tiles": len(tiles),
            "split_cells": len({(t.ix, t.iy) for t in tiles if t.sub is not None}),
            "points_per_tile_max": int(max(sizes)) if sizes else 0,
            "points_per_tile_mean": float(np.mean(sizes)) if sizes else 0.0,
        }


def run_tiled(plan: TilePlan, points: np.ndarray,
              fn: Callable[[np.ndarray, np.ndarray], np.ndarray], *,
              out_dtype=np.int32, fill=0, ncols: int = 1,
              progress: Optional[Callable[[float, str], None]] = None,
              should_cancel: Optional[Callable[[], bool]] = None,
              extra_columns: Optional[Sequence[np.ndarray]] = None) -> np.ndarray:
    """Run `fn(chunk_points, core_mask, *chunk_extra_columns)` on every tile
    and scatter the core results into an (N,) array of `out_dtype`.

    `fn` gets the buffered chunk (a copy, contiguous) and must return one value
    per chunk row; only rows where `core_mask` is True are kept. Raises
    `TiledCancelled` when `should_cancel()` turns true between tiles.

    `ncols > 1` makes the output (N, ncols) and `fn` must return one ROW per
    chunk point — for tools whose per-point answer is a vector rather than a
    scalar (normal estimation returns a direction plus its derived shape
    scalars). `ncols == 1` keeps the original (N,) shape exactly, so every
    existing caller is unaffected.
    """
    n = plan.n
    out = (np.full(n, fill, dtype=out_dtype) if ncols == 1
           else np.full((n, ncols), fill, dtype=out_dtype))
    total = len(plan.tiles())
    for k, (tile, idx, core) in enumerate(plan.gathered()):
        if should_cancel is not None and should_cancel():
            raise TiledCancelled()
        if idx.size == 0:
            continue
        chunk = np.ascontiguousarray(points[idx])
        extras = [np.ascontiguousarray(col[idx]) for col in (extra_columns or ())]
        res = np.asarray(fn(chunk, core, *extras))
        if res.shape[0] != idx.shape[0]:
            raise ValueError(f"tile function returned {res.shape[0]} values for {idx.shape[0]} points")
        out[idx[core]] = res[core]
        if progress is not None:
            progress((k + 1) / total, f"Tile {k + 1} of {total}")
    return out


class TiledCancelled(Exception):
    pass


def iter_tiles(plan: TilePlan, points: np.ndarray) -> Iterator[Tuple[Tile, np.ndarray, np.ndarray, np.ndarray]]:
    """Yield `(tile, indices, core_mask, chunk_points)` for callers that want
    to drive the tiles themselves (a process pool, a streaming writer)."""
    for tile, idx, core in plan.gathered():
        if idx.size:
            yield tile, idx, core, np.ascontiguousarray(points[idx])


# ---- parallel tiles ----------------------------------------------------------------
#
# Tiles are independent, so they can run on every core - but only in separate
# PROCESSES: the whole-cloud algorithms here (CSF, cKDTree queries) hold the
# GIL or serialise on it, and threads would not help. The pool is `spawn`,
# never fork: the caller may be the backend's killable worker, which has
# open3d (and in the backend itself libhelios) loaded, and a forked copy of
# either crashes in the post-fork window. Spawned children inherit the
# worker's process group, so a cancel that `killpg`s the worker reaps them.
#
# The points reach the children through a `.npy` FILE (`points_path`), which
# each child memory-maps and gathers its own tile from by index - the seg
# worker already has its input staged as exactly that file. Only the tile's
# core results travel back. A job is named by (module, function) so the task
# pickles are a few strings plus one index array per tile.
import multiprocessing as _mp
import os as _os


def worker_count(n_tiles: int, *, per_worker_bytes: int, budget_bytes: int,
                 baseline_bytes: int = 400 * 1024 ** 2) -> int:
    """How many pool processes to run: the env pin `PHYTOGRAPH_TILE_WORKERS`,
    else min(cores, tiles, what the memory budget allows). Each child costs
    `baseline_bytes` (a Python with numpy/scipy/CSF imported) plus one tile's
    working set. 1 disables the pool (tiles run in-process)."""
    raw = _os.environ.get("PHYTOGRAPH_TILE_WORKERS")
    if raw is not None:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    # Only a killable seg worker may open a pool. multiprocessing's POSIX
    # launcher forks before it execs, and the backend process has libhelios
    # (GLFW) and open3d loaded - a forked copy of that dies in the post-fork
    # window (the reason _SegProc uses posix_spawn), which leaves the pool
    # blocked on its start-up pipe. The worker never loads libhelios, so the
    # fork there is safe. Anywhere else (the DEM's in-process ground call, a
    # direct segment_ground in a test) the tiles run in-process.
    if not _os.environ.get("PHYTOGRAPH_SEG_WORKER"):
        return 1
    cpu = _os.cpu_count() or 1
    if n_tiles < 4 or cpu < 2:
        return 1
    fits = max(1, int(budget_bytes // max(1, per_worker_bytes + baseline_bytes)))
    return int(max(1, min(cpu, n_tiles, fits)))


def _resolve_job(module: str, name: str):
    import importlib
    obj = importlib.import_module(module)
    for part in name.split("."):
        obj = getattr(obj, part)
    return obj


def _tile_task(args):
    """Pool worker body: memmap the points file, gather the tile's rows, run
    the job, and return only the core rows' results with their output rows."""
    points_path, file_idx, out_idx, core, module, name, kwargs = args
    points = np.load(points_path, mmap_mode="r")
    # `np.array`, not `np.ascontiguousarray`: the latter can pass a memmap's
    # read-only buffer straight through, and open3d's Vector3dVector refuses a
    # non-writeable array ("array is not writeable"). A tile job that hands its
    # chunk to open3d would fail only in the POOL, never in the in-process path.
    chunk = np.array(points[file_idx], dtype=points.dtype, order="C")
    fn = _resolve_job(module, name)
    res = np.asarray(fn(chunk, core, **kwargs))
    if res.shape[0] != file_idx.shape[0]:
        raise ValueError(f"tile job returned {res.shape[0]} values for {file_idx.shape[0]} points")
    return out_idx, res[core]


class staged_points:
    """Context manager yielding `(path, file_rows)` for `run_tiled_parallel`.

    Inside the backend's killable worker the input is already on disk
    (`PHYTOGRAPH_TILE_POINTS_NPY`, set by seg_worker) and is reused; `file_rows`
    maps the plan's rows onto that file when the caller tiled a SUBSET of it
    (denoise drops non-finite rows first). Anywhere else the points are saved
    to a temporary `.npy` for the pool's lifetime.
    """

    def __init__(self, points: np.ndarray, *, file_rows: Optional[np.ndarray] = None):
        self._points = points
        self._file_rows = file_rows
        self._tmp = None

    def __enter__(self):
        path = _os.environ.get("PHYTOGRAPH_TILE_POINTS_NPY")
        if path and _os.path.isfile(path):
            try:
                n_file = np.load(path, mmap_mode="r").shape[0]
            except Exception:
                n_file = -1
            rows = self._file_rows
            if rows is None and n_file == self._points.shape[0]:
                return path, None
            if rows is not None and n_file > 0 and (rows.size == 0 or int(rows.max()) < n_file):
                return path, rows
        import tempfile
        self._tmp = tempfile.TemporaryDirectory(prefix="phyto_tiles_")
        tmp_path = _os.path.join(self._tmp.name, "points.npy")
        np.save(tmp_path, np.ascontiguousarray(self._points))
        return tmp_path, None

    def __exit__(self, *exc):
        if self._tmp is not None:
            self._tmp.cleanup()
        return False


def run_tiled_parallel(plan: TilePlan, points_path: str, job: Tuple[str, str], *,
                       workers: int, job_kwargs: Optional[dict] = None,
                       file_rows: Optional[np.ndarray] = None,
                       out_dtype=np.int32, fill=0, ncols: int = 1,
                       progress: Optional[Callable[[float, str], None]] = None,
                       should_cancel: Optional[Callable[[], bool]] = None) -> np.ndarray:
    """`run_tiled` over a spawn pool of `workers` processes. `job` is
    ("module", "function") resolving to `fn(chunk, core, **job_kwargs)`;
    `points_path` is an `.npy` holding the plan's points (or a superset of
    them, with `file_rows` mapping plan row -> file row).

    `ncols > 1` returns (N, ncols), matching `run_tiled`."""
    out = (np.full(plan.n, fill, dtype=out_dtype) if ncols == 1
           else np.full((plan.n, ncols), fill, dtype=out_dtype))
    tiles = plan.tiles()
    total = len(tiles)
    if total == 0:
        return out
    module, name = job
    kwargs = dict(job_kwargs or {})
    def tasks():
        # A generator, not a list: the pool's feeder thread pulls tasks only
        # as fast as the task pipe drains, so just the tiles in flight hold
        # their index arrays. A list held every tile's at once - ~3x the cloud
        # in int64 once collars are counted (~1.6 GB at 45.7 M points).
        for tile, idx, core in plan.gathered():
            if idx.size:
                file_idx = idx if file_rows is None else file_rows[idx]
                yield (points_path, file_idx, idx[core], core, module, name, kwargs)
    ctx = _mp.get_context("spawn")
    done = 0
    with ctx.Pool(processes=max(1, int(workers))) as pool:
        for idx_core, res_core in pool.imap_unordered(_tile_task, tasks()):
            out[idx_core] = res_core
            done += 1
            if should_cancel is not None and should_cancel():
                pool.terminate()
                raise TiledCancelled()
            if progress is not None:
                progress(done / total, f"Tile {done} of {total}")
    return out
