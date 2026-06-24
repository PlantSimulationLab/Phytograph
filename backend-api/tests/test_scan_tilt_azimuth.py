"""Tilt + azimuth-offset composition for synthetic scans (`POST /api/lidar/scan`).

Regression guard for a sign bug in the scanner body frame (LiDAR.cpp): the
roll/pitch tilt axes are built from the phiMin heading rotated by the azimuth
offset. Helios measures phi clockwise-from-+y while the offset is a CCW
(right-hand) rotation about +z, so advancing the heading by the offset must
SUBTRACT it from the phi angle. The old code added it, which reflected the body
frame about the un-offset heading — so any tilt leaned the WRONG way once the
scanner had a heading.

The check is convention-independent: a target with 4-fold rotational symmetry
about the scanner's vertical axis must satisfy

    hits(offset=90, tilt) == Rz(90) * hits(offset=0, tilt)

because yawing the rig by 90 deg and yawing the (symmetric) world by 90 deg are
the same thing. A reflected body frame breaks this exactly.
"""

import numpy as np
import pytest

import main  # noqa: F401  (ensures backend-api is importable; real app under test)

# Box centred on the Z axis (x,y in [-0.6,0.6], z in [0,0.3]); its faces are
# invariant under a 90 deg rotation about +z, so the scene matches Rz(90).
_BOX_VERTS = [
    [-0.6, -0.6, 0.0], [0.6, -0.6, 0.0], [0.6, 0.6, 0.0], [-0.6, 0.6, 0.0],
    [-0.6, -0.6, 0.3], [0.6, -0.6, 0.3], [0.6, 0.6, 0.3], [-0.6, 0.6, 0.3],
]
_BOX_TRIS = [
    [0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
]


def _tilted_scanner(roll=0.0, pitch=0.0, az=0.0):
    return {
        "id": "s", "origin": [0.0, 0.0, 3.0],
        "n_theta": 180, "n_phi": 360,
        "theta_min_deg": 0.0, "theta_max_deg": 180.0,
        "phi_min_deg": 0.0, "phi_max_deg": 360.0,
        "return_type": "single", "exit_diameter_m": 0.0, "beam_divergence_mrad": 0.0,
        "tilt_roll_deg": roll, "tilt_pitch_deg": pitch, "scan_azimuth_offset_deg": az,
    }


def _centroid(client, **kw):
    from tests.binframe import decode_lidar_scan
    resp = client.post("/api/lidar/scan", json={
        "meshes": [{"vertices": _BOX_VERTS, "triangles": _BOX_TRIS}],
        "scanners": [_tilted_scanner(**kw)],
    })
    assert resp.status_code == 200, resp.text
    body = decode_lidar_scan(resp.content)
    assert body["success"] is True, body.get("error")
    pts = np.asarray(body["results"][0]["points"], dtype=np.float64)
    assert len(pts) > 0
    return pts.mean(axis=0)


def _rot_z(deg, p):
    a = np.radians(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]])


@pytest.mark.parametrize("roll,pitch", [(20.0, 0.0), (0.0, 20.0), (15.0, 10.0)])
def test_azimuth_offset_rotates_tilt_in_the_same_sense(client, roll, pitch):
    pytest.importorskip("pyhelios")
    level = _centroid(client, roll=roll, pitch=pitch, az=0.0)
    headed = _centroid(client, roll=roll, pitch=pitch, az=90.0)

    # The tilt must actually push the centroid off the vertical axis, or Rz(90)
    # maps it onto itself and the test can't tell a reflection from the truth.
    assert np.hypot(level[0], level[1]) > 0.05, "tilt should move the centroid off-axis"

    # Correct composition: heading 90 == level pattern rigidly yawed 90 deg.
    # The old (reflected) body frame missed this by ~2x the off-axis offset.
    np.testing.assert_allclose(headed, _rot_z(90.0, level), atol=1e-2)
