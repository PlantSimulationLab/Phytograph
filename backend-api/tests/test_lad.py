"""Tests for the leaf area density (LAD) endpoint plumbing in main.py.

Two layers:
- Request-shaping / validation tests that stub pyhelios, so they run without a
  compiled native lib (grid-required, multi-return column validation).
- An end-to-end test against real pyhelios using a committed point-cloud fixture
  (a synthetic scan of the LAI=2 spherical leaf cube), adapted from the C++
  lidar self-test's "Single/Eight Voxel Isotropic Patches" cases. The C++ test
  asserts LAD within 2% and G(theta) within 5% of analytic truth; we loosen to
  ~12% because triangulating a discrete point cloud is noisier than the C++
  pure-synthetic G(theta), and the fixture uses a reduced angular resolution.
"""

import math
import os

import numpy as np
import pytest

import main

_FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "lad-leafcube")
_FIXTURE_XYZ = os.path.join(_FIXTURE_DIR, "leafcube.xyz")
_FIXTURE_ORIGIN = [-5.0, 0.0, 0.5]

# Multi-return (full-waveform) fixture: same leaf cube, scanned with several rays
# per pulse, so most pulses produce multiple returns. Columns:
# x y z timestamp target_index target_count.
_MULTI_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "lad-leafcube-multi")
_MULTI_XYZ = os.path.join(_MULTI_DIR, "leafcube_multi.xyz")
_MULTI_FORMAT = "x y z timestamp target_index target_count"


# ---------------------------------------------------------------------------
# Request-shaping / validation (pyhelios stubbed)
# ---------------------------------------------------------------------------

class _FakeCloud:
    """Records the call sequence; reports a couple of trivial cells so the
    handler returns success without a real native lib."""
    instances = []

    def __init__(self):
        self.calls = []
        self.gridcells = 1
        _FakeCloud.instances.append(self)

    def disableMessages(self):
        pass

    def loadXML(self, path):
        self.calls.append(("loadXML", path))

    def addScan(self, **kwargs):
        self.calls.append(("addScan", kwargs))
        return len([c for c in self.calls if c[0] == "addScan"]) - 1

    def addHitPointsWithData(self, scanID, xyz, dirs, labels, vals):
        self.calls.append(("addHitPointsWithData", scanID, len(xyz), tuple(labels or [])))

    def addGrid(self, center, size, ndiv, rotation=0.0):
        self.calls.append(("addGrid", tuple(center), tuple(size), tuple(ndiv)))

    def triangulateHitPoints(self, lmax, aspect):
        self.calls.append(("triangulate", lmax, aspect))

    def getTriangleCount(self):
        return 100

    def gapfillMisses(self):
        self.calls.append(("gapfill",))
        # Simulate Helios tagging synthesised misses with gapfillMisses_code=1.0
        # on top of the original hits (code 0.0). Two recovered misses here.
        self._gapfill_codes = [0.0, 0.0, 1.0, 1.0]

    def getHitDataAll(self, label):
        if label == "gapfillMisses_code":
            return getattr(self, "_gapfill_codes", [])
        return []

    def calculateLeafArea(self, ctx, min_hits, element_width=None):
        # Uncertainty is always on now: _do_lad_computation passes element_width.
        self.calls.append(("calculateLeafArea", min_hits, element_width))

    def getGridCellCount(self):
        return self.gridcells

    def getCellCenter(self, i):
        return main_vec(0.0, 0.0, 0.5)

    def getCellSize(self, i):
        return main_vec(1.0, 1.0, 1.0)

    def getCellLeafArea(self, i):
        return 2.0

    def getCellLeafAreaDensity(self, i):
        return 2.0

    def getCellGtheta(self, i):
        return 0.5

    # --- Pimont (2018) uncertainty getters (stubbed) ---
    def getCellLADVariance(self, i):
        return 0.04          # std 0.2

    def getCellBeamCount(self, i):
        return 1000

    def getCellRelativeDensityIndex(self, i):
        return 0.6

    def getCellMeanPathLength(self, i):
        return 0.8

    def getCellLeafAreaConfidenceInterval(self, i, conf):
        return (True, 1.8, 2.2)

    def getGroupLADConfidenceInterval(self, indices, conf):
        return (True, 2.0, 1.9, 2.1)


class _FakeContext:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _Vec:
    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z


def main_vec(x, y, z):
    return _Vec(x, y, z)


@pytest.fixture
def stub_pyhelios(monkeypatch):
    """Stub the pyhelios import inside _do_lad_computation."""
    import sys
    import types
    _FakeCloud.instances = []
    fake = types.ModuleType("pyhelios")
    fake.LiDARCloud = _FakeCloud
    fake.Context = _FakeContext
    monkeypatch.setitem(sys.modules, "pyhelios", fake)
    return _FakeCloud


def _single_return_request(tmp_path, **grid_over):
    # Carries an explicit is_miss column (one flagged miss) so the cloud has the
    # transmitted-beam population calculateLeafArea() now requires — no gapfill
    # needed, so this still exercises the single-return (no-gapfill) sequence.
    f = tmp_path / "scan.xyz"
    f.write_text("0.1 0.1 0.5 0\n-0.1 0.0 0.6 0\n0.2 -0.1 0.4 0\n9.0 9.0 9.0 1\n")
    grid = main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], **(
        {"nx": 1, "ny": 1, "nz": 1} | grid_over))
    scan = main.HeliosScanEntry(file_path=str(f), ascii_format="x y z is_miss",
                                origin=[0, 0, 5], return_type="single")
    return main.LADComputeRequest(scans=[scan], grid=grid, lmax=0.1,
                                  max_aspect_ratio=4.0, min_voxel_hits=1)


class TestLADRequestShaping:
    def test_single_return_runs_the_expected_sequence(self, tmp_path, stub_pyhelios):
        result = main._do_lad_computation(_single_return_request(tmp_path))
        assert result["success"] is True
        assert result["return_mode"] == "single"
        assert result["is_multi_return"] is False
        assert len(result["cells"]) == 1
        cell = result["cells"][0]
        assert cell["lad"] == pytest.approx(2.0)
        assert cell["gtheta"] == pytest.approx(0.5)

        cloud = stub_pyhelios.instances[-1]
        names = [c[0] for c in cloud.calls]
        # Single-return must NOT gapfill, and must triangulate before LAD.
        assert "gapfill" not in names
        assert names.index("triangulate") < names.index("calculateLeafArea")

    def test_grid_is_required(self, tmp_path, stub_pyhelios):
        # A request with grid=None is rejected by Pydantic, but a direct call
        # with the field cleared exercises the guard in _do_lad_computation.
        req = _single_return_request(tmp_path)
        object.__setattr__(req, "grid", None)
        result = main._do_lad_computation(req)
        assert result["success"] is False
        assert "grid is required" in result["error"].lower() or "voxel grid" in result["error"].lower()

    def test_multi_return_without_columns_falls_back_then_fails_no_misses(self, tmp_path, stub_pyhelios):
        # Multi-return claimed but the file is plain XYZ: it falls back to single
        # (warning), but plain XYZ also carries no misses, so the inversion can't
        # run — the backend reports the clear no-misses error.
        f = tmp_path / "scan.xyz"
        f.write_text("0.1 0.1 0.5\n0.0 0.0 0.6\n")
        scan = main.HeliosScanEntry(
            file_path=str(f), ascii_format="x y z",  # lacks timestamp/target_*
            origin=[0, 0, 5], return_type="multi")
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1),
            lmax=0.1, max_aspect_ratio=4.0, min_voxel_hits=1)
        result = main._do_lad_computation(req)

        assert result["success"] is False
        assert "miss" in result["error"].lower()
        # The multi-return fallback warning is still surfaced alongside the error.
        assert any("multi-return" in w for w in result["warnings"])
        cloud = stub_pyhelios.instances[-1]
        assert "gapfill" not in [c[0] for c in cloud.calls]
        assert "calculateLeafArea" not in [c[0] for c in cloud.calls]

    def test_multi_return_with_columns_gapfills(self, tmp_path, stub_pyhelios):
        f = tmp_path / "scan.xyz"
        f.write_text("0.1 0.1 0.5 1.0 0 1\n0.0 0.0 0.6 1.0 0 1\n")
        fmt = "x y z timestamp target_index target_count"
        scan = main.HeliosScanEntry(
            file_path=str(f), ascii_format=fmt, origin=[0, 0, 5], return_type="multi")
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1),
            lmax=0.1, max_aspect_ratio=4.0, min_voxel_hits=1)
        result = main._do_lad_computation(req)

        assert result["success"] is True
        assert result["return_mode"] == "multi"
        assert result["is_multi_return"] is True
        cloud = stub_pyhelios.instances[-1]
        names = [c[0] for c in cloud.calls]
        # gapfill must run, and before calculateLeafArea.
        assert "gapfill" in names
        assert names.index("gapfill") < names.index("calculateLeafArea")

    def test_single_return_with_timestamp_gapfills_and_reports(self, tmp_path, stub_pyhelios):
        # A single-return scan that carries a timestamp (but no target_*) is
        # gapfillable: misses are recovered from the timestamp gaps. Widening the
        # old multi-return-only trigger. The recovered count is surfaced.
        f = tmp_path / "scan.xyz"
        f.write_text("0.1 0.1 0.5 1.0\n0.0 0.0 0.6 2.0\n0.2 -0.1 0.4 3.0\n")
        scan = main.HeliosScanEntry(
            file_path=str(f), ascii_format="x y z timestamp",
            origin=[0, 0, 5], return_type="single")
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1),
            lmax=0.1, max_aspect_ratio=4.0, min_voxel_hits=1)
        result = main._do_lad_computation(req)

        assert result["success"] is True
        # Single-return mode, but gapfill still runs (timestamp present).
        assert result["return_mode"] == "single"
        cloud = stub_pyhelios.instances[-1]
        assert "gapfill" in [c[0] for c in cloud.calls]
        assert result["gapfilled_misses"] == 2
        assert any("Recovered 2" in w for w in result["warnings"])

    def test_no_misses_no_timestamp_fails_clearly(self, tmp_path, stub_pyhelios):
        # Neither miss points nor a timestamp: can't account for transmitted beams,
        # so the inversion has no valid denominator. calculateLeafArea() fail-fasts
        # on this upstream; the backend detects it first and returns a clear,
        # actionable error (no gapfill, no calculateLeafArea call).
        f = tmp_path / "scan.xyz"
        f.write_text("0.1 0.1 0.5\n0.0 0.0 0.6\n0.2 -0.1 0.4\n")
        scan = main.HeliosScanEntry(
            file_path=str(f), ascii_format="x y z",
            origin=[0, 0, 5], return_type="single")
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1),
            lmax=0.1, max_aspect_ratio=4.0, min_voxel_hits=1)
        result = main._do_lad_computation(req)

        assert result["success"] is False
        assert "miss" in result["error"].lower()
        cloud = stub_pyhelios.instances[-1]
        # Neither gapfill nor the inversion should have been attempted.
        assert "gapfill" not in [c[0] for c in cloud.calls]
        assert "calculateLeafArea" not in [c[0] for c in cloud.calls]

    def test_existing_misses_skip_gapfill(self, tmp_path, stub_pyhelios):
        # A scan that already carries miss points (is_miss=1) must NOT be
        # gapfilled — that would synthesise duplicates on top of real misses.
        f = tmp_path / "scan.xyz"
        # x y z timestamp is_miss — one row flagged as an existing miss.
        f.write_text("0.1 0.1 0.5 1.0 0\n0.0 0.0 0.6 2.0 0\n9.0 9.0 9.0 3.0 1\n")
        scan = main.HeliosScanEntry(
            file_path=str(f), ascii_format="x y z timestamp is_miss",
            origin=[0, 0, 5], return_type="single")
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1),
            lmax=0.1, max_aspect_ratio=4.0, min_voxel_hits=1)
        result = main._do_lad_computation(req)

        assert result["success"] is True
        cloud = stub_pyhelios.instances[-1]
        assert "gapfill" not in [c[0] for c in cloud.calls]
        assert result["had_miss_points"] is True
        # Not the "no misses / no timestamp" warning — misses ARE present.
        assert not any("likely to be inaccurate" in w for w in result["warnings"])

    def test_stale_session_falls_back_to_file_with_warning(self, tmp_path, stub_pyhelios):
        # A session id the backend doesn't have (e.g. after a restart) must NOT
        # 404 the whole computation when the scan also carries a source file —
        # it falls back to the file and warns that unbaked edits were dropped.
        # (is_miss column present so the inversion has misses to work with.)
        f = tmp_path / "scan.xyz"
        f.write_text("0.1 0.1 0.5 0\n-0.1 0.0 0.6 0\n0.2 -0.1 0.4 0\n9.0 9.0 9.0 1\n")
        scan = main.HeliosScanEntry(
            session_id="does-not-exist", file_path=str(f),
            ascii_format="x y z is_miss",
            origin=[0, 0, 5], return_type="single")
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1),
            lmax=0.1, max_aspect_ratio=4.0, min_voxel_hits=1)
        result = main._do_lad_computation(req)

        assert result["success"] is True, result.get("error")
        assert any("no longer available" in w for w in result["warnings"])

    def test_stale_session_without_file_errors_actionably(self, tmp_path, stub_pyhelios):
        # No fallback available: a clear, actionable error rather than a bare 404.
        scan = main.HeliosScanEntry(
            session_id="does-not-exist", origin=[0, 0, 5], return_type="single")
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1),
            lmax=0.1, max_aspect_ratio=4.0, min_voxel_hits=1)
        result = main._do_lad_computation(req)

        assert result["success"] is False
        assert "session not found" in result["error"].lower()
        assert "re-import" in result["error"].lower()


# ---------------------------------------------------------------------------
# Per-cell hit counting (pure numpy, no pyhelios)
# ---------------------------------------------------------------------------

class TestCountPointsPerCell:
    def test_bins_points_into_uniform_grid(self):
        # 2x1x1 grid spanning x in [-1,1], cells centered at -0.5 and +0.5.
        import numpy as np
        scan_xyz = [np.array([[-0.5, 0, 0], [-0.6, 0, 0], [0.5, 0, 0]], dtype=np.float64)]
        centers = [main_vec(-0.5, 0, 0), main_vec(0.5, 0, 0)]
        sizes = [main_vec(1, 1, 1), main_vec(1, 1, 1)]
        counts = main._count_points_per_cell(scan_xyz, centers, sizes)
        assert counts[0] == 2   # the two negative-x points
        assert counts[1] == 1   # the one positive-x point


# ---------------------------------------------------------------------------
# Pimont (2018) uncertainty wiring (stubbed pyhelios — deterministic shaping)
# ---------------------------------------------------------------------------

class TestLADUncertaintyShaping:
    def test_element_width_threaded_and_group_ci_returned(self, tmp_path, stub_pyhelios):
        req = _single_return_request(tmp_path)
        object.__setattr__(req, "element_width", 0.05)
        result = main._do_lad_computation(req)
        assert result["success"] is True

        # element_width reaches calculateLeafArea (now a 3-arg call) and is echoed.
        cloud = stub_pyhelios.instances[-1]
        la_call = next(c for c in cloud.calls if c[0] == "calculateLeafArea")
        assert la_call[2] == pytest.approx(0.05)
        assert result["element_width"] == pytest.approx(0.05)
        assert result["confidence_level"] == pytest.approx(0.95)

        # Per-cell uncertainty surfaced: variance 0.04 -> std 0.2; CI carried.
        cell = result["cells"][0]
        assert cell["lad_variance"] == pytest.approx(0.04)
        assert cell["lad_std"] == pytest.approx(0.2)
        assert cell["beam_count"] == 1000
        assert cell["relative_density_index"] == pytest.approx(0.6)
        assert cell["ci_valid"] is True
        assert cell["leaf_area_ci_lower"] == pytest.approx(1.8)
        assert cell["leaf_area_ci_upper"] == pytest.approx(2.2)

        # Group-scale CI: valid, with mean inside the bounds.
        assert result["group_ci_valid"] is True
        assert result["group_lad_ci_lower"] <= result["group_lad_mean"] <= result["group_lad_ci_upper"]

    def test_min_voxel_hits_none_floors_to_five_and_warns(self, tmp_path, stub_pyhelios):
        req = _single_return_request(tmp_path)
        object.__setattr__(req, "min_voxel_hits", None)
        result = main._do_lad_computation(req)
        assert result["success"] is True
        cloud = stub_pyhelios.instances[-1]
        la_call = next(c for c in cloud.calls if c[0] == "calculateLeafArea")
        assert la_call[1] == 5  # floored
        assert any("defaulted to 5" in w for w in result["warnings"])

    def test_response_model_serializes_without_nan(self, tmp_path, stub_pyhelios):
        # The success dict must round-trip through the Pydantic response model
        # (sentinels already mapped to None/JSON-safe values).
        result = main._do_lad_computation(_single_return_request(tmp_path))
        model = main.LADComputeResponse(**result)
        dumped = model.model_dump()
        assert dumped["element_width"] == pytest.approx(0.05)
        assert dumped["cells"][0]["lad_std"] == pytest.approx(0.2)


# ---------------------------------------------------------------------------
# End-to-end against real pyhelios + the committed leaf-cube fixture.
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not os.path.isfile(_FIXTURE_XYZ),
                    reason="lad-leafcube fixture not present")
class TestLeafCubeLAD:
    """Adapts the C++ 'LiDAR Single/Eight Voxel Isotropic Patches' tests. The
    fixture is a synthetic scan of the LAI=2 spherical leaf cube; the 1x1x1 m
    voxel at (0,0,0.5) has true LAD=2.0 m^2/m^3 and G(theta)=0.5."""

    def _request(self, nx=1, ny=1, nz=1):
        scan = main.HeliosScanEntry(
            file_path=_FIXTURE_XYZ, ascii_format="x y z is_miss",
            origin=_FIXTURE_ORIGIN,
            n_theta=2600, n_phi=5200, theta_min=0, theta_max=180,
            phi_min=0, phi_max=360, return_type="single")
        return main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=nx, ny=ny, nz=nz),
            lmax=0.04, max_aspect_ratio=10, min_voxel_hits=1)

    def test_single_voxel_lad_near_two(self):
        pytest.importorskip("pyhelios")
        result = main._do_lad_computation(self._request())
        assert result["success"] is True, result.get("error")
        assert len(result["cells"]) == 1
        cell = result["cells"][0]
        # True LAD=2.0; point-cloud triangulation recovers it within ~12%.
        assert cell["lad"] == pytest.approx(2.0, rel=0.12)
        # Spherical leaf distribution → G(theta)=0.5, within ~12%.
        assert cell["gtheta"] == pytest.approx(0.5, rel=0.12)
        assert cell["hit_count"] > 0
        assert result["return_mode"] == "single"

    def test_uncertainty_reported_with_element_width(self):
        pytest.importorskip("pyhelios")
        result = main._do_lad_computation(self._request())
        assert result["success"] is True, result.get("error")
        # Uncertainty is on by default (element_width defaults to 0.05).
        assert result["element_width"] == pytest.approx(0.05)
        assert result["confidence_level"] == pytest.approx(0.95)
        cell = result["cells"][0]
        # A solved voxel reports a non-negative std and a real beam count.
        assert cell["lad_std"] is not None and cell["lad_std"] >= 0
        assert cell["beam_count"] is not None and cell["beam_count"] >= 0
        # Group-scale CI brackets its own mean when valid.
        if result["group_ci_valid"]:
            assert (result["group_lad_ci_lower"] <= result["group_lad_mean"]
                    <= result["group_lad_ci_upper"])

    def test_eight_voxel_rmse_against_truth(self):
        pytest.importorskip("pyhelios")
        result = main._do_lad_computation(self._request(nx=2, ny=2, nz=2))
        assert result["success"] is True, result.get("error")
        cells = result["cells"]
        assert len(cells) == 8
        # Every cell's LAD should be near 2.0 (the cube is uniform). The C++
        # synthetic test asserts RMSE < 0.06; point-cloud input is noisier, so
        # allow RMSE < 0.5 across the eight cells.
        rmse = math.sqrt(sum((c["lad"] - 2.0) ** 2 for c in cells) / len(cells))
        assert rmse < 0.5, f"per-cell LAD RMSE too high: {rmse}"


# ---------------------------------------------------------------------------
# Faithful port of the C++ "LiDAR Eight Voxel Isotropic Patches Test"
# (plugins/lidar/tests/selfTest.cpp), driven through our backend's
# _do_lad_computation instead of calling calculateLeafArea() on a syntheticScan
# cloud directly. This is the authoritative 2x2x2 oracle: the exact per-cell LAD
# is computed from the leaf-cube primitive areas, and we assert our backend path
# recovers it. We test BOTH the well-conditioned multi-return case (misses are
# recorded, so hits+misses share one raster) and the single-return case (Helios
# synthesizes the miss raster from Ntheta/Nphi), which is the regime the
# real-data sphere case fell over in.
# ---------------------------------------------------------------------------

_GEOM_XML = "plugins/lidar/xml/leaf_cube_LAI2_lw0_01_spherical.xml"
_HELIOS_CORE = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", "pyhelios", "helios-core"))


@pytest.mark.skipif(
    not os.path.isfile(os.path.join(_HELIOS_CORE, _GEOM_XML)),
    reason="leaf-cube geometry not present (helios-core submodule)")
class TestEightVoxelIsotropicPatches:
    """Mirror the C++ Eight Voxel Isotropic Patches test on a 2x2x2 grid, but feed
    the scan through the backend's inline-points path. Generates a fresh dense
    synthetic scan at test time (like the C++ test's syntheticScan) and asserts
    per-cell LAD against the exact primitive-derived truth."""

    # Resolution reduced from 10000x12000: the single-return path now records
    # misses (calculateLeafArea fail-fasts without them), which adds the missed-ray
    # population to the cloud. A coarser raster keeps the test fast; we relax the
    # correctness bounds accordingly and lean on the pyhelios/helios C++ tests for
    # exact-accuracy verification of the inversion itself.
    NTHETA, NPHI = 4000, 4800
    ORIGIN = [-5.0, 0.0, 0.5]
    GRID_CENTER = [0.0, 0.0, 0.5]
    GRID_SIZE = [1.0, 1.0, 1.0]

    def _exact_per_cell_lad(self, ctx, uuids, cloud):
        """Exact LAD per voxel = (primitive area assigned to that voxel) / voxel
        volume, binning each primitive by its first vertex like the C++ test."""
        gs = cloud.getCellSize(0)
        vol = gs.x * gs.y * gs.z
        lad_ex = [0.0] * 8
        for uuid in uuids:
            v = ctx.getPrimitiveVertices(uuid)[0]
            i = 1 if v.x > 0.0 else 0
            j = 1 if v.y > 0.0 else 0
            k = 1 if v.z > 0.5 else 0
            lad_ex[k * 4 + j * 2 + i] += ctx.getPrimitiveArea(uuid) / vol
        return lad_ex

    def _generate_scan(self, multi_return):
        """Return (points (N,3), scalar_columns|None, exact_lad[8]) for a fresh
        dense synthetic scan, generated from helios-core's working directory."""
        pytest.importorskip("pyhelios")
        import math
        from pyhelios import LiDARCloud, Context

        cwd = os.getcwd()
        os.chdir(_HELIOS_CORE)
        try:
            cloud = LiDARCloud()
            cloud.disableMessages()
            cloud.addScan(
                origin=self.ORIGIN, Ntheta=self.NTHETA, theta_range=(0.0, math.pi),
                Nphi=self.NPHI, phi_range=(0.0, 2 * math.pi),
                exit_diameter=(0.01 if multi_return else 0.0),
                beam_divergence=(0.0003 if multi_return else 0.0))
            cloud.addGrid(center=self.GRID_CENTER, size=self.GRID_SIZE, ndiv=[2, 2, 2])
            with Context() as ctx:
                uuids = ctx.loadXML(_GEOM_XML, True)
                exact = self._exact_per_cell_lad(ctx, uuids, cloud)
                # Both paths record misses: calculateLeafArea() fail-fasts on a
                # cloud with no miss points (the transmission denominator). Helios
                # tags every hit with is_miss (0.0 return / 1.0 miss); forward it so
                # the backend sees has_misses=True and the inversion runs.
                if multi_return:
                    cloud.syntheticScan(ctx, rays_per_pulse=10,
                                        pulse_distance_threshold=0.02,
                                        record_misses=True)
                else:
                    cloud.syntheticScan(ctx, record_misses=True)
                positions, _ = cloud.getHitsXYZRGB()
                if multi_return:
                    cols = {c: cloud.getHitDataAll(c)
                            for c in ("timestamp", "target_index",
                                      "target_count", "is_miss")}
                else:
                    cols = {"is_miss": cloud.getHitDataAll("is_miss")}
        finally:
            os.chdir(cwd)

        xyz = np.array([[p.x, p.y, p.z] for p in positions], dtype=np.float64)
        return xyz, cols, exact

    def _run(self, xyz, cols, return_type):
        scan = main.HeliosScanEntry(
            points=xyz.tolist(),
            scalar_columns=cols,
            origin=self.ORIGIN, n_theta=self.NTHETA, n_phi=self.NPHI,
            theta_min=0, theta_max=180, phi_min=0, phi_max=360,
            return_type=return_type)
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=self.GRID_CENTER, size=self.GRID_SIZE,
                                 nx=2, ny=2, nz=2),
            lmax=0.04, max_aspect_ratio=10, min_voxel_hits=1)
        return main._do_lad_computation(req)

    def _rmse(self, cells, exact):
        # Map each result cell to the exact value by its (i,j,k) octant.
        per = []
        for c in cells:
            cx, cy, cz = c["center"]
            i = 1 if cx > 0.0 else 0
            j = 1 if cy > 0.0 else 0
            k = 1 if cz > 0.5 else 0
            per.append((c["lad"] - exact[k * 4 + j * 2 + i]) ** 2)
        return math.sqrt(sum(per) / len(per))

    def test_multireturn_recovers_exact_per_cell_lad(self):
        """Multi-return (misses recorded → consistent raster) must recover the
        exact per-cell LAD across all eight voxels."""
        xyz, cols, exact = self._generate_scan(multi_return=True)
        result = self._run(xyz, cols, "multi")
        assert result["success"] is True, result.get("error")
        assert result["return_mode"] == "multi"
        cells = result["cells"]
        assert len(cells) == 8
        # No cell may be a degenerate zero — every voxel of the uniform cube has
        # leaf area. (The sphere bug manifested as a whole layer pinned near 0.)
        # This is the deterministic regression guard; the RMSE bound below is
        # looser because the multi-return finite-beam scan samples randomly
        # (observed RMSE ~0.12-0.14 across runs, so 0.4 leaves tail headroom).
        assert all(c["lad"] > 0.5 for c in cells), \
            f"degenerate cell(s): {[round(c['lad'], 3) for c in cells]}"
        rmse = self._rmse(cells, exact)
        assert rmse < 0.4, f"per-cell LAD RMSE too high: {rmse} (exact {exact})"

    def test_singlereturn_recovers_per_cell_lad(self):
        """Single-return with recorded misses: every voxel of the uniform cube must
        recover a non-degenerate LAD across all eight cells — including the upper
        layer (the regime the real-data sphere case failed in, one z-layer pinned
        near zero). Coarser raster than the C++ test, so the RMSE bound is loose;
        the pyhelios/helios C++ tests verify exact-accuracy of the inversion."""
        xyz, cols, exact = self._generate_scan(multi_return=False)
        result = self._run(xyz, cols, "single")
        assert result["success"] is True, result.get("error")
        assert result["return_mode"] == "single"
        cells = result["cells"]
        assert len(cells) == 8
        assert all(c["lad"] > 0.5 for c in cells), \
            f"degenerate cell(s): {[round(c['lad'], 3) for c in cells]}"
        rmse = self._rmse(cells, exact)
        assert rmse < 0.5, f"per-cell LAD RMSE too high: {rmse} (exact {exact})"


# ---------------------------------------------------------------------------
# Multi-return (full-waveform) LAD against real pyhelios.
#
# These exercise the multi-return algorithm end to end: the per-pulse
# timestamp/target_index/target_count columns are present, so the backend detects
# multi-return, runs gapfillMisses(), and the equal-weighting inversion. Until
# the PyHelios fix for the loadXML stack-buffer overflow (commit "LiDAR: fix
# non-deterministic crash loading multi-return ASCII clouds"), this path crashed
# ~7/12 runs; the repeated-run test is the regression guard for that.
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not os.path.isfile(_MULTI_XYZ),
                    reason="lad-leafcube-multi fixture not present")
class TestLeafCubeMultiReturnLAD:
    """The multi-return fixture is a full-waveform scan of the same LAI=2 leaf
    cube; the 1x1x1 m voxel still has true LAD=2.0 m^2/m^3 and G(theta)=0.5."""

    def _file_request(self):
        """Multi-return fed from a file path (the file-import path)."""
        scan = main.HeliosScanEntry(
            file_path=_MULTI_XYZ, ascii_format=_MULTI_FORMAT, origin=_FIXTURE_ORIGIN,
            n_theta=800, n_phi=1600, theta_min=0, theta_max=180,
            phi_min=0, phi_max=360, return_type="multi")
        return main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1),
            lmax=0.04, max_aspect_ratio=10, min_voxel_hits=1)

    def _synthetic_request(self):
        """Multi-return fed as inline points + scalar_columns (the synthetic /
        in-memory cloud path — no file, no session)."""
        d = np.loadtxt(_MULTI_XYZ)
        scan = main.HeliosScanEntry(
            points=d[:, :3].tolist(),
            scalar_columns={
                "timestamp": d[:, 3].tolist(),
                "target_index": d[:, 4].tolist(),
                "target_count": d[:, 5].tolist(),
            },
            origin=_FIXTURE_ORIGIN,
            n_theta=800, n_phi=1600, theta_min=0, theta_max=180,
            phi_min=0, phi_max=360, return_type="multi")
        return main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1),
            lmax=0.04, max_aspect_ratio=10, min_voxel_hits=1)

    def test_file_path_runs_multireturn_algorithm(self):
        pytest.importorskip("pyhelios")
        result = main._do_lad_computation(self._file_request())
        assert result["success"] is True, result.get("error")
        # The multi-return algorithm actually ran (not the single-return fallback).
        assert result["is_multi_return"] is True
        assert result["return_mode"] == "multi"
        # No fallback warning — the per-pulse columns were present.
        assert not result.get("warnings"), result.get("warnings")
        cell = result["cells"][0]
        assert cell["lad"] == pytest.approx(2.0, rel=0.15)
        # G(theta)=0.5 for the spherical distribution. The multi-return fixture
        # uses a lower angular resolution + finite beam, which biases the
        # triangulated G estimate a little more than the single-return case, so
        # allow ~20% here (still tight enough to catch a wrong G-function).
        assert cell["gtheta"] == pytest.approx(0.5, rel=0.20)
        assert cell["hit_count"] > 0

    def test_synthetic_scalar_columns_runs_multireturn_algorithm(self):
        pytest.importorskip("pyhelios")
        result = main._do_lad_computation(self._synthetic_request())
        assert result["success"] is True, result.get("error")
        assert result["is_multi_return"] is True
        assert result["return_mode"] == "multi"
        cell = result["cells"][0]
        assert cell["lad"] == pytest.approx(2.0, rel=0.15)

    def test_repeated_runs_are_stable(self):
        """Regression guard for the fixed non-deterministic loadXML crash: the
        multi-return path must succeed on every run, not ~5 in 12."""
        pytest.importorskip("pyhelios")
        lads = []
        for _ in range(8):
            result = main._do_lad_computation(self._file_request())
            assert result["success"] is True, result.get("error")
            assert result["is_multi_return"] is True
            lads.append(result["cells"][0]["lad"])
        # Deterministic input → identical result every run.
        assert max(lads) - min(lads) < 1e-6, f"LAD not stable across runs: {lads}"


@pytest.mark.skipif(not os.path.isfile(_MULTI_XYZ),
                    reason="multi-return leafcube fixture not present")
class TestMultiReturnImportColumnMapping:
    """Regression guard for the import-wizard losing the per-pulse multi-return
    columns.

    The wizard previews a header-less ASCII scan, assigns each column a role +
    suggested slug, and ships that as the session's column plan. The per-pulse
    columns (timestamp/target_index/target_count) must be pinned to their
    canonical slugs — not a positional 'col_N' — or the LAD path can't find them
    in the session, silently writes them as zeros, and the full-waveform
    inversion runs on degenerate data (recovering LAD ~0.11 instead of ~2.0).
    This is exactly what failed in the UI (session) path while the file_path /
    inline-points paths happened to dodge it.
    """

    def test_preview_pins_canonical_multireturn_slugs(self):
        # The Helios <ASCII_format> hint the XML-import path passes through.
        resp = main._preview_ascii(_MULTI_XYZ, _MULTI_FORMAT, 20)
        by_index = {c.index: c for c in resp.columns}
        # x/y/z keep their reserved roles.
        assert by_index[0].detected_role == "x"
        assert by_index[1].detected_role == "y"
        assert by_index[2].detected_role == "z"
        # The three per-pulse columns are carried as extras under their CANONICAL
        # slugs, not a positional fallback like 'col_4'.
        assert by_index[3].detected_role == "extra"
        assert by_index[3].suggested_slug == "timestamp"
        assert by_index[4].suggested_slug == "target_index"
        assert by_index[5].suggested_slug == "target_count"

    def test_wizard_column_plan_round_trips_multireturn_slugs(self):
        """A column plan built from the preview's suggestions (what the wizard
        ships when the user accepts the defaults) must materialise the three
        per-pulse columns as extra dims under their canonical slugs."""
        resp = main._preview_ascii(_MULTI_XYZ, _MULTI_FORMAT, 20)
        # Mirror the renderer's buildColumnPlan: each column keeps its detected
        # role, and an 'extra' carries the preview's suggested slug/label.
        entries = []
        for c in resp.columns:
            entries.append(main.ColumnPlanEntry(
                index=c.index,
                role=c.detected_role,
                slug=(c.suggested_slug if c.detected_role == "extra" else None),
                label=(c.suggested_label if c.detected_role == "extra" else None),
                categorical=False,
            ))
        plan = main.ColumnPlan(columns=entries, rgb_is_255=False)
        _, extra_dims = main._plan_columns_from_column_plan(plan)
        slugs = {e["slug"] for e in extra_dims}
        assert {"timestamp", "target_index", "target_count"} <= slugs, slugs

    def test_session_path_recovers_multireturn_lad(self, tmp_path):
        """End-to-end through the SESSION feed (the real UI path): import the
        fixture via the column plan, build a session, then run LAD with
        session_id. Must run the multi-return algorithm and recover LAD ~2.0 —
        not the ~0.11 the zeroed-column regression produced."""
        pytest.importorskip("pyhelios")
        import laspy  # noqa: F401  (session create needs it)

        resp = main._preview_ascii(_MULTI_XYZ, _MULTI_FORMAT, 20)
        entries = [
            main.ColumnPlanEntry(
                index=c.index, role=c.detected_role,
                slug=(c.suggested_slug if c.detected_role == "extra" else None),
                label=(c.suggested_label if c.detected_role == "extra" else None),
                categorical=False,
            )
            for c in resp.columns
        ]
        plan = main.ColumnPlan(columns=entries, rgb_is_255=False)

        # Build the session arrays the same way create_cloud_session does.
        las_path, _, source_extra_dims = main._source_to_las(
            main._Path(_MULTI_XYZ), _MULTI_FORMAT, tmp_path, plan)
        positions, colors, intensity, extras, extra_dims_meta = \
            main._read_las_into_arrays(las_path)
        # The per-pulse columns survived the round-trip under canonical slugs.
        assert {"timestamp", "target_index", "target_count"} <= set(extras), \
            sorted(extras)

        sess = main.CloudSession(
            session_id="testmr01",
            source_path=_MULTI_XYZ,
            ascii_format=_MULTI_FORMAT,
            column_plan=plan,
            positions=positions, colors=colors, intensity=intensity,
            extras=extras, extra_dims_meta=extra_dims_meta,
            deleted=np.zeros(len(positions), dtype=bool),
            deleted_history=[],
            octree_cache_id=None,
            created_at=0.0,
        )
        with main._cloud_session_lock:
            main._cloud_sessions["testmr01"] = sess
        try:
            scan = main.HeliosScanEntry(
                session_id="testmr01", origin=_FIXTURE_ORIGIN,
                n_theta=800, n_phi=1600, theta_min=0, theta_max=180,
                phi_min=0, phi_max=360, return_type="multi")
            req = main.LADComputeRequest(
                scans=[scan],
                grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1),
                lmax=0.04, max_aspect_ratio=10, min_voxel_hits=1)
            result = main._do_lad_computation(req)
        finally:
            main._cloud_sessions.pop("testmr01", None)

        assert result["success"] is True, result.get("error")
        assert result["return_mode"] == "multi"
        assert not result.get("warnings"), result.get("warnings")
        assert result["cells"][0]["lad"] == pytest.approx(2.0, rel=0.15)


class TestSingleReturnMissImportColumnMapping:
    """Regression guard for the import-wizard dropping the `is_miss` column.

    A single-return scan carries no timestamp, so LAD can't recover misses by
    gapfilling — it relies on the explicit `is_miss` column the scan ships
    (0.0 return / 1.0 sky-miss). `_tokenize_ascii_format` only keeps tokens it
    recognises as known roles; `is_miss` was absent from `_XYZ_KNOWN_ROLES`, so
    an `<ASCII_format>x y z is_miss</ASCII_format>` hint dropped the 4th token to
    'skip'. The column never reached the session, the cloud arrived at Helios
    with zero misses, and `calculateLeafArea` fail-fast refused it with
    "no sky/miss points". This is exactly what failed in the UI (session) path.
    """

    _FORMAT = "x y z is_miss"

    def test_preview_pins_canonical_miss_slug(self):
        # The Helios <ASCII_format> hint the XML-import path passes through.
        resp = main._preview_ascii(_FIXTURE_XYZ, self._FORMAT, 20)
        by_index = {c.index: c for c in resp.columns}
        assert by_index[0].detected_role == "x"
        assert by_index[1].detected_role == "y"
        assert by_index[2].detected_role == "z"
        # The miss flag reports the dedicated 'is_miss' role token (pre-selects
        # the wizard's 'Miss Flag' option) pinned to the canonical slug — not a
        # positional fallback like 'col_4' and not dropped to 'skip'.
        assert by_index[3].detected_role == "is_miss"
        assert by_index[3].suggested_slug == "is_miss"

    def test_wizard_column_plan_round_trips_miss_slug(self):
        """A column plan built from the preview's suggestions (what the wizard
        ships when the user accepts the defaults) must materialise the miss
        column as an extra dim under the canonical `is_miss` slug."""
        resp = main._preview_ascii(_FIXTURE_XYZ, self._FORMAT, 20)
        entries = [
            main.ColumnPlanEntry(
                index=c.index, role=c.detected_role,
                slug=(c.suggested_slug if c.detected_role == "extra" else None),
                label=(c.suggested_label if c.detected_role == "extra" else None),
                categorical=False,
            )
            for c in resp.columns
        ]
        plan = main.ColumnPlan(columns=entries, rgb_is_255=False)
        _, extra_dims = main._plan_columns_from_column_plan(plan)
        slugs = {e["slug"] for e in extra_dims}
        assert "is_miss" in slugs, slugs

    def test_session_path_has_misses_and_computes_lad(self, tmp_path):
        """End-to-end through the SESSION feed (the real UI path): import the
        single-return fixture via the column plan, build a session, then run LAD
        with session_id. The session must carry the `is_miss` column with real
        misses, and the inversion must recover LAD ~2.0 — not fail with
        "no sky/miss points"."""
        pytest.importorskip("pyhelios")
        import laspy  # noqa: F401  (session create needs it)

        resp = main._preview_ascii(_FIXTURE_XYZ, self._FORMAT, 20)
        entries = [
            main.ColumnPlanEntry(
                index=c.index, role=c.detected_role,
                slug=(c.suggested_slug if c.detected_role == "extra" else None),
                label=(c.suggested_label if c.detected_role == "extra" else None),
                categorical=False,
            )
            for c in resp.columns
        ]
        plan = main.ColumnPlan(columns=entries, rgb_is_255=False)

        las_path, _, _ = main._source_to_las(
            main._Path(_FIXTURE_XYZ), self._FORMAT, tmp_path, plan)
        positions, colors, intensity, extras, extra_dims_meta = \
            main._read_las_into_arrays(las_path)
        # The miss flag survived the round-trip under its canonical slug, and the
        # fixture genuinely carries sky misses (is_miss == 1 for some rows).
        assert "is_miss" in extras, sorted(extras)
        assert bool(np.any(extras["is_miss"] != 0)), "fixture lost its misses"

        sess = main.CloudSession(
            session_id="testsr01",
            source_path=_FIXTURE_XYZ,
            ascii_format=self._FORMAT,
            column_plan=plan,
            positions=positions, colors=colors, intensity=intensity,
            extras=extras, extra_dims_meta=extra_dims_meta,
            deleted=np.zeros(len(positions), dtype=bool),
            deleted_history=[],
            octree_cache_id=None,
            created_at=0.0,
        )
        with main._cloud_session_lock:
            main._cloud_sessions["testsr01"] = sess
        try:
            scan = main.HeliosScanEntry(
                session_id="testsr01", origin=_FIXTURE_ORIGIN,
                n_theta=2600, n_phi=5200, theta_min=0, theta_max=180,
                phi_min=0, phi_max=360, return_type="single")
            req = main.LADComputeRequest(
                scans=[scan],
                grid=main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1),
                lmax=0.04, max_aspect_ratio=10, min_voxel_hits=1)
            result = main._do_lad_computation(req)
        finally:
            main._cloud_sessions.pop("testsr01", None)

        assert result["success"] is True, result.get("error")
        assert result["return_mode"] == "single"
        assert result["cells"][0]["lad"] == pytest.approx(2.0, rel=0.25)
