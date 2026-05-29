"""Tests for `_read_points_from_source` + the `PointSource` model (M4).

This is the shared reader every octree-backed downstream op (skeleton,
triangulate, c2m, icp, export) uses to pull points out of the original
source file, since the backend has no octree reader. No PotreeConverter
needed — this only parses the ASCII source — so the suite runs everywhere.

Asserts the load-bearing invariants:
  - full-resolution count matches the file
  - `max_points` stride-downsamples (count <= cap, stride preserved)
  - translation is ADDED (mean shifts by exactly t) — the sign that must
    agree with the renderer's getDisplayData and `_filtered_xyz_to_las`
  - colors come back in 0-1 only when `want_colors` is set
  - a missing file 404s
"""

import numpy as np
import pytest

import main


GRID_FORMAT = "x y z r255 g255 b255 reflectance"


@pytest.fixture
def grid_xyz(tmp_path):
    """10×10×10 grid spanning [0, 0.9]^3 in 0.1 steps — 1000 points, with
    RGB (0-255) + reflectance columns. Same shape as the crop-octree suite."""
    f = tmp_path / "grid.xyz"
    lines = []
    for i in range(10):
        for j in range(10):
            for k in range(10):
                r = (i * 17) % 256
                g = (j * 23) % 256
                b = (k * 31) % 256
                refl = ((i + j + k) * 0.01) % 1.0
                lines.append(
                    f"{i * 0.1:.4f} {j * 0.1:.4f} {k * 0.1:.4f} {r} {g} {b} {refl:.4f}"
                )
    f.write_text("\n".join(lines) + "\n")
    return f


def test_full_resolution_count(grid_xyz):
    src = main.PointSource(source_path=str(grid_xyz), ascii_format=GRID_FORMAT)
    pos, colors, intensity = main._read_points_from_source(src)
    assert pos.shape == (1000, 3)
    assert pos.dtype == np.float64
    assert colors is None  # want_colors defaults False
    assert intensity is not None and intensity.shape == (1000,)


def test_max_points_stride_downsample(grid_xyz):
    src = main.PointSource(
        source_path=str(grid_xyz), ascii_format=GRID_FORMAT, max_points=100
    )
    pos, _, _ = main._read_points_from_source(src)
    # stride = ceil(1000/100) = 10 → exactly 100 survivors.
    assert pos.shape[0] == 100
    # Stride keeps the first point and every 10th after — first row is origin.
    np.testing.assert_allclose(pos[0], [0.0, 0.0, 0.0], atol=1e-9)


def test_max_points_above_count_is_noop(grid_xyz):
    src = main.PointSource(
        source_path=str(grid_xyz), ascii_format=GRID_FORMAT, max_points=99999
    )
    pos, _, _ = main._read_points_from_source(src)
    assert pos.shape[0] == 1000


def test_translation_is_added(grid_xyz):
    base = main._read_points_from_source(
        main.PointSource(source_path=str(grid_xyz), ascii_format=GRID_FORMAT)
    )[0]
    t = [10.0, -5.0, 2.5]
    shifted = main._read_points_from_source(
        main.PointSource(
            source_path=str(grid_xyz), ascii_format=GRID_FORMAT, translation=t
        )
    )[0]
    # Every point moved by exactly +t.
    np.testing.assert_allclose(shifted - base, np.tile(t, (1000, 1)), atol=1e-9)
    np.testing.assert_allclose(shifted.mean(axis=0) - base.mean(axis=0), t, atol=1e-9)


def test_bad_translation_length_400(grid_xyz):
    src = main.PointSource(
        source_path=str(grid_xyz), ascii_format=GRID_FORMAT, translation=[1.0, 2.0]
    )
    with pytest.raises(main.HTTPException) as exc:
        main._read_points_from_source(src)
    assert exc.value.status_code == 400


def test_want_colors_returns_0_1_range(grid_xyz):
    src = main.PointSource(
        source_path=str(grid_xyz), ascii_format=GRID_FORMAT, want_colors=True
    )
    _, colors, _ = main._read_points_from_source(src)
    assert colors is not None
    assert colors.shape == (1000, 3)
    assert colors.min() >= 0.0 and colors.max() <= 1.0


def test_missing_file_404():
    src = main.PointSource(source_path="/no/such/file.xyz")
    with pytest.raises(main.HTTPException) as exc:
        main._read_points_from_source(src)
    assert exc.value.status_code == 404
