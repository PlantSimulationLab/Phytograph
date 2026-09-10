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


class TilePlan:
    """Points binned into an XY grid of `tile_m` cells, plus the tile list.

    `order` sorts points by cell; `cell_start[c]:cell_start[c+1]` is cell c's
    range in that order. Tiles are cells; a tile's buffered chunk is the
    union of its 3x3 neighbourhood's ranges filtered to the buffered box.
    """

    def __init__(self, xy: np.ndarray, tile_m: float, buffer_m: float):
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
            self.order = np.argsort(cell, kind="stable")
            counts = np.bincount(cell, minlength=self.nx * self.ny)
        else:
            self.order = np.zeros(0, dtype=np.int64)
            counts = np.zeros(self.nx * self.ny, dtype=np.int64)
        self.cell_start = np.concatenate([[0], np.cumsum(counts)]).astype(np.int64)
        self._xy = xy

    @classmethod
    def build(cls, xy: np.ndarray, *, tile_m: Optional[float] = None, buffer_m: float = 0.0,
              target_points: int = DEFAULT_TARGET_POINTS) -> "TilePlan":
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
        return cls(xy, tile_m, buffer_m)

    # ---- geometry ----------------------------------------------------------------

    def cell_range(self, ix: int, iy: int) -> Tuple[int, int]:
        c = ix * self.ny + iy
        return int(self.cell_start[c]), int(self.cell_start[c + 1])

    def tiles(self) -> List[Tile]:
        out = []
        for ix in range(self.nx):
            for iy in range(self.ny):
                a, b = self.cell_range(ix, iy)
                if b == a:
                    continue          # an empty core has nothing to label
                cmin = self.origin + np.array([ix, iy]) * self.tile_m
                cmax = cmin + self.tile_m
                out.append(Tile(ix, iy, cmin, cmax, cmin - self.buffer_m, cmax + self.buffer_m))
        return out

    def gather(self, tile: Tile) -> Tuple[np.ndarray, np.ndarray]:
        """(indices, core_mask) for a tile's buffered chunk: indices into the
        original point order, and which of them lie in the tile's core."""
        parts = []
        for jx in range(max(0, tile.ix - 1), min(self.nx, tile.ix + 2)):
            for jy in range(max(0, tile.iy - 1), min(self.ny, tile.iy + 2)):
                a, b = self.cell_range(jx, jy)
                if b > a:
                    parts.append(self.order[a:b])
        idx = np.concatenate(parts) if parts else np.zeros(0, dtype=np.int64)
        xy = self._xy[idx, :2]
        if self.buffer_m > 0:
            inside = np.all((xy >= tile.buf_min) & (xy < tile.buf_max), axis=1)
            idx = idx[inside]
            xy = xy[inside]
        core = np.all((xy >= tile.core_min) & (xy < tile.core_max), axis=1)
        # The core cell's own points are exactly its range, so every core point
        # is present; points on the upper boundary of the LAST cell were clipped
        # into it by the binning, so accept them as core there too.
        if tile.ix == self.nx - 1 or tile.iy == self.ny - 1:
            own_a, own_b = self.cell_range(tile.ix, tile.iy)
            own = np.isin(idx, self.order[own_a:own_b], assume_unique=False)
            core |= own
        return idx, core

    def describe(self) -> dict:
        tiles = self.tiles()
        sizes = [self.cell_range(t.ix, t.iy)[1] - self.cell_range(t.ix, t.iy)[0] for t in tiles]
        return {
            "n": self.n, "tile_m": self.tile_m, "buffer_m": self.buffer_m,
            "grid": [self.nx, self.ny], "tiles": len(tiles),
            "points_per_tile_max": int(max(sizes)) if sizes else 0,
            "points_per_tile_mean": float(np.mean(sizes)) if sizes else 0.0,
        }


def run_tiled(plan: TilePlan, points: np.ndarray,
              fn: Callable[[np.ndarray, np.ndarray], np.ndarray], *,
              out_dtype=np.int32, fill=0,
              progress: Optional[Callable[[float, str], None]] = None,
              should_cancel: Optional[Callable[[], bool]] = None,
              extra_columns: Optional[Sequence[np.ndarray]] = None) -> np.ndarray:
    """Run `fn(chunk_points, core_mask, *chunk_extra_columns)` on every tile
    and scatter the core results into an (N,) array of `out_dtype`.

    `fn` gets the buffered chunk (a copy, contiguous) and must return one value
    per chunk row; only rows where `core_mask` is True are kept. Raises
    `TiledCancelled` when `should_cancel()` turns true between tiles.
    """
    n = plan.n
    out = np.full(n, fill, dtype=out_dtype)
    tiles = plan.tiles()
    total = len(tiles)
    for k, tile in enumerate(tiles):
        if should_cancel is not None and should_cancel():
            raise TiledCancelled()
        idx, core = plan.gather(tile)
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
    for tile in plan.tiles():
        idx, core = plan.gather(tile)
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
    chunk = np.ascontiguousarray(points[file_idx])
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
                       out_dtype=np.int32, fill=0,
                       progress: Optional[Callable[[float, str], None]] = None,
                       should_cancel: Optional[Callable[[], bool]] = None) -> np.ndarray:
    """`run_tiled` over a spawn pool of `workers` processes. `job` is
    ("module", "function") resolving to `fn(chunk, core, **job_kwargs)`;
    `points_path` is an `.npy` holding the plan's points (or a superset of
    them, with `file_rows` mapping plan row -> file row)."""
    out = np.full(plan.n, fill, dtype=out_dtype)
    tiles = plan.tiles()
    total = len(tiles)
    if total == 0:
        return out
    module, name = job
    kwargs = dict(job_kwargs or {})
    tasks = []
    for tile in tiles:
        idx, core = plan.gather(tile)
        if idx.size:
            file_idx = idx if file_rows is None else file_rows[idx]
            tasks.append((points_path, file_idx, idx[core], core, module, name, kwargs))
    ctx = _mp.get_context("spawn")
    done = 0
    with ctx.Pool(processes=max(1, int(workers))) as pool:
        for idx_core, res_core in pool.imap_unordered(_tile_task, tasks):
            out[idx_core] = res_core
            done += 1
            if should_cancel is not None and should_cancel():
                pool.terminate()
                raise TiledCancelled()
            if progress is not None:
                progress(done / total, f"Tile {done} of {total}")
    return out
