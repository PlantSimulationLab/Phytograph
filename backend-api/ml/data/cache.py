"""The training cache: each labelled cloud as a directory of memory-mappable
arrays, bucketed by spatial cell so a crop reads only the cells it needs.

The corpus is ~25 GB, mostly ASCII, and one Helios scene is 1.4 GB of text.
Parsing that per crop is out of the question, and so is holding it all in RAM
across a dozen loader workers. The cache is written once (``research/ml/
preprocess.py``, as a Slurm job) and read through ``np.load(mmap_mode="r")``,
so every worker shares the page cache.

One item directory holds:

- ``xyz.npy``: (N, 3) float32, relative to ``meta.origin`` (float64). Points
  are grid-sampled at ``meta.voxel`` (5 mm by default, finer than any model's
  base voxel, so training still has a choice of representative per voxel) and
  sorted by cell.
- ``sem.npy``: (N,) uint8 unified semantic codes (``readers.SEM``).
- ``organ.npy`` and ``reflectance.npy``, when the source has them.
- ``cells.npy`` / ``starts.npy``: the sorted occupied cell keys and each
  cell's first row (``starts`` has one extra entry, N).
- ``meta.json``: provenance, split, point counts per class, the cell size.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from ..grid import grid_sample
from .readers import Cloud, SEM

CACHE_VOXEL = 0.005
CELL = 0.5


def _cell_coords(xyz: np.ndarray, cell: float) -> np.ndarray:
    return np.floor(xyz / cell).astype(np.int64)


def _pack(q: np.ndarray) -> np.ndarray:
    # Cells are relative to the item's origin, shifted positive by 2^20, so
    # 21 bits per axis cover +-524 km at 0.5 m.
    q = q + (1 << 20)
    return (q[..., 0] << 42) | (q[..., 1] << 21) | q[..., 2]


def write_item(cloud: Cloud, out_dir: str | Path, meta: dict,
               voxel: float = CACHE_VOXEL, cell: float = CELL, seed: int = 0) -> dict:
    """Grid-sample, recentre, bucket and write one cloud. Returns its meta."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    finite = np.isfinite(cloud.xyz).all(axis=1)
    xyz = cloud.xyz[finite]
    # Keep a random point per voxel, not the first: the first is whatever the
    # source's scan order put there, which correlates with scan position.
    keep, _ = grid_sample(xyz, voxel, rng=np.random.default_rng(seed))
    xyz = xyz[keep]
    sel = np.flatnonzero(finite)[keep]
    lo, hi = xyz.min(axis=0), xyz.max(axis=0)
    # Horizontal centre and the lowest point, so z is height above the item's
    # base (useful for inspection; the network only sees crop-relative xyz).
    origin = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])
    rel = xyz - origin
    keys = _pack(_cell_coords(rel, cell))
    order = np.argsort(keys, kind="stable")
    keys = keys[order]
    cells, starts = np.unique(keys, return_index=True)
    starts = np.append(starts, len(keys)).astype(np.int64)

    np.save(out / "xyz.npy", rel[order].astype(np.float32))
    sem = cloud.sem[sel][order]
    np.save(out / "sem.npy", sem)
    if cloud.organ is not None:
        np.save(out / "organ.npy", cloud.organ[sel][order])
    if cloud.reflectance is not None:
        np.save(out / "reflectance.npy", cloud.reflectance[sel][order].astype(np.float32))
    np.save(out / "cells.npy", cells)
    np.save(out / "starts.npy", starts)

    counts = {name: int((sem == code).sum()) for name, code in SEM.items()}
    full = dict(meta)
    full.update({
        "n_points": int(len(rel)), "n_source_points": int(len(cloud)),
        "voxel": voxel, "cell": cell, "origin": origin.tolist(),
        "extent": (hi - lo).tolist(), "counts": counts,
        "has_organ": cloud.organ is not None,
        "has_reflectance": cloud.reflectance is not None,
        "source_meta": cloud.meta,
    })
    (out / "meta.json").write_text(json.dumps(full, indent=2) + "\n")
    return full


class CachedItem:
    """Read side of one item. Arrays are memory-mapped on first use."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.meta = json.loads((self.path / "meta.json").read_text())
        self.cell = float(self.meta["cell"])
        self._arrays: dict = {}
        self._class_rows: dict = {}

    def __getstate__(self):
        # Sent to every DataLoader worker. Pickling an np.memmap copies its
        # whole contents, so drop the maps and let each worker reopen them.
        state = dict(self.__dict__)
        state["_arrays"] = {}
        state["_class_rows"] = {}
        return state

    def _arr(self, name: str):
        if name not in self._arrays:
            f = self.path / f"{name}.npy"
            self._arrays[name] = np.load(f, mmap_mode="r") if f.exists() else None
        return self._arrays[name]

    @property
    def xyz(self):
        return self._arr("xyz")

    @property
    def sem(self):
        return self._arr("sem")

    @property
    def organ(self):
        return self._arr("organ")

    @property
    def reflectance(self):
        return self._arr("reflectance")

    def __len__(self):
        return int(self.meta["n_points"])

    def rows_of(self, codes: tuple[int, ...]) -> np.ndarray:
        """Row indices whose semantic code is in ``codes`` (cached)."""
        if codes not in self._class_rows:
            self._class_rows[codes] = np.flatnonzero(np.isin(np.asarray(self.sem), codes))
        return self._class_rows[codes]

    def ball(self, centre: np.ndarray, radius: float) -> np.ndarray:
        """Rows within ``radius`` of ``centre``, read cell by cell."""
        cells, starts = self._arr("cells"), self._arr("starts")
        lo = _cell_coords(np.asarray(centre) - radius, self.cell)
        hi = _cell_coords(np.asarray(centre) + radius, self.cell)
        grid = np.stack(np.meshgrid(*[np.arange(a, b + 1) for a, b in zip(lo, hi)],
                                    indexing="ij"), axis=-1).reshape(-1, 3)
        want = _pack(grid)
        pos = np.searchsorted(cells, want)
        pos = np.clip(pos, 0, len(cells) - 1)
        hit = cells[pos] == want
        ranges = [(starts[j], starts[j + 1]) for j in pos[hit]]
        if not ranges:
            return np.empty(0, np.int64)
        rows = np.concatenate([np.arange(a, b) for a, b in ranges])
        d2 = ((np.asarray(self.xyz[rows], dtype=np.float32) - centre) ** 2).sum(axis=1)
        return rows[d2 <= radius * radius]


def open_cache(root: str | Path) -> dict[str, CachedItem]:
    """Every item under ``root``, keyed ``<dataset>/<name>``."""
    root = Path(root)
    items = {}
    for meta in sorted(root.glob("*/*/meta.json")):
        it = CachedItem(meta.parent)
        items[f"{it.meta['dataset']}/{it.meta['name']}"] = it
    return items
