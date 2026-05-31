"""Tests for the path-based point-cloud importer (/api/pointcloud/import_by_path).

The endpoint exists because the renderer's TS parsers can't hold a >512 MB
string. These tests stay small (a few points) but cover the format-detection
and binary-packing logic that has to keep working at multi-GB scale, plus
the extension dispatch (XYZ-family → pandas, PLY/PCD → open3d).
"""

import struct
from pathlib import Path

import pytest

# Header layout matches main.py: <4sIBB22x = magic, count, has_colors,
# has_intensity, then 22 bytes of reserved zeros. 32 bytes total.
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


def test_xyz_only_file_returns_positions(client, tmp_path: Path):
    f = tmp_path / "scan.xyz"
    f.write_text("0 0 0\n1 2 3\n-1.5 0.5 4.25\n")
    res = client.post("/api/pointcloud/import_by_path",
                      json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "application/octet-stream"
    body = res.content
    header = _unpack_header(body)
    assert header == {"magic": b"PHX1", "count": 3, "has_colors": False, "has_intensity": False}
    pts = _positions(body, 3)
    assert pts.tolist() == [[0.0, 0.0, 0.0], [1.0, 2.0, 3.0], [-1.5, 0.5, 4.25]]
    # Sanity: payload length = header + count * 3 floats.
    assert len(body) == HEADER_SIZE + 3 * 3 * 4


def test_pts_count_header_line_is_dropped(client, tmp_path: Path):
    """A `.pts` file leads with a bare point-count line; it must not be parsed
    as a data point on the flat import path."""
    f = tmp_path / "scan.pts"
    f.write_text("3\n10 20 30\n11 21 31\n12 22 32\n")
    res = client.post("/api/pointcloud/import_by_path", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    header = _unpack_header(res.content)
    assert header["count"] == 3  # not 4
    pts = _positions(res.content, 3)
    assert pts.tolist() == [[10.0, 20.0, 30.0], [11.0, 21.0, 31.0], [12.0, 22.0, 32.0]]


def test_asc_headerless_file_returns_positions(client, tmp_path: Path):
    """`.asc` is treated like `.xyz` — headerless whitespace ASCII."""
    f = tmp_path / "scan.asc"
    f.write_text("0 0 0\n1 2 3\n")
    res = client.post("/api/pointcloud/import_by_path", json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    assert _unpack_header(res.content)["count"] == 2


def test_helios_ascii_format_normalises_rgb_and_keeps_reflectance(client, tmp_path: Path):
    """Matches the BPPtree fixture format: 'x y z r255 g255 b255 reflectance'.

    This is the case the bug report hit — r255 means the 0-255 byte range and
    has to be scaled to 0-1 on the response, while reflectance lands in the
    intensity slot of the binary payload.
    """
    f = tmp_path / "bpp.xyz"
    f.write_text("0 0 0 255 0 0 0.5\n1 1 1 0 128 64 -1.25\n")
    res = client.post("/api/pointcloud/import_by_path", json={
        "file_path": str(f),
        "ascii_format": "x y z r255 g255 b255 reflectance",
    })
    assert res.status_code == 200, res.text
    body = res.content
    header = _unpack_header(body)
    assert header == {"magic": b"PHX1", "count": 2, "has_colors": True, "has_intensity": True}
    cols = _colors(body, 2)
    # 255→1.0, 128→~0.5019, 0→0
    assert cols[0].tolist() == [1.0, 0.0, 0.0]
    assert cols[1][0] == 0.0
    assert abs(cols[1][1] - (128 / 255.0)) < 1e-6
    assert abs(cols[1][2] - (64 / 255.0)) < 1e-6
    intensity = _intensity(body, 2, has_colors=True)
    assert intensity.tolist() == pytest.approx([0.5, -1.25])


def test_unknown_format_tokens_consume_columns_without_emitting_data(client, tmp_path: Path):
    """Helios formats include columns like 'timestamp' or 'target_index' that
    we don't surface. They must still be consumed so the xyz column indices
    line up — otherwise pandas would read xyz from the wrong offsets."""
    f = tmp_path / "ts.xyz"
    # Layout: timestamp x y z target_index → x is column 1, not column 0.
    f.write_text("123 0.5 1.5 2.5 7\n")
    res = client.post("/api/pointcloud/import_by_path", json={
        "file_path": str(f),
        "ascii_format": "timestamp x y z target_index",
    })
    assert res.status_code == 200, res.text
    body = res.content
    assert _unpack_header(body)["count"] == 1
    pts = _positions(body, 1)
    assert pts.tolist() == [[0.5, 1.5, 2.5]]


def test_comment_and_blank_lines_are_skipped(client, tmp_path: Path):
    f = tmp_path / "comments.xyz"
    f.write_text("# comment\n\n1 2 3\n# another\n4 5 6\n")
    res = client.post("/api/pointcloud/import_by_path",
                      json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    header = _unpack_header(res.content)
    assert header["count"] == 2
    assert _positions(res.content, 2).tolist() == [[1, 2, 3], [4, 5, 6]]


def test_leading_text_header_row_is_skipped(client, tmp_path: Path):
    """Non-Helios XYZ exports sometimes lead with a column-name row. We sniff
    it and skip it so the rest can be read as floats."""
    f = tmp_path / "with-header.xyz"
    f.write_text("X Y Z\n10 20 30\n40 50 60\n")
    res = client.post("/api/pointcloud/import_by_path",
                      json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    assert _positions(res.content, 2).tolist() == [[10, 20, 30], [40, 50, 60]]


def test_missing_file_returns_404(client, tmp_path: Path):
    bogus = tmp_path / "does-not-exist.xyz"
    res = client.post("/api/pointcloud/import_by_path",
                      json={"file_path": str(bogus)})
    assert res.status_code == 404
    assert "not found" in res.json()["detail"].lower()


def test_format_without_xyz_is_rejected(client, tmp_path: Path):
    f = tmp_path / "no-xyz.xyz"
    f.write_text("0.5 1.0\n")
    res = client.post("/api/pointcloud/import_by_path", json={
        "file_path": str(f),
        "ascii_format": "intensity reflectance",
    })
    assert res.status_code == 400
    assert "x, y" in res.json()["detail"]


def test_autodetect_six_columns_assumes_r255_g255_b255(client, tmp_path: Path):
    """No <ASCII_format> + 6 columns → treat tail as 0-255 RGB (the legacy
    Helios convention this codebase has always used)."""
    f = tmp_path / "auto-rgb.xyz"
    f.write_text("0 0 0 255 255 255\n1 1 1 0 0 0\n")
    res = client.post("/api/pointcloud/import_by_path",
                      json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    body = res.content
    assert _unpack_header(body)["has_colors"]
    cols = _colors(body, 2)
    assert cols[0].tolist() == [1.0, 1.0, 1.0]
    assert cols[1].tolist() == [0.0, 0.0, 0.0]


def test_empty_file_returns_400(client, tmp_path: Path):
    f = tmp_path / "empty.xyz"
    f.write_text("# only a comment\n\n")
    res = client.post("/api/pointcloud/import_by_path",
                      json={"file_path": str(f)})
    assert res.status_code == 400


def test_unknown_extension_is_rejected(client, tmp_path: Path):
    """LAS/LAZ have their own multipart endpoint; .obj/.json aren't point
    clouds. The dispatcher should reject anything outside the supported set
    rather than silently treating it as XYZ."""
    f = tmp_path / "mesh.obj"
    f.write_text("v 0 0 0\n")
    res = client.post("/api/pointcloud/import_by_path",
                      json={"file_path": str(f)})
    assert res.status_code == 400
    assert ".obj" in res.json()["detail"]


def test_ascii_ply_via_open3d(client, tmp_path: Path):
    """ASCII PLY with vertex colors should round-trip through open3d. This is
    the case from the user report — large ASCII PLYs were tripping the V8
    string limit in the renderer."""
    ply = (
        "ply\n"
        "format ascii 1.0\n"
        "element vertex 3\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "property uchar red\n"
        "property uchar green\n"
        "property uchar blue\n"
        "end_header\n"
        "0 0 0 255 0 0\n"
        "1 2 3 0 255 0\n"
        "4 5 6 0 0 255\n"
    )
    f = tmp_path / "cloud.ply"
    f.write_text(ply)
    res = client.post("/api/pointcloud/import_by_path",
                      json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    body = res.content
    header = _unpack_header(body)
    assert header == {"magic": b"PHX1", "count": 3, "has_colors": True, "has_intensity": False}
    pts = _positions(body, 3)
    assert pts.tolist() == [[0, 0, 0], [1, 2, 3], [4, 5, 6]]
    cols = _colors(body, 3)
    # open3d normalises 0-255 to 0-1 on read for PLY uchar color channels.
    assert cols[0].tolist() == pytest.approx([1.0, 0.0, 0.0])
    assert cols[1].tolist() == pytest.approx([0.0, 1.0, 0.0])
    assert cols[2].tolist() == pytest.approx([0.0, 0.0, 1.0])


def test_ascii_ply_without_colors(client, tmp_path: Path):
    ply = (
        "ply\n"
        "format ascii 1.0\n"
        "element vertex 2\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "end_header\n"
        "0.5 1.5 2.5\n"
        "-1 -2 -3\n"
    )
    f = tmp_path / "nocol.ply"
    f.write_text(ply)
    res = client.post("/api/pointcloud/import_by_path",
                      json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    header = _unpack_header(res.content)
    assert header["count"] == 2
    assert not header["has_colors"]
    assert _positions(res.content, 2).tolist() == [[0.5, 1.5, 2.5], [-1, -2, -3]]


def test_ascii_pcd_via_open3d(client, tmp_path: Path):
    """ASCII PCD without colors (simplest case — open3d's packed-RGB scaling
    is quirky and isn't worth asserting on here)."""
    pcd = (
        "VERSION 0.7\n"
        "FIELDS x y z\n"
        "SIZE 4 4 4\n"
        "TYPE F F F\n"
        "COUNT 1 1 1\n"
        "WIDTH 3\n"
        "HEIGHT 1\n"
        "POINTS 3\n"
        "DATA ascii\n"
        "0 0 0\n"
        "1 2 3\n"
        "4 5 6\n"
    )
    f = tmp_path / "cloud.pcd"
    f.write_text(pcd)
    res = client.post("/api/pointcloud/import_by_path",
                      json={"file_path": str(f)})
    assert res.status_code == 200, res.text
    header = _unpack_header(res.content)
    assert header == {"magic": b"PHX1", "count": 3, "has_colors": False, "has_intensity": False}
    assert _positions(res.content, 3).tolist() == [[0, 0, 0], [1, 2, 3], [4, 5, 6]]


def test_ply_with_no_vertices_returns_400(client, tmp_path: Path):
    ply = (
        "ply\n"
        "format ascii 1.0\n"
        "element vertex 0\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "end_header\n"
    )
    f = tmp_path / "empty.ply"
    f.write_text(ply)
    res = client.post("/api/pointcloud/import_by_path",
                      json={"file_path": str(f)})
    assert res.status_code == 400
    assert "no points" in res.json()["detail"].lower()


def test_ascii_format_hint_is_ignored_for_ply(client, tmp_path: Path):
    """A caller forwarding the Helios <ASCII_format> hint shouldn't accidentally
    derail PLY parsing (the field is meaningless for PLY/PCD)."""
    ply = (
        "ply\n"
        "format ascii 1.0\n"
        "element vertex 1\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "end_header\n"
        "7 8 9\n"
    )
    f = tmp_path / "with-hint.ply"
    f.write_text(ply)
    res = client.post("/api/pointcloud/import_by_path", json={
        "file_path": str(f),
        "ascii_format": "x y z reflectance",
    })
    assert res.status_code == 200, res.text
    assert _positions(res.content, 1).tolist() == [[7, 8, 9]]
