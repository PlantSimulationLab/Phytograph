"""Tests for the Livox non-repeating rosette (Risley-prism) scan pattern.

A Livox rosette is driven by pyhelios' addScanRisley: a single beam is refracted
through a stack of continuously rotating wedge prisms, tracing a non-repetitive
rosette that fills a CIRCULAR field of view whose extent is an EMERGENT property
of the wedge angles + refractive indices (not an angular-sweep parameter). It is
always trajectory-driven; a stationary tripod capture is a trajectory of two
identical poses separated in time by the acquisition duration.

The validation cases (missing prisms / missing trajectory) run anywhere. The
end-to-end case requires a compiled pyhelios with the `lidar` plugin and is
skipped otherwise.

The discriminating assertion is NOT "didn't throw": it fires a Livox Mid-40 stack
at a broad wall and checks that the returned beam directions form the correct
CIRCULAR emergent FOV — a ~38.4° full-cone (≈19.2° half-angle) about the optical
axis. A wrong coordinate convention would scatter the beams over a hemisphere; a
missing prism refraction would collapse them on-axis. Both are caught here.
"""

import math

import numpy as np
import pytest

import main
from tests.binframe import decode_bin_frame, decode_lidar_scan


# Verified Livox Mid-40 prism stack (HELIOS++ data/scanners_tls.xml; corroborated
# by Wang et al., Sensors 2021;21(14):4722). Two counter-rotating wedges. Datasheet
# units: wedge degrees, rotor Hz — the backend converts to rad / rad-per-second.
_MID40_PRISMS = [
    {"wedge_angle_deg": 18.7481, "refractive_index": 1.51, "rotor_rate_hz": -121.5657},
    {"wedge_angle_deg": 17.9634, "refractive_index": 1.51, "rotor_rate_hz": 77.7430},
]
_MID40_PRF = 100000.0
_MID40_FOV_HALFANGLE_DEG = 38.4 / 2.0  # ≈19.2° — the published circular FOV

# A wall facing the scanner along +y (the rosette's optical axis in the body
# frame; with an identity-attitude trajectory the body +y maps to world +y). Given
# a shallow thickness so the axis-aligned bounding-box cull doesn't reject it (a
# perfectly coplanar mesh scans to zero hits). Spans wide enough (±3.5 m at 5 m
# range → ±35°) that the ≈19° rosette cone lands entirely on the wall, so the
# measured max half-angle reflects the PRISM OPTICS, not the wall edges.
_WALL_D = 5.0
_WALL_H = 3.5  # half-extent in x and z


def _wall_mesh():
    # Two faces a hair apart in y so the AABB has non-zero depth along every axis.
    y0, y1 = _WALL_D, _WALL_D + 0.02
    verts = [
        [-_WALL_H, y0, -_WALL_H], [_WALL_H, y0, -_WALL_H],
        [_WALL_H, y0, _WALL_H], [-_WALL_H, y0, _WALL_H],
        [-_WALL_H, y1, -_WALL_H], [_WALL_H, y1, -_WALL_H],
        [_WALL_H, y1, _WALL_H], [-_WALL_H, y1, _WALL_H],
    ]
    tris = [
        [0, 1, 2], [0, 2, 3],          # front face (y0)
        [4, 6, 5], [4, 7, 6],          # back face (y1)
    ]
    return {"vertices": verts, "triangles": tris}


def _stationary_trajectory(origin=(0.0, 0.0, 0.0), duration_s=0.03):
    """A stationary Livox capture: two identical poses (identity attitude) at the
    same position, separated in time by the acquisition duration. Npulses =
    PRF * duration; 0.03 s at 100 kHz ≈ 3000 pulses — enough to characterize the
    rosette FOV without large allocations."""
    return {
        "poses": [
            {"t": 0.0, "x": origin[0], "y": origin[1], "z": origin[2],
             "qx": 0.0, "qy": 0.0, "qz": 0.0, "qw": 1.0},
            {"t": duration_s, "x": origin[0], "y": origin[1], "z": origin[2],
             "qx": 0.0, "qy": 0.0, "qz": 0.0, "qw": 1.0},
        ],
    }


def _risley_scanner(scanner_id="rosette", prisms=None, trajectory="default",
                    prf=_MID40_PRF, refractive_index_air=1.0):
    s = {
        "id": scanner_id,
        "origin": [0.0, 0.0, 0.0],
        "scan_pattern": "risley_prism",
        # These grid fields are ignored for Risley but the model requires them.
        "n_theta": 1, "n_phi": 1,
        "theta_min_deg": 0.0, "theta_max_deg": 180.0,
        "phi_min_deg": 0.0, "phi_max_deg": 360.0,
        "return_mode": "multi", "max_returns": 2,
        "exit_diameter_m": 0.0, "beam_divergence_mrad": 0.0,
        "refractive_index_air": refractive_index_air,
        "pulse_rate_hz": prf,
    }
    if prisms is not None:
        s["risley_prisms"] = prisms
    if trajectory == "default":
        s["trajectory"] = _stationary_trajectory()
    elif trajectory is not None:
        s["trajectory"] = trajectory
    return s


# --------------------------------------------------------------------------- #
# Validation (no native build needed)                                           #
# --------------------------------------------------------------------------- #

def test_risley_without_prisms_fails(client):
    resp = client.post("/api/lidar/scan", json={
        "meshes": [_wall_mesh()],
        "scanners": [_risley_scanner(prisms=None)],
    })
    assert resp.status_code == 200
    body, _ = decode_bin_frame(resp.content)
    assert body["success"] is False
    assert "prism" in body["error"].lower()


def test_risley_without_trajectory_fails(client):
    resp = client.post("/api/lidar/scan", json={
        "meshes": [_wall_mesh()],
        "scanners": [_risley_scanner(prisms=_MID40_PRISMS, trajectory=None)],
    })
    assert resp.status_code == 200
    body, _ = decode_bin_frame(resp.content)
    assert body["success"] is False
    assert "trajectory" in body["error"].lower()


def test_risley_zero_prf_fails(client):
    resp = client.post("/api/lidar/scan", json={
        "meshes": [_wall_mesh()],
        "scanners": [_risley_scanner(prisms=_MID40_PRISMS, prf=0.0)],
    })
    assert resp.status_code == 200
    body, _ = decode_bin_frame(resp.content)
    assert body["success"] is False
    assert "prf" in body["error"].lower() or "pulse_rate" in body["error"].lower()


# --------------------------------------------------------------------------- #
# End-to-end ray tracing (needs the compiled lidar plugin)                      #
# --------------------------------------------------------------------------- #

class TestRealRisleyScan:
    def _scan(self, client, scanners):
        pytest.importorskip("pyhelios")
        resp = client.post("/api/lidar/scan", json={
            "meshes": [_wall_mesh()],
            "scanners": scanners,
        })
        assert resp.status_code == 200, resp.text
        body = decode_lidar_scan(resp.content)
        assert body["success"] is True, body.get("error")
        return body

    def test_mid40_rosette_fills_the_published_circular_fov(self, client):
        body = self._scan(client, [_risley_scanner("mid40", prisms=_MID40_PRISMS)])
        assert len(body["results"]) == 1
        res = body["results"][0]
        assert res["scanner_id"] == "mid40"
        assert res["num_points"] > 200, "the rosette should return many hits on the wall"

        pts = np.array(res["points"], dtype=np.float64)
        assert np.isfinite(pts).all()

        # Beam directions from the scanner origin (at world 0). The optical axis is
        # +y; the half-angle of each beam is its angle from +y.
        dirs = pts / np.linalg.norm(pts, axis=1, keepdims=True)
        half_angles = np.degrees(np.arccos(np.clip(dirs[:, 1], -1.0, 1.0)))

        # Emergent circular FOV: every beam within the published ~19.2° half-angle
        # (a small margin for beam-footprint + wall discretization), and the pattern
        # genuinely spreads out to near that edge (not collapsed on-axis — which
        # would mean the prism refraction was skipped).
        assert half_angles.max() < _MID40_FOV_HALFANGLE_DEG + 3.0, (
            f"beams exceed the Mid-40 FOV: max half-angle {half_angles.max():.1f}°")
        assert half_angles.max() > _MID40_FOV_HALFANGLE_DEG - 6.0, (
            f"rosette did not fill its FOV: max half-angle {half_angles.max():.1f}°")

        # Circular (not a raster band): the hit footprint on the wall is roughly as
        # wide in x as in z about the axis — a hemispherical scatter or a line scan
        # would break this.
        span_x = pts[:, 0].max() - pts[:, 0].min()
        span_z = pts[:, 2].max() - pts[:, 2].min()
        assert 0.5 < span_x / span_z < 2.0, (
            f"FOV not circular: x-span {span_x:.2f} vs z-span {span_z:.2f}")

        # A Risley scan is trajectory-driven: every hit carries a timestamp, never
        # a spinning 'channel'.
        scalars = res["scalars"]
        assert "timestamp" in scalars
        assert len(scalars["timestamp"]) == res["num_points"]
        assert "channel" not in scalars

    def test_avia_wider_fov_than_mid40(self, client):
        # The Avia's larger wedges fill a wider FOV (70.4°×77.2°) than the Mid-40's
        # 38.4°, so its beams reach a materially larger max half-angle. This proves
        # the wedge geometry — not a fixed cone — drives the FOV.
        avia_prisms = [
            {"wedge_angle_deg": 30.8856, "refractive_index": 1.51, "rotor_rate_hz": -131.5463},
            {"wedge_angle_deg": 29.7735, "refractive_index": 1.51, "rotor_rate_hz": 40.8032},
            {"wedge_angle_deg": 3.1351, "refractive_index": 1.51, "rotor_rate_hz": 213.1611},
        ]
        mid40 = self._scan(client, [_risley_scanner("m", prisms=_MID40_PRISMS)])["results"][0]
        avia = self._scan(client, [_risley_scanner("a", prisms=avia_prisms, prf=40000.0)])["results"][0]

        def max_halfangle(res):
            pts = np.array(res["points"], dtype=np.float64)
            dirs = pts / np.linalg.norm(pts, axis=1, keepdims=True)
            return np.degrees(np.arccos(np.clip(dirs[:, 1], -1.0, 1.0))).max()

        assert max_halfangle(avia) > max_halfangle(mid40) + 5.0, (
            "Avia's larger wedges should fill a wider FOV than the Mid-40")
