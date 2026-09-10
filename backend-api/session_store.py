"""On-disk, memory-mapped columnar store for one cloud session.

A `CloudSession` holds every point of an imported cloud as numpy arrays - the
source of truth for every edit, compute and export after import. Held purely
in RAM that puts a hard ceiling on cloud size (a 100 M-point session is
6-9 GB resident) and makes eviction a whole-session pickle round trip. This
module is the out-of-core alternative: every column is its own `.npy` file
under one directory, opened with `numpy.memmap`, so

  * whole-array code keeps working unchanged (`positions[keep]`,
    `deleted |= mask` - a memmap IS an ndarray);
  * resident memory is the OS page cache - pages the session does not touch
    are evictable, and nothing has to be pickled to free them;
  * chunked code (`iter_ranges`) gets zero-copy slices, which is what the
    tiled / streaming tools of the large-cloud plan consume;
  * a column can be replaced atomically (write `.tmp`, `os.replace`), so a
    crash mid-write leaves the previous column, never a torn one.

This is deliberately NOT a data-interchange format (that is LAS/LAZ on export).
It is a private cache format for THIS build, keyed by `STORE_VERSION`; a
directory from another version is refused, not migrated. Compression is
deferred on purpose: uncompressed pages are what makes the memmap zero-copy.

Layout of a store directory:

    meta.json                 {"version", "n", "columns": {name: {...}}, "attrs": {...}}
    columns/<name>.npy        one array per column, first axis == n

Column names are restricted to `[A-Za-z0-9_.-]` so a slug from a file can
never escape the directory. Attributes (`attrs`) are small JSON-serialisable
values - world shift, provenance, edit generation - never per-point data.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Dict, Iterator, Optional, Tuple

import numpy as np

STORE_VERSION = 1
META_FILE = "meta.json"
COLUMN_DIR = "columns"
_NAME_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,120}$")
DEFAULT_CHUNK_ROWS = 2_000_000


class StoreError(RuntimeError):
    pass


def _check_name(name: str) -> str:
    if not _NAME_RE.match(name) or name in (".", ".."):
        raise StoreError(f"invalid column name {name!r}")
    return name


def _replace_with_retry(src: Path, dst: Path, timeout_s: float = 5.0) -> None:
    """`os.replace`, tolerating a transient Windows handle on either path
    (Defender / the Search indexer open freshly written files to scan them)."""
    deadline = time.time() + timeout_s
    delay = 0.05
    while True:
        try:
            os.replace(src, dst)
            return
        except OSError:
            if time.time() >= deadline:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.5)


def iter_ranges(n: int, rows: int = DEFAULT_CHUNK_ROWS) -> Iterator[Tuple[int, int]]:
    """Contiguous `[a, b)` ranges covering `0..n` in steps of `rows`."""
    rows = max(1, int(rows))
    a = 0
    n = int(n)
    while a < n:
        b = min(n, a + rows)
        yield a, b
        a = b


class SessionStore:
    """One session's columns on disk, memory-mapped on demand.

    Thread-safety: column maps are created under a lock and then shared; the
    arrays themselves carry the same concurrency contract as the in-RAM
    session (the caller's `_cloud_session_lock`). A store is bound to one
    process; two processes mapping the same directory `r+` is undefined.
    """

    def __init__(self, root: Path, meta: dict, *, writable: bool):
        self.root = Path(root)
        self._meta = meta
        self._writable = writable
        self._maps: Dict[str, np.memmap] = {}
        self._lock = threading.Lock()

    # ---- lifecycle -----------------------------------------------------------

    @classmethod
    def create(cls, root: Path, n: int, *, attrs: Optional[dict] = None) -> "SessionStore":
        """Make an empty store for `n` points. Columns are added afterwards
        (`add_column` / `allocate_column`)."""
        root = Path(root)
        if root.exists():
            raise StoreError(f"store directory already exists: {root}")
        (root / COLUMN_DIR).mkdir(parents=True)
        meta = {"version": STORE_VERSION, "n": int(n), "columns": {},
                "attrs": dict(attrs or {}), "generation": 0}
        store = cls(root, meta, writable=True)
        store._write_meta()
        return store

    @classmethod
    def open(cls, root: Path, *, writable: bool = True) -> "SessionStore":
        root = Path(root)
        meta_path = root / META_FILE
        try:
            meta = json.loads(meta_path.read_text())
        except (OSError, ValueError) as e:
            raise StoreError(f"unreadable store at {root}: {e}") from e
        if meta.get("version") != STORE_VERSION:
            raise StoreError(f"store version {meta.get('version')!r} != {STORE_VERSION}")
        for name, spec in meta.get("columns", {}).items():
            if not (root / COLUMN_DIR / f"{name}.npy").is_file():
                raise StoreError(f"store at {root} is missing column {name!r}")
        return cls(root, meta, writable=writable)

    def close(self) -> None:
        with self._lock:
            for m in self._maps.values():
                try:
                    if self._writable:
                        m.flush()
                except Exception:
                    pass
            self._maps.clear()

    def delete(self) -> None:
        self.close()
        shutil.rmtree(self.root, ignore_errors=True)

    def flush(self) -> None:
        with self._lock:
            for m in self._maps.values():
                m.flush()
        self._write_meta()

    # ---- metadata -------------------------------------------------------------

    @property
    def n(self) -> int:
        return int(self._meta["n"])

    @property
    def generation(self) -> int:
        return int(self._meta.get("generation", 0))

    def bump_generation(self) -> int:
        self._meta["generation"] = self.generation + 1
        self._write_meta()
        return self.generation

    @property
    def attrs(self) -> dict:
        return self._meta.setdefault("attrs", {})

    def set_attr(self, key: str, value) -> None:
        self.attrs[key] = value
        self._write_meta()

    def columns(self) -> Dict[str, dict]:
        return dict(self._meta["columns"])

    def has_column(self, name: str) -> bool:
        return name in self._meta["columns"]

    def _write_meta(self) -> None:
        if not self._writable:
            return
        path = self.root / META_FILE
        tmp = self.root / (META_FILE + ".tmp")
        tmp.write_text(json.dumps(self._meta, indent=1, sort_keys=True))
        _replace_with_retry(tmp, path)

    def _column_path(self, name: str) -> Path:
        return self.root / COLUMN_DIR / f"{_check_name(name)}.npy"

    # ---- columns --------------------------------------------------------------

    def column(self, name: str) -> np.memmap:
        """The memory-mapped array for `name` (cached per store)."""
        with self._lock:
            m = self._maps.get(name)
            if m is not None:
                return m
            if name not in self._meta["columns"]:
                raise KeyError(name)
            mode = "r+" if self._writable else "r"
            m = np.load(self._column_path(name), mmap_mode=mode)
            self._maps[name] = m
            return m

    def allocate_column(self, name: str, dtype, shape1: Optional[Tuple[int, ...]] = None) -> np.memmap:
        """Create an all-zero column of shape (n, *shape1) and return its map,
        for callers that fill it in chunks (import)."""
        self._require_writable()
        _check_name(name)
        if name in self._meta["columns"]:
            raise StoreError(f"column {name!r} already exists")
        shape = (self.n,) + tuple(int(s) for s in (shape1 or ()))
        path = self._column_path(name)
        tmp = path.with_suffix(".npy.tmp")
        m = np.lib.format.open_memmap(str(tmp), mode="w+", dtype=np.dtype(dtype), shape=shape)
        m.flush()
        del m
        _replace_with_retry(tmp, path)
        self._register(name, np.dtype(dtype), shape)
        return self.column(name)

    def add_column(self, name: str, array: np.ndarray) -> np.memmap:
        """Write `array` as a new column (first axis must be n)."""
        self._require_writable()
        if name in self._meta["columns"]:
            raise StoreError(f"column {name!r} already exists")
        self._write_array(name, array)
        return self.column(name)

    def replace_column(self, name: str, array: np.ndarray) -> np.memmap:
        """Atomically replace a column's contents (and dtype/shape if they
        changed). The previous file stays intact until the new one is complete."""
        self._require_writable()
        with self._lock:
            self._maps.pop(name, None)
        self._write_array(name, array)
        return self.column(name)

    def drop_column(self, name: str) -> None:
        self._require_writable()
        with self._lock:
            self._maps.pop(name, None)
        self._meta["columns"].pop(name, None)
        self._write_meta()
        try:
            self._column_path(name).unlink()
        except FileNotFoundError:
            pass

    def _write_array(self, name: str, array: np.ndarray) -> None:
        array = np.asarray(array)
        if array.ndim < 1 or array.shape[0] != self.n:
            raise StoreError(
                f"column {name!r} has first axis {array.shape[:1]} but the store holds {self.n} points")
        path = self._column_path(name)
        tmp = path.with_suffix(".npy.tmp")
        with open(tmp, "wb") as fh:
            np.lib.format.write_array(fh, np.ascontiguousarray(array), allow_pickle=False)
        _replace_with_retry(tmp, path)
        self._register(name, array.dtype, array.shape)

    def _register(self, name: str, dtype: np.dtype, shape: Tuple[int, ...]) -> None:
        self._meta["columns"][name] = {"dtype": np.dtype(dtype).str, "shape": [int(s) for s in shape]}
        self._write_meta()

    def _require_writable(self) -> None:
        if not self._writable:
            raise StoreError(f"store at {self.root} was opened read-only")

    # ---- chunk access ----------------------------------------------------------

    def iter_chunks(self, names, rows: int = DEFAULT_CHUNK_ROWS) -> Iterator[Tuple[int, int, Dict[str, np.ndarray]]]:
        """Yield `(a, b, {name: view})` for contiguous row ranges - zero-copy
        views into the maps, valid until the next chunk."""
        cols = {name: self.column(name) for name in names}
        for a, b in iter_ranges(self.n, rows):
            yield a, b, {name: m[a:b] for name, m in cols.items()}

    # ---- identity ---------------------------------------------------------------

    def is_own(self, name: str, arr) -> bool:
        """Whether `arr` is the very map this store handed out for `name`."""
        with self._lock:
            return self._maps.get(name) is arr

    def column_name_of(self, arr) -> Optional[str]:
        """The column whose map `arr` is, or None."""
        with self._lock:
            for name, m in self._maps.items():
                if m is arr:
                    return name
        return None

    # ---- accounting -----------------------------------------------------------

    def bytes_on_disk(self) -> int:
        total = 0
        for name in self._meta["columns"]:
            try:
                total += self._column_path(name).stat().st_size
            except OSError:
                pass
        return total

    def bytes_resident_estimate(self) -> int:
        """Upper bound on what the maps could occupy if fully paged in."""
        total = 0
        for spec in self._meta["columns"].values():
            total += int(np.prod(spec["shape"])) * np.dtype(spec["dtype"]).itemsize
        return total
