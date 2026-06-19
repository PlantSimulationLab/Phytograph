"""Tests that synthetic LiDAR scans honor a texture's alpha channel.

Leaf textures are leaf-shaped opaque cutouts on a transparent background. When a
mesh is scanned, Helios ray-traces against the texture's alpha channel, so rays
return hits only where the leaf is opaque and pass through the transparent
regions — instead of treating each leaf quad as a solid rectangle. These tests
drive the real `/api/lidar/scan` endpoint with a textured material and assert,
statistically, that the alpha mask gates the returns.

The check is distributional (fewer hits, and they cluster where the texture is
opaque) — not cylinder-by-cylinder — so it stays robust to ray-count and
footprint details while still proving the mechanism actually works.

Requires the compiled pyhelios lidar plugin (skipped on a mock/CI build) and
Pillow (a transitive core dep via open3d/matplotlib) to author the fixture.
"""
import base64
import io

import numpy as np
import pytest

from tests.binframe import decode_lidar_scan


# A square patch given a real z-thickness on two corners. A perfectly flat
# (coplanar) mesh collapses the lidar engine's AABB and scans to zero hits, so
# the patch is a shallow wedge: enough thickness for a non-degenerate AABB while
# staying essentially a flat leaf facing the scanner. See test_lidar_scan.py.
_H = 0.5
_TILT = 0.25
_QUAD_VERTS = [
    [-_H, -_H, 0.0],
    [_H, -_H, 0.0],
    [_H, _H, _TILT],
    [-_H, _H, _TILT],
]
_QUAD_TRIS = [[0, 1, 2], [0, 2, 3]]
# Per-vertex UVs: quad corners map to the texture corners.
_QUAD_UVS = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
# Opaque disk radius as a fraction of the (half-unit) texture, matching the PNG.
_DISK_FRAC = 0.30


def _alpha_disk_png(size=128, disk_frac=_DISK_FRAC):
    """A PNG opaque in a center disk, transparent in the corners (base64)."""
    Image = pytest.importorskip("PIL.Image")
    img = Image.new("RGBA", (size, size), (40, 140, 50, 0))
    px = img.load()
    c = (size - 1) / 2.0
    r = size * disk_frac
    for y in range(size):
        for x in range(size):
            if (x - c) ** 2 + (y - c) ** 2 <= r * r:
                px[x, y] = (40, 140, 50, 255)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _overhead_scanner(scanner_id="s0"):
    # Scanner 3 m above the patch, full upper-hemisphere sweep (theta 0..180) so
    # the cone covers the whole 1 m patch. Dense raster for a stable hit count.
    return {
        "id": scanner_id,
        "origin": [0.0, 0.0, 3.0],
        "n_theta": 300,
        "n_phi": 300,
        "theta_min_deg": 0.0,
        "theta_max_deg": 180.0,
        "phi_min_deg": 0.0,
        "phi_max_deg": 360.0,
        "return_type": "single",
        "exit_diameter_m": 0.0,
        "beam_divergence_mrad": 0.0,
    }


def _scan(client, mesh):
    resp = client.post("/api/lidar/scan", json={
        "meshes": [mesh],
        "scanners": [_overhead_scanner()],
    })
    assert resp.status_code == 200, resp.text
    body = decode_lidar_scan(resp.content)
    assert body["success"] is True, body.get("error")
    res = body["results"][0]
    n = res["num_points"]
    pts = (np.array(res["points"], dtype=np.float64).reshape(-1, 3)
           if n else np.zeros((0, 3)))
    return n, pts


class TestAlphaMaskedScan:
    """The texture alpha channel gates which rays return hits."""

    def _opaque_mesh(self):
        return {
            "vertices": _QUAD_VERTS,
            "triangles": _QUAD_TRIS,
            "colors": [[0.2, 0.6, 0.2]] * 4,
        }

    def _alpha_mesh(self):
        return {
            "vertices": _QUAD_VERTS,
            "triangles": _QUAD_TRIS,
            "colors": [[0.2, 0.6, 0.2]] * 4,
            "uv_coordinates": _QUAD_UVS,
            "materials": [{
                "name": "leaf",
                "texture_data": _alpha_disk_png(),
                "has_alpha": True,
                "triangle_indices": [0, 1],
            }],
        }

    def test_alpha_mask_reduces_hits(self, client):
        pytest.importorskip("pyhelios")
        n_opaque, _ = _scan(client, self._opaque_mesh())
        n_alpha, _ = _scan(client, self._alpha_mesh())

        assert n_opaque > 500, "opaque control should produce a dense return"
        assert n_alpha > 0, "the opaque disk should still return some hits"
        # The transparent corners must drop a substantial fraction of returns.
        # Probe measured ~0.55; require a clear, margin-safe reduction.
        assert n_alpha < 0.80 * n_opaque, (
            f"alpha mask barely changed hits ({n_alpha} vs {n_opaque}); "
            "texture transparency is not gating rays"
        )

    def test_alpha_hits_concentrate_where_texture_is_opaque(self, client):
        pytest.importorskip("pyhelios")
        _, pts_opaque = _scan(client, self._opaque_mesh())
        _, pts_alpha = _scan(client, self._alpha_mesh())
        assert len(pts_opaque) > 0 and len(pts_alpha) > 0

        # Radial distance from the patch center (xy plane). Alpha hits must stay
        # inside the opaque disk, well within the opaque control's footprint —
        # proving rays passed THROUGH the transparent corners rather than just
        # thinning uniformly.
        r_opaque = np.sqrt(pts_opaque[:, 0] ** 2 + pts_opaque[:, 1] ** 2)
        r_alpha = np.sqrt(pts_alpha[:, 0] ** 2 + pts_alpha[:, 1] ** 2)

        assert r_alpha.max() < 0.75 * r_opaque.max(), (
            "alpha hits reach as far out as opaque hits — corners not masked"
        )
        assert r_alpha.mean() < r_opaque.mean(), (
            "alpha hits are not pulled toward the opaque center"
        )
