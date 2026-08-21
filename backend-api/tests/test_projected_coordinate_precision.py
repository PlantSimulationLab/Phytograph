"""Projected (UTM) clouds must survive a file load without being quantised.

Regression guard: the ASCII and PLY/PCD loaders used to parse positions as
float32. At a UTM northing of ~5.4e6 the float32 spacing is 0.5 m, so a real
tile was snapped onto a decimetre lattice AT PARSE TIME — before anything could
recentre it. On a 1 cm-detail tree scan that collapsed ~99% of distinct
northings, destroying exactly the geometry the app exists to measure.

The `suggested_shift` machinery does NOT protect this path: it is surfaced on
the preview response for the import wizard and is never applied inside
`_load_*_arrays`, which is what the compute chokepoint
(`_read_points_from_source`) calls.
"""

import numpy as np
import pytest

from main import PointSource, _load_xyz_arrays, _read_points_from_source


# A realistic UTM zone-10N tile with centimetre structure.
EASTING, NORTHING = 500_000.0, 5_400_000.0


@pytest.fixture
def utm_cloud(tmp_path):
    rng = np.random.default_rng(0)
    n = 3000
    xyz = np.column_stack([
        EASTING + rng.normal(0, 1.5, n),
        NORTHING + rng.normal(0, 1.5, n),
        rng.uniform(0, 8, n),
    ])
    path = tmp_path / "utm.xyz"
    # 3 decimals = 1 mm, the precision a real survey file carries.
    np.savetxt(path, xyz, fmt="%.3f")
    return path, xyz


def test_utm_positions_load_as_float64(utm_cloud):
    path, _ = utm_cloud
    pos, _, _ = _load_xyz_arrays(str(path), "x y z", None)
    assert pos.dtype == np.float64


def test_utm_coordinates_survive_the_load(utm_cloud):
    """Error must be bounded by the FILE's own 1 mm rounding, not by float32."""
    path, xyz = utm_cloud
    pos, _, _ = _load_xyz_arrays(str(path), "x y z", None)

    err = np.abs(pos - xyz).max()
    assert err < 1e-3, f"coordinates quantised on load (max error {err} m)"


def test_distinct_coordinates_are_not_collapsed(utm_cloud):
    """The float32 bug merged thousands of distinct northings into a handful."""
    path, xyz = utm_cloud
    pos, _, _ = _load_xyz_arrays(str(path), "x y z", None)

    expected = np.unique(np.round(xyz[:, 1], 3)).size
    got = np.unique(pos[:, 1]).size
    assert got == expected, f"northings collapsed: {expected} -> {got}"


def test_centimetre_detail_is_resolvable(utm_cloud):
    """Nearest-neighbour spacing must not be destroyed — this is what every
    downstream tool (skeleton radius, triangulation spacing, LAD voxels)
    estimates its scale from."""
    path, _ = utm_cloud
    pos, _, _ = _load_xyz_arrays(str(path), "x y z", None)

    # In float32 at this northing, points 1 cm apart snap together and the
    # median NN distance collapses toward 0.
    sample = pos[:400]
    d = np.linalg.norm(sample[:, None, :] - sample[None, :, :], axis=-1)
    np.fill_diagonal(d, np.inf)
    assert np.median(d.min(axis=1)) > 1e-3


def test_precision_holds_through_the_compute_chokepoint(utm_cloud):
    """`_read_points_from_source` is what every compute tool reads through."""
    path, xyz = utm_cloud
    # Direct loader test: allow_file_source is the deliberate opt-in for reading
    # a file with no session (compute paths must send session_id instead).
    pos, _, _ = _read_points_from_source(
        PointSource(source_path=str(path), ascii_format="x y z",
                    allow_file_source=True))

    assert pos.dtype == np.float64
    assert np.abs(pos - xyz).max() < 1e-3
