"""Decoder for the PHB1 binary-frame responses (see main._bin_frame_bytes),
for tests of endpoints that use the binary transport. Mirrors the renderer's
decodeBinaryFrame."""

import json
import struct

import numpy as np


def decode_bin_frame(content: bytes):
    """Decode a PHB1 frame body into (meta: dict, buffers: dict[str, np.ndarray]).

    Skips leading whitespace keepalives and PHP1 progress markers (see
    main._pack_progress_marker) that precede the frame on streaming endpoints."""
    i = 0
    while True:
        while i < len(content) and content[i] in (0x20, 0x09, 0x0A, 0x0D):
            i += 1
        if content[i:i + 4] != b"PHP1":
            break
        marker_len = struct.unpack_from("<I", content, i + 4)[0]
        i += 8 + marker_len
    assert content[i:i + 4] == b"PHB1", "not a PHB1 frame"
    header_len = struct.unpack_from("<I", content, i + 4)[0]
    header = json.loads(content[i + 8:i + 8 + header_len].decode("utf-8"))
    off = i + 8 + header_len
    buffers = {}
    for d in header["buffers"]:
        dtype = np.float32 if d["dtype"] == "f32" else np.uint32
        n = d["length"]
        buffers[d["name"]] = np.frombuffer(content, dtype=dtype, count=n, offset=off).copy()
        off += n * 4
    return header["meta"], buffers


def decode_progress_markers(content: bytes):
    """Return the list of PHP1 progress markers ({"progress","message"}) that
    precede the PHB1 frame in a streaming response body."""
    markers = []
    i = 0
    while True:
        while i < len(content) and content[i] in (0x20, 0x09, 0x0A, 0x0D):
            i += 1
        if content[i:i + 4] != b"PHP1":
            break
        marker_len = struct.unpack_from("<I", content, i + 4)[0]
        markers.append(json.loads(content[i + 8:i + 8 + marker_len].decode("utf-8")))
        i += 8 + marker_len
    return markers


async def decode_misses(response) -> dict:
    """Drain the /misses endpoint's StreamingResponse and decode its PHB1 frame
    into the flat dict the overlay consumes: {count, total, origin, radius,
    positions}. `positions` is a Python list (flat [x,y,z,...]), so an empty
    result compares `== []`. Tests call the endpoint coroutine directly, so they
    get a StreamingResponse rather than a TestClient body."""
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk if isinstance(chunk, bytes) else bytes(chunk))
    meta, buffers = decode_bin_frame(b"".join(chunks))
    pos = buffers.get("positions")
    return {
        "count": meta.get("count", 0),
        "total": meta.get("total", 0),
        "origin": meta.get("origin", [0.0, 0.0, 0.0]),
        "radius": meta.get("radius", 0.0),
        "positions": pos.tolist() if pos is not None else [],
    }


def decode_lidar_scan(content: bytes) -> dict:
    """Reconstruct the per-scanner LiDAR scan result (old dict shape) from a PHB1
    frame, so the scan tests can assert on points (N,3) / colors / scalars."""
    meta, buffers = decode_bin_frame(content)
    if not meta.get("success"):
        return {"success": False, "error": meta.get("error"), "results": []}
    results = []
    for i, s in enumerate(meta["scanners"]):
        n = s["num_points"]
        pts = buffers[f"s{i}.points"].reshape(-1, 3) if n else np.empty((0, 3), np.float32)
        cols = buffers.get(f"s{i}.colors")
        cols = cols.reshape(-1, 3) if (s.get("has_colors") and cols is not None) else None
        scalars = {name: buffers[f"s{i}.scalar{j}"] for j, name in enumerate(s["scalar_fields"])}
        results.append({"scanner_id": s["scanner_id"], "num_points": n,
                        "points": pts, "colors": cols, "scalars": scalars,
                        "session": s.get("session")})
    return {"success": True, "results": results}
