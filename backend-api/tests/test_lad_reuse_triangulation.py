"""Tests for reusing a previously-run Helios triangulation in LAD inversion.

When a user reuses a triangulation, the backend must NOT re-run the (potentially
minutes-long) Delaunay pass — it injects the already-computed mesh via
cloud.setExternalTriangulation and runs the inversion on that. These tests pin
the equivalence (reuse-LAD == fresh-LAD per cell) and the core guarantee
(triangulateHitPoints is not called on the reuse path), plus the scan-id
remapping contract and the binary request-frame decoder.

The mesh is captured from a real fresh run by spying on triangulateHitPoints,
reading getTriangleVerticesAll() off the cloud, and deduplicating to the indexed
(vertices + index triples) form the renderer stores and sends back.
"""

import json
import os

import numpy as np
import pytest

import main

_FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "lad-leafcube")
_FIXTURE_XYZ = os.path.join(_FIXTURE_DIR, "leafcube.xyz")
_FIXTURE_ORIGIN = [-5.0, 0.0, 0.5]


def _request(nx=1, ny=1, nz=1):
    scan = main.HeliosScanEntry(
        file_path=_FIXTURE_XYZ, ascii_format="x y z is_miss",
        origin=_FIXTURE_ORIGIN,
        n_theta=2600, n_phi=5200, theta_min=0, theta_max=180,
        phi_min=0, phi_max=360, return_type="single")
    return main.LADComputeRequest(
        scans=[scan],
        grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=nx, ny=ny, nz=nz),
        lmax=0.04, max_aspect_ratio=10, min_voxel_hits=1)


def _capture_mesh(request, monkeypatch):
    """Run a fresh LAD and capture the mesh it triangulated, indexed like the
    renderer stores it. Returns (vertices(V,3) f32, indices(T,3) u32,
    scan_ids(T,) i32) and the fresh result dict."""
    from pyhelios import LiDARCloud

    captured = {}
    real = LiDARCloud.triangulateHitPoints

    def spy(self, lmax, max_aspect_ratio):
        real(self, lmax, max_aspect_ratio)
        flat, scan = self.getTriangleVerticesAll()  # (T*9,) f32, (T,) i32
        captured["flat"] = np.asarray(flat, dtype=np.float32).reshape(-1, 3)
        captured["scan"] = np.asarray(scan, dtype=np.int32)

    monkeypatch.setattr(LiDARCloud, "triangulateHitPoints", spy)
    result = main._do_lad_computation(request)
    monkeypatch.undo()

    assert "flat" in captured, "triangulateHitPoints was not called on the fresh run"
    # Dedup to indexed form (rounding to 5 dp mirrors _do_helios_computation).
    soup = captured["flat"]
    rounded = np.round(soup, 5)
    unique, inverse = np.unique(rounded, axis=0, return_inverse=True)
    indices = inverse.ravel().reshape(-1, 3).astype(np.uint32)
    verts = unique.astype(np.float32)
    return verts, indices, captured["scan"], result


def _cells_by_octant(result):
    """Map result cells -> {(i,j,k): cell} so per-cell comparison is order-free."""
    out = {}
    for c in result["cells"]:
        cx, cy, cz = c["center"]
        key = (1 if cx > 0 else 0, 1 if cy > 0 else 0, 1 if cz > 0.5 else 0)
        out[key] = c
    return out


@pytest.mark.skipif(not os.path.isfile(_FIXTURE_XYZ),
                    reason="lad-leafcube fixture not present")
class TestReuseEquivalence:

    def test_reuse_matches_fresh_per_cell(self, monkeypatch):
        pytest.importorskip("pyhelios")
        req = _request(nx=2, ny=2, nz=2)
        verts, indices, scan_ids, fresh = _capture_mesh(req, monkeypatch)
        assert fresh["success"] is True, fresh.get("error")

        reuse = main._do_lad_computation(req, reuse_mesh=(verts, indices, scan_ids))
        assert reuse["success"] is True, reuse.get("error")

        a = _cells_by_octant(fresh)
        b = _cells_by_octant(reuse)
        assert a.keys() == b.keys()
        for key in a:
            # The reuse round-trip adds only float32 quantization, the 5-dp dedup
            # rounding (mirroring _do_helios_computation's vertex export), and
            # centroid- vs first-vertex grid binning. ~3% per cell bounds that drift
            # while still firmly proving equivalence — a real defect in how G(theta)
            # consumes the injected mesh would blow far past it (cf. the moving-layer
            # sphere bug that pinned whole layers near zero).
            assert b[key]["lad"] == pytest.approx(a[key]["lad"], rel=0.03, abs=1e-4), \
                f"cell {key} lad: fresh {a[key]['lad']} vs reuse {b[key]['lad']}"
            assert b[key]["gtheta"] == pytest.approx(a[key]["gtheta"], rel=0.03, abs=1e-4), \
                f"cell {key} gtheta: fresh {a[key]['gtheta']} vs reuse {b[key]['gtheta']}"

    def test_reuse_does_not_retriangulate(self, monkeypatch):
        """The core guarantee: the reuse path must not call triangulateHitPoints."""
        pytest.importorskip("pyhelios")
        from pyhelios import LiDARCloud
        req = _request()
        verts, indices, scan_ids, _ = _capture_mesh(req, monkeypatch)

        calls = {"n": 0}
        real = LiDARCloud.triangulateHitPoints

        def spy(self, lmax, aspect):
            calls["n"] += 1
            return real(self, lmax, aspect)

        monkeypatch.setattr(LiDARCloud, "triangulateHitPoints", spy)
        result = main._do_lad_computation(req, reuse_mesh=(verts, indices, scan_ids))
        monkeypatch.undo()
        assert result["success"] is True, result.get("error")
        assert calls["n"] == 0, "reuse path must not re-run triangulateHitPoints"

    def test_reuse_scan_ids_in_any_order(self, monkeypatch):
        """Single-scan mesh: every triangle's scan id is 0, which must point at the
        sole request scan regardless. (The renderer remaps to request order; this
        asserts the backend honors whatever 0-based indices it's given.)"""
        pytest.importorskip("pyhelios")
        req = _request()
        verts, indices, scan_ids, _ = _capture_mesh(req, monkeypatch)
        assert set(np.unique(scan_ids).tolist()) == {0}
        reuse = main._do_lad_computation(req, reuse_mesh=(verts, indices, scan_ids))
        assert reuse["success"] is True, reuse.get("error")


@pytest.mark.skipif(not os.path.isfile(_FIXTURE_XYZ),
                    reason="lad-leafcube fixture not present")
class TestReuseValidationAndFrame:

    def _mesh(self, monkeypatch):
        return _capture_mesh(_request(), monkeypatch)

    def _frame(self, meta, verts, indices, scan_ids):
        return main._bin_frame_bytes(meta, [
            ("mesh_vertices", verts.reshape(-1), "f32"),
            ("mesh_indices", indices.reshape(-1), "u32"),
            ("mesh_scan_ids", np.asarray(scan_ids, dtype=np.uint32), "u32"),
        ])

    def _meta(self):
        return json.loads(_request().model_dump_json())

    def test_frame_round_trips(self, monkeypatch):
        pytest.importorskip("pyhelios")
        verts, indices, scan_ids, _ = self._mesh(monkeypatch)
        frame = self._frame(self._meta(), verts, indices, scan_ids)
        req, (v, i, s) = main._decode_lad_request_frame(frame)
        assert isinstance(req, main.LADComputeRequest)
        assert v.shape == verts.shape and i.shape == indices.shape
        assert np.array_equal(s, scan_ids.astype(np.int32))
        # And it actually computes.
        result = main._do_lad_computation(req, reuse_mesh=(v, i, s))
        assert result["success"] is True, result.get("error")

    def test_frame_bad_scan_id_rejected(self, monkeypatch):
        pytest.importorskip("pyhelios")
        verts, indices, scan_ids, _ = self._mesh(monkeypatch)
        bad = scan_ids.copy()
        bad[0] = 7  # only scan 0 exists
        frame = self._frame(self._meta(), verts, indices, bad)
        with pytest.raises(ValueError, match="scan count|scan_ids"):
            main._decode_lad_request_frame(frame)

    def test_frame_index_out_of_range_rejected(self, monkeypatch):
        pytest.importorskip("pyhelios")
        verts, indices, scan_ids, _ = self._mesh(monkeypatch)
        bad = indices.copy()
        bad[0, 0] = verts.shape[0] + 100
        frame = self._frame(self._meta(), verts, bad, scan_ids)
        with pytest.raises(ValueError, match="beyond mesh_vertices|vertex"):
            main._decode_lad_request_frame(frame)

    def test_frame_scan_id_length_mismatch_rejected(self, monkeypatch):
        pytest.importorskip("pyhelios")
        verts, indices, scan_ids, _ = self._mesh(monkeypatch)
        frame = self._frame(self._meta(), verts, indices, scan_ids[:-1])
        with pytest.raises(ValueError, match="one per triangle|expected"):
            main._decode_lad_request_frame(frame)
