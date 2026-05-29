"""Tests for /api/pointcloud/crop_by_path.

The crop endpoint mirrors import_by_path's PHX1 binary response format,
so we reuse the same header/payload unpackers. The cases below cover the
semantic contract that the renderer relies on: AABB filtering, the
optional translation bake-in, and the empty-result + bad-input edge
cases the in-renderer apply path used to handle.
"""

import struct
from pathlib import Path

HEADER_SIZE = 32


def _unpack_header(body: bytes) -> dict:
    magic, count, has_colors, has_intensity = struct.unpack_from('<4sIBB', body, 0)
    return {
        "magic": magic,
        "count": count,
        "has_colors": bool(has_colors),
        "has_intensity": bool(has_intensity),
    }


def _positions(body: bytes, count: int):
    import numpy as np
    return np.frombuffer(body, dtype=np.float32, count=count * 3, offset=HEADER_SIZE).reshape(count, 3)


def _colors(body: bytes, count: int):
    import numpy as np
    offset = HEADER_SIZE + count * 3 * 4
    return np.frombuffer(body, dtype=np.float32, count=count * 3, offset=offset).reshape(count, 3)


def _intensity(body: bytes, count: int, has_colors: bool):
    import numpy as np
    offset = HEADER_SIZE + count * 3 * 4
    if has_colors:
        offset += count * 3 * 4
    return np.frombuffer(body, dtype=np.float32, count=count, offset=offset)


def test_box_keeps_only_inside_points(client, tmp_path: Path):
    """Five points along a line; an AABB of x∈[0.5, 2.5] should keep the
    middle three. Y/Z bounds wide enough that x is the only constraint."""
    f = tmp_path / "line.xyz"
    f.write_text("0 0 0\n1 0 0\n2 0 0\n3 0 0\n4 0 0\n")
    res = client.post("/api/pointcloud/crop_by_path", json={
        "file_path": str(f),
        "crop_min": [0.5, -10, -10],
        "crop_max": [2.5, 10, 10],
    })
    assert res.status_code == 200, res.text
    body = res.content
    header = _unpack_header(body)
    assert header == {"magic": b"PHX1", "count": 2, "has_colors": False, "has_intensity": False}
    # x=1 and x=2 are inside [0.5, 2.5]. x=0, 3, 4 are out.
    assert _positions(body, 2).tolist() == [[1, 0, 0], [2, 0, 0]]


def test_box_preserves_colors_and_intensity(client, tmp_path: Path):
    """Crop on a BPPtree-style file (rgb255 + reflectance). The colour and
    intensity channels have to be filtered with the SAME boolean mask as
    positions — otherwise a kept point would get a neighbour's RGB."""
    f = tmp_path / "rgb.xyz"
    # Three points: (0,0,0)=red, (5,0,0)=green-ish, (10,0,0)=blue. Keep the
    # middle one with x∈[3, 7].
    f.write_text(
        "0 0 0 255 0 0 0.1\n"
        "5 0 0 0 255 0 0.5\n"
        "10 0 0 0 0 255 0.9\n"
    )
    res = client.post("/api/pointcloud/crop_by_path", json={
        "file_path": str(f),
        "ascii_format": "x y z r255 g255 b255 reflectance",
        "crop_min": [3, -1, -1],
        "crop_max": [7, 1, 1],
    })
    assert res.status_code == 200, res.text
    body = res.content
    header = _unpack_header(body)
    assert header == {"magic": b"PHX1", "count": 1, "has_colors": True, "has_intensity": True}
    assert _positions(body, 1).tolist() == [[5, 0, 0]]
    # The green point's RGB, not red or blue. Confirms filter alignment.
    cols = _colors(body, 1)
    assert cols[0].tolist() == [0.0, 1.0, 0.0]
    assert _intensity(body, 1, has_colors=True).tolist() == [0.5]


def test_invert_returns_outside_points(client, tmp_path: Path):
    """crop_invert flips the predicate. Same fixture as the line test;
    inside the [0.5, 2.5] box would be x=1,2 — invert returns x=0,3,4."""
    f = tmp_path / "line.xyz"
    f.write_text("0 0 0\n1 0 0\n2 0 0\n3 0 0\n4 0 0\n")
    res = client.post("/api/pointcloud/crop_by_path", json={
        "file_path": str(f),
        "crop_min": [0.5, -10, -10],
        "crop_max": [2.5, 10, 10],
        "crop_invert": True,
    })
    assert res.status_code == 200, res.text
    body = res.content
    assert _unpack_header(body)["count"] == 3
    assert _positions(body, 3).tolist() == [[0, 0, 0], [3, 0, 0], [4, 0, 0]]


def test_translation_baked_before_box_test(client, tmp_path: Path):
    """Translation shifts the cloud's world position before the AABB test
    runs and stays baked into the result. Matches the in-renderer apply
    semantics where editState.translation gets folded into cloud.data."""
    f = tmp_path / "shifted.xyz"
    # File positions are at x=0,1,2. Translation +10 puts them at 10,11,12.
    # AABB x∈[10.5, 11.5] keeps only the middle (post-translation x=11).
    f.write_text("0 0 0\n1 0 0\n2 0 0\n")
    res = client.post("/api/pointcloud/crop_by_path", json={
        "file_path": str(f),
        "translation": [10, 0, 0],
        "crop_min": [10.5, -10, -10],
        "crop_max": [11.5, 10, 10],
    })
    assert res.status_code == 200, res.text
    body = res.content
    assert _unpack_header(body)["count"] == 1
    # Translation is baked: the returned point is in world coords (x=11),
    # not local file coords (x=1).
    assert _positions(body, 1).tolist() == [[11, 0, 0]]


def test_empty_result_is_200_not_error(client, tmp_path: Path):
    """A crop box that excludes every point returns a 200 with
    point_count=0. The renderer surfaces the empty case via its
    delete-confirmation modal — an error response would short-circuit
    that UX."""
    f = tmp_path / "tiny.xyz"
    f.write_text("0 0 0\n1 1 1\n")
    res = client.post("/api/pointcloud/crop_by_path", json={
        "file_path": str(f),
        "crop_min": [100, 100, 100],
        "crop_max": [200, 200, 200],
    })
    assert res.status_code == 200, res.text
    header = _unpack_header(res.content)
    assert header["count"] == 0
    # No colors/intensity in the source → flags are False even on an
    # empty result. (The renderer doesn't reach for the channel arrays
    # when count=0.)
    assert not header["has_colors"]
    assert not header["has_intensity"]
    # Payload is just the 32-byte header.
    assert len(res.content) == HEADER_SIZE


def test_missing_file_returns_404(client, tmp_path: Path):
    bogus = tmp_path / "nope.xyz"
    res = client.post("/api/pointcloud/crop_by_path", json={
        "file_path": str(bogus),
        "crop_min": [0, 0, 0],
        "crop_max": [1, 1, 1],
    })
    assert res.status_code == 404
    assert "not found" in res.json()["detail"].lower()


def test_malformed_bounds_rejected(client, tmp_path: Path):
    """crop_min/crop_max must be exactly [x, y, z]. A 2-element array is
    a renderer bug we'd rather catch with a 400 than silently broadcast
    against a numpy array."""
    f = tmp_path / "ok.xyz"
    f.write_text("0 0 0\n")
    res = client.post("/api/pointcloud/crop_by_path", json={
        "file_path": str(f),
        "crop_min": [0, 0],
        "crop_max": [1, 1, 1],
    })
    assert res.status_code == 400
    assert "3-element" in res.json()["detail"]
