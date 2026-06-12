"""Tests for the synthetic LiDAR scan endpoint (`POST /api/lidar/scan`).

The validation cases (missing geometry / scanners) run anywhere — they exercise
the endpoint's request handling without touching the native plugin. The
end-to-end ray-tracing cases require a compiled pyhelios with the `lidar` plugin
and are skipped when it isn't importable (CI without the native build).

The endpoint returns one result PER SCANNER (keyed by the scanner's `id`), each
carrying points + colors + per-hit scalar fields (intensity / distance /
timestamp / target_index / target_count). The assertions check real geometry and
real scalar data, not just "no error".

NOTE on the fixture shape: the lidar engine first culls scan rays against the
geometry's axis-aligned bounding box, so a perfectly flat (coplanar) mesh scans
to zero hits. We use a 3-D tetrahedron to exercise the true code path.
"""

import numpy as np
import pytest

from tests.binframe import decode_bin_frame, decode_lidar_scan


# A small solid pyramid (tetrahedron): base near z=0, apex at z=0.6.
_PYRAMID_VERTS = [
    [-0.5, -0.5, 0.0],
    [0.5, -0.5, 0.0],
    [0.0, 0.5, 0.0],
    [0.0, 0.0, 0.6],
]
_PYRAMID_TRIS = [[0, 1, 2], [0, 1, 3], [1, 2, 3], [0, 2, 3]]
_APEX_Z = 0.6


def _scanner(scanner_id="s0", origin=(0.0, 0.0, 3.0), return_type="single",
             theta=(0.0, 180.0)):
    return {
        "id": scanner_id,
        "origin": list(origin),
        "n_theta": 120,
        "n_phi": 120,
        "theta_min_deg": theta[0],
        "theta_max_deg": theta[1],
        "phi_min_deg": 0.0,
        "phi_max_deg": 360.0,
        "return_type": return_type,
        "exit_diameter_m": 0.0,
        "beam_divergence_mrad": 0.0,
    }


def test_no_meshes_returns_failure(client):
    resp = client.post("/api/lidar/scan", json={"meshes": [], "scanners": [_scanner()]})
    assert resp.status_code == 200
    body, _ = decode_bin_frame(resp.content)
    assert body["success"] is False
    assert "geometry" in body["error"].lower()


def test_no_scanners_returns_failure(client):
    resp = client.post("/api/lidar/scan", json={
        "meshes": [{"vertices": _PYRAMID_VERTS, "triangles": _PYRAMID_TRIS}],
        "scanners": [],
    })
    assert resp.status_code == 200
    body, _ = decode_bin_frame(resp.content)
    assert body["success"] is False
    assert "scanner" in body["error"].lower()


class TestRealScan:
    """End-to-end ray tracing against the compiled lidar plugin."""

    def _scan(self, client, scanners):
        pytest.importorskip("pyhelios")
        resp = client.post("/api/lidar/scan", json={
            "meshes": [{
                "vertices": _PYRAMID_VERTS,
                "triangles": _PYRAMID_TRIS,
                "colors": [[1.0, 0.0, 0.0]] * len(_PYRAMID_VERTS),
            }],
            "scanners": scanners,
        })
        assert resp.status_code == 200, resp.text
        body = decode_lidar_scan(resp.content)
        assert body["success"] is True, body.get("error")
        return body

    def test_discrete_hits_land_on_the_pyramid_with_scalars(self, client):
        body = self._scan(client, [_scanner("top", return_type="single")])
        # One result, keyed by the scanner id we sent.
        assert len(body["results"]) == 1
        res = body["results"][0]
        assert res["scanner_id"] == "top"
        assert res["num_points"] > 0, "scanner above the pyramid should produce hits"

        pts = np.array(res["points"], dtype=np.float64)
        assert np.isfinite(pts).all()
        # Hits sit on the solid pyramid (between base z=0 and apex), within footprint.
        assert pts[:, 2].min() >= -1e-3
        assert pts[:, 2].max() <= _APEX_Z + 1e-3
        assert pts[:, 0].min() >= -0.5 - 1e-3 and pts[:, 0].max() <= 0.5 + 1e-3
        assert pts[:, 1].min() >= -0.5 - 1e-3 and pts[:, 1].max() <= 0.5 + 1e-3

        # Per-hit scalar fields are present and aligned 1:1 with points.
        scalars = res["scalars"]
        for key in ("intensity", "distance", "timestamp", "target_index", "target_count"):
            assert key in scalars, f"missing scalar field {key}"
            assert len(scalars[key]) == res["num_points"]
        # Intensity is surfaced as a magnitude in [0, 1].
        inten = np.array(scalars["intensity"], dtype=np.float64)
        assert inten.min() >= 0.0 and inten.max() <= 1.0 + 1e-6
        # Distance from a scanner 3 m up onto a <1 m tall object is ~2.4–3 m.
        dist = np.array(scalars["distance"], dtype=np.float64)
        assert dist.min() > 2.0 and dist.max() < 3.1

    def test_multi_return_scan_also_hits_the_pyramid(self, client):
        body = self._scan(client, [_scanner("top", return_type="multi")])
        res = body["results"][0]
        assert res["num_points"] > 0
        pts = np.array(res["points"], dtype=np.float64)
        assert np.isfinite(pts).all()
        assert pts[:, 2].max() <= _APEX_Z + 5e-2
        # Multi-return records target_count per hit.
        assert "target_count" in res["scalars"]

    def test_scanner_aimed_away_returns_no_hits(self, client):
        # A scanner BELOW the geometry sweeping only the lower hemisphere never
        # hits the pyramid above it → its result has zero points.
        body = self._scan(client, [_scanner("below", origin=(0.0, 0.0, -3.0), theta=(90.0, 180.0))])
        res = body["results"][0]
        assert res["num_points"] == 0

    def test_two_scanners_are_returned_separately(self, client):
        # Two scanners → two results, each keyed by its own id, each with its own
        # points. This is what lets the renderer attach data per scanner.
        body = self._scan(client, [
            _scanner("A", origin=(0.0, 0.0, 3.0)),
            _scanner("B", origin=(3.0, 0.0, 0.3)),
        ])
        assert len(body["results"]) == 2
        by_id = {r["scanner_id"]: r for r in body["results"]}
        assert set(by_id) == {"A", "B"}
        assert by_id["A"]["num_points"] > 0
        assert by_id["B"]["num_points"] > 0
        # Independent hit sets (not the same merged cloud copied twice).
        assert not np.array_equal(by_id["A"]["points"], by_id["B"]["points"])
