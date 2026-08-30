"""C2M must not lose precision on a georeferenced (UTM) cloud.

Open3D's `RaycastingScene` is Embree-backed and takes float32 ONLY -- a float64
tensor is rejected outright -- so `_do_c2m_distance` has to cast. It was casting
ABSOLUTE coordinates: `_read_points_from_source` adds `world_shift` back, so a
projected cloud arrives at real UTM magnitudes.

float32 spacing at a UTM northing of 4,210,000 is 0.5 m. This endpoint reports
`points_within_1mm`. The quantisation was therefore 500x coarser than the
smallest quantity being measured, and nothing raised -- the numbers just came
back wrong:

    true clearance 5 mm, flat mesh, 2000 points, UTM 32N
      before:  mean 0.012843  rmse 0.061884  max 0.500025   <- 0.5 m = the spacing
      after:   mean 0.005000  rmse 0.005000  max 0.005000

A point-to-mesh distance is translation-invariant, so recentring both the mesh
and the query points on the mesh centroid before the cast leaves every distance
unchanged while moving the coordinates into float32's precise range (sub-micron
across a 1 km scene).

These tests drive the real `_do_c2m_distance`, not a reimplementation: the
geometry is chosen so the exact answer is known analytically (points a fixed
height above a flat plane), which is what makes an absolute-error assertion
possible at all.
"""

import numpy as np
import pytest

import main


# A UTM 32N easting/northing of the magnitude the project's own example data
# carries. The northing is what hurts: float32 spacing is 0.5 m here.
UTM_ORIGIN = (512000.0, 4210000.0)
TRUE_CLEARANCE = 0.005          # 5 mm -- the scale C2M's coverage metrics use
PLANE_Z = 100.0


def _flat_plane_case(ox: float, oy: float, clearance: float = TRUE_CLEARANCE,
                     n: int = 2000):
    """A 10x10 m flat mesh at z=PLANE_Z centred on (ox, oy), plus `n` points
    exactly `clearance` above it. Every true point-to-mesh distance is exactly
    `clearance`, so any deviation is numerical error."""
    v = np.array([
        [ox - 5, oy - 5, PLANE_Z], [ox + 5, oy - 5, PLANE_Z],
        [ox + 5, oy + 5, PLANE_Z], [ox - 5, oy + 5, PLANE_Z],
    ], dtype=np.float64)
    tri = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int32)
    rng = np.random.default_rng(0)
    pts = np.column_stack([
        ox + rng.uniform(-4, 4, n),
        oy + rng.uniform(-4, 4, n),
        np.full(n, PLANE_Z + clearance),
    ])
    return main.C2MDistanceRequest(
        points=pts.ravel().tolist(),
        mesh_vertices=v.ravel().tolist(),
        mesh_indices=tri.ravel().tolist(),
    )


@pytest.mark.parametrize("label,origin", [
    ("origin-local", (0.0, 0.0)),
    ("utm-32n", UTM_ORIGIN),
    ("utm-far-north", (699999.0, 7800000.0)),
])
def test_distance_is_exact_regardless_of_georeferencing(label, origin):
    """The same geometry must measure the same whether it sits at the origin or
    at UTM magnitudes. Before the fix the UTM cases read ~2.6x high in the mean
    and 12x high in RMSE."""
    res = main._do_c2m_distance(_flat_plane_case(*origin))
    assert res["success"] is True, res.get("error")
    # 1 micron: far tighter than the 5 mm being measured, and unreachable if the
    # cast happens on absolute coordinates (whose spacing alone is 0.5 m).
    assert res["mean_distance"] == pytest.approx(TRUE_CLEARANCE, abs=1e-6)
    assert res["rmse"] == pytest.approx(TRUE_CLEARANCE, abs=1e-6)
    assert res["max_distance"] == pytest.approx(TRUE_CLEARANCE, abs=1e-6)
    assert res["min_distance"] == pytest.approx(TRUE_CLEARANCE, abs=1e-6)
    # A flat plane at uniform clearance has no spread; the pre-fix run reported
    # std 0.06 m from quantisation alone.
    assert res["std_deviation"] == pytest.approx(0.0, abs=1e-6)


def test_georeferenced_matches_origin_local_exactly():
    """The invariant stated directly: translating the whole scene by a UTM offset
    must not change any reported statistic. This is the assertion that cannot be
    satisfied by a float32 cast on absolute coordinates."""
    local = main._do_c2m_distance(_flat_plane_case(0.0, 0.0))
    utm = main._do_c2m_distance(_flat_plane_case(*UTM_ORIGIN))
    assert local["success"] and utm["success"]
    for key in ("mean_distance", "rmse", "max_distance", "min_distance",
                "median_distance", "std_deviation", "percentile_95"):
        assert utm[key] == pytest.approx(local[key], abs=1e-6), key


def test_a_real_gap_is_still_measured_at_utm_magnitude():
    """Precision, not a hardcoded answer: a different clearance must produce a
    correspondingly different distance, so the fix cannot be faked by returning
    a constant."""
    res = main._do_c2m_distance(
        _flat_plane_case(*UTM_ORIGIN, clearance=0.25))
    assert res["success"] is True, res.get("error")
    assert res["mean_distance"] == pytest.approx(0.25, abs=1e-6)


def test_coverage_percentages_survive_georeferencing():
    """`points_within_*` are the metrics the 0.5 m quantisation most directly
    corrupts -- they compare distances against fractions of the bbox diagonal."""
    local = main._do_c2m_distance(_flat_plane_case(0.0, 0.0))
    utm = main._do_c2m_distance(_flat_plane_case(*UTM_ORIGIN))
    for key in ("points_within_1mm", "points_within_5mm", "points_within_10mm"):
        assert utm[key] == pytest.approx(local[key], abs=1e-9), key
