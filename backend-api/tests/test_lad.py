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

    def triangulateHitPoints(self, lmax, aspect):
        self.calls.append(("triangulate", lmax, aspect))

    def getTriangleCount(self):
        return 100

    def gapfillMisses(self):
        self.calls.append(("gapfill",))

    def calculateLeafArea(self, ctx, min_hits):
        self.calls.append(("calculateLeafArea", min_hits))

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
    f = tmp_path / "scan.xyz"
    f.write_text("0.1 0.1 0.5\n-0.1 0.0 0.6\n0.2 -0.1 0.4\n")
    grid = main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], **(
        {"nx": 1, "ny": 1, "nz": 1} | grid_over))
    scan = main.HeliosScanEntry(file_path=str(f), ascii_format="x y z",
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

    def test_multi_return_without_columns_falls_back_with_warning(self, tmp_path, stub_pyhelios):
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

        assert result["success"] is True
        assert result["return_mode"] == "single"     # fell back
        assert any("multi-return" in w for w in result["warnings"])
        cloud = stub_pyhelios.instances[-1]
        assert "gapfill" not in [c[0] for c in cloud.calls]

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


# ---------------------------------------------------------------------------
# Per-cell hit counting (pure numpy, no pyhelios)
# ---------------------------------------------------------------------------

class TestCountPointsPerCell:
    def test_bins_points_into_uniform_grid(self, tmp_path):
        # 2x1x1 grid spanning x in [-1,1], cells centered at -0.5 and +0.5.
        f = tmp_path / "scan.xyz"
        f.write_text("-0.5 0 0\n-0.6 0 0\n0.5 0 0\n")
        scans_info = [{"filepath": str(f), "ascii_format": "x y z"}]
        centers = [main_vec(-0.5, 0, 0), main_vec(0.5, 0, 0)]
        sizes = [main_vec(1, 1, 1), main_vec(1, 1, 1)]
        counts = main._count_points_per_cell(scans_info, centers, sizes)
        assert counts[0] == 2   # the two negative-x points
        assert counts[1] == 1   # the one positive-x point


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
            file_path=_FIXTURE_XYZ, ascii_format="x y z", origin=_FIXTURE_ORIGIN,
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
