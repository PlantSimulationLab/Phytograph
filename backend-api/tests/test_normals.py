"""Correctness of the normal-estimation core against geometry whose normals are
known analytically, plus the orientation contract.

The seam/tiling behaviour lives in `test_normals_tiled.py`.
"""

import numpy as np
import pytest

import normals


def _plane(n=20000, seed=0):
    rng = np.random.default_rng(seed)
    xy = rng.uniform(-5, 5, size=(n, 2))
    return np.column_stack([xy, np.zeros(n)])


def _sphere(n=20000, radius=3.0, seed=1):
    rng = np.random.default_rng(seed)
    v = rng.normal(size=(n, 3))
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    return v * radius, v


def _vertical_wall(n=20000, seed=2):
    """A plane at x=0: normals are +/-X, so verticality is 90 degrees."""
    rng = np.random.default_rng(seed)
    yz = rng.uniform(-5, 5, size=(n, 2))
    return np.column_stack([np.zeros(n), yz])


def test_plane_normals_are_vertical_and_flat():
    pts = _plane()
    res = normals.compute_normals(pts, k=20, orientation="up")
    assert res.shape == (len(pts), normals.N_COLUMNS)
    assert res.dtype == np.float32
    # Every normal is +Z to within a rounding error.
    assert np.abs(res[:, 2]).min() > 0.9999
    assert (res[:, 2] > 0).all(), "orientation='up' must leave every normal +Z"
    # A perfect plane has no surface variation and lies flat.
    assert res[:, 3].max() < 1e-6, "curvature on a plane must be ~0"
    assert res[:, 4].max() < 0.05, "verticality on a flat plane must be ~0 deg"


def test_wall_is_ninety_degrees_verticality():
    res = normals.compute_normals(_vertical_wall(), k=20, orientation="none")
    assert res[:, 4].mean() == pytest.approx(90.0, abs=0.05)


def test_sphere_normals_are_radial():
    pts, radial = _sphere()
    res = normals.compute_normals(pts, k=30, orientation="none")
    dot = np.abs(np.einsum("ij,ij->i", res[:, 0:3].astype(np.float64), radial))
    # Unoriented, so compare magnitudes: the normal must lie along the radius.
    assert dot.mean() > 0.999
    assert np.percentile(dot, 1) > 0.99


def test_curvature_is_higher_on_a_sharp_edge_than_on_a_face():
    """Surface variation must actually discriminate: an edge scores above a face."""
    rng = np.random.default_rng(5)
    n = 15000
    # Two faces of a right-angled corner meeting along y.
    y = rng.uniform(-5, 5, n)
    t = rng.uniform(0, 1, n)
    horiz = np.column_stack([t * 2.0, y, np.zeros(n)])
    vert = np.column_stack([np.zeros(n), y, t * 2.0])
    pts = np.vstack([horiz, vert])
    res = normals.compute_normals(pts, k=30, orientation="none")

    # Distance along each face FROM the shared edge at x=z=0. Taking
    # min(|x|,|z|) over the stacked array would read 0 for every point, since
    # each face is flat in one of the two coordinates.
    dist_to_edge = np.concatenate([np.abs(horiz[:, 0]), np.abs(vert[:, 2])])
    near_edge = dist_to_edge < 0.05
    on_face = dist_to_edge > 0.5
    assert near_edge.sum() > 100 and on_face.sum() > 100
    assert res[near_edge, 3].mean() > 10 * res[on_face, 3].mean()


def test_origin_orientation_faces_the_sensor():
    pts, _ = _sphere()
    res = normals.compute_normals(pts, k=30, orientation="origin", origin=[0, 0, 0])
    # Facing the origin means pointing inward, against the radius.
    view = -pts
    assert (np.einsum("ij,ij->i", res[:, 0:3].astype(np.float64), view) >= 0).all()


def test_per_point_beam_origins_orient_each_point_independently():
    """A per-point origin array is the TLS case: two halves of the cloud are seen
    from opposite sides and must end up pointing opposite ways."""
    rng = np.random.default_rng(7)
    n = 8000
    xy = rng.uniform(-5, 5, size=(n, 2))
    pts = np.column_stack([xy, np.zeros(n)])
    origins = np.zeros((n, 3))
    origins[: n // 2, 2] = 10.0     # first half scanned from above
    origins[n // 2:, 2] = -10.0     # second half from below

    res = normals.compute_normals(pts, k=20, orientation="origin", origin=origins)
    assert (res[: n // 2, 2] > 0).all(), "points seen from above must face up"
    assert (res[n // 2:, 2] < 0).all(), "points seen from below must face down"


def test_orientation_none_leaves_signs_untouched():
    pts = _plane()
    raw = normals.compute_normals(pts, k=20, orientation="none")
    up = normals.compute_normals(pts, k=20, orientation="up")
    # Same axis either way; 'up' may have flipped some of them.
    assert np.abs(np.abs(raw[:, 2]) - np.abs(up[:, 2])).max() < 1e-5


def test_duplicate_points_get_a_zero_normal_not_a_confident_fake():
    """`eigh` of an all-zero covariance returns an ARBITRARY basis, so without a
    guard every duplicate point emitted a unit-length normal that means nothing.
    A zero vector is the honest answer and is already the house convention for
    "no normal here" (the tiling fill, deleted rows and misses all use it)."""
    res = normals.compute_normals(np.tile(np.array([1.0, 2.0, 3.0]), (500, 1)),
                                  k=20, orientation="none")
    assert np.abs(res).max() == 0.0


def test_a_point_with_no_neighbours_in_radius_is_not_reported_as_max_curvature():
    """The dangerous case. open3d returns the IDENTITY covariance when it cannot
    compute one, whose curvature is 1/(1+1+1) = 1/3 — the theoretical MAXIMUM —
    with verticality 90 deg. A sparse far-field region under a pinned radius
    therefore rendered as a confident bright band of vertical, high-curvature
    surface that does not exist."""
    rng = np.random.default_rng(0)
    scattered = np.column_stack([rng.uniform(-50, 50, 600),
                                 rng.uniform(-50, 50, 600),
                                 np.zeros(600)])
    res = normals.compute_normals(scattered, k=20, radius=0.01,
                                  orientation="none")
    assert np.linalg.norm(res[:, 0:3].astype(np.float64), axis=1).max() == 0.0
    assert res[:, 3].max() == 0.0, "must not report 1/3 curvature"
    assert res[:, 4].max() == 0.0, "must not report 90 deg verticality"


def test_the_degeneracy_guard_leaves_real_surfaces_alone():
    """The guard must not eat valid data — the failure mode of a too-eager
    sentinel check would be silent holes in an ordinary cloud."""
    for pts, k in ((_plane(20000), 20), (_sphere(20000)[0], 30)):
        res = normals.compute_normals(pts, k=k, orientation="none")
        norms = np.linalg.norm(res[:, 0:3].astype(np.float64), axis=1)
        assert (norms > 0.99).all(), "every point on a real surface keeps a normal"


def test_too_few_points_warns_and_returns_zeros_rather_than_raising():
    meta = {}
    res = normals.compute_normals(np.zeros((10, 3)), k=20, meta=meta)
    assert res.shape == (10, normals.N_COLUMNS)
    assert not res.any()
    assert "warning" in meta


def test_unknown_orientation_is_rejected():
    with pytest.raises(ValueError):
        normals.compute_normals(_plane(1000), orientation="sideways")


def test_per_point_origin_length_is_validated():
    with pytest.raises(ValueError):
        normals.compute_normals(_plane(1000), orientation="origin",
                                origin=np.zeros((7, 3)))


def test_k_is_clamped_into_range():
    meta = {}
    normals.compute_normals(_plane(2000), k=100000, meta=meta)
    assert meta["k"] == normals.MAX_K
    meta = {}
    normals.compute_normals(_plane(2000), k=1, meta=meta)
    assert meta["k"] == normals.MIN_K


def test_radius_search_is_honoured():
    meta = {}
    res = normals.compute_normals(_plane(5000), k=20, radius=0.5, meta=meta)
    assert meta["radius"] == 0.5
    assert np.abs(res[:, 2]).min() > 0.999


def test_columns_contract_matches_output_width():
    """The slug list and the array width are a contract with the endpoint, which
    writes one session column per output column."""
    assert len(normals.COLUMNS) == normals.N_COLUMNS
    res = normals.compute_normals(_plane(1000), k=20)
    assert res.shape[1] == len(normals.COLUMNS)
    assert [s for s, _ in normals.COLUMNS][:3] == ["nx", "ny", "nz"]
