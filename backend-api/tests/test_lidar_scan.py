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

import main
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
                       elevations=(-40.0, -50.0, -60.0, -70.0, -80.0), n_phi=720,
                       trajectory=None, pulse_rate_hz=None):
    """A spinning-multibeam scanner aimed downward at the box below it.

    Elevations are degrees above horizon (negative = below horizon, i.e. looking
    down). Each becomes one laser channel; the count sets the zenith resolution.
    `n_phi` is azimuth steps per revolution. A spinning sensor rotates
    continuously, so it is a MOVING-platform pattern: pass `trajectory` (+
    `pulse_rate_hz`) to make it valid. Without a trajectory the backend rejects it.
    """
    s = {
        "id": scanner_id,
        "origin": list(origin),
        "scan_pattern": "spinning_multibeam",
        "beam_elevation_angles_deg": list(elevations),
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
    if trajectory is not None:
        s["trajectory"] = trajectory
        s["pulse_rate_hz"] = pulse_rate_hz or 20000.0
    return s


def _stationary_capture(origin=(0.0, 0.0, 3.0), n_channels=5, n_phi=720,
                        pulse_rate_hz=20000.0):
    """A trajectory that expresses a STATIONARY spinning-multibeam capture: two
    poses at the SAME position one revolution-duration apart (so the moving path
    fires exactly one full 360° revolution from a fixed origin)."""
    rev_dur = (n_channels * n_phi) / pulse_rate_hz
    p = {"x": origin[0], "y": origin[1], "z": origin[2],
         "qx": 0, "qy": 0, "qz": 0, "qw": 1}
    return {"poses": [dict(t=0.0, **p), dict(t=rev_dur, **p)]}


class TestMultibeamScan:
    """Spinning-multibeam pattern. A rotating sensor is a MOVING-platform pattern:
    a stationary capture is expressed as a trajectory with two coincident poses one
    revolution apart. A multibeam scanner with NO trajectory is rejected."""

    def test_stationary_multibeam_without_trajectory_is_rejected(self, client):
        # No trajectory → a free-spinning sensor with no time element is ill-defined.
        resp = client.post("/api/lidar/scan", json={
            "meshes": [{"vertices": _BOX_VERTS, "triangles": _BOX_TRIS}],
            "scanners": [_multibeam_scanner("mb")],  # no trajectory
        })
        assert resp.status_code == 200
        body, _ = decode_bin_frame(resp.content)
        assert body["success"] is False
        assert "trajectory" in (body.get("error") or "").lower()
        assert "multibeam" in (body.get("error") or "").lower()

    def test_stationary_capture_via_one_revolution_trajectory(self, client):
        # The supported "stationary spinning multibeam": two coincident poses one
        # revolution apart → one full 360° revolution from a fixed origin, landing
        # real returns on the box.
        pytest.importorskip("pyhelios")
        elevs = (-40.0, -50.0, -60.0, -70.0, -80.0)
        scanner = _multibeam_scanner(
            "mb", elevations=elevs, n_phi=720,
            trajectory=_stationary_capture(n_channels=len(elevs), n_phi=720))
        resp = client.post("/api/lidar/scan", json={
            "meshes": [{"vertices": _BOX_VERTS, "triangles": _BOX_TRIS}],
            "scanners": [scanner]})
        assert resp.status_code == 200, resp.text
        body = decode_lidar_scan(resp.content)
        assert body["success"] is True, body.get("error")
        res = body["results"][0]
        assert res["scanner_id"] == "mb"
        assert res["num_points"] > 0, "one-revolution multibeam should hit the box"
        pts = np.array(res["points"], dtype=np.float64)
        assert np.isfinite(pts).all()
        assert pts[:, 2].min() >= -1e-3 and pts[:, 2].max() <= 1.0 + 1e-3
        assert pts[:, 0].min() >= -_BOX_HALF - 1e-3 and pts[:, 0].max() <= _BOX_HALF + 1e-3
        assert pts[:, 1].min() >= -_BOX_HALF - 1e-3 and pts[:, 1].max() <= _BOX_HALF + 1e-3

    def test_channel_count_sets_the_zenith_resolution(self, client):
        # Ntheta == number of channels, so a denser elevation list samples the
        # surface more finely → more hits than a sparse one (statistical check).
        pytest.importorskip("pyhelios")

        def scan(elevs):
            scanner = _multibeam_scanner(
                "mb", elevations=elevs, n_phi=720,
                trajectory=_stationary_capture(n_channels=len(elevs), n_phi=720))
            resp = client.post("/api/lidar/scan", json={
                "meshes": [{"vertices": _BOX_VERTS, "triangles": _BOX_TRIS}],
                "scanners": [scanner]})
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
        # not a silent empty scan. (With a trajectory so it reaches the channel check.)
        pytest.importorskip("pyhelios")
        scanner = _multibeam_scanner("mb", trajectory=_stationary_capture())
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

    def test_azimuth_offset_rotates_the_hit_pattern(self, client):
        # scan_azimuth_offset_deg (initial scanner heading) is applied by the
        # synthetic-scan generator via PyHelios addScan scan_azimuth_offset
        # (v0.1.23+), a right-hand rotation of the azimuth sweep about world +z.
        # A full 360° sweep is rotation-invariant about +z, so use a NARROW phi
        # window (a beam fan covering one sector): a 90° heading offset then
        # sweeps a different sector and steers the fan onto different geometry of
        # the (asymmetric) tetrahedron, moving the hit centroid — mirroring the
        # tilt test.
        fanned = {**_scanner("a"), "phi_min_deg": 0.0, "phi_max_deg": 90.0}
        base = self._scan_full(client, [fanned])["results"][0]
        headed = self._scan_full(
            client, [{**fanned, "scan_azimuth_offset_deg": 90.0}]
        )["results"][0]

        assert base["num_points"] > 0 and headed["num_points"] > 0
        bc = np.asarray(base["points"], dtype=np.float64).mean(axis=0)
        hc = np.asarray(headed["points"], dtype=np.float64).mean(axis=0)
        # Centroid moves once the scanner heading is offset 90°.
        assert np.linalg.norm(bc - hc) > 1e-2

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

        # The session must hold those misses, and the miss-octree projection
        # (_gather_miss_positions) must find them and place them on the bounding
        # sphere around the scanner origin (every one strictly outside the hits).
        sess = main._cloud_sessions[sid]
        pos, radius = main._gather_miss_positions(sess, [0.0, 0.0, 3.0])
        assert pos.shape[0] > 0  # placeable (have a beam direction from origin)
        assert radius > 0
        dist = np.linalg.norm(pos - np.array([0.0, 0.0, 3.0]), axis=1)
        assert np.allclose(dist, radius, rtol=1e-4)  # all on the sphere

    def test_no_session_when_misses_not_recorded(self, client):
        # Default (record_misses off): plain in-memory cloud, no session created.
        body = self._scan_full(client, [_scanner("n")])
        assert body["results"][0]["session"] is None


# A wide, low ground slab so a moving overhead pass produces hits along the whole
# flight line (not just under one static viewpoint). 8x2 m in x/y, ~0.4 m tall so
# the AABB isn't degenerate (the engine culls rays against a non-flat AABB).
_SLAB_VERTS = [
    [-4.0, -1.0, 0.0], [4.0, -1.0, 0.0], [4.0, 1.0, 0.0], [-4.0, 1.0, 0.0],
    [-4.0, -1.0, 0.4], [4.0, -1.0, 0.4], [4.0, 1.0, 0.4], [-4.0, 1.0, 0.4],
]
_SLAB_TRIS = [
    [0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6],
    [1, 2, 6], [1, 6, 5], [0, 3, 7], [0, 7, 4],
]


def _moving_scanner(scanner_id="m0", x0=-3.0, x1=3.0, z=5.0,
                    pulse_rate_hz=20000.0, n_theta=60, n_phi=120):
    """A scanner flying a straight +x pass at altitude z over the slab, nadir
    (identity attitude). `n_phi` is azimuth steps PER REVOLUTION; the backend
    derives the full-flight grid (revolutions, total pulses) from the PRF
    (pulse_rate_hz) and the trajectory's duration so the sweep spans the flight."""
    return {
        "id": scanner_id,
        "origin": [x0, 0.0, z],  # fallback anchor (ignored for a moving scan)
        "n_theta": n_theta,
        "n_phi": n_phi,
        "theta_min_deg": 0.0,
        "theta_max_deg": 180.0,
        "phi_min_deg": 0.0,
        "phi_max_deg": 360.0,
        "return_type": "single",
        "exit_diameter_m": 0.0,
        "beam_divergence_mrad": 0.0,
        "pulse_rate_hz": pulse_rate_hz,
        "trajectory": {
            "poses": [
                {"t": 0.0, "x": x0, "y": 0.0, "z": z, "qx": 0, "qy": 0, "qz": 0, "qw": 1},
                {"t": 1.0, "x": x1, "y": 0.0, "z": z, "qx": 0, "qy": 0, "qz": 0, "qw": 1},
            ],
        },
    }


class TestSyntheticMovingScan:
    """A scanner carrying a trajectory must run a MOVING scan (addScanMoving):
    each return records its own per-beam origin that walks the trajectory, NOT a
    single static origin. The discriminating control is a static scanner over the
    same scene whose origins are all identical."""

    def _scan(self, client, scanners):
        pytest.importorskip("pyhelios")
        resp = client.post("/api/lidar/scan", json={
            "meshes": [{"vertices": _SLAB_VERTS, "triangles": _SLAB_TRIS}],
            "scanners": scanners,
            "record_misses": True,
        })
        assert resp.status_code == 200, resp.text
        body = decode_lidar_scan(resp.content)
        assert body["success"] is True, body.get("error")
        return body

    def _result_scalars(self, scanner):
        """Per-beam origin/pulse_id columns are deliberately EXCLUDED from the
        render frame (they'd bloat a multi-million-point cloud the renderer must
        decode), so the HTTP-decoded frame doesn't carry them. They DO live in the
        full result dict — which is what feeds the session the leaf-area inversion
        reads. Call _do_lidar_scan directly to assert on that authoritative data."""
        pytest.importorskip("pyhelios")
        req = main.LidarScanRequest(
            meshes=[main.LidarScanMesh(vertices=_SLAB_VERTS, triangles=_SLAB_TRIS)],
            scanners=[main.LidarScanScanner(**scanner)], record_misses=True)
        res = main._do_lidar_scan(req)
        assert res["results"], res.get("error")
        return res["results"][0]["scalars"]

    def test_moving_scan_records_per_beam_origins_along_the_path(self, client):
        # The render frame must NOT carry the per-beam origin columns (payload).
        body = self._scan(client, [_moving_scanner("fly")])
        res = body["results"][0]
        assert res["num_points"] > 0, "overhead moving pass should hit the slab"
        assert "origin_x" not in res["scalars"], "origins must be excluded from the frame"

        # The full result (→ session → LAD) DOES carry them.
        scalars = self._result_scalars(_moving_scanner("fly"))
        for k in ("origin_x", "origin_y", "origin_z", "timestamp"):
            assert k in scalars, f"moving scan must record {k}"

        ox = np.asarray(scalars["origin_x"], dtype=np.float64)
        oz = np.asarray(scalars["origin_z"], dtype=np.float64)
        ts = np.asarray(scalars["timestamp"], dtype=np.float64)

        # The emission origin MOVED in x across the flight — the whole point. A
        # static scan (the bug) would have a single constant origin_x.
        assert ox.max() - ox.min() > 2.0, \
            f"origin_x barely moved ({ox.min():.2f}..{ox.max():.2f}); ran static?"
        # Altitude held ~constant at the flight height.
        assert np.allclose(oz, 5.0, atol=1e-3)
        # Each origin lies on the flown line x in [-3, 3].
        assert ox.min() >= -3.01 and ox.max() <= 3.01
        # Timestamps advance over the flight (monotone-ish, real seconds).
        assert ts.max() - ts.min() > 0.1

    def test_moving_vs_static_origin_spread(self, client):
        # Moving origins spread along the path; a static scan writes none (its
        # getHitOrigin falls back to the single scan origin). Read the full result
        # scalars (the frame excludes per-beam origins).
        mov = self._result_scalars(_moving_scanner("fly"))
        mov_ox = np.asarray(mov["origin_x"], dtype=np.float64)
        assert mov_ox.std() > 0.5, "moving origins should spread along the path"

        static = self._result_scalars(_scanner_over_slab("fixed"))
        assert "origin_x" not in static, "static scan must not write per-beam origins"

    def test_missing_pulse_rate_fails_clearly(self, client):
        pytest.importorskip("pyhelios")
        scanner = _moving_scanner("nopr")
        scanner.pop("pulse_rate_hz")
        resp = client.post("/api/lidar/scan", json={
            "meshes": [{"vertices": _SLAB_VERTS, "triangles": _SLAB_TRIS}],
            "scanners": [scanner],
        })
        assert resp.status_code == 200
        body = decode_lidar_scan(resp.content)
        assert body["success"] is False
        assert "pulse_rate" in body["error"].lower()


def _scanner_over_slab(scanner_id="fixed", origin=(0.0, 0.0, 5.0)):
    """A static scanner over the slab — the moving-scan control."""
    return {
        "id": scanner_id,
        "origin": list(origin),
        "n_theta": 60,
        "n_phi": 120,
        "theta_min_deg": 0.0,
        "theta_max_deg": 180.0,
        "phi_min_deg": 0.0,
        "phi_max_deg": 360.0,
        "return_type": "single",
        "exit_diameter_m": 0.0,
        "beam_divergence_mrad": 0.0,
    }


class TestMovingScanGridDerivation:
    """The PRF + per-revolution resolution + trajectory duration derivation that
    makes a moving scan span the WHOLE flight (pulse count = PRF × duration), not
    a fixed Ntheta×Nphi grid that finishes in milliseconds."""

    def test_spans_full_flight_duration(self):
        # 32 channels × 360 az/rev = 11520 pulses/rev; at 695 kHz that's ~60.3
        # rev/s. Over a 10 s flight → ~603 revolutions, ~6.95M pulses.
        g = main._derive_moving_scan_grid(32, 360, 695000.0, [0.0, 10.0])
        assert g["duration_s"] == 10.0
        assert g["rotation_rate_hz"] == pytest.approx(695000.0 / (32 * 360), rel=1e-6)
        assert g["n_revolutions"] == pytest.approx(g["rotation_rate_hz"] * 10.0, rel=1e-6)
        # total pulses ≈ PRF × duration (the whole flight fired at the PRF).
        assert g["total_pulses"] == pytest.approx(695000.0 * 10.0, rel=0.01)
        # phi spans many revolutions, not one.
        assert g["phi_max_rad"] > 2 * np.pi * 100

    def test_more_pulses_for_a_longer_flight(self):
        short = main._derive_moving_scan_grid(32, 360, 100000.0, [0.0, 2.0])
        long = main._derive_moving_scan_grid(32, 360, 100000.0, [0.0, 20.0])
        # 10× the flight time → ~10× the pulses and revolutions.
        assert long["total_pulses"] == pytest.approx(10 * short["total_pulses"], rel=0.01)
        assert long["n_revolutions"] == pytest.approx(10 * short["n_revolutions"], rel=0.01)

    def test_single_pose_falls_back_to_one_revolution(self):
        # A zero-duration (single-pose) trajectory can't span a flight; it should
        # produce one sensible revolution rather than zero pulses / a NaN.
        g = main._derive_moving_scan_grid(32, 360, 695000.0, [5.0])
        assert g["n_revolutions"] == 1.0
        assert g["n_phi_total"] == 360
        assert g["total_pulses"] == 32 * 360


class TestMovingScanFullFlightCoverage:
    """End-to-end: a moving scan with per-rev resolution must cover the WHOLE
    flight — the bug was that a realistic PRF finished the sweep in ~0.05 s, so
    the platform barely moved (concentric circles from the first pose)."""

    # A long ground strip so a full-flight pass produces a swath, not a disk.
    _STRIP_V = [[-30, -3, 0], [30, -3, 0], [30, 3, 0], [-30, 3, 0],
                [-30, -3, 0.4], [30, -3, 0.4], [30, 3, 0.4], [-30, 3, 0.4]]
    _STRIP_T = [[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 3, 7], [0, 7, 4]]

    def test_realistic_prf_still_spans_the_flight(self, client):
        pytest.importorskip("pyhelios")
        # Drone flies +y from -25..25 over 10 s at z=10. A realistic 695 kHz PRF
        # would, under the OLD model, finish in ~0.05 s near y=-25. With per-rev
        # resolution + flight-duration derivation it must span the whole pass.
        poses = [{"t": i * 10 / 4, "x": 0.0, "y": -25 + i * 12.5, "z": 10.0,
                  "qx": 0, "qy": 0, "qz": 0, "qw": 1} for i in range(5)]
        scanner = {
            "id": "fly", "origin": [0.0, -25.0, 10.0],
            "n_theta": 16, "n_phi": 120,  # 120 az steps PER REVOLUTION
            "theta_min_deg": 60.0, "theta_max_deg": 120.0,
            "phi_min_deg": 0.0, "phi_max_deg": 360.0,
            "return_type": "single", "exit_diameter_m": 0.0, "beam_divergence_mrad": 0.0,
            "pulse_rate_hz": 695000.0,
            "trajectory": {"poses": poses},
        }
        # Read the full result scalars directly (per-beam origins are excluded
        # from the HTTP render frame to keep it small).
        req = main.LidarScanRequest(
            meshes=[main.LidarScanMesh(vertices=self._STRIP_V, triangles=self._STRIP_T)],
            scanners=[main.LidarScanScanner(**scanner)], record_misses=True)
        res = main._do_lidar_scan(req)
        assert res["results"], res.get("error")
        oy = np.asarray(res["results"][0]["scalars"]["origin_y"], dtype=np.float64)
        oy = oy[np.isfinite(oy)]
        # The emission origin must walk nearly the whole -25..25 flight (≥40 of 50 m),
        # NOT sit near the first pose (the bug).
        assert oy.max() - oy.min() > 40.0, \
            f"origin_y only spanned {oy.min():.1f}..{oy.max():.1f}; sweep didn't cover the flight"


class TestMovingMultibeamChannels:
    """For a spinning-multibeam moving scan, Ntheta is the CHANNEL COUNT (one row
    per beam elevation angle), not the raster zenith point count."""

    def test_channel_count_drives_ntheta(self, client):
        pytest.importorskip("pyhelios")
        # 8 downward channels; n_theta below is deliberately wrong (would be
        # ignored) — the backend must use the 8 elevation angles as Ntheta. A low
        # pass close over a wide slab so the downward channels land returns.
        wide_v = [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0],
                  [-10, -10, 0.4], [10, -10, 0.4], [10, 10, 0.4], [-10, 10, 0.4]]
        wide_t = [[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                  [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 3, 7], [0, 7, 4]]
        poses = [{"t": 0.0, "x": -2, "y": 0, "z": 2, "qx": 0, "qy": 0, "qz": 0, "qw": 1},
                 {"t": 1.0, "x": 2, "y": 0, "z": 2, "qx": 0, "qy": 0, "qz": 0, "qw": 1}]
        scanner = {
            "id": "mb", "origin": [-2.0, 0.0, 2.0],
            "scan_pattern": "spinning_multibeam",
            # Steeply downward channels (well below horizon) so they hit the ground.
            "beam_elevation_angles_deg": [-50, -55, -60, -65, -70, -75, -80, -85],
            "n_theta": 999,  # wrong on purpose — must be ignored for multibeam
            "n_phi": 180,
            "theta_min_deg": 0.0, "theta_max_deg": 180.0,
            "phi_min_deg": 0.0, "phi_max_deg": 360.0,
            "return_type": "single", "exit_diameter_m": 0.0, "beam_divergence_mrad": 0.0,
            "pulse_rate_hz": 20000.0,
            "trajectory": {"poses": poses},
        }
        resp = client.post("/api/lidar/scan", json={
            "meshes": [{"vertices": wide_v, "triangles": wide_t}],
            "scanners": [scanner], "record_misses": True})
        body = decode_lidar_scan(resp.content)
        # Must succeed (using 8 channels) — not crash on a 999-row grid or ignore
        # the elevation angles.
        assert body["success"] is True, body.get("error")
        assert body["results"][0]["num_points"] > 0
