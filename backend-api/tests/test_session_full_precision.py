"""ASCII/XYZ imports must keep FULL source precision in the session array.

Regression for a triangulation break on `example-datasets/BPPtree_scaninds.xml`:
Helios triangulation traced garbage triangles (≈15x too few, leaf surfaces
shattered) on an imported tree scan.

Root cause: the import path converts an ASCII source to a LAS for PotreeConverter
(`_xyz_to_las`) at the LAS 1 mm scale, then read THAT LAS back into the session's
in-RAM positions array. For a tree scanned from tens of metres away the true
inter-point spacing is sub-millimetre, so the 1 mm quantization collapsed/jittered
neighbouring points; Helios projects each hit to (zenith, azimuth) from the scan
origin and runs a Delaunay over those angles, so the quantization blew up local
edge lengths and most candidate triangles then exceeded Lmax.

The session array is the source of truth and is never re-read from the file, so it
must hold full precision. The fix captures the source-precision xyz during the LAS
conversion (`_xyz_to_las(..., capture_full_xyz=True)`) and uses it for the session
positions; the 1 mm LAS is kept only as PotreeConverter's octree input (a display
cache, where 1 mm is invisible).

These tests pin BOTH halves at the conversion layer (no PotreeConverter needed):
  - the captured xyz is bit-for-bit the source, NOT the 1 mm LAS read-back, AND
  - it stays point-for-point aligned with the LAS-derived arrays even when rows
    with non-finite xyz are dropped.
"""

from pathlib import Path

import numpy as np
import pytest

import main


@pytest.fixture
def fine_scan(tmp_path):
    """A small ASCII scan whose coordinates carry sub-millimetre detail near
    z~100 m — exactly where the 1 mm LAS scale does damage. Returns (path, fmt,
    expected (N,3) array)."""
    rng = np.random.default_rng(0)
    n = 500
    # Base near z=103 m (like the real BPP scan), with sub-mm structure.
    xyz = np.column_stack([
        rng.uniform(-0.2, 0.2, n),
        rng.uniform(-0.2, 0.2, n),
        103.0 + rng.uniform(0.0, 30.0, n),
    ])
    # Force several coordinates to have detail finer than the 1 mm LAS step so a
    # round-trip through the quantized LAS is provably lossy.
    xyz[:50, 0] += 0.0001234  # 0.12 mm offsets
    refl = rng.uniform(0, 1, n)
    path = tmp_path / "fine.xyz"
    lines = [f"{x:.8f} {y:.8f} {z:.8f} {r:.6f}" for (x, y, z), r in zip(xyz, refl)]
    path.write_text("\n".join(lines) + "\n")
    return path, "x y z reflectance", xyz


def test_captured_xyz_is_full_precision_not_las_quantized(fine_scan, tmp_path):
    path, fmt, expected = fine_scan
    out = tmp_path / "o.las"

    total, _extra_dims, full_xyz = main._xyz_to_las(
        path, fmt, out, None, capture_full_xyz=True)
    las = main._read_las_into_arrays(out)

    assert total == expected.shape[0]
    assert full_xyz is not None
    # Aligned with the LAS-derived arrays (same count, same order).
    assert full_xyz.shape == las.positions.shape == expected.shape

    # The captured array is the SOURCE to within its written 8-dp text precision
    # (the fixture writes %.8f), i.e. ~1e-8 — NOT rounded to the 1 mm LAS scale.
    assert np.abs(full_xyz - expected).max() < 1e-7

    # And it is meaningfully better than the LAS read-back: the LAS path quantizes
    # to ~1 mm, so its max error is on the order of half the 1 mm scale. This is
    # the precision loss the fix exists to avoid — guard that it's real, so the
    # test can't pass by accident if the two ever became the same array.
    las_err = np.abs(las.positions - expected).max()
    assert las_err > 1e-4, (
        f"LAS read-back error {las_err:.2e} m unexpectedly small — the fixture no "
        f"longer exercises sub-mm precision, so this test proves nothing.")


def test_capture_aligns_when_nan_xyz_rows_dropped(tmp_path):
    """Rows with non-finite x/y/z are dropped during conversion (mirrors the flat
    loader's dropna). The captured full-precision xyz must drop the SAME rows in
    the SAME order, so it stays index-aligned with the LAS colors/intensity/extras
    the session pairs it with."""
    path = tmp_path / "withnan.xyz"
    # Row 2 (0-based) has a NaN x and must be dropped from BOTH outputs.
    path.write_text(
        "1.0 2.0 3.0 10\n"
        "1.1 2.1 3.1 11\n"
        "nan 2.2 3.2 12\n"
        "1.3 2.3 3.3 13\n"
        "1.5 2.5 3.5 15\n"
    )
    out = tmp_path / "o.las"
    total, _ed, full_xyz = main._xyz_to_las(
        path, "x y z reflectance", out, None, capture_full_xyz=True)
    las = main._read_las_into_arrays(out)

    assert total == 4  # one NaN row dropped
    assert full_xyz.shape[0] == las.positions.shape[0] == 4
    expected = np.array([
        [1.0, 2.0, 3.0], [1.1, 2.1, 3.1], [1.3, 2.3, 3.3], [1.5, 2.5, 3.5]])
    assert np.allclose(full_xyz, expected)


def test_no_capture_returns_none(fine_scan, tmp_path):
    """Default (capture_full_xyz=False) must not change the legacy return shape's
    third element to anything but None — callers that don't need the array (and
    the non-ASCII branches of _source_to_las) rely on that."""
    path, fmt, _ = fine_scan
    out = tmp_path / "o.las"
    total, extra_dims, full_xyz = main._xyz_to_las(path, fmt, out, None)
    assert total > 0
    assert isinstance(extra_dims, list)
    assert full_xyz is None
