"""Synthetic LiDAR scans can carry per-organ labels from a generated plant.

A generated plant mesh tags each triangle with a Helios ``object_label`` organ
type, mapped to a small int code (``_ORGAN_LABEL_TO_CODE``). When the user opts
in, those codes ride to the backend as ``organ_codes`` on each scan mesh; the
loader stamps them onto the loaded primitives as ``"organ"`` int primitive data,
and — because ``"organ"`` is requested in ``extra_fields`` — the ray tracer
samples that data onto every hit (LiDAR.cpp column_format). The hit then reports
which organ it struck.

These tests drive the real ``/api/lidar/scan`` endpoint and assert the per-hit
``organ`` scalar matches the triangle the ray landed on. The textured case is the
important one: the multi-material loader regroups triangles by material id, so a
naive per-triangle mapping would mislabel every leaf hit — the loader sidesteps
that by loading one material slot at a time. Here we interleave two materials with
DISTINCT organ codes so a scrambled mapping would be caught.

Requires the compiled pyhelios lidar plugin (skipped on a mock build) and Pillow.
"""
import base64
import io

import numpy as np
import pytest

from tests.binframe import decode_lidar_scan


def _opaque_png(rgb=(40, 140, 50), size=32):
    """A fully-opaque solid-color PNG (base64) — every ray that hits the quad
    registers a return, so the organ label is what we're testing, not alpha."""
    Image = pytest.importorskip("PIL.Image")
    img = Image.new("RGBA", (size, size), (rgb[0], rgb[1], rgb[2], 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _overhead_scanner(scanner_id="s0"):
    # 3 m above the patches, full upper hemisphere so the cone covers both quads.
    return {
        "id": scanner_id,
        "origin": [0.0, 0.0, 3.0],
        "n_theta": 220,
        "n_phi": 220,
        "theta_min_deg": 0.0,
        "theta_max_deg": 180.0,
        "phi_min_deg": 0.0,
        "phi_max_deg": 360.0,
        "return_type": "single",
        "exit_diameter_m": 0.0,
        "beam_divergence_mrad": 0.0,
    }


def _run(client, mesh, extra_fields=None):
    body = {"meshes": [mesh], "scanners": [_overhead_scanner()]}
    if extra_fields is not None:
        body["extra_fields"] = extra_fields
    resp = client.post("/api/lidar/scan", json=body)
    assert resp.status_code == 200, resp.text
    decoded = decode_lidar_scan(resp.content)
    assert decoded["success"] is True, decoded.get("error")
    res = decoded["results"][0]
    n = res["num_points"]
    pts = (np.array(res["points"], dtype=np.float64).reshape(-1, 3)
           if n else np.zeros((0, 3)))
    return res, n, pts


# Two coplanar-ish wedges: LEFT (x<0) and RIGHT (x>0), each a slight z-tilt so the
# AABB isn't degenerate. Verts 0-3 = left quad, 4-7 = right quad.
_VERTS = [
    [-0.9, -0.3, 0.0], [-0.3, -0.3, 0.0], [-0.3, 0.3, 0.15], [-0.9, 0.3, 0.15],
    [0.3, -0.3, 0.0], [0.9, -0.3, 0.0], [0.9, 0.3, 0.15], [0.3, 0.3, 0.15],
]
# Triangle order INTERLEAVES the two quads (L, R, L, R) so the textured loader's
# regroup-by-material is non-trivial — a wrong mapping swaps the organ labels.
_TRIS = [[0, 1, 2], [4, 5, 6], [0, 2, 3], [4, 6, 7]]
_UVS = [
    [0, 0], [1, 0], [1, 1], [0, 1],
    [0, 0], [1, 0], [1, 1], [0, 1],
]
# LEFT quad = leaf (organ code 1), RIGHT quad = fruit (organ code 5).
_ORGAN_CODES = [1, 5, 1, 5]


class TestOrganLabeledScan:
    def _textured_mesh(self, organ=True):
        mesh = {
            "vertices": _VERTS,
            "triangles": _TRIS,
            "colors": [[0.2, 0.6, 0.2]] * 8,
            "uv_coordinates": _UVS,
            "materials": [
                {"name": "leaf", "texture_data": _opaque_png((40, 140, 50)),
                 "has_alpha": True, "triangle_indices": [0, 2]},   # left quad
                {"name": "fruit", "texture_data": _opaque_png((180, 40, 40)),
                 "has_alpha": True, "triangle_indices": [1, 3]},   # right quad
            ],
        }
        if organ:
            mesh["organ_codes"] = _ORGAN_CODES
        return mesh

    def test_textured_multi_material_organ_labels_track_geometry(self, client):
        """Left (leaf=1) and right (fruit=5) hits carry the right organ code even
        though the textured loader regroups triangles by material."""
        pytest.importorskip("pyhelios")
        res, n, pts = _run(client, self._textured_mesh(), extra_fields=["organ"])
        assert "organ" in res["scalars"], "organ scalar was not sampled onto hits"
        organ = np.asarray(res["scalars"]["organ"], dtype=np.float64)
        assert len(organ) == n

        left = pts[:, 0] < 0.0
        right = pts[:, 0] > 0.0
        assert left.sum() > 50 and right.sum() > 50, "need hits on both quads"

        # Every left hit is a leaf; every right hit is a fruit. Round defends
        # against float32 storage of the int code.
        assert np.all(np.rint(organ[left]) == 1), "left (leaf) hits mislabeled"
        assert np.all(np.rint(organ[right]) == 5), "right (fruit) hits mislabeled"

    def test_untextured_path_labels_hits(self, client):
        """The color-only path stamps + samples organ codes too (input order)."""
        pytest.importorskip("pyhelios")
        mesh = {
            "vertices": _VERTS,
            "triangles": _TRIS,
            "colors": [[0.2, 0.6, 0.2]] * 8,
            "organ_codes": _ORGAN_CODES,
        }
        res, n, pts = _run(client, mesh, extra_fields=["organ"])
        assert "organ" in res["scalars"]
        organ = np.asarray(res["scalars"]["organ"], dtype=np.float64)
        left = pts[:, 0] < 0.0
        right = pts[:, 0] > 0.0
        assert left.sum() > 50 and right.sum() > 50
        assert np.all(np.rint(organ[left]) == 1)
        assert np.all(np.rint(organ[right]) == 5)

    def test_opt_out_omits_organ_scalar(self, client):
        """Without 'organ' in extra_fields the scan does not fabricate the field —
        this is the backend half of the opt-in gate (the viewer sends neither the
        codes nor the extra field unless the box is checked)."""
        pytest.importorskip("pyhelios")
        res, n, _ = _run(client, self._textured_mesh(organ=False), extra_fields=None)
        assert n > 0
        assert "organ" not in res["scalars"], "organ leaked into an opt-out scan"
