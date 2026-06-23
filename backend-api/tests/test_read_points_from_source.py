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


# ---------------------------------------------------------------------------
# Session-backed sources. A session-backed cloud (e.g. a synthetic scan) is the
# in-RAM source of truth; its source_path may be EMPTY (no on-disk file). The
# reader must take the session branch on `session_id` alone and never touch the
# (empty) path — this is the chokepoint behind the buildPointSource fix that
# stopped session clouds with no cache_dir from falling into the uncapped inline
# JSON path. See test_read_points_from_source's module docstring + PointSource.
# ---------------------------------------------------------------------------

@pytest.fixture
def _clear_sessions():
    with main._cloud_session_lock:
        before = dict(main._cloud_sessions)
    yield
    with main._cloud_session_lock:
        main._cloud_sessions.clear()
        main._cloud_sessions.update(before)


def _make_session(session_id, positions, extras=None, deleted=None, world_shift=None):
    n = len(positions)
    sess = main.CloudSession(
        session_id=session_id,
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=np.asarray(positions, dtype=np.float64),
        colors=None,
        intensity=None,
        extras={k: np.asarray(v, dtype=np.float32) for k, v in (extras or {}).items()},
        extra_dims_meta=[],
        deleted=(np.asarray(deleted, dtype=bool) if deleted is not None
                 else np.zeros(n, dtype=bool)),
        deleted_history=[],
        octree_cache_id=None,
        created_at=0.0,
    )
    if world_shift is not None:
        sess.world_shift = np.asarray(world_shift, dtype=np.float64)
    with main._cloud_session_lock:
        main._cloud_sessions[session_id] = sess
    return sess


def test_session_source_with_EMPTY_source_path(_clear_sessions):
    # The bug scenario: a session-backed synthetic cloud whose source_path is ''.
    # Must resolve from the in-RAM session, NOT try to read the empty path.
    pts = np.arange(30, dtype=np.float64).reshape(10, 3)
    _make_session("sess-empty", pts)
    src = main.PointSource(source_path="", session_id="sess-empty")
    pos, _, _ = main._read_points_from_source(src)
    assert pos.shape == (10, 3)
    np.testing.assert_allclose(pos, pts, atol=1e-9)


def test_session_source_with_no_source_path_field(_clear_sessions):
    # source_path is now Optional and may be omitted entirely for a session source.
    pts = np.arange(9, dtype=np.float64).reshape(3, 3)
    _make_session("sess-none", pts)
    src = main.PointSource(session_id="sess-none")
    pos, _, _ = main._read_points_from_source(src)
    assert pos.shape == (3, 3)


def test_session_source_excludes_misses(_clear_sessions):
    # is_miss-flagged rows must be dropped (surface reconstruction never meshes sky).
    pts = np.arange(15, dtype=np.float64).reshape(5, 3)
    miss = [0, 0, 1, 0, 1]  # rows 2 and 4 are misses
    _make_session("sess-miss", pts, extras={main._MISS_SLUG: miss})
    src = main.PointSource(session_id="sess-miss")  # include_misses defaults False
    pos, _, _ = main._read_points_from_source(src)
    assert pos.shape[0] == 3  # 5 - 2 misses
    np.testing.assert_allclose(pos, pts[[0, 1, 3]], atol=1e-9)


def test_session_source_honors_deletions(_clear_sessions):
    pts = np.arange(12, dtype=np.float64).reshape(4, 3)
    _make_session("sess-del", pts, deleted=[False, True, False, True])
    src = main.PointSource(session_id="sess-del")
    pos, _, _ = main._read_points_from_source(src)
    assert pos.shape[0] == 2
    np.testing.assert_allclose(pos, pts[[0, 2]], atol=1e-9)


def test_session_source_adds_world_shift(_clear_sessions):
    # The session stores points with the import global-shift SUBTRACTED; the reader
    # adds it back so downstream gets true world coords.
    pts = np.zeros((3, 3), dtype=np.float64)
    shift = [100.0, 200.0, 300.0]
    _make_session("sess-shift", pts, world_shift=shift)
    src = main.PointSource(session_id="sess-shift")
    pos, _, _ = main._read_points_from_source(src)
    np.testing.assert_allclose(pos, np.tile(shift, (3, 1)), atol=1e-6)


def test_no_session_and_no_source_path_400():
    # Neither a session nor a file → clean 400, not a confusing file read of "".
    src = main.PointSource()  # both default to None
    with pytest.raises(main.HTTPException) as exc:
        main._read_points_from_source(src)
    assert exc.value.status_code == 400
