"""In-place rigid transform of a built Potree octree.

WHY THIS EXISTS
---------------
Applying a transform to a session used to mean rebuilding its octree from
scratch: write every surviving point to a temp LAS, then run PotreeConverter
over the whole thing. Measured on this project's bundled converter, that is
~39 s for 5 M points — and the Transformation tool, cloud-to-cloud ICP and
Auto-Register all pay it, serially, once per cloud. For a medium-to-large
registration run, applying the alignment cost about as much as computing it.

But a rigid transform does not invalidate an octree. Rotation and translation
preserve every spatial relationship the hierarchy encodes: neighbourhood,
subdivision, LOD selection, point ordering. The index is already correct — only
the coordinate frame its numbers are expressed in has moved.

For a PURE TRANSLATION we can therefore rewrite the coordinates and keep the
whole structure. Measured on the same 5 M-point cloud: 0.79 s instead of
39.16 s, a ~50x speedup, with every non-position attribute byte preserved
exactly.

WHY ROTATION IS NOT HANDLED HERE
--------------------------------
Node membership in Potree is "which octant of the recursively-halved root cube
does this point fall in". The root bounding box is a CUBE, and translation moves
the cube with the cloud, so every point keeps its octant. A rotation spins the
cloud INSIDE an axis-aligned cube, so membership changes immediately and
massively — measured on a synthetic cloud, the share of points landing in a
different depth-4 node was 3 % at 0.5 degrees, 28 % at 5 degrees, 88 % at 30
degrees, 100 % at 90 degrees. The rotated cloud does not even fit the original
cube (tight diagonal 35.7 vs side 25.7, needing ~1.39x growth).

Rewriting positions under rotation would leave points filed under nodes whose
bounds no longer contain them, silently corrupting frustum culling, LOD
selection and every per-tile CPU predicate (see the renderer's
`octreeCropMask.ts`, which tests points against composed tile bounds). Handling
rotation properly means re-bucketing points into nodes and regenerating
`hierarchy.bin` — i.e. reimplementing the converter's core indexing — so it is
deliberately out of scope. `classify_matrix` rejects rotation and the caller
falls back to a full rebuild.

FORMAT FACTS (verified empirically against this project's bundled
PotreeConverter 2.x, not taken from documentation)
------------------------------------------------------------------
* Positions decode GLOBALLY: ``world = int32 * scale + offset``, using the single
  top-level ``scale``/``offset`` in metadata.json. They are NOT node-relative.
* ``metadata.offset == boundingBox.min``, and the root bounding box is a cube.
* ``hierarchy.bin`` records are 22 bytes and carry NO coordinates — only a node
  type, a child mask, a point count and a byte range into octree.bin. So a
  translation needs no hierarchy edit at all; the file is copied verbatim.
* ``encoding`` is ``DEFAULT`` (uncompressed) for output this project produces;
  points are fixed-stride records with ``position`` first, at byte offset 0.
* A translated reconvert yields identical ``spacing`` and identical
  ``hierarchy.firstChunkSize`` — confirming the structure is genuinely invariant.

Compressed (``BROTLI``) encodings are refused rather than mishandled: their point
layout differs and the position bytes are not addressable this way.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Optional, Sequence, Tuple

import numpy as np

# Byte offset of the `position` attribute within a point record, and its size.
# PotreeConverter always writes position first; `_position_layout` verifies this
# against the file's own attribute list rather than trusting it.
_POSITION_NAME = "position"

# Rows processed per chunk when rewriting octree.bin. A 28 M-point cloud at 35
# bytes/point is ~1 GB, and this runs on a backend that already holds the full
# session in RAM, so the rewrite is streamed rather than loaded whole. 4 M rows
# is ~140 MB per chunk at that stride.
_CHUNK_ROWS = 4_000_000

# A matrix counts as a pure translation when its rotation block is the identity
# to within this tolerance. Registration matrices arrive as float64 products of
# several transforms, so an exact comparison would reject a genuine translation
# carrying float noise; 1e-9 is far below any rotation a user could intend
# (1e-9 rad over a 1 km extent is ~1 micron of displacement) while absorbing
# accumulated round-off.
_IDENTITY_TOL = 1e-9


class OctreeTransformError(RuntimeError):
    """Raised when an octree cannot be transformed in place.

    Always a signal to fall back to a full rebuild, never a user-facing failure:
    the caller catches this and calls the converter path instead.
    """


def _scrub_json(text: str) -> str:
    """Make PotreeConverter's metadata.json parseable by the stdlib.

    The converter emits bare `inf` / `-inf` / `nan` literals on uninitialised
    min/max fields, which strict JSON rejects. Mirrors the same scrubbing
    `main._read_octree_metadata` does; kept here so this module has no import
    dependency on main.py (it must be unit-testable without a live server).
    """
    text = re.sub(r'(?<![\w.])-?inf(?![\w.])', 'null', text)
    text = re.sub(r'(?<![\w.])nan(?![\w.])', 'null', text)
    return text


def read_metadata(octree_dir: Path) -> dict:
    """Parse an octree's metadata.json, tolerating the converter's inf/nan."""
    p = Path(octree_dir) / "metadata.json"
    if not p.is_file():
        raise OctreeTransformError(f"metadata.json missing from {octree_dir}")
    try:
        return json.loads(_scrub_json(p.read_text()))
    except (OSError, json.JSONDecodeError) as e:
        raise OctreeTransformError(f"unreadable metadata.json in {octree_dir}: {e}") from e


def classify_matrix(matrix: Sequence[float]) -> Tuple[bool, np.ndarray]:
    """Split a row-major 4x4 into (is_pure_translation, translation_vector).

    `matrix` is the same layout the transform endpoint and ICP responses use:
    16 floats, ROW-MAJOR, acting on WORLD coordinates.

    Returns the translation regardless, so a caller that has already decided to
    take the fast path does not re-derive it. When the rotation block is not the
    identity the flag is False and the caller must rebuild — see the module
    docstring for why rotation cannot reuse the node structure.
    """
    m = np.asarray(matrix, dtype=np.float64)
    if m.size != 16:
        raise OctreeTransformError(
            f"matrix must be 16 floats (row-major 4x4); got {m.size}")
    m = m.reshape(4, 4)
    rotation = m[:3, :3]
    translation = m[:3, 3].copy()

    # The bottom row must be [0,0,0,1]; anything else is a projective or scaled
    # transform, which is not rigid and is not something this path can express.
    if not np.allclose(m[3, :], np.array([0.0, 0.0, 0.0, 1.0]), atol=_IDENTITY_TOL, rtol=0.0):
        return False, translation

    is_identity = bool(np.max(np.abs(rotation - np.eye(3))) <= _IDENTITY_TOL)
    return is_identity, translation


def _position_layout(meta: dict) -> Tuple[int, int, int]:
    """Return (byte_offset_of_position, stride_bytes, n_attributes_counted).

    Derived from the file's OWN attribute list rather than assuming position
    sits at offset 0 — if a future converter build reorders attributes, this
    finds the real offset instead of silently rewriting the wrong bytes.

    PotreeConverter writes a duplicate `position` entry (a morton-encoded
    placeholder that never gets updated); only the FIRST occurrence is a real
    record field, matching how `main._read_octree_metadata` dedupes. Every
    attribute still contributes its size to the stride exactly once.
    """
    attrs = meta.get("attributes")
    if not isinstance(attrs, list) or not attrs:
        raise OctreeTransformError("metadata.json has no attribute list")

    pos_offset: Optional[int] = None
    stride = 0
    seen: set = set()
    counted = 0
    for a in attrs:
        name = a.get("name")
        if not name or name in seen:
            continue
        seen.add(name)
        size = int(a.get("size", 0))
        if size <= 0:
            raise OctreeTransformError(f"attribute {name!r} has non-positive size {size}")
        if name == _POSITION_NAME and pos_offset is None:
            if int(a.get("numElements", 0)) != 3 or a.get("type") != "int32":
                raise OctreeTransformError(
                    "position attribute is not 3 x int32 "
                    f"(numElements={a.get('numElements')}, type={a.get('type')!r})")
            if size != 12:
                raise OctreeTransformError(f"position attribute size is {size}, expected 12")
            pos_offset = stride
        stride += size
        counted += 1

    if pos_offset is None:
        raise OctreeTransformError("metadata.json declares no `position` attribute")
    return pos_offset, stride, counted


def _require_uncompressed(meta: dict) -> None:
    """Refuse an encoding whose point records are not fixed-stride raw bytes."""
    encoding = str(meta.get("encoding", "DEFAULT")).upper()
    if encoding not in ("", "DEFAULT", "UNCOMPRESSED"):
        raise OctreeTransformError(
            f"octree encoding {encoding!r} is not addressable in place; "
            "only DEFAULT/UNCOMPRESSED can be rewritten")


def _shift_xyz(value, delta: np.ndarray):
    """Add `delta` to a 3-element JSON list, preserving None entries.

    Uninitialised min/max fields arrive as None (the scrubbed `inf`), and a
    translated None is still None — shifting it would invent a bound the
    converter never computed.
    """
    if not isinstance(value, list) or len(value) != 3:
        return value
    out = []
    for i, v in enumerate(value):
        out.append(None if v is None else float(v) + float(delta[i]))
    return out


def _translate_metadata(meta: dict, delta: np.ndarray, new_offset: np.ndarray) -> dict:
    """Return a copy of `meta` describing the same octree, translated by `delta`.

    `scale`, `spacing` and `hierarchy` are deliberately untouched: a translated
    reconvert produces byte-identical values for all three, which is the
    empirical evidence that the structure is invariant.

    `offset` is set explicitly rather than shifted, because the rewrite re-bases
    the int32 coordinates against a freshly chosen origin (keeping them small and
    centred, exactly as the converter does) — so the new offset is an input to
    this function, not a derivation from the old one.
    """
    out = json.loads(json.dumps(meta))  # deep copy; meta is plain JSON data

    out["offset"] = [float(v) for v in new_offset]

    bbox = out.get("boundingBox")
    if isinstance(bbox, dict):
        bbox["min"] = _shift_xyz(bbox.get("min"), delta)
        bbox["max"] = _shift_xyz(bbox.get("max"), delta)

    # The position attribute's min/max are the TIGHT data bounds the renderer
    # uses for camera framing and crop-box initialisation. They move with the
    # points; leaving them behind would frame the camera on empty space.
    for a in out.get("attributes", []):
        if a.get("name") == _POSITION_NAME:
            a["min"] = _shift_xyz(a.get("min"), delta)
            a["max"] = _shift_xyz(a.get("max"), delta)

    return out


def _decoded_bounds(src_bin: Path, pos_offset: int, stride: int,
                    scale: np.ndarray, offset: np.ndarray) -> Optional[Tuple[np.ndarray, np.ndarray]]:
    """Min/max of the decoded world positions, streamed. None for an empty file.

    Needed because the new int32 origin must be chosen from the ACTUAL point
    extent. Deriving it from `boundingBox` instead would work for a clean
    converter output but not for an octree this function has already rewritten
    once, where the padded cube and the data no longer share a corner.
    """
    size = src_bin.stat().st_size
    if size == 0:
        return None
    if size % stride != 0:
        raise OctreeTransformError(
            f"octree.bin size {size} is not a multiple of the {stride}-byte point stride")

    lo = np.full(3, np.inf, dtype=np.float64)
    hi = np.full(3, -np.inf, dtype=np.float64)
    with open(src_bin, "rb") as f:
        while True:
            raw = f.read(_CHUNK_ROWS * stride)
            if not raw:
                break
            rows = np.frombuffer(raw, dtype=np.uint8).reshape(-1, stride)
            ints = rows[:, pos_offset:pos_offset + 12].copy().view(np.int32).reshape(-1, 3)
            world = ints * scale + offset
            lo = np.minimum(lo, world.min(axis=0))
            hi = np.maximum(hi, world.max(axis=0))
    return lo, hi


def translate_octree_dir(src_dir: Path, dst_dir: Path, delta: Sequence[float]) -> dict:
    """Write a translated copy of the octree at `src_dir` into `dst_dir`.

    `dst_dir` must not already exist; it is created here. Returns the new
    metadata dict (as written).

    Only `octree.bin` and `metadata.json` change. `hierarchy.bin` and every
    sidecar (e.g. the slug->label map) are copied verbatim, because a
    translation changes neither the node graph nor any attribute semantics.
    """
    src_dir = Path(src_dir)
    dst_dir = Path(dst_dir)
    delta = np.asarray(delta, dtype=np.float64).reshape(3)

    meta = read_metadata(src_dir)
    _require_uncompressed(meta)
    pos_offset, stride, _ = _position_layout(meta)

    scale = np.asarray(meta.get("scale", [1.0, 1.0, 1.0]), dtype=np.float64).reshape(3)
    offset = np.asarray(meta.get("offset", [0.0, 0.0, 0.0]), dtype=np.float64).reshape(3)
    if not np.all(scale > 0):
        raise OctreeTransformError(f"metadata scale must be positive; got {scale.tolist()}")

    src_bin = src_dir / "octree.bin"
    if not src_bin.is_file():
        raise OctreeTransformError(f"octree.bin missing from {src_dir}")

    bounds = _decoded_bounds(src_bin, pos_offset, stride, scale, offset)

    # Choose the new int32 origin the way the converter does: the floor of the
    # translated data minimum, snapped to the scale grid. Re-basing (rather than
    # just adding delta to the old offset) keeps the stored ints small, which is
    # what stops a far-from-origin cloud — a UTM scan, say — from drifting toward
    # the int32 limit after repeated transforms.
    if bounds is None:
        new_offset = offset + delta
    else:
        lo, _hi = bounds
        new_offset = np.floor((lo + delta) / scale) * scale

    dst_dir.mkdir(parents=True, exist_ok=False)

    # Copy everything except the two files we rewrite. hierarchy.bin carries no
    # coordinates (22-byte records: type, child mask, point count, byte range),
    # so it is valid unchanged.
    for child in src_dir.iterdir():
        if child.name in ("octree.bin", "metadata.json"):
            continue
        if child.is_dir():
            shutil.copytree(child, dst_dir / child.name)
        else:
            shutil.copy2(child, dst_dir / child.name)

    # Stream the position rewrite. Non-position bytes are carried through
    # untouched by copying whole rows and overwriting only the position field.
    dst_bin = dst_dir / "octree.bin"
    with open(src_bin, "rb") as fin, open(dst_bin, "wb") as fout:
        while True:
            raw = fin.read(_CHUNK_ROWS * stride)
            if not raw:
                break
            rows = np.frombuffer(raw, dtype=np.uint8).reshape(-1, stride).copy()
            ints = rows[:, pos_offset:pos_offset + 12].copy().view(np.int32).reshape(-1, 3)
            world = ints * scale + offset + delta
            new_ints = np.rint((world - new_offset) / scale).astype(np.int32)
            rows[:, pos_offset:pos_offset + 12] = new_ints.view(np.uint8).reshape(-1, 12)
            fout.write(rows.tobytes())

    new_meta = _translate_metadata(meta, delta, new_offset)
    (dst_dir / "metadata.json").write_text(json.dumps(new_meta, indent="\t"))
    return new_meta
