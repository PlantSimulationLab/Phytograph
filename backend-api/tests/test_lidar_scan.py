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


# A solid 1 m cube centered at z=0.5 — a finite-VOLUME target. Multibeam scans
# need this (not a flat patch or a thin near-coplanar pyramid): the lidar engine
# culls rays against the geometry's axis-aligned bounding box, and a degenerate
# (zero-thickness) AABB collapses a slab and reports every ray as a miss,
# regardless of scan pattern. A closed box gives a non-degenerate AABB so the
# multibeam channels land real returns just like a raster sweep does.
_BOX_CENTER = (0.0, 0.0, 0.5)
_BOX_HALF = 0.5  # half-extent → 1 m cube spanning z in [0, 1]


def _box_mesh(center=_BOX_CENTER, half=_BOX_HALF):
    cx, cy, cz = center
    verts = [[cx + dx * half, cy + dy * half, cz + dz * half]
             for dx in (-1, 1) for dy in (-1, 1) for dz in (-1, 1)]
    tris = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
            [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]]
    return verts, tris


_BOX_VERTS, _BOX_TRIS = _box_mesh()


def _multibeam_scanner(scanner_id="mb", origin=(0.0, 0.0, 3.0),
                       elevations=(-40.0, -50.0, -60.0, -70.0, -80.0), n_phi=720):
    """A spinning-multibeam scanner aimed downward at the box below it.

    Elevations are degrees above horizon (negative = below horizon, i.e. looking
    down). Each becomes one laser channel; the count sets the zenith resolution.
    """
    return {
        "id": scanner_id,
        "origin": list(origin),
        "scan_pattern": "spinning_multibeam",
        "beam_elevation_angles_deg": list(elevations),
        # n_theta / theta_* are ignored for multibeam but the model requires them.
        "n_theta": 1,
        "n_phi": n_phi,
        "theta_min_deg": 0.0,
        "theta_max_deg": 180.0,
        "phi_min_deg": 0.0,
        "phi_max_deg": 360.0,
        "return_type": "single",
        "exit_diameter_m": 0.0,
        "beam_divergence_mrad": 0.0,
    }


class TestMultibeamScan:
    """Spinning-multibeam pattern against the compiled lidar plugin."""

    def test_multibeam_produces_real_returns_on_the_box(self, client):
        # A multi-channel sensor 3 m above the box, sweeping downward, lands real
        # returns on the top face — exactly as the raster path does.
        pytest.importorskip("pyhelios")
        resp = client.post("/api/lidar/scan", json={
            "meshes": [{"vertices": _BOX_VERTS, "triangles": _BOX_TRIS}],
            "scanners": [_multibeam_scanner("mb")],
        })
        assert resp.status_code == 200, resp.text
        body = decode_lidar_scan(resp.content)
        assert body["success"] is True, body.get("error")
        assert len(body["results"]) == 1
        res = body["results"][0]
        assert res["scanner_id"] == "mb"
        assert res["num_points"] > 0, "multibeam sweep over the box should hit it"
        pts = np.array(res["points"], dtype=np.float64)
        assert np.isfinite(pts).all()
        # Hits sit on the solid cube (z in [0, 1]) within its footprint.
        assert pts[:, 2].min() >= -1e-3
        assert pts[:, 2].max() <= 1.0 + 1e-3
        assert pts[:, 0].min() >= -_BOX_HALF - 1e-3 and pts[:, 0].max() <= _BOX_HALF + 1e-3
        assert pts[:, 1].min() >= -_BOX_HALF - 1e-3 and pts[:, 1].max() <= _BOX_HALF + 1e-3

    def test_channel_count_sets_the_zenith_resolution(self, client):
        # Ntheta == number of channels, so a denser elevation list samples the
        # surface more finely → more hits than a sparse one (statistical check).
        pytest.importorskip("pyhelios")

        def scan(elevs):
            resp = client.post("/api/lidar/scan", json={
                "meshes": [{"vertices": _BOX_VERTS, "triangles": _BOX_TRIS}],
                "scanners": [_multibeam_scanner("mb", elevations=elevs)],
            })
            assert resp.status_code == 200, resp.text
            body = decode_lidar_scan(resp.content)
            assert body["success"] is True, body.get("error")
            return body["results"][0]["num_points"]

        # Steep-enough elevations so both sets land on the box's top face (a
        # 0.5 m-wide face 2 m below the scanner; shallow beams sweep past it).
        sparse = scan((-60.0, -80.0))
        dense = scan(tuple(float(-40 - 5 * i) for i in range(10)))  # 10 channels
        assert sparse > 0
        assert dense > sparse

    def test_empty_elevation_list_is_rejected(self, client):
        # A multibeam scanner with no channels can't define any beams → failure,
        # not a silent empty scan.
        pytest.importorskip("pyhelios")
        scanner = _multibeam_scanner("mb")
        scanner["beam_elevation_angles_deg"] = []
        resp = client.post("/api/lidar/scan", json={
            "meshes": [{"vertices": _BOX_VERTS, "triangles": _BOX_TRIS}],
            "scanners": [scanner],
        })
        assert resp.status_code == 200
        body, _ = decode_bin_frame(resp.content)
        assert body["success"] is False
        assert "elevation" in body["error"].lower()


class TestScanOptions:
    """Noise, tilt, and miss-recording run-options against the compiled plugin."""

    def _scan_full(self, client, scanners, **req_opts):
        """POST a full request (so we can set per-scanner noise/tilt + request-level
        record_misses) and return the decoded per-scanner result."""
        pytest.importorskip("pyhelios")
        resp = client.post("/api/lidar/scan", json={
            "meshes": [{"vertices": _PYRAMID_VERTS, "triangles": _PYRAMID_TRIS}],
            "scanners": scanners,
            **req_opts,
        })
        assert resp.status_code == 200, resp.text
        body = decode_lidar_scan(resp.content)
        assert body["success"] is True, body.get("error")
        return body

    def test_range_noise_perturbs_along_beam_distance(self, client):
        # Same scanner + identical grid → the same beams fire in the same order, so
        # we can pair each noised hit's range against its noise-free counterpart.
        # The per-ray DIFFERENCE isolates the injected noise from the geometry's
        # own distance spread; its std should land near the 50 mm we asked for
        # (statistical check — not asserting any single ray).
        SIGMA = 0.05
        clean = self._scan_full(client, [_scanner("c")])["results"][0]
        noisy = self._scan_full(client, [{**_scanner("c"), "range_noise_m": SIGMA}])["results"][0]

        assert clean["num_points"] > 50
        # Misses are off, so both scans hit the same surface points in the same
        # order; require the counts to match before pairing.
        assert noisy["num_points"] == clean["num_points"]
        clean_d = np.asarray(clean["scalars"]["distance"], dtype=np.float64)
        noisy_d = np.asarray(noisy["scalars"]["distance"], dtype=np.float64)
        diff = noisy_d - clean_d
        # The noise is zero-mean and ~SIGMA wide. With dozens of hits the sample
        # std lands in a generous band around SIGMA; the clean-vs-clean diff is 0.
        assert diff.std() > SIGMA * 0.5
        assert diff.std() < SIGMA * 2.0
        assert abs(diff.mean()) < SIGMA  # zero-mean perturbation

    def test_tilt_rotates_the_hit_pattern(self, client):
        # A level scan vs a 20° rolled scan from the same origin must produce a
        # different hit cloud (the beams point elsewhere). Compare the hit
        # centroids: tilting the scanner shifts where the swept cone lands.
        level = self._scan_full(client, [_scanner("t")])["results"][0]
        tilted_scanner = {**_scanner("t"), "tilt_roll_deg": 20.0}
        tilted = self._scan_full(client, [tilted_scanner])["results"][0]

        assert level["num_points"] > 0 and tilted["num_points"] > 0
        lc = np.asarray(level["points"], dtype=np.float64).mean(axis=0)
        tc = np.asarray(tilted["points"], dtype=np.float64).mean(axis=0)
        # Centroid moves by a non-trivial amount once the scanner is tilted 20°.
        assert np.linalg.norm(lc - tc) > 1e-2

    def test_azimuth_offset_is_accepted_but_not_yet_consumed(self, client):
        # The renderer sends scan_azimuth_offset_deg (initial scanner heading), but
        # helios-core / PyHelios don't expose the field yet, so the backend accepts
        # it and IGNORES it (see the TODO(scanAzimuthOffset) blocks in main.py). This
        # pins that documented behavior: the request must succeed, and the hit cloud
        # must be IDENTICAL to one without the field — proving it is truly a no-op
        # today. When Helios gains the field and the placeholders are wired up, this
        # test should start failing (geometry will differ) and be replaced with a
        # real "heading rotates the hit pattern" assertion, mirroring the tilt test.
        base = self._scan_full(client, [_scanner("a")])["results"][0]
        headed = self._scan_full(
            client, [{**_scanner("a"), "scan_azimuth_offset_deg": 90.0}]
        )["results"][0]

        assert base["num_points"] > 0
        assert headed["num_points"] == base["num_points"]
        bc = np.asarray(base["points"], dtype=np.float64)
        hc = np.asarray(headed["points"], dtype=np.float64)
        # Same beams in the same order → identical hits (field ignored for now).
        assert np.allclose(bc, hc)

    def test_record_misses_builds_a_session_with_is_miss(self, client):
        # A scanner sweeping the full sphere from above mostly misses the small
        # pyramid. With record_misses on, those rays are kept, flagged is_miss,
        # and the scan is routed through a cloud session so the overlay/LAD work.
        body = self._scan_full(client, [_scanner("m")], record_misses=True)
        res = body["results"][0]
        assert res["num_points"] > 0
        session = res["session"]
        assert session is not None, "record_misses should create a cloud session"
        assert session["has_misses"] is True
        assert session["miss_count"] > 0
        sid = session["session_id"]

        # Regression (camera auto-fit flies to infinity): the in-memory render
        # points must be HITS ONLY. syntheticScan() places miss points ~1 km out
        # along each beam (LIDAR_RAYTRACE_MISS_T = 1001 m). If they leak into the
        # primary point array, the cloud's bounding box spans ~2 km, the camera
        # auto-fit (distance = 2 * maxDim) parks the view ~4 km from a sub-metre
        # target, and the user can't zoom back in. The misses are preserved in the
        # session (for the overlay + LAD), so the render array must exclude them.
        pts = np.asarray(res["points"], dtype=np.float64)
        assert res["num_points"] == pts.shape[0]
        # The pyramid spans <1 m about the origin; every hit must be within a few
        # metres. A miss leaking in would push this to ~1000 m. Use a tight bound
        # (10 m) so even one stray far point fails — not the 1 km miss distance.
        assert np.abs(pts).max() < 10.0, "miss point (~1 km) leaked into render cloud"

        # The session-based miss overlay endpoint must find those misses and
        # project them onto the bounding sphere around the scanner origin.
        r = client.get(f"/api/cloud/session/{sid}/misses",
                       params={"origin_x": 0.0, "origin_y": 0.0, "origin_z": 3.0})
        assert r.status_code == 200, r.text
        misses = r.json()
        assert misses["total"] > 0
        assert misses["count"] > 0  # placeable (have a beam direction from origin)
        assert len(misses["positions"]) == misses["count"] * 3

    def test_no_session_when_misses_not_recorded(self, client):
        # Default (record_misses off): plain in-memory cloud, no session created.
        body = self._scan_full(client, [_scanner("n")])
        assert body["results"][0]["session"] is None
