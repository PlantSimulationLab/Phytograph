"""Decoder for the PHB1 binary-frame responses (see main._bin_frame_bytes),
for tests of endpoints that use the binary transport. Mirrors the renderer's
decodeBinaryFrame."""

import json
import struct

import numpy as np


def decode_bin_frame(content: bytes):
    """Decode a PHB1 frame body into (meta: dict, buffers: dict[str, np.ndarray])."""
    i = 0
    while i < len(content) and content[i] in (0x20, 0x09, 0x0A, 0x0D):
        i += 1
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
                        "points": pts, "colors": cols, "scalars": scalars})
    return {"success": True, "results": results}
