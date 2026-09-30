"""The `.phyto` project file: one self-contained ZIP of a whole scene.

Specification: docs/docs/developers/architecture/project-file.md. Keep the
two in step; `FORMAT_VERSION` moves whenever a reader of the previous version
could not read what this writes.

Everything a project holds is JSON or a numeric array - a `.pz` block-
compressed column (see `write_array`), or a `.npy` in a version-1 file - and
no array is ever unpickled: a project is a file people send each other, and
unpickling one would run whatever it carries. Member names are validated
before use.

This module knows the container and the session SCHEMA; it never touches a
live session registry or lock. `main.py` snapshots a CloudSession into a
`dict` of fields for `write_session`, and builds a CloudSession from what
`read_session` returns.
"""
from __future__ import annotations

import io
import json
import os
import re
import struct
import time
import zipfile
import zlib
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Dict, Iterator, List, Optional, Tuple

import numpy as np

FORMAT = "phytograph-project"
# 2: session columns are `.pz` (write_array), and an octree a saved session
#    can rebuild exactly is left out (`manifest["regenerate"]`). Version-1
#    files (`.npy` columns, every octree embedded) still open.
FORMAT_VERSION = 2
MANIFEST = "manifest.json"
SCENE = "scene.json"

_NAME_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,120}$")
_HEX_RE = re.compile(r"^[0-9a-f]{8,64}$")
_CHUNK = 16 << 20

# Point-aligned session arrays saved as columns (plus every extras column).
SESSION_ARRAYS = ("positions", "colors", "intensity", "deleted", "deleted_base",
                  "timestamps", "beam_origins")
# JSON-able scalar session fields.
SESSION_SCALARS = (
    "source_path", "ascii_format", "column_plan", "extra_dims_meta", "crs_epsg",
    "source_units", "source_unit_scale", "gps_time_encoding", "octree_cache_id",
    "rendered_octree_cache_id", "miss_octree_cache_id", "miss_octree_origin",
    "octree_pose", "octree_point_count", "octree_stale_gen", "normals_stale",
    "derived_fields", "backfilled_misses_stale", "backfilled_misses_moved",
    "unrestorable_hit_count",
)
LABEL_DELTA_ARRAYS = ("idx", "prev", "starts", "lengths", "prev_float")


class ProjectError(ValueError):
    """A project that cannot be read (wrong format, newer version, damaged)."""


def check_name(name: str) -> str:
    if not isinstance(name, str) or not _NAME_RE.match(name) or name in (".", ".."):
        raise ProjectError(f"invalid name in project: {name!r}")
    return name


def check_cache_id(cid: str) -> str:
    if not isinstance(cid, str) or not _HEX_RE.match(cid):
        raise ProjectError(f"invalid octree id in project: {cid!r}")
    return cid


# ==================== arrays ====================

def write_npy(zf: zipfile.ZipFile, member: str, arr: np.ndarray) -> None:
    """Write `arr` as an uncompressed `.npy` member, streamed: numpy writes a
    non-file object in bounded buffers, so a memory-mapped column is read
    page by page rather than copied whole."""
    arr = np.asarray(arr)
    if arr.dtype.hasobject:
        raise ProjectError(f"refusing to write object array {member}")
    zi = zipfile.ZipInfo(member, date_time=time.localtime()[:6])
    zi.compress_type = zipfile.ZIP_STORED
    with zf.open(zi, "w", force_zip64=True) as f:
        np.lib.format.write_array(f, np.ascontiguousarray(arr) if not arr.flags.c_contiguous else arr,
                                  allow_pickle=False)


# ==================== compressed columns (.pz) ====================
#
# A LiDAR session is ~50 bytes/point of columns, and all but `positions`
# compress well IF the right transform runs first - which one depends on the
# column, so it is picked per column from a sample rather than assumed:
#   none           - small-integer columns (intensity, flags) deflate best raw;
#   shuffle        - byte planes of a float (exponent bytes vs mantissa noise);
#   delta+shuffle  - monotone columns (GPS time: 0.56 raw -> 0.27).
# Measured on a 21 M-point RIEGL scan: ~48 -> ~27 bytes/point, lossless.
# Float64 positions are the floor (~0.76 at best): their low mantissa bytes
# are measurement noise.
#
# Blocks are independent, so both directions run on a thread pool (zlib and
# numpy release the GIL) and stream: a column is never whole in RAM twice,
# which matters for a memory-mapped 100 M-point store. The ZIP member itself
# is STORED; the compression is inside it, where it can run in parallel.
#
# Member layout: MAGIC, u32 header length, JSON header {dtype, shape, filter,
# block_rows}, then per block a u32 compressed length and a raw-deflate body.

PZ_EXT = ".pz"
_PZ_MAGIC = b"PHYZ\x01\n"
_PZ_BLOCK_BYTES = 8 << 20
_PZ_SAMPLE_ROWS = 1 << 17
_PZ_LEVEL = 1
_PZ_FILTERS = ("none", "shuffle", "delta_shuffle")
_PZ_KINDS = "biuf"   # bool, signed, unsigned, float: nothing else is written
_PZ_WORKERS = max(1, min(8, (os.cpu_count() or 2)))
_INT_OF_SIZE = {1: np.int8, 2: np.int16, 4: np.int32, 8: np.int64}


def _pz_forward(block: np.ndarray, filt: str) -> bytes:
    """Apply `filt` to one C-contiguous block of rows and return its bytes."""
    if filt == "delta_shuffle":
        # Differences of the integer VIEW, so floats round-trip bit-exactly
        # (NaN payloads included) and overflow wraps identically both ways.
        v = block.view(_INT_OF_SIZE[block.dtype.itemsize])
        block = np.diff(v, axis=0, prepend=np.zeros((1,) + v.shape[1:], v.dtype))
    if filt in ("shuffle", "delta_shuffle") and block.dtype.itemsize > 1:
        return block.view(np.uint8).reshape(-1, block.dtype.itemsize).T.tobytes()
    return block.tobytes()


def _pz_inverse(raw: bytes, filt: str, dtype: np.dtype, shape: tuple) -> np.ndarray:
    size = dtype.itemsize
    if filt in ("shuffle", "delta_shuffle") and size > 1:
        u8 = np.frombuffer(raw, np.uint8).reshape(size, -1).T
        arr = np.ascontiguousarray(u8).view(dtype).reshape(shape)
    else:
        arr = np.frombuffer(raw, dtype).reshape(shape)
    if filt == "delta_shuffle":
        arr = np.cumsum(arr.view(_INT_OF_SIZE[size]), axis=0,
                        dtype=_INT_OF_SIZE[size]).view(dtype)
    return arr


def _pz_compress(data: bytes) -> bytes:
    c = zlib.compressobj(_PZ_LEVEL, zlib.DEFLATED, -15)
    return c.compress(data) + c.flush()


def _pz_pick_filter(arr: np.ndarray) -> str:
    sample = np.ascontiguousarray(arr[:_PZ_SAMPLE_ROWS])
    if sample.size == 0:
        return "none"
    candidates = ["none"]
    if sample.dtype.itemsize > 1:
        candidates.append("shuffle")
    if sample.dtype.kind != "b" and len(sample) > 1:
        candidates.append("delta_shuffle")
    return min(candidates, key=lambda f: len(_pz_compress(_pz_forward(sample, f))))


def write_array(zf: zipfile.ZipFile, stem: str, arr: np.ndarray,
                check: Optional[Callable[[], None]] = None) -> str:
    """Write `arr` as the compressed member `<stem>.pz` and return its name.
    Streams a memory-mapped column block by block; `check` (a cancel
    checkpoint) runs between blocks."""
    arr = np.asarray(arr)
    if arr.dtype.hasobject or arr.dtype.kind not in _PZ_KINDS:
        raise ProjectError(f"refusing to write {arr.dtype} array {stem}")
    if arr.ndim == 0:
        # Nothing to block; a 0-d `.npy` keeps its shape exactly.
        write_npy(zf, stem + ".npy", arr)
        return stem + ".npy"
    arr = arr.astype(arr.dtype.newbyteorder("<"), copy=False)
    row_bytes = max(1, arr.dtype.itemsize * int(np.prod(arr.shape[1:], dtype=np.int64)))
    rows = max(1, _PZ_BLOCK_BYTES // row_bytes)
    filt = _pz_pick_filter(arr)
    header = json.dumps({"dtype": arr.dtype.str, "shape": list(arr.shape),
                         "filter": filt, "block_rows": rows}).encode()
    member = stem + PZ_EXT
    zi = zipfile.ZipInfo(member, date_time=time.localtime()[:6])
    zi.compress_type = zipfile.ZIP_STORED

    def job(start: int) -> bytes:
        return _pz_compress(_pz_forward(np.ascontiguousarray(arr[start:start + rows]), filt))

    with zf.open(zi, "w", force_zip64=True) as f, ThreadPoolExecutor(_PZ_WORKERS) as ex:
        f.write(_PZ_MAGIC + struct.pack("<I", len(header)) + header)
        pending: deque = deque()

        def drain_one():
            body = pending.popleft().result()
            f.write(struct.pack("<I", len(body)))
            f.write(body)

        for start in range(0, len(arr), rows):
            if check is not None:
                check()
            pending.append(ex.submit(job, start))
            if len(pending) >= 2 * _PZ_WORKERS:
                drain_one()
        while pending:
            drain_one()
    return member


def _read_exact(f, n: int, member: str) -> bytes:
    buf = f.read(n)
    if len(buf) != n:
        raise ProjectError(f"{member} is truncated")
    return buf


def _pz_read_header(f, member: str) -> dict:
    if _read_exact(f, len(_PZ_MAGIC), member) != _PZ_MAGIC:
        raise ProjectError(f"{member} is not a Phytograph column")
    (hlen,) = struct.unpack("<I", _read_exact(f, 4, member))
    if hlen > 4096:
        raise ProjectError(f"{member} has a malformed header")
    try:
        h = json.loads(_read_exact(f, hlen, member))
        dtype = np.dtype(str(h["dtype"]))
        shape = tuple(int(d) for d in h["shape"])
        filt, rows = str(h["filter"]), int(h["block_rows"])
    except (ValueError, KeyError, TypeError) as e:
        raise ProjectError(f"{member} has a malformed header: {e}")
    if (dtype.hasobject or dtype.kind not in _PZ_KINDS or filt not in _PZ_FILTERS
            or rows < 1 or not shape or any(d < 0 for d in shape)):
        raise ProjectError(f"{member} has an unsupported layout")
    return {"dtype": dtype, "shape": shape, "filter": filt, "rows": rows}


def _read_pz(zf: zipfile.ZipFile, member: str,
             allocate: Optional[Callable[[tuple, np.dtype], np.ndarray]] = None) -> np.ndarray:
    with zf.open(member) as f:
        h = _pz_read_header(f, member)
        dtype, shape, filt, rows = h["dtype"], h["shape"], h["filter"], h["rows"]
        out = allocate(shape, dtype) if allocate else np.empty(shape, dtype=dtype)
        if tuple(out.shape) != shape or out.dtype != dtype:
            raise ProjectError(f"{member}: destination does not match the stored array")
        tail = shape[1:]
        row_bytes = dtype.itemsize * int(np.prod(tail, dtype=np.int64))

        def job(start: int, body: bytes) -> None:
            n_rows = min(rows, shape[0] - start)
            expected = n_rows * row_bytes
            d = zlib.decompressobj(-15)
            try:
                raw = d.decompress(body, expected + 1) if expected else d.decompress(body)
            except zlib.error as e:
                raise ProjectError(f"{member} is damaged: {e}")
            if len(raw) != expected or d.unconsumed_tail:
                raise ProjectError(f"{member} is damaged")
            out[start:start + n_rows] = _pz_inverse(raw, filt, dtype, (n_rows,) + tail)

        with ThreadPoolExecutor(_PZ_WORKERS) as ex:
            pending: deque = deque()
            for start in range(0, shape[0], rows):
                (clen,) = struct.unpack("<I", _read_exact(f, 4, member))
                pending.append(ex.submit(job, start, _read_exact(f, clen, member)))
                if len(pending) >= 2 * _PZ_WORKERS:
                    pending.popleft().result()
            while pending:
                pending.popleft().result()
    return out


def read_array(zf: zipfile.ZipFile, stem: str,
               allocate: Optional[Callable[[tuple, np.dtype], np.ndarray]] = None) -> np.ndarray:
    """Read the array saved under `stem`: `<stem>.pz`, or `<stem>.npy` as a
    version-1 project wrote it."""
    names = zf.NameToInfo
    if stem + PZ_EXT in names:
        return _read_pz(zf, stem + PZ_EXT, allocate)
    return read_npy(zf, stem + ".npy", allocate)


def _npy_header(f) -> Tuple[tuple, bool, np.dtype]:
    version = np.lib.format.read_magic(f)
    if version == (1, 0):
        shape, fortran, dtype = np.lib.format.read_array_header_1_0(f)
    elif version in ((2, 0), (3, 0)):
        shape, fortran, dtype = np.lib.format.read_array_header_2_0(f)
    else:
        raise ProjectError(f"unsupported .npy version {version}")
    if dtype.hasobject:
        raise ProjectError("project holds an object array; refusing to load it")
    return shape, fortran, dtype


def npy_info(zf: zipfile.ZipFile, member: str) -> Tuple[tuple, np.dtype]:
    with zf.open(member) as f:
        shape, _fortran, dtype = _npy_header(f)
    return tuple(shape), dtype


def read_npy(zf: zipfile.ZipFile, member: str,
             allocate: Optional[Callable[[tuple, np.dtype], np.ndarray]] = None) -> np.ndarray:
    """Read a `.npy` member. With `allocate(shape, dtype)`, the destination
    (e.g. a memory-mapped store column) is filled in chunks, so a column
    never exists twice in RAM."""
    with zf.open(member) as f:
        shape, fortran, dtype = _npy_header(f)
        if fortran:
            # `write_npy` only ever writes C order; a Fortran-order member was
            # not written by Phytograph.
            raise ProjectError(f"{member} is Fortran-ordered; not a Phytograph array")
        out = allocate(tuple(shape), dtype) if allocate else np.empty(shape, dtype=dtype)
        if tuple(out.shape) != tuple(shape) or out.dtype != dtype or not out.flags.c_contiguous:
            raise ProjectError(f"{member}: destination does not match the stored array")
        flat = out.reshape(-1).view(np.uint8)
        view = memoryview(flat)
        off, total = 0, flat.size
        while off < total:
            n = f.readinto(view[off:off + _CHUNK])
            if not n:
                raise ProjectError(f"{member} is truncated")
            off += n
    return out


def write_json(zf: zipfile.ZipFile, member: str, obj) -> None:
    zf.writestr(zipfile.ZipInfo(member, date_time=time.localtime()[:6]),
                json.dumps(obj, allow_nan=True, default=_json_default),
                compress_type=zipfile.ZIP_DEFLATED)


def read_json(zf: zipfile.ZipFile, member: str):
    return json.loads(zf.read(member).decode("utf-8"))


def _json_default(o):
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, np.generic):
        return o.item()
    if hasattr(o, "model_dump"):
        return o.model_dump()
    raise TypeError(f"{type(o).__name__} is not JSON-serializable")


# ==================== sessions ====================

def write_session(zf: zipfile.ZipFile, key: str, fields: dict,
                  check: Optional[Callable[[], None]] = None) -> dict:
    """Write one session under `sessions/<key>/`. `fields` is a snapshot of
    the session: arrays (SESSION_ARRAYS), `extras` {slug: array} in order,
    `world_shift`, `deleted_history` [arrays], `label_history`
    {slug: [delta dicts]}, `backfilled_misses` {key: array} and the
    SESSION_SCALARS. Returns the manifest entry."""
    key = check_name(key)
    base = f"sessions/{key}"
    doc: dict = {"key": key, "n": int(len(fields["positions"])), "arrays": [], "extras": [],
                 "deleted_history": 0, "label_history": {}, "backfilled_misses": []}
    for name in SESSION_ARRAYS:
        arr = fields.get(name)
        if arr is None:
            continue
        if check is not None:
            check()
        write_array(zf, f"{base}/{name}", arr, check)
        doc["arrays"].append(name)
    for i, (slug, arr) in enumerate(fields.get("extras", {}).items()):
        if check is not None:
            check()
        write_array(zf, f"{base}/x{i}", arr, check)
        doc["extras"].append({"slug": slug, "member": f"x{i}"})
    ws = fields.get("world_shift")
    doc["world_shift"] = None if ws is None else [float(v) for v in np.asarray(ws).reshape(3)]
    for i, arr in enumerate(fields.get("deleted_history") or []):
        write_array(zf, f"{base}/history/del{i}", np.asarray(arr))
    doc["deleted_history"] = len(fields.get("deleted_history") or [])
    for slug, deltas in (fields.get("label_history") or {}).items():
        entries = []
        for j, d in enumerate(deltas):
            e = {"stroke_id": d["stroke_id"], "encoding": d["encoding"],
                 "changed_count": int(d.get("changed_count", 0)), "arrays": []}
            for a in LABEL_DELTA_ARRAYS:
                if d.get(a) is not None:
                    m = f"lab_{len(doc['label_history'])}_{j}_{a}"
                    write_array(zf, f"{base}/history/{m}", np.asarray(d[a]))
                    e["arrays"].append([a, m])
            entries.append(e)
        doc["label_history"][slug] = entries
    for k, arr in (fields.get("backfilled_misses") or {}).items():
        if arr is None:
            continue
        check_name(k)
        write_array(zf, f"{base}/misses/{k}", np.asarray(arr))
        doc["backfilled_misses"].append(k)
    doc["scalars"] = {k: fields.get(k) for k in SESSION_SCALARS}
    write_json(zf, f"{base}/session.json", doc)
    return {"key": key, "n": doc["n"]}


def read_session(zf: zipfile.ZipFile, key: str,
                 allocate: Optional[Callable[[str, tuple, np.dtype], np.ndarray]] = None) -> dict:
    """The fields of one saved session. Point-aligned columns go through
    `allocate(column_name, shape, dtype)` when given (a store), else RAM.
    Returns the same shape of dict `write_session` takes, plus `n`."""
    key = check_name(key)
    base = f"sessions/{key}"
    doc = read_json(zf, f"{base}/session.json")
    n = int(doc["n"])

    def col(member_name: str, store_name: str):
        alloc = (lambda shape, dtype: allocate(store_name, shape, dtype)) if allocate else None
        arr = read_array(zf, f"{base}/{check_name(member_name)}", alloc)
        if arr.shape[:1] != (n,):
            raise ProjectError(f"{base}/{member_name} has {arr.shape[:1]} rows, expected {n}")
        return arr

    fields: dict = {"n": n}
    for name in doc["arrays"]:
        if name not in SESSION_ARRAYS:
            raise ProjectError(f"unknown session array {name!r}")
        fields[name] = col(name, name)
    fields["extras"] = {}
    for e in doc["extras"]:
        fields["extras"][str(e["slug"])] = col(e["member"], e["member"])
    fields["world_shift"] = None if doc.get("world_shift") is None else np.asarray(doc["world_shift"], dtype=np.float64)
    fields["deleted_history"] = [read_array(zf, f"{base}/history/del{i}")
                                 for i in range(int(doc.get("deleted_history", 0)))]
    fields["label_history"] = {}
    for slug, entries in (doc.get("label_history") or {}).items():
        out = []
        for e in entries:
            d = {"stroke_id": str(e["stroke_id"]), "encoding": str(e["encoding"]),
                 "changed_count": int(e.get("changed_count", 0))}
            for a, m in e["arrays"]:
                if a not in LABEL_DELTA_ARRAYS:
                    raise ProjectError(f"unknown label-history array {a!r}")
                d[a] = read_array(zf, f"{base}/history/{check_name(m)}")
            out.append(d)
        fields["label_history"][str(slug)] = out
    misses = {k: read_array(zf, f"{base}/misses/{check_name(k)}") for k in doc.get("backfilled_misses") or []}
    fields["backfilled_misses"] = misses or None
    fields.update({k: doc.get("scalars", {}).get(k) for k in SESSION_SCALARS})
    return fields


# ==================== octrees ====================

def write_octree(zf: zipfile.ZipFile, cache_id: str, directory: Path) -> bool:
    """Copy one octree cache directory in (flat: an octree dir has no
    subdirectories). False when it is not on disk."""
    cache_id = check_cache_id(cache_id)
    d = Path(directory)
    if not (d / "metadata.json").is_file():
        return False
    for f in sorted(d.iterdir()):
        if f.is_file():
            zi = zipfile.ZipInfo(f"octrees/{cache_id}/{check_name(f.name)}", date_time=time.localtime()[:6])
            zi.compress_type = zipfile.ZIP_STORED
            with open(f, "rb") as src, zf.open(zi, "w", force_zip64=True) as dst:
                while True:
                    buf = src.read(_CHUNK)
                    if not buf:
                        break
                    dst.write(buf)
    return True


def extract_octree(zf: zipfile.ZipFile, cache_id: str, staging: Path) -> None:
    """Extract one octree's files into `staging` (created)."""
    cache_id = check_cache_id(cache_id)
    staging.mkdir(parents=True, exist_ok=False)
    prefix = f"octrees/{cache_id}/"
    for info in zf.infolist():
        if not info.filename.startswith(prefix):
            continue
        name = check_name(info.filename[len(prefix):])
        with zf.open(info) as src, open(staging / name, "wb") as dst:
            while True:
                buf = src.read(_CHUNK)
                if not buf:
                    break
                dst.write(buf)


# ==================== manifest ====================

def write_manifest(zf: zipfile.ZipFile, *, app_version: str, sessions: List[dict],
                   octrees: List[str], regenerate: Optional[List[str]] = None) -> None:
    """`octrees` are embedded; `regenerate` are octree ids the file left out
    because a saved session rebuilds them exactly on open."""
    write_json(zf, MANIFEST, {
        "format": FORMAT, "version": FORMAT_VERSION, "app_version": app_version,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "sessions": sessions, "octrees": octrees, "regenerate": list(regenerate or []),
    })


def read_manifest(zf: zipfile.ZipFile) -> dict:
    try:
        m = read_json(zf, MANIFEST)
    except KeyError:
        raise ProjectError("not a Phytograph project (no manifest)")
    if m.get("format") != FORMAT:
        raise ProjectError("not a Phytograph project")
    if int(m.get("version", 0)) > FORMAT_VERSION:
        raise ProjectError(
            f"this project was saved by a newer Phytograph ({m.get('app_version')}); "
            f"update Phytograph to open it")
    for s in m.get("sessions", []):
        check_name(s["key"])
    for c in m.get("octrees", []) + m.get("regenerate", []):
        check_cache_id(c)
    return m


def open_zip(path: str) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(path, "r")
    except (zipfile.BadZipFile, OSError) as e:
        raise ProjectError(f"cannot read project: {e}")
