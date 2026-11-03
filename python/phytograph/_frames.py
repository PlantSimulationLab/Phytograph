"""Decoders for the backend's streaming wire format.

Long-running endpoints answer `application/octet-stream`:

* optional 4-byte whitespace keepalives,
* any number of `PHP1` progress markers, each ``b"PHP1" + <u32 len> + JSON``.
  The first carries ``{"run_id": ...}`` (the handle for ``/api/cancel``); a
  terminal one carries ``"canceled": true`` or ``"error": "..."``, because the
  200 status line is already on the wire by the time the worker fails,
* then the payload: a ``PHB1`` binary frame, or a plain JSON document.

This module is the ONE Python decoder for that format. The backend's own tests
import it (``backend-api/tests/binframe.py``) so the client and the tests can
never drift apart. Mirrors the renderer's ``decodeBinaryFrame``
(``src/renderer/utils/backendApi.ts``).
"""
from __future__ import annotations

import json
import struct
from typing import Any, Dict, Iterator, List, Optional, Tuple

import numpy as np

PROGRESS_MAGIC = b"PHP1"
FRAME_MAGIC = b"PHB1"
_WS = (0x20, 0x09, 0x0A, 0x0D)
_DTYPES = {"f32": np.float32, "u32": np.uint32}


class StreamParser:
    """Incremental parser: ``feed()`` bytes as they arrive, get back the PHP1
    markers completed so far; once the stream ends, ``payload()`` is whatever
    followed the last marker (a PHB1 frame or JSON bytes)."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self._pos = 0
        self._in_markers = True

    def feed(self, chunk: bytes) -> List[Dict[str, Any]]:
        self._buf += chunk
        out: List[Dict[str, Any]] = []
        while self._in_markers:
            i = self._pos
            while i < len(self._buf) and self._buf[i] in _WS:
                i += 1
            if len(self._buf) - i < 4:
                self._pos = i
                break
            if self._buf[i:i + 4] != PROGRESS_MAGIC:
                self._pos = i
                self._in_markers = False
                break
            if len(self._buf) - i < 8:
                self._pos = i
                break
            n = struct.unpack_from("<I", self._buf, i + 4)[0]
            if len(self._buf) - i < 8 + n:
                self._pos = i
                break
            raw = bytes(self._buf[i + 8:i + 8 + n])
            try:
                out.append(json.loads(raw.decode("utf-8")))
            except (ValueError, UnicodeDecodeError) as e:
                # A corrupt marker means the stream itself is broken; skipping it
                # could skip the terminal error/cancel marker and decode garbage.
                raise ValueError(f"malformed PHP1 progress marker: {raw[:80]!r}") from e
            self._pos = i + 8 + n
        return out

    def payload(self) -> bytes:
        return bytes(self._buf[self._pos:])


def iter_markers(content: bytes) -> Iterator[Dict[str, Any]]:
    """Every PHP1 marker at the head of a complete body."""
    p = StreamParser()
    yield from p.feed(content)


def split_stream(content: bytes) -> Tuple[List[Dict[str, Any]], bytes]:
    """(markers, payload) for a complete body."""
    p = StreamParser()
    markers = p.feed(content)
    return markers, p.payload()


def decode_frame(payload: bytes) -> Tuple[Dict[str, Any], Dict[str, np.ndarray]]:
    """Decode one PHB1 frame into ``(meta, {name: array})``. Leading whitespace
    and PHP1 markers are skipped, so a whole streamed body is accepted too."""
    _, payload = split_stream(payload)
    i = 0
    while i < len(payload) and payload[i] in _WS:
        i += 1
    if payload[i:i + 4] != FRAME_MAGIC:
        raise ValueError("not a PHB1 frame")
    header_len = struct.unpack_from("<I", payload, i + 4)[0]
    header = json.loads(payload[i + 8:i + 8 + header_len].decode("utf-8"))
    off = i + 8 + header_len
    buffers: Dict[str, np.ndarray] = {}
    for d in header["buffers"]:
        dtype = _DTYPES[d["dtype"]]
        n = int(d["length"])
        buffers[d["name"]] = np.frombuffer(payload, dtype=dtype, count=n, offset=off).copy()
        off += n * 4
    return header["meta"], buffers


def is_frame(payload: bytes) -> bool:
    return payload.lstrip(b" \t\r\n")[:4] == FRAME_MAGIC


def terminal_marker(markers: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The in-band failure/cancel marker, if the stream ended with one."""
    for m in reversed(markers):
        if isinstance(m, dict) and (m.get("error") or m.get("canceled")):
            return m
    return None
