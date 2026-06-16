"""Regression tests for the triangulation point-spacing cross-check.

Background: Helios triangulation reconstructs leaf facets from the point cloud,
and the per-cell G(theta) (leaf-projection coefficient) is derived from the
triangle normals. The auto-Lmax estimator (Otsu over candidate triangle-edge
lengths) silently overshoots on a sparsely-sampled surface — it lets the
triangulation BRIDGE across the gaps, producing beam-aligned triangles whose
normals are wrong, which collapses G(theta). On the canonical
`leaf_cube_LAI2_lw0_01_spherical` scan (true G(theta)=0.5) the auto estimate
(Lmax≈0.22) drives G(theta) down to ~0.16; the Helios self-test's Lmax=0.04
(near the real ~0.03 m point spacing) recovers ~0.5.

The candidate-edge distribution can't self-diagnose this (its split looks clean
even when the lower mode is still bridges). `_do_spacing_check` brings in an
INDEPENDENT signal — the nearest-neighbor spacing of the points strictly inside
the grid — and flags the run as likely-bridging when Lmax far exceeds it.

These tests exercise `_do_spacing_check` directly on the committed multi-return
leafcube fixture. They use only numpy/scipy (no compiled pyhelios), so they run
in CI: the spacing check measures the INPUT points, never triangulates.
"""

import os

import pytest

import main

_FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "lad-leafcube-multi")
_FIXTURE_XYZ = os.path.join(_FIXTURE_DIR, "leafcube_multi.xyz")
_FIXTURE_FMT = "x y z timestamp target_index target_count"
_FIXTURE_ORIGIN = [-5.0, 0.0, 0.5]
# The grid from the fixture XML: a 1x1x1 m voxel centered at (0,0,0.5).
_GRID = main.HeliosGrid(center=[0.0, 0.0, 0.5], size=[1.0, 1.0, 1.0], nx=1, ny=1, nz=1)


def _request(lmax: float) -> "main.HeliosTriangulationRequest":
    scan = main.HeliosScanEntry(
        file_path=_FIXTURE_XYZ,
        ascii_format=_FIXTURE_FMT,
        origin=_FIXTURE_ORIGIN,
        return_type="multi",
    )
    return main.HeliosTriangulationRequest(scans=[scan], grid=_GRID, lmax=lmax)


@pytest.fixture(scope="module")
def _has_fixture():
    if not os.path.isfile(_FIXTURE_XYZ):
        pytest.skip(f"leafcube fixture missing: {_FIXTURE_XYZ}")


def test_excludes_sky_misses_from_spacing(_has_fixture):
    """The fixture has 9301 points but only 6498 real leaf returns inside the
    grid — the rest are sky/miss returns parked at max range (~990 m). Those must
    NOT contribute to the spacing, or a far miss's nearest neighbor (another far
    miss) would inflate the estimate. The strict in-cell cull (not the permissive
    beam-intersects-AABB cull) is what makes this correct."""
    r = main._do_spacing_check(_request(0.04))
    assert r["success"]
    # Exactly the leaf returns inside the [-0.5,0.5]^2 x [0,1] cell.
    assert r["n_points"] == 6498


def test_self_test_lmax_not_flagged(_has_fixture):
    """At the Helios self-test's Lmax (0.04 m) — which recovers G(theta)≈0.5 —
    the spacing check should NOT flag bridging: 0.04 is ~1.4x the ~0.029 m median
    point spacing, well under the 3x threshold."""
    r = main._do_spacing_check(_request(0.04))
    assert r["success"]
    assert r["median_spacing"] == pytest.approx(0.0293, abs=0.003)
    assert r["ratio"] == pytest.approx(1.37, abs=0.2)
    assert r["likely_bridging"] is False


def test_auto_lmax_flagged_as_bridging(_has_fixture):
    """At the auto-estimated Lmax (0.2203 m) — which collapses G(theta) to ~0.16 —
    the spacing check MUST flag bridging: 0.22 is ~7.5x the point spacing, so the
    triangulation is bridging across the sparse surface."""
    r = main._do_spacing_check(_request(0.2203))
    assert r["success"]
    assert r["ratio"] == pytest.approx(7.5, abs=0.5)
    assert r["likely_bridging"] is True
    assert "bridging" in r["message"].lower()


def test_threshold_boundary(_has_fixture):
    """The flag tracks `_SPACING_BRIDGE_RATIO`: an Lmax just under 3x the spacing
    is clean; just over is flagged. Guards against the threshold drifting silently."""
    spacing = main._do_spacing_check(_request(0.04))["median_spacing"]
    just_under = main._do_spacing_check(_request(spacing * (main._SPACING_BRIDGE_RATIO - 0.2)))
    just_over = main._do_spacing_check(_request(spacing * (main._SPACING_BRIDGE_RATIO + 0.2)))
    assert just_under["likely_bridging"] is False
    assert just_over["likely_bridging"] is True


def test_no_points_in_grid(_has_fixture):
    """A grid that encloses none of the points yields a clean failure, not a crash."""
    scan = main.HeliosScanEntry(
        file_path=_FIXTURE_XYZ, ascii_format=_FIXTURE_FMT,
        origin=_FIXTURE_ORIGIN, return_type="multi",
    )
    far_grid = main.HeliosGrid(center=[1000.0, 1000.0, 1000.0], size=[1.0, 1.0, 1.0])
    req = main.HeliosTriangulationRequest(scans=[scan], grid=far_grid, lmax=0.1)
    r = main._do_spacing_check(req)
    assert r["success"] is False
    assert "no points" in r["error"].lower()
