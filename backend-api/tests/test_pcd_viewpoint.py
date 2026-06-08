"""Tests for PCD scan-origin recovery from the VIEWPOINT header.

PCD is the only supported format besides E57 that records a sensor pose, but it
carries only a translation + orientation quaternion (no angular sweep or grid),
and almost every real file leaves it at the identity default `0 0 0 1 0 0 0`.
`_pcd_to_las` therefore surfaces ONLY a non-identity VIEWPOINT translation as the
scan origin (via the same per-output-LAS channel E57 uses), and create_cloud_session
forwards it as `scan_params.origin` so a lone-PCD import auto-populates the scan
origin while the rest of ScanParameters stays at its default.
"""

from pathlib import Path

import numpy as np
import pytest

import main

pytest.importorskip("open3d")
laspy = pytest.importorskip("laspy")


def _write_pcd(path: Path, viewpoint: str) -> None:
    """Write a tiny valid ASCII PCD (3 points) with the given VIEWPOINT line."""
    lines = [
        "# .PCD v0.7 - Point Cloud Data file format",
        "VERSION 0.7",
        "FIELDS x y z",
        "SIZE 4 4 4",
        "TYPE F F F",
        "COUNT 1 1 1",
        "WIDTH 3",
        "HEIGHT 1",
        viewpoint,
        "POINTS 3",
        "DATA ascii",
        "0.0 0.0 0.0",
        "1.0 0.0 0.0",
        "0.0 1.0 0.0",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="ascii")


def test_viewpoint_origin_parsed_when_non_identity(tmp_path):
    src = tmp_path / "scan.pcd"
    _write_pcd(src, "VIEWPOINT 10.5 -3.0 2.0 1 0 0 0")
    assert main._pcd_viewpoint_origin(src) == [10.5, -3.0, 2.0]


def test_viewpoint_identity_returns_none(tmp_path):
    """The identity default carries no real pose — don't fabricate a (0,0,0)
    origin for every PCD that just left VIEWPOINT at its default."""
    src = tmp_path / "scan.pcd"
    _write_pcd(src, "VIEWPOINT 0 0 0 1 0 0 0")
    assert main._pcd_viewpoint_origin(src) is None


def test_viewpoint_absent_returns_none(tmp_path):
    """A PCD with no VIEWPOINT line at all yields no origin."""
    src = tmp_path / "scan.pcd"
    lines = [
        "VERSION 0.7", "FIELDS x y z", "SIZE 4 4 4", "TYPE F F F",
        "COUNT 1 1 1", "WIDTH 2", "HEIGHT 1", "POINTS 2", "DATA ascii",
        "0.0 0.0 0.0", "1.0 1.0 1.0",
    ]
    src.write_text("\n".join(lines) + "\n", encoding="ascii")
    assert main._pcd_viewpoint_origin(src) is None


def test_pcd_to_las_stashes_non_identity_origin(tmp_path):
    """_pcd_to_las records a non-identity VIEWPOINT origin in the scan-meta
    channel keyed by the output LAS, so create_cloud_session can forward it."""
    src = tmp_path / "scan.pcd"
    _write_pcd(src, "VIEWPOINT 7.0 8.0 9.0 1 0 0 0")
    out = tmp_path / "out.las"

    n, extra_dims = main._pcd_to_las(src, out)
    assert n == 3
    assert extra_dims == []

    meta = main._e57_scan_meta.get(str(out.resolve()))
    assert meta is not None
    assert meta["origin"] == [7.0, 8.0, 9.0]
    assert meta["scan_params"]["origin"] == [7.0, 8.0, 9.0]
    # PCD carries no angular sweep / grid — only origin is populated.
    assert set(meta["scan_params"].keys()) == {"origin"}
    assert meta["has_misses"] is False


def test_pcd_to_las_identity_stashes_nothing(tmp_path):
    """An identity-VIEWPOINT PCD leaves the scan-meta channel empty so no
    spurious origin is surfaced."""
    src = tmp_path / "scan.pcd"
    _write_pcd(src, "VIEWPOINT 0 0 0 1 0 0 0")
    out = tmp_path / "out.las"

    main._e57_scan_meta.pop(str(out.resolve()), None)
    main._pcd_to_las(src, out)
    assert main._e57_scan_meta.get(str(out.resolve())) is None
