"""Progress-marker tests for the streaming triangulation endpoints.

Two contracts are pinned here:

1. `_pack_progress_marker` emits a well-formed PHP1 marker whose total length is
   a 4-byte multiple — the alignment invariant the renderer's zero-copy decode
   relies on (markers precede the PHB1 frame, so misaligned padding would shift
   every buffer offset).
2. `_do_open3d_triangulation` reports real per-stage progress: a capturing
   callback sees the expected stage labels in order, ending at fraction 1.0.
"""

import struct

import numpy as np

import main
from main import TriangulationRequest, _do_open3d_triangulation, _pack_progress_marker

from tests.binframe import decode_bin_frame, decode_progress_markers


def _parse_marker(buf: bytes):
    assert buf[:4] == b"PHP1"
    (json_len,) = struct.unpack("<I", buf[4:8])
    import json
    payload = buf[8:8 + json_len]
    return json.loads(payload)


def test_pack_progress_marker_roundtrip_and_alignment():
    buf = _pack_progress_marker(0.42, "Estimating normals")
    # Total marker length must stay a multiple of 4 (keeps the PHB1 frame aligned).
    assert len(buf) % 4 == 0
    parsed = _parse_marker(buf)
    assert parsed == {"progress": 0.42, "message": "Estimating normals"}


def test_pack_progress_marker_allows_null_progress():
    buf = _pack_progress_marker(None, "Triangulating")
    assert len(buf) % 4 == 0
    assert _parse_marker(buf) == {"progress": None, "message": "Triangulating"}


def _sphere_points(n_lat: int = 16, n_lon: int = 16) -> list[list[float]]:
    """A unit-sphere point cloud — a non-degenerate 3D surface ball pivoting
    triangulates cleanly (no cocircular/cospherical normal-orientation issues)."""
    pts = []
    for i in range(1, n_lat):
        theta = np.pi * i / n_lat
        for j in range(n_lon):
            phi = 2 * np.pi * j / n_lon
            pts.append([
                np.sin(theta) * np.cos(phi),
                np.sin(theta) * np.sin(phi),
                np.cos(theta),
            ])
    return pts


def test_open3d_triangulation_reports_real_stages():
    """The Open3D path must emit ordered stage labels ending at fraction 1.0."""
    events: list[tuple] = []

    def progress(fraction, message):
        events.append((fraction, message))

    req = TriangulationRequest(method="ball_pivoting", points=_sphere_points())
    res = _do_open3d_triangulation(req, progress=progress)
    assert res["success"] is True

    labels = [m for _, m in events]
    # Genuine stage transitions, in order.
    assert labels[0] == "Reading points"
    assert "Preparing point cloud" in labels
    assert "Estimating normals" in labels
    assert any(l.startswith("Meshing") for l in labels)
    assert "Cleaning up mesh" in labels
    assert labels[-1] == "Finalizing"

    fractions = [f for f, _ in events if f is not None]
    assert fractions[-1] == 1.0
    # Monotonically non-decreasing — honest progress, never going backwards.
    assert fractions == sorted(fractions)


def test_open3d_triangulation_works_without_progress_callback():
    """The progress arg is optional — omitting it must not change behavior."""
    req = TriangulationRequest(method="ball_pivoting", points=_sphere_points())
    res = _do_open3d_triangulation(req)
    assert res["success"] is True
    assert res["num_triangles"] > 0


def test_triangulate_endpoint_streams_progress_markers(client):
    """The /api/triangulate streaming response carries PHP1 progress markers
    ahead of the PHB1 frame, and the frame still decodes correctly."""
    res = client.post(
        "/api/triangulate",
        json={"method": "ball_pivoting", "points": _sphere_points()},
    )
    assert res.status_code == 200

    markers = decode_progress_markers(res.content)
    labels = [m["message"] for m in markers]
    assert "Reading points" in labels
    assert labels[-1] == "Finalizing"

    # The frame after the markers still decodes to a real mesh.
    meta, buffers = decode_bin_frame(res.content)
    assert meta["success"] is True
    assert meta["num_triangles"] > 0
