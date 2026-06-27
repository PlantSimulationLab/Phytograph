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

    def addGrid(self, center, size, ndiv, rotation=0.0, column_offsets=None):
        self.calls.append(("addGrid", tuple(center), tuple(size), tuple(ndiv), rotation,
                           tuple(column_offsets) if column_offsets is not None else None))
        # Mimic Helios's k-major (for k: for j: for i) cell ordering so the result
        # loop's `i % (nx*ny)` column mapping and the dropped-column filter can be
        # exercised against a multi-cell grid.
        self.gridcells = int(ndiv[0]) * int(ndiv[1]) * int(ndiv[2])
        self._ndiv = (int(ndiv[0]), int(ndiv[1]), int(ndiv[2]))
        self._column_offsets = list(column_offsets) if column_offsets is not None else None

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

    def calculateLeafArea(self, ctx, min_hits, element_width=None, Gtheta=None):
        # Uncertainty is always on now: _do_lad_computation passes element_width.
        # Gtheta is supplied only on the moving-platform (beam-based) path.
        self.calls.append(("calculateLeafArea", min_hits, element_width, Gtheta))

    def getGridCellCount(self):
        return self.gridcells

    def getCellCenter(self, i):
        # Single-cell default keeps the legacy stub behavior. For a multi-cell grid
        # (terrain tests) reconstruct the unrotated lattice center + per-column
        # offset, mirroring the real LiDARcloud::addGrid arithmetic, so tests can
        # assert the reported z tracks the DEM.
        ndiv = getattr(self, "_ndiv", (1, 1, 1))
        nx, ny, nz = ndiv
        if nx * ny * nz <= 1:
            return main_vec(0.0, 0.0, 0.5)
        k = i // (nx * ny)
        rem = i % (nx * ny)
        j = rem // nx
        ii = rem % nx
        # grid center [0,0,*], size [nx,ny,nz] => unit cells; lattice z origin at 0.
        z = 0.5 + k * 1.0
        off = (self._column_offsets[rem] if getattr(self, "_column_offsets", None) else 0.0)
        return main_vec(-0.5 * nx + ii + 0.5, -0.5 * ny + j + 0.5, z + off)

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

    def test_multi_return_with_timestamp_but_no_misses_now_errors(self, tmp_path, stub_pyhelios):
        # LAD no longer gapfills silently. A multi-return scan that carries a
        # timestamp but no miss points must be backfilled FIRST (the explicit
        # Backfill Misses step); fed straight to LAD it errors actionably.
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

        assert result["success"] is False
        assert "miss" in result["error"].lower()
        assert "backfill" in result["error"].lower()
        cloud = stub_pyhelios.instances[-1]
        names = [c[0] for c in cloud.calls]
        # No silent gapfill, and the inversion is never attempted.
        assert "gapfill" not in names
        assert "calculateLeafArea" not in names

    def test_single_return_with_timestamp_but_no_misses_now_errors(self, tmp_path, stub_pyhelios):
        # Same contract for single-return: a timestamp alone is not misses. LAD
        # directs the user to Backfill Misses rather than recovering them inline.
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

        assert result["success"] is False
        assert "miss" in result["error"].lower()
        assert "backfill" in result["error"].lower()
        cloud = stub_pyhelios.instances[-1]
        assert "gapfill" not in [c[0] for c in cloud.calls]
        assert "calculateLeafArea" not in [c[0] for c in cloud.calls]

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
                # Seed the Context RNG so the multi-return scan is reproducible.
                # syntheticScan's beam-divergence / finite-aperture sub-ray sampling
                # draws from the Context RNG (LiDAR.cpp context->randu/randn), which
                # the Context otherwise seeds from wall-clock — making per-cell LAD
                # scatter run-to-run and the RMSE bound below an intermittent flake.
                # A fixed seed makes the scan deterministic; syntheticScan does not
                # reseed the Context, so this holds for the whole call.
                ctx.seedRandomGenerator(20240607)
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

    def _run(self, xyz, cols, return_type, rotation=0.0):
        scan = main.HeliosScanEntry(
            points=xyz.tolist(),
            scalar_columns=cols,
            origin=self.ORIGIN, n_theta=self.NTHETA, n_phi=self.NPHI,
            theta_min=0, theta_max=180, phi_min=0, phi_max=360,
            return_type=return_type)
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=self.GRID_CENTER, size=self.GRID_SIZE,
                                 nx=2, ny=2, nz=2, rotation=rotation),
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

    def test_rotated_grid_returns_unrotated_centers_and_echoes_rotation(self):
        """A rotated grid must (a) echo grid_rotation in the response, and (b) still
        return AXIS-ALIGNED cell centers — Helios stores the azimuthal rotation
        per-cell and does NOT bake it into getCellCenter. This is the invariant the
        renderer relies on: it rotates the centers about the grid center itself
        (Helios's own visualizer does the same). If Helios ever started returning
        pre-rotated centers, the renderer would double-rotate — this guards that."""
        xyz, cols, _ = self._generate_scan(multi_return=False)
        ROT = 37.0
        result = self._run(xyz, cols, "single", rotation=ROT)
        assert result["success"] is True, result.get("error")
        assert result["grid_rotation"] == pytest.approx(ROT)

        cells = result["cells"]
        assert len(cells) == 8
        # Every cell center is on the AXIS-ALIGNED 2x2x2 lattice about the grid
        # center: |x-gc| == |y-gc| == 0.25. A pre-rotated center would land off this
        # lattice (e.g. x-offset != +/-0.25). z is never rotated.
        gx, gy, _gz = self.GRID_CENTER
        for c in cells:
            cx, cy, _cz = c["center"]
            assert abs(abs(cx - gx) - 0.25) < 1e-3, f"x not on axis-aligned lattice: {cx}"
            assert abs(abs(cy - gy) - 0.25) < 1e-3, f"y not on axis-aligned lattice: {cy}"

        # And the rotation genuinely changed the physics: the per-cell LAD with a
        # 37deg grid differs from the unrotated grid (the beams cross different
        # rotated voxels), so this isn't a silently-ignored parameter.
        unrot = self._run(xyz, cols, "single", rotation=0.0)
        rot_lads = sorted(round(c["lad"], 4) for c in cells)
        unrot_lads = sorted(round(c["lad"], 4) for c in unrot["cells"])
        assert rot_lads != unrot_lads, "rotation did not affect the inversion"


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

    def test_file_path_multireturn_without_misses_now_errors(self):
        # The multi-return fixture carries timestamp/target_* but NO recorded
        # misses. LAD no longer gapfills silently, and the file_path path has no
        # Backfill Misses step (that's session-only), so it must hard-fail with the
        # actionable no-misses error rather than auto-recovering.
        pytest.importorskip("pyhelios")
        result = main._do_lad_computation(self._file_request())
        assert result["success"] is False
        assert "miss" in result["error"].lower()

    def test_synthetic_scalar_columns_without_misses_now_errors(self):
        # Same contract for the inline-points (synthetic) path: timestamp present,
        # misses absent → hard-fail. A synthetic cloud must record misses at
        # generation time to be LAD-ready.
        pytest.importorskip("pyhelios")
        result = main._do_lad_computation(self._synthetic_request())
        assert result["success"] is False
        assert "miss" in result["error"].lower()


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
        fixture via the column plan, build a session, run the explicit Backfill
        Misses step (the fixture carries a timestamp but no recorded misses, and
        LAD no longer gapfills silently), then run LAD with session_id. Must run
        the multi-return algorithm and recover LAD ~2.0 — not the ~0.11 the
        zeroed-column regression produced."""
        import asyncio
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
        las_path, _, source_extra_dims, _, _ = main._source_to_las(
            main._Path(_MULTI_XYZ), _MULTI_FORMAT, tmp_path, plan)
        _r = main._read_las_into_arrays(las_path)
        positions, colors, intensity = _r.positions, _r.colors, _r.intensity
        extras, extra_dims_meta = _r.extras, _r.extra_dims_meta
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
            # Backfill Misses first: recover the sky points from the timestamp and
            # persist them in the session, the way the UI step does. The endpoint
            # streams PHP1 markers + a JSON tail; drain it to the result dict.
            import json as _json
            resp = asyncio.run(main.backfill_cloud_misses(
                "testmr01",
                main.BackfillMissesRequest(
                    origin=_FIXTURE_ORIGIN, n_theta=800, n_phi=1600,
                    theta_min=0, theta_max=180, phi_min=0, phi_max=360)))

            async def _collect():
                return b"".join([c if isinstance(c, (bytes, bytearray)) else c.encode()
                                 async for c in resp.body_iterator])
            raw = asyncio.run(_collect())
            i = 0
            while i + 8 <= len(raw) and raw[i:i + 4] == b"PHP1":
                mlen = int.from_bytes(raw[i + 4:i + 8], "little")
                i += 8 + mlen
            while i < len(raw) and raw[i:i + 1] in (b" ", b"\n", b"\t"):
                i += 1
            bf = _json.loads(raw[i:])
            assert bf["has_misses"] is True
            assert bf["backfilled"] > 0
            assert sess.backfilled_misses is not None

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

        las_path, _, _, _, _ = main._source_to_las(
            main._Path(_FIXTURE_XYZ), self._FORMAT, tmp_path, plan)
        _r = main._read_las_into_arrays(las_path)
        positions, colors, intensity = _r.positions, _r.colors, _r.intensity
        extras, extra_dims_meta = _r.extras, _r.extra_dims_meta
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


class TestLADGridRotation:
    """The LAD voxel grid must honor the grid box's azimuthal rotation, so the
    result grid aligns with the (rotated) grid mesh the user laid out — the same
    fix the triangulation crop already carries."""

    def test_grid_rotation_is_forwarded_to_addGrid_in_degrees(self, tmp_path, stub_pyhelios):
        # Helios's LiDARcloud::addGrid takes DEGREES (it converts *pi/180 internally),
        # despite the PyHelios docstring saying radians. The backend must pass the
        # request's grid.rotation through unchanged, not pre-converted to radians.
        req = _single_return_request(tmp_path, rotation=30.0)
        result = main._do_lad_computation(req)
        assert result["success"] is True

        cloud = stub_pyhelios.instances[-1]
        add_grid = next(c for c in cloud.calls if c[0] == "addGrid")
        # tuple: ("addGrid", center, size, ndiv, rotation)
        assert add_grid[4] == pytest.approx(30.0)
        # And the response carries it so the renderer can orient the voxel cubes.
        assert result["grid_rotation"] == pytest.approx(30.0)

    def test_zero_rotation_is_the_default(self, tmp_path, stub_pyhelios):
        result = main._do_lad_computation(_single_return_request(tmp_path))
        assert result["grid_rotation"] == pytest.approx(0.0)
        cloud = stub_pyhelios.instances[-1]
        add_grid = next(c for c in cloud.calls if c[0] == "addGrid")
        assert add_grid[4] == pytest.approx(0.0)


class TestCountPointsPerCellRotation:
    """`_count_points_per_cell` populates the per-voxel hit_count for the UI. With
    a rotated grid it must bin points in the ROTATED cell frame, matching Helios's
    convention (inverse-rotate about the grid center by -rotation about +z)."""

    @staticmethod
    def _axis_aligned_cells(center, size, nx, ny, nz):
        """Reproduce Helios's getCellCenter output: the UNROTATED (axis-aligned)
        lattice centers. Helios stores the azimuthal rotation per-cell but does NOT
        bake it into the center, so getCellCenter always returns these — which is
        exactly why _count_points_per_cell must un-rotate the POINTS, not the cells."""
        cx, cy, cz = center
        sx, sy, sz = size
        centers, sizes = [], []
        for k in range(nz):
            z = -0.5 * sz + (k + 0.5) * (sz / nz)
            for j in range(ny):
                y = -0.5 * sy + (j + 0.5) * (sy / ny)
                for i in range(nx):
                    x = -0.5 * sx + (i + 0.5) * (sx / nx)
                    centers.append(_Vec(cx + x, cy + y, cz + z))
                    sizes.append(_Vec(sx / nx, sy / ny, sz / nz))
        return centers, sizes

    def test_rotated_grid_bins_points_into_the_correct_cell(self):
        # A 2x1x1 grid centered at origin, rotated 90deg about +z. Helios's cell
        # centers stay UNROTATED at x=-0.5 (cell 0) and x=+0.5 (cell 1). A WORLD
        # point on the +y axis falls in the cell that — after the grid's +90deg
        # rotation — occupies +y, i.e. the cell whose unrotated center is at +x
        # (cell 1). The function un-rotates the point by -90deg: (0,+0.4)->(+0.4,0)
        # which lands in cell 1; (0,-0.4)->(-0.4,0) lands in cell 0.
        center, size = [0.0, 0.0, 0.5], [2.0, 1.0, 1.0]
        centers, sizes = self._axis_aligned_cells(center, size, 2, 1, 1)
        assert centers[0].x == pytest.approx(-0.5, abs=1e-6)
        assert centers[1].x == pytest.approx(0.5, abs=1e-6)

        pts = np.array([[0.0, 0.4, 0.5], [0.0, -0.4, 0.5]], dtype=np.float64)
        counts = main._count_points_per_cell([pts], centers, sizes,
                                             grid_rotation_rad=math.radians(90.0))
        assert counts[1] == 1   # world (0,+0.4) -> rotated cell 1
        assert counts[0] == 1   # world (0,-0.4) -> rotated cell 0

        # Control: with NO rotation, those same world points lie on the y-axis
        # boundary between the two x-cells, not cleanly inside either x-half — so a
        # rotated-aware result that differs from the unrotated one proves rotation
        # actually changed the binning (guards against a no-op).
        counts_norot = main._count_points_per_cell([pts], centers, sizes,
                                                   grid_rotation_rad=0.0)
        assert not np.array_equal(counts, counts_norot)

    def test_unrotated_grid_unchanged(self):
        # Rotation 0 must behave exactly as before (regression guard).
        center, size = [0.0, 0.0, 0.5], [2.0, 1.0, 1.0]
        centers, sizes = self._axis_aligned_cells(center, size, 2, 1, 1)
        pts = np.array([[0.4, 0.0, 0.5], [-0.4, 0.0, 0.5]], dtype=np.float64)
        counts = main._count_points_per_cell([pts], centers, sizes, grid_rotation_rad=0.0)
        assert counts[1] == 1   # (+0.4, 0) -> cell 1 (x=+0.5)
        assert counts[0] == 1   # (-0.4, 0) -> cell 0 (x=-0.5)


# ---------------------------------------------------------------------------
# Terrain-following voxel grids (DEM-sampled per-column z offsets)
# ---------------------------------------------------------------------------

def _flat_dem(nx, ny, cell, origin, z):
    """A fully-valid DEM raster at a constant elevation."""
    return main.DemRaster(grid_z=[float(z)] * (nx * ny), nx=nx, ny=ny,
                          cell=cell, origin=list(origin))


class TestSampleDemColumns:
    """Pure-function tests for _sample_dem_columns (no pyhelios needed)."""

    def test_flat_dem_offsets_lift_grid_bottom_to_surface_plus_clearance(self):
        # 2x2x4 grid, size 2x2x4 (unit cells), centered so its bottom is at z=0.
        # Grid center z = 2.0 (bottom = 0.0). DEM at z=10 everywhere.
        # safety_fraction 0.5, cell height = size.z/nz = 4/4 = 1 -> clearance 0.5.
        # Each column's bottom should land at 10 + 0.5 = 10.5, so the offset added
        # to the regular lattice (whose bottom is at grid_bottom=0) is 10.5.
        offs, kept, dropped = main._sample_dem_columns(
            grid_center=[0.0, 0.0, 2.0], grid_size=[2.0, 2.0, 4.0],
            grid_nx=2, grid_ny=2, grid_nz=4, grid_rotation_rad=0.0,
            dem=_flat_dem(4, 4, 1.0, [-2.0, -2.0], 10.0), safety_fraction=0.5)
        assert dropped == 0
        assert kept.all()
        assert len(offs) == 4
        for o in offs:
            assert o == pytest.approx(10.5)

    def test_sloped_dem_gives_per_column_offsets(self):
        # DEM elevation increases with x: cell (di) has z = di. With a 2x2x2 grid
        # spanning the DEM, the +x columns should get a larger offset than -x.
        nx_d, ny_d = 4, 4
        grid_z = []
        for j in range(ny_d):
            for i in range(nx_d):
                grid_z.append(float(i))  # z rises with x
        dem = main.DemRaster(grid_z=grid_z, nx=nx_d, ny=ny_d, cell=1.0,
                             origin=[-2.0, -2.0])
        offs, kept, dropped = main._sample_dem_columns(
            grid_center=[0.0, 0.0, 1.0], grid_size=[2.0, 2.0, 2.0],
            grid_nx=2, grid_ny=2, grid_nz=2, grid_rotation_rad=0.0,
            dem=dem, safety_fraction=0.0)
        assert dropped == 0 and kept.all()
        # columns: [j*nx+i]; i=0 are -x, i=1 are +x. +x columns sample a higher DEM.
        assert offs[1] > offs[0]   # (i=1,j=0) > (i=0,j=0)
        assert offs[3] > offs[2]   # (i=1,j=1) > (i=0,j=1)

    def test_void_cell_inherits_nearest_valid(self):
        # One void (NaN) cell in the middle of an otherwise-flat DEM; the column
        # over it must inherit a finite neighbor, not be dropped.
        nan = float("nan")
        grid_z = [5.0] * 9
        grid_z[4] = nan  # center cell void
        dem = main.DemRaster(grid_z=grid_z, nx=3, ny=3, cell=1.0, origin=[-1.5, -1.5])
        offs, kept, dropped = main._sample_dem_columns(
            grid_center=[0.0, 0.0, 1.0], grid_size=[1.0, 1.0, 2.0],
            grid_nx=1, grid_ny=1, grid_nz=2, grid_rotation_rad=0.0,
            dem=dem, safety_fraction=0.0)
        # Single column samples the (void) center cell -> inherits 5.0, kept.
        assert dropped == 0
        assert kept.all()
        assert offs[0] == pytest.approx(5.0)  # grid bottom at 0 -> offset == dem_z

    def test_columns_outside_footprint_are_dropped(self):
        # Grid larger than the DEM: outer columns fall outside the raster footprint.
        # 4x4 grid over a 10-unit span -> column centers at +-3.75, +-1.25. A DEM
        # footprint of [-2, 2] catches the +-1.25 columns and drops the +-3.75 ones.
        dem = _flat_dem(4, 4, 1.0, [-2.0, -2.0], 3.0)  # footprint x,y in [-2, 2]
        offs, kept, dropped = main._sample_dem_columns(
            grid_center=[0.0, 0.0, 1.0], grid_size=[10.0, 10.0, 2.0],
            grid_nx=4, grid_ny=4, grid_nz=1, grid_rotation_rad=0.0,
            dem=dem, safety_fraction=0.0)
        assert dropped > 0
        assert not kept.all()
        assert kept.any()  # the central columns over the DEM survive
        # Exactly the inner 2x2 block of columns (|center| = 1.25) survives.
        assert kept.sum() == 4


class TestLADTerrainFollow:
    """Request-path tests with pyhelios stubbed."""

    def _terrain_request(self, tmp_path, dem, nx=2, ny=2, nz=2, **over):
        f = tmp_path / "scan.xyz"
        f.write_text("0.1 0.1 0.5 0\n-0.1 0.0 0.6 0\n0.2 -0.1 0.4 0\n9.0 9.0 9.0 1\n")
        grid = main.HeliosGrid(center=[0, 0, 1.0], size=[2, 2, 2], nx=nx, ny=ny, nz=nz)
        scan = main.HeliosScanEntry(file_path=str(f), ascii_format="x y z is_miss",
                                    origin=[0, 0, 5], return_type="single")
        return main.LADComputeRequest(
            scans=[scan], grid=grid, lmax=0.1, max_aspect_ratio=4.0, min_voxel_hits=1,
            terrain_follow=True, dem=dem, **over)

    def test_offsets_passed_to_addgrid(self, tmp_path, stub_pyhelios):
        dem = _flat_dem(4, 4, 1.0, [-2.0, -2.0], 10.0)
        result = main._do_lad_computation(self._terrain_request(tmp_path, dem))
        assert result["success"] is True
        assert result["terrain_follow"] is True
        assert result["dropped_columns"] == 0
        cloud = stub_pyhelios.instances[-1]
        addgrid = [c for c in cloud.calls if c[0] == "addGrid"][-1]
        column_offsets = addgrid[5]
        assert column_offsets is not None
        assert len(column_offsets) == 4   # nx*ny
        # flat DEM at 10, clearance 0.5*(2/2)=0.5, grid bottom 0 -> offset 10.5
        for o in column_offsets:
            assert o == pytest.approx(10.5)
        # Reported cell centers track the lifted columns (bottom layer z ~ 11.0).
        zmin = min(c["center"][2] for c in result["cells"])
        assert zmin == pytest.approx(11.0, abs=1e-6)  # 0.5 (cell mid) + 10.5 offset

    def test_terrain_follow_requires_dem(self, tmp_path, stub_pyhelios):
        req = self._terrain_request(tmp_path, _flat_dem(4, 4, 1.0, [-2.0, -2.0], 1.0))
        object.__setattr__(req, "dem", None)
        result = main._do_lad_computation(req)
        assert result["success"] is False
        assert "dem" in result["error"].lower()

    def test_dropped_columns_excluded_and_reported(self, tmp_path, stub_pyhelios):
        # The grid is center=[0,0,1], size=[2,2,2], 2x2 columns: each column footprint
        # is 1x1 m, so the +x columns span x in [0,1] and the -x columns x in [-1,0].
        # A DEM covering only x in [-2,0] (and all y) leaves the +x columns' ENTIRE
        # footprint outside it, so they drop. A column is kept if ANY part of its
        # footprint overlaps the DEM (the whole-cell-clears-ground rule samples the
        # footprint, not just the center).
        dem = main.DemRaster(grid_z=[4.0] * (4 * 4), nx=4, ny=4, cell=1.0,
                             origin=[-2.0, -2.0])  # footprint x,y in [-2, 2]
        # Shrink to the -x half: only x in [-2, 0].
        dem = main.DemRaster(grid_z=[4.0] * (2 * 4), nx=2, ny=4, cell=1.0,
                             origin=[-2.0, -2.0])  # x in [-2, 0], y in [-2, 2]
        req = self._terrain_request(tmp_path, dem, nx=2, ny=2, nz=1)
        result = main._do_lad_computation(req)
        # The 2 +x columns (footprint x in [0,1]) lie outside the DEM and drop;
        # the 2 -x columns (x in [-1,0]) overlap it and are kept.
        assert result["dropped_columns"] == 2
        assert len(result["cells"]) == 2
        assert any("dropped" in w.lower() for w in result.get("warnings", []))

    def test_all_columns_dropped_errors(self, tmp_path, stub_pyhelios):
        # DEM far away from the grid -> every column outside footprint.
        dem = _flat_dem(2, 2, 1.0, [1000.0, 1000.0], 4.0)
        result = main._do_lad_computation(self._terrain_request(tmp_path, dem))
        assert result["success"] is False
        assert "outside the dem" in result["error"].lower()


class TestCountPointsTerrain:
    """_count_points_per_cell must bin correctly when columns are z-shifted."""

    def test_terrain_offsets_restore_regular_binning(self):
        # 1x1x2 grid, one column lifted by +10. A point at z = 10.5 (world) sits in
        # the LOWER terrain cell (whose world z-range is [10, 11]); without terrain
        # awareness it would bin against an unshifted [0,2] lattice and miss.
        nx, ny, nz = 1, 1, 2
        col_off = [10.0]
        # cells (unrotated lattice z 0.5/1.5) + offset 10 -> world centers 10.5/11.5
        centers = [main_vec(0.0, 0.0, 0.5 + 10.0), main_vec(0.0, 0.0, 1.5 + 10.0)]
        sizes = [main_vec(1.0, 1.0, 1.0), main_vec(1.0, 1.0, 1.0)]
        pts = np.array([[0.0, 0.0, 10.4], [0.0, 0.0, 11.6]], dtype=np.float64)
        counts = main._count_points_per_cell(
            [pts], centers, sizes, grid_rotation_rad=0.0,
            column_z_offsets=col_off, ndiv=(nx, ny, nz))
        assert counts[0] == 1   # 10.4 -> lower terrain cell [10,11]
        assert counts[1] == 1   # 11.6 -> upper terrain cell [11,12]


class TestLADGthetaOverride:
    """A static scan can skip triangulation and invert with a supplied G(theta)."""

    def _static_request(self, tmp_path, **over):
        f = tmp_path / "scan.xyz"
        f.write_text("0.1 0.1 0.5 0\n-0.1 0.0 0.6 0\n0.2 -0.1 0.4 0\n9.0 9.0 9.0 1\n")
        grid = main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1)
        scan = main.HeliosScanEntry(file_path=str(f), ascii_format="x y z is_miss",
                                    origin=[0, 0, 5], return_type="single")
        return main.LADComputeRequest(scans=[scan], grid=grid, lmax=0.1,
                                      max_aspect_ratio=4.0, min_voxel_hits=1, **over)

    def test_override_skips_triangulation_and_passes_gtheta(self, tmp_path, stub_pyhelios):
        req = self._static_request(tmp_path, gtheta_override=True, gtheta=0.5)
        result = main._do_lad_computation(req)
        assert result["success"] is True
        cloud = stub_pyhelios.instances[-1]
        names = [c[0] for c in cloud.calls]
        # The override path must NOT triangulate...
        assert "triangulate" not in names
        # ...and must pass the supplied G(theta) to calculateLeafArea.
        cla = [c for c in cloud.calls if c[0] == "calculateLeafArea"][-1]
        assert cla[3] == pytest.approx(0.5)   # (name, min_hits, element_width, Gtheta)

    def test_static_without_override_still_triangulates(self, tmp_path, stub_pyhelios):
        result = main._do_lad_computation(self._static_request(tmp_path))
        assert result["success"] is True
        cloud = stub_pyhelios.instances[-1]
        names = [c[0] for c in cloud.calls]
        assert "triangulate" in names
        cla = [c for c in cloud.calls if c[0] == "calculateLeafArea"][-1]
        assert cla[3] is None   # no supplied G(theta) on the triangulated path

    def test_override_defaults_gtheta_to_half_with_warning(self, tmp_path, stub_pyhelios):
        # Override on but no gtheta supplied -> default 0.5 + a warning.
        req = self._static_request(tmp_path, gtheta_override=True)
        result = main._do_lad_computation(req)
        assert result["success"] is True
        cloud = stub_pyhelios.instances[-1]
        cla = [c for c in cloud.calls if c[0] == "calculateLeafArea"][-1]
        assert cla[3] == pytest.approx(0.5)
        assert any("g(theta)" in w.lower() for w in result.get("warnings", []))

    def test_override_rejects_reused_mesh(self, tmp_path, stub_pyhelios):
        # A reused triangulation is incompatible with a G(theta) override.
        req = self._static_request(tmp_path, gtheta_override=True, gtheta=0.5)
        fake_mesh = (np.zeros((3, 3), np.float32),
                     np.array([[0, 1, 2]], np.int64),
                     np.array([0], np.int32))
        result = main._do_lad_computation(req, reuse_mesh=fake_mesh)
        assert result["success"] is False
        assert "override" in result["error"].lower() or "g(theta)" in result["error"].lower()


class TestSnapGridEndpoint:
    """POST /api/lad/snap-grid runs _sample_dem_columns (single source of truth)."""

    def test_snap_returns_offsets_tracking_slope(self):
        # DEM elevation rises with x; the snapped columns' offsets must rise too.
        nx_d, ny_d = 4, 4
        grid_z = [float(i) for j in range(ny_d) for i in range(nx_d)]
        dem = main.DemRaster(grid_z=grid_z, nx=nx_d, ny=ny_d, cell=1.0,
                             origin=[-2.0, -2.0])
        grid = main.HeliosGrid(center=[0, 0, 1.0], size=[2, 2, 2], nx=2, ny=2, nz=2)
        req = main.SnapGridRequest(grid=grid, dem=dem, safety_fraction=0.0)
        # Call the helper the endpoint wraps (avoids spinning up the ASGI app).
        import math as _m
        offsets, kept, dropped = main._sample_dem_columns(
            grid.center, grid.size, grid.nx, grid.ny, grid.nz,
            _m.radians(grid.rotation), dem, req.safety_fraction)
        assert dropped == 0 and kept.all()
        # +x columns sample a higher DEM than -x columns.
        assert offsets[1] > offsets[0]
        assert offsets[3] > offsets[2]


class TestLADAuthoritativeOffsets:
    """A snapped grid's column_offsets are used verbatim; the DEM is NOT re-sampled."""

    def _request(self, tmp_path, **grid_over):
        f = tmp_path / "scan.xyz"
        f.write_text("0.1 0.1 0.5 0\n-0.1 0.0 0.6 0\n0.2 -0.1 0.4 0\n9.0 9.0 9.0 1\n")
        grid = main.HeliosGrid(center=[0, 0, 1.0], size=[2, 2, 2], nx=2, ny=2, nz=1,
                               **grid_over)
        scan = main.HeliosScanEntry(file_path=str(f), ascii_format="x y z is_miss",
                                    origin=[0, 0, 5], return_type="single")
        return main.LADComputeRequest(scans=[scan], grid=grid, lmax=0.1,
                                      max_aspect_ratio=4.0, min_voxel_hits=1)

    def test_offsets_used_verbatim_without_resampling(self, tmp_path, stub_pyhelios, monkeypatch):
        # If _do_lad_computation re-sampled the DEM, this would blow up — proving
        # the authoritative path skips it entirely.
        def _boom(*a, **k):
            raise AssertionError("_sample_dem_columns must NOT run for an authoritative grid")
        monkeypatch.setattr(main, "_sample_dem_columns", _boom)

        offs = [1.0, 2.0, 3.0, 4.0]  # nx*ny = 4
        req = self._request(tmp_path, column_offsets=offs)
        result = main._do_lad_computation(req)
        assert result["success"] is True
        assert result["terrain_follow"] is True
        cloud = stub_pyhelios.instances[-1]
        addgrid = [c for c in cloud.calls if c[0] == "addGrid"][-1]
        assert list(addgrid[5]) == offs   # passed straight through to addGrid

    def test_kept_columns_drop_excludes_cells(self, tmp_path, stub_pyhelios):
        # Mark one column dropped; its cells must be excluded from the result.
        offs = [1.0, 2.0, 3.0, 4.0]
        kept = [True, False, True, True]   # column 1 dropped
        req = self._request(tmp_path, column_offsets=offs, kept_columns=kept)
        result = main._do_lad_computation(req)
        assert result["success"] is True
        # nz=1 so cells == columns; 3 kept of 4.
        assert len(result["cells"]) == 3
        assert result["dropped_columns"] == 1

    def test_wrong_length_offsets_error(self, tmp_path, stub_pyhelios):
        req = self._request(tmp_path, column_offsets=[1.0, 2.0])  # need 4
        result = main._do_lad_computation(req)
        assert result["success"] is False
        assert "column_offsets" in result["error"]

    def test_all_columns_dropped_errors(self, tmp_path, stub_pyhelios):
        req = self._request(tmp_path, column_offsets=[1.0, 2.0, 3.0, 4.0],
                            kept_columns=[False, False, False, False])
        result = main._do_lad_computation(req)
        assert result["success"] is False
        assert "no valid columns" in result["error"].lower()
