"""Sky/miss points must be excluded for a FILE point source, not just a session.

Regression guard for a silent wrong-answer class: `_read_points_from_source`
used to apply its `include_misses` filter ONLY on the session branch, on the
stated premise that a file path "can't carry an is_miss column anyway". That
premise was false — this app writes `is_miss` as a first-class LAS extra dim and
as an ASCII column, and export defaults to include_misses=True. So a user who
exported a scan with misses and re-imported it by path fed points projected
~1 km out into ICP / C2M / skeleton / segmentation.

The damage was not a crash: a miss shell inflates the cloud's bbox diagonal
~170x, and ICP scales max_correspondence_distance off that diagonal, so every
point matched every other point and ICP returned a confidently WRONG transform
at fitness ~1.0.
"""

import numpy as np
import pytest

import main
from main import (
    PointSource,
    _MISS_SLUG,
    _file_miss_mask,
    _icp_quality,
    _read_points_from_source,
    _robust_cloud_diagonal,
)


HITS, MISSES = 2000, 200


def _hits_and_misses(seed=0):
    """A compact 'tree' plus a far-field shell of miss rays ~1 km out."""
    rng = np.random.default_rng(seed)
    hits = np.column_stack([
        rng.normal(0, 1.5, HITS),
        rng.normal(0, 1.5, HITS),
        rng.uniform(0, 8, HITS),
    ])
    d = rng.normal(0, 1, (MISSES, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    return hits, d * 1000.0


def _write_las(path, xyz, is_miss):
    """Write a LAS carrying `is_miss` as an extra dim, exactly as the app's
    own writers (`_session_to_las`, `_ply_to_las`, `_e57_to_las`) do."""
    laspy = pytest.importorskip("laspy")
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001])
    header.offsets = np.floor(xyz.min(axis=0))
    header.add_extra_dim(laspy.ExtraBytesParams(name=_MISS_SLUG, type=np.float32))
    las = laspy.LasData(header)
    las.x, las.y, las.z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    las[_MISS_SLUG] = is_miss.astype(np.float32)
    las.write(str(path))


@pytest.fixture
def las_with_misses(tmp_path):
    hits, misses = _hits_and_misses()
    xyz = np.vstack([hits, misses])
    is_miss = np.concatenate([np.zeros(len(hits)), np.ones(len(misses))])
    path = tmp_path / "scan_with_misses.las"
    _write_las(path, xyz, is_miss)
    return path, hits


def test_las_file_source_drops_misses_by_default(las_with_misses):
    path, hits = las_with_misses
    pos, _, _ = _read_points_from_source(PointSource(source_path=str(path)))

    assert len(pos) == len(hits), "miss rows must not reach a compute consumer"
    # The surviving extent is the tree, not the 2 km miss shell.
    assert np.ptp(pos, axis=0).max() < 50.0


def test_las_file_source_keeps_misses_when_asked(las_with_misses):
    """Export/LAD deliberately opt in; the flag must still mean 'keep'."""
    path, hits = las_with_misses
    pos, _, _ = _read_points_from_source(
        PointSource(source_path=str(path), include_misses=True))

    assert len(pos) == len(hits) + MISSES
    assert np.ptp(pos, axis=0).max() > 1000.0


def test_ascii_file_source_drops_misses(tmp_path):
    """Same guarantee via the ASCII path — `is_miss` is a known ASCII role, but
    it is NOT in _XYZ_DATA_ROLES, so the loader silently discarded the column
    while keeping the miss rows' coordinates."""
    hits, misses = _hits_and_misses(seed=1)
    xyz = np.vstack([hits, misses])
    is_miss = np.concatenate([np.zeros(len(hits)), np.ones(len(misses))])
    path = tmp_path / "scan.xyz"
    np.savetxt(path, np.column_stack([xyz, is_miss]), fmt="%.4f")

    pos, _, _ = _read_points_from_source(
        PointSource(source_path=str(path), ascii_format="x y z is_miss"))

    assert len(pos) == len(hits)
    assert np.ptp(pos, axis=0).max() < 50.0


def test_file_without_miss_column_is_untouched(tmp_path):
    """A plain cloud has no miss info — every point must survive."""
    hits, _ = _hits_and_misses(seed=2)
    path = tmp_path / "plain.xyz"
    np.savetxt(path, hits, fmt="%.4f")

    assert _file_miss_mask(str(path), "x y z") is None
    pos, _, _ = _read_points_from_source(
        PointSource(source_path=str(path), ascii_format="x y z"))
    assert len(pos) == len(hits)


def test_miss_mask_probe_never_raises(tmp_path):
    """The probe is best-effort: unreadable/odd input yields None, not an error
    (a miss probe must never break an otherwise-valid load)."""
    assert _file_miss_mask(str(tmp_path / "nope.las"), None) is None
    assert _file_miss_mask(str(tmp_path / "nope.xyz"), "x y z is_miss") is None
    junk = tmp_path / "junk.ply"
    junk.write_text("not a ply\n")
    assert _file_miss_mask(str(junk), None) is None


# ---------------------------------------------------------------------------
# ICP scale robustness — defence in depth for any other far-field stray
# ---------------------------------------------------------------------------

def test_robust_diagonal_ignores_far_field_shell():
    hits, misses = _hits_and_misses(seed=3)
    clean = _robust_cloud_diagonal(hits)
    polluted = _robust_cloud_diagonal(np.vstack([hits, misses]))

    raw = np.linalg.norm(np.vstack([hits, misses]).max(axis=0)
                         - np.vstack([hits, misses]).min(axis=0))
    assert raw > 2000.0, "sanity: the raw AABB really is inflated"
    # The robust estimate stays on the tree's own scale.
    assert polluted == pytest.approx(clean, rel=0.05)


def test_robust_diagonal_matches_aabb_on_clean_input():
    """No behaviour change for well-formed clouds."""
    hits, _ = _hits_and_misses(seed=4)
    aabb = float(np.linalg.norm(hits.max(axis=0) - hits.min(axis=0)))
    assert _robust_cloud_diagonal(hits) == pytest.approx(aabb, rel=0.15)


def test_robust_diagonal_degenerate_inputs():
    assert _robust_cloud_diagonal(np.empty((0, 3))) == 0.0
    # All-identical points: no spread, must not divide by zero or return NaN.
    same = np.zeros((32, 3))
    assert _robust_cloud_diagonal(same) == 0.0


def test_icp_quality_flags_a_bad_fit_that_fitness_would_hide():
    """RMSE ~7% of a 20 m object is a bad alignment even at fitness 1.0."""
    ratio, warning = _icp_quality(rmse=1.4, diagonal=20.0)
    assert ratio == pytest.approx(0.07)
    assert warning and "residual error is high" in warning


def test_icp_quality_silent_on_a_good_fit():
    ratio, warning = _icp_quality(rmse=0.002, diagonal=20.0)
    assert ratio == pytest.approx(0.0001)
    assert warning is None


def test_icp_quality_handles_degenerate_scale():
    assert _icp_quality(rmse=1.0, diagonal=0.0) == (None, None)
