"""Unit tests for the Helios triangulation plumbing in main.py.

These cover the pure XML/grid/bounds helpers and the request-shaping logic of
`_do_helios_computation` that decides per-scan resolution, angular bounds, and
the grid. To avoid requiring a compiled pyhelios in CI, the test that exercises
`_do_helios_computation` monkeypatches the pyhelios entry points and captures
the arguments passed to `_generate_helios_xml` — asserting on what *would* be
fed to Helios, which is exactly the integration this change fixes.
"""

import os
import re
from collections import Counter

import pytest

import main

# The committed sphere fixture mirrors the C++ lidar self-test's sphere.xml.
_SPHERE_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..",
                 "tests", "e2e", "fixtures", "sphere-scan"))
_SPHERE_FMT = "row column x y z r g b reflectance"
_SPHERE_ORIGINS = [(-2, 0, 0.5), (0, -2, 0.5), (2, 0, 0.5), (0, 2, 0.5)]


# ---------------------------------------------------------------------------
# _file_xyz_bounds
# ---------------------------------------------------------------------------

class TestXyzColumnIndices:
    def test_defaults_to_first_three_columns(self):
        assert main._xyz_column_indices(None) == (0, 1, 2)
        assert main._xyz_column_indices("x y z") == (0, 1, 2)

    def test_locates_xyz_when_not_leading(self):
        # The sphere fixture's format: coords are columns 2-4.
        assert main._xyz_column_indices("row column x y z r g b reflectance") == (2, 3, 4)

    def test_falls_back_when_format_lacks_xyz(self):
        assert main._xyz_column_indices("a b c d") == (0, 1, 2)


class TestFileXyzBounds:
    def test_returns_count_and_bounds(self, tmp_path):
        f = tmp_path / "scan.xyz"
        f.write_text("0 0 0\n1 2 3\n-1 5 2\n")
        n, lo, hi = main._file_xyz_bounds(str(f))
        assert n == 3
        assert lo == [-1.0, 0.0, 0.0]
        assert hi == [1.0, 5.0, 3.0]

    def test_uses_ascii_format_to_locate_coords(self, tmp_path):
        # "row column x y z ..." → coords in columns 2-4, not 0-2.
        f = tmp_path / "scan.xyz"
        f.write_text(
            "0 0 -1.0 2.0 3.0 255 0 0 0.5\n"
            "1 0 4.0 -5.0 6.0 255 0 0 0.5\n")
        n, lo, hi = main._file_xyz_bounds(str(f), _SPHERE_FMT)
        assert n == 2
        assert lo == [-1.0, -5.0, 3.0]
        assert hi == [4.0, 2.0, 6.0]

    def test_skips_comments_and_short_lines(self, tmp_path):
        f = tmp_path / "scan.xyz"
        f.write_text("# header\n0 0 0\n\nbad line\n2 2 2 99\n")
        n, lo, hi = main._file_xyz_bounds(str(f))
        # Two valid coordinate lines (the 4-col one keeps its first 3 cols).
        assert n == 2
        assert lo == [0.0, 0.0, 0.0]
        assert hi == [2.0, 2.0, 2.0]

    def test_empty_file_returns_none_bounds(self, tmp_path):
        f = tmp_path / "scan.xyz"
        f.write_text("# only a comment\n")
        n, lo, hi = main._file_xyz_bounds(str(f))
        assert n == 0 and lo is None and hi is None


# ---------------------------------------------------------------------------
# _bin_points_to_cells
# ---------------------------------------------------------------------------

class TestBinPointsToCells:
    def test_single_cell_grid_bins_everything_to_zero(self):
        # The auto 1x1x1 grid: every in-bounds point lands in cell 0.
        pts = [[0, 0, 0], [0.4, -0.4, 0.4], [-0.49, 0.49, -0.49]]
        ids = main._bin_points_to_cells(pts, [0, 0, 0], [1, 1, 1], 1, 1, 1)
        assert ids.tolist() == [0, 0, 0]

    def test_row_major_index_ordering(self):
        # 2x2x2 grid centered at origin, size 2 → cells are unit cubes spanning
        # [-1,0] and [0,1] per axis. Index = i + nx*(j + ny*k).
        # Point in the (i=1,j=0,k=0) cell → 1; (0,1,0) → 2; (0,0,1) → 4.
        pts = [
            [-0.5, -0.5, -0.5],  # (0,0,0) -> 0
            [0.5, -0.5, -0.5],   # (1,0,0) -> 1
            [-0.5, 0.5, -0.5],   # (0,1,0) -> 2
            [-0.5, -0.5, 0.5],   # (0,0,1) -> 4
            [0.5, 0.5, 0.5],     # (1,1,1) -> 7
        ]
        ids = main._bin_points_to_cells(pts, [0, 0, 0], [2, 2, 2], 2, 2, 2)
        assert ids.tolist() == [0, 1, 2, 4, 7]

    def test_points_outside_grid_get_negative_one(self):
        pts = [[0, 0, 0], [100, 0, 0], [0, -100, 0]]
        ids = main._bin_points_to_cells(pts, [0, 0, 0], [1, 1, 1], 1, 1, 1)
        assert ids.tolist() == [0, -1, -1]

    def test_empty_input_returns_empty(self):
        ids = main._bin_points_to_cells([], [0, 0, 0], [1, 1, 1], 1, 1, 1)
        assert ids.tolist() == []


# ---------------------------------------------------------------------------
# _generate_helios_xml
# ---------------------------------------------------------------------------

def _scan_info(**overrides):
    base = {
        "filepath": "/tmp/a.xyz",
        "ascii_format": "x y z",
        "origin": [0.0, 0.0, 1.0],
        "n_theta": 100,
        "n_phi": 200,
        "theta_min": 10.0,
        "theta_max": 120.0,
        "phi_min": 0.0,
        "phi_max": 360.0,
    }
    base.update(overrides)
    return base


class TestGenerateHeliosXml:
    def test_per_scan_angles_and_size_are_written(self, tmp_path):
        scans = [
            _scan_info(origin=[0, 0, 1], n_theta=50, n_phi=60,
                       theta_min=5, theta_max=95, phi_min=10, phi_max=350),
            _scan_info(origin=[1, 1, 2], n_theta=70, n_phi=80,
                       theta_min=20, theta_max=160, phi_min=0, phi_max=180),
        ]
        path = main._generate_helios_xml(
            str(tmp_path), scans, grid_center=[0, 0, 0], grid_size=[10, 10, 10])
        xml = open(path).read()

        # Two distinct <scan> blocks, each with its own size + angular bounds.
        blocks = re.findall(r"<scan>.*?</scan>", xml, re.DOTALL)
        assert len(blocks) == 2
        assert "<size>50 60</size>" in blocks[0]
        assert "<thetaMin>5</thetaMin>" in blocks[0]
        assert "<phiMax>350</phiMax>" in blocks[0]
        assert "<size>70 80</size>" in blocks[1]
        assert "<thetaMax>160</thetaMax>" in blocks[1]
        assert "<phiMax>180</phiMax>" in blocks[1]

    def test_grid_subdivisions_default_to_single_cell(self, tmp_path):
        path = main._generate_helios_xml(
            str(tmp_path), [_scan_info()], grid_center=[1, 2, 3], grid_size=[4, 5, 6])
        xml = open(path).read()
        assert "<Nx>1</Nx>" in xml
        assert "<Ny>1</Ny>" in xml
        assert "<Nz>1</Nz>" in xml
        assert "<center>1 2 3</center>" in xml
        assert "<size>4 5 6</size>" in xml

    def test_grid_subdivisions_are_honored(self, tmp_path):
        path = main._generate_helios_xml(
            str(tmp_path), [_scan_info()], grid_center=[0, 0, 0],
            grid_size=[1, 1, 1], grid_nx=2, grid_ny=3, grid_nz=4)
        xml = open(path).read()
        assert "<Nx>2</Nx>" in xml
        assert "<Ny>3</Ny>" in xml
        assert "<Nz>4</Nz>" in xml

    def test_xml_name_lets_per_scan_configs_coexist(self, tmp_path):
        # Per-scan triangulation writes one config per scan into one temp dir.
        p0 = main._generate_helios_xml(
            str(tmp_path), [_scan_info()], [0, 0, 0], [1, 1, 1],
            xml_name="helios_config_0.xml")
        p1 = main._generate_helios_xml(
            str(tmp_path), [_scan_info()], [0, 0, 0], [1, 1, 1],
            xml_name="helios_config_1.xml")
        assert p0 != p1
        assert p0.endswith("helios_config_0.xml")
        assert p1.endswith("helios_config_1.xml")


# ---------------------------------------------------------------------------
# _do_helios_computation — request shaping (pyhelios stubbed)
# ---------------------------------------------------------------------------

class _FakeCloud:
    """Minimal stand-in: load the XML we generated, report zero triangles."""
    def __init__(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def disableMessages(self):
        pass

    def loadXML(self, path):
        pass

    def triangulateHitPoints(self, lmax, aspect):
        pass

    def getTriangleCount(self):
        return 0  # short-circuits before needing a real Context

    def getTriangulationStats(self):
        return {"candidates": 0, "dropped_lmax": 0,
                "dropped_aspect": 0, "dropped_degenerate": 0}


@pytest.fixture
def captured_xml(monkeypatch):
    """Capture the args passed to _generate_helios_xml, and stub pyhelios so the
    computation runs without a compiled native lib."""
    captured = {}

    real = main._generate_helios_xml

    # Per-scan triangulation calls this once per scan with a single-element
    # scans_info; accumulate them so single-scan tests still read [0] and the
    # grid (shared across calls) is captured from the last call.
    captured.setdefault("scans_info", [])

    def spy(tmpdir, scans_info, grid_center, grid_size,
            grid_nx=1, grid_ny=1, grid_nz=1, xml_name="helios_config.xml",
            grid_rotation_deg=0.0):
        captured["scans_info"].extend(scans_info)
        captured["grid_center"] = grid_center
        captured["grid_size"] = grid_size
        captured["grid_nxyz"] = (grid_nx, grid_ny, grid_nz)
        captured["grid_rotation_deg"] = grid_rotation_deg
        return real(tmpdir, scans_info, grid_center, grid_size,
                    grid_nx, grid_ny, grid_nz, xml_name,
                    grid_rotation_deg=grid_rotation_deg)

    monkeypatch.setattr(main, "_generate_helios_xml", spy)

    # Stub the pyhelios import inside _do_helios_computation.
    import sys
    import types
    fake = types.ModuleType("pyhelios")
    fake.LiDARCloud = _FakeCloud
    fake.Context = _FakeCloud
    monkeypatch.setitem(sys.modules, "pyhelios", fake)

    return captured


def _points_scan(points, origin, **extra):
    return main.HeliosScanEntry(points=points, origin=origin, **extra)


class TestDoHeliosComputationShaping:
    def test_per_scan_resolution_used_when_supplied(self, captured_xml):
        req = main.HeliosTriangulationRequest(scans=[
            _points_scan(
                [[0, 0, 0], [1, 1, 1], [2, 0, 1]],
                origin=[0, 0, 5],
                n_theta=33, n_phi=44,
                theta_min=15, theta_max=140, phi_min=5, phi_max=355,
            ),
        ])
        # The fake cloud reports zero triangles, so the run "fails"; this test
        # only cares about what geometry was fed to _generate_helios_xml.
        main._do_helios_computation(req)
        si = captured_xml["scans_info"][0]
        # The supplied values are used verbatim — not the count-based guess.
        assert si["n_theta"] == 33 and si["n_phi"] == 44
        assert si["theta_min"] == 15 and si["theta_max"] == 140
        assert si["phi_min"] == 5 and si["phi_max"] == 355

    def test_resolution_falls_back_to_count_estimate(self, captured_xml):
        # No per-scan n_theta/n_phi → backend estimates from point count.
        pts = [[float(i), 0.0, 0.0] for i in range(400)]
        req = main.HeliosTriangulationRequest(scans=[_points_scan(pts, origin=[0, 0, 5])])
        main._do_helios_computation(req)
        si = captured_xml["scans_info"][0]
        assert si["n_theta"] >= 10 and si["n_phi"] >= 10
        # Falls back to request-level angles (defaults) when scan omits them.
        assert si["theta_min"] == req.theta_min
        assert si["phi_max"] == req.phi_max

    def test_no_grid_autocreates_single_cell_over_bbox_with_warning(self, captured_xml):
        pts = [[-1, -2, -3], [4, 5, 6]]
        req = main.HeliosTriangulationRequest(scans=[_points_scan(pts, origin=[0, 0, 5])])
        result = main._do_helios_computation(req)

        assert result["grid_warning"] is True
        assert "bounding box" in result["grid_message"]
        assert captured_xml["grid_nxyz"] == (1, 1, 1)
        # Center is the midpoint of the bbox; size encloses the full extent.
        cx, cy, cz = captured_xml["grid_center"]
        sx, sy, sz = captured_xml["grid_size"]
        assert cx == pytest.approx(1.5) and cy == pytest.approx(1.5) and cz == pytest.approx(1.5)
        assert sx >= 5.0 and sy >= 7.0 and sz >= 9.0  # padded extents

    def test_explicit_grid_is_used_verbatim(self, captured_xml):
        pts = [[0, 0, 0], [1, 1, 1]]
        req = main.HeliosTriangulationRequest(
            scans=[_points_scan(pts, origin=[0, 0, 5])],
            grid=main.HeliosGrid(center=[10, 20, 30], size=[2, 3, 4], nx=2, ny=2, nz=3),
        )
        result = main._do_helios_computation(req)

        assert result["grid_warning"] is False
        assert captured_xml["grid_center"] == [10, 20, 30]
        assert captured_xml["grid_size"] == [2, 3, 4]
        assert captured_xml["grid_nxyz"] == (2, 2, 3)
        assert captured_xml["grid_rotation_deg"] == 0.0  # default when absent

    def test_grid_rotation_is_passed_through(self, captured_xml):
        # Regression: HeliosGrid.rotation was dropped by the model, so a rotated
        # UI grid cropped its axis-aligned extent and leaked points past the
        # rotated walls. The rotation must reach _generate_helios_xml.
        pts = [[0, 0, 0], [1, 1, 1]]
        req = main.HeliosTriangulationRequest(
            scans=[_points_scan(pts, origin=[0, 0, 5])],
            grid=main.HeliosGrid(center=[0, 0, 0], size=[4, 4, 3], rotation=61.0),
        )
        main._do_helios_computation(req)
        assert captured_xml["grid_rotation_deg"] == 61.0


# ---------------------------------------------------------------------------
# End-to-end reproduction of the C++ lidar self-test, against real pyhelios.
# ---------------------------------------------------------------------------

@pytest.mark.skipif(
    not all(os.path.isfile(os.path.join(_SPHERE_DIR, f"sphere_scan{i}.xyz"))
            for i in range(4)),
    reason="sphere fixture data not present")
class TestSphereReproduction:
    """Mirror the C++ 'LiDAR Single Voxel Sphere Test', which loads four
    100x200 scans of a unit sphere and triangulates to ~383 primitives. We feed
    the same data through the real triangulation path (no pyhelios stub) and
    expect the same count via the auto-fit single-cell grid."""

    def _request(self, grid=None):
        scans = [
            main.HeliosScanEntry(
                file_path=os.path.join(_SPHERE_DIR, f"sphere_scan{i}.xyz"),
                ascii_format=_SPHERE_FMT, origin=list(o),
                n_theta=100, n_phi=200,
                theta_min=0, theta_max=180, phi_min=0, phi_max=360)
            for i, o in enumerate(_SPHERE_ORIGINS)
        ]
        return main.HeliosTriangulationRequest(
            scans=scans, lmax=0.5, max_aspect_ratio=5, grid=grid)

    def test_autogrid_reproduces_cpp_triangle_count(self):
        pytest.importorskip("pyhelios")
        result = main._do_helios_computation(self._request())
        assert result["success"] is True, result.get("error")
        assert result["grid_warning"] is True
        # C++ reference: 383 primitives. Allow a small band for platform variance.
        assert 340 <= result["num_triangles"] <= 430

    def test_triangle_scan_ids_cover_all_four_scans(self):
        pytest.importorskip("pyhelios")
        result = main._do_helios_computation(self._request())
        ids = result["triangle_scan_ids"]
        # One id per triangle, aligned with the triangle list.
        assert len(ids) == len(result["triangles"]) == result["num_triangles"]
        # Every id refers to a real scan, and all four scans contribute
        # (per-scan triangulation tags each triangle with its origin scan).
        assert all(0 <= i < 4 for i in ids)
        assert set(ids) == {0, 1, 2, 3}

    def test_triangle_cell_ids_align_and_route_to_grid(self):
        pytest.importorskip("pyhelios")
        # A 2x2x2 grid spanning the sphere: triangle centroids should spread
        # across more than one cell, and every id must be a valid cell index
        # (0..7) or -1, aligned 1:1 with the triangle list.
        grid = main.HeliosGrid(center=[0, 0, 0.5], size=[3, 3, 3], nx=2, ny=2, nz=2)
        result = main._do_helios_computation(self._request(grid=grid))
        assert result["success"] is True, result.get("error")
        cell_ids = result["triangle_cell_ids"]
        assert len(cell_ids) == result["num_triangles"]
        assert all(i == -1 or 0 <= i < 8 for i in cell_ids)
        # The sphere is not confined to a single octant — multiple cells get hits.
        assert len({i for i in cell_ids if i >= 0}) > 1

    def test_frontend_filter_reproduces_cpp_kept_set(self):
        """The interactive front-end filter (lib/heliosFilter.ts) must reproduce
        the C++ triangulateHitPoints output. The backend no longer sends
        per-triangle metrics — the front-end recomputes max-edge / aspect from the
        returned geometry (computeHeliosMetrics) and applies the keep rule. We
        mirror that here: run unfiltered (every candidate), recompute the metrics
        from the returned vertices, apply the keep rule at lmax=0.1 / aspect=5,
        and require the same triangle set as a direct C++ run at those values."""
        pytest.importorskip("pyhelios")
        lmax, aspect = 0.1, 5.0

        base = self._request()
        full = main._do_helios_computation(
            base.model_copy(update={"lmax": 1.0e9, "max_aspect_ratio": 1.0e9}))
        filtered = main._do_helios_computation(
            base.model_copy(update={"lmax": lmax, "max_aspect_ratio": aspect}))
        assert full["success"] and filtered["success"]

        def canon(verts, tris):
            """Multiset of triangles as sorted, rounded vertex-coordinate tuples,
            so two runs with different vertex dedup/order compare equal."""
            c = Counter()
            for a, b, cc in tris:
                tri = tuple(sorted(
                    tuple(round(verts[i][k], 4) for k in range(3)) for i in (a, b, cc)))
                c[tri] += 1
            return c

        def edge(verts, i, j):
            return sum((verts[i][k] - verts[j][k]) ** 2 for k in range(3)) ** 0.5

        # Recompute metrics from geometry (as computeHeliosMetrics does) and apply
        # the keep rule: KEEP iff maxEdge <= lmax && maxEdge/minEdge <= aspect.
        fv, ft = full["vertices"], full["triangles"]
        py_kept = Counter()
        for a, b, cc in ft:
            e = [edge(fv, a, b), edge(fv, b, cc), edge(fv, a, cc)]
            mx, mn = max(e), min(e)
            asp = mx / mn if mn > 0 else 1e9
            if mx <= lmax and asp <= aspect:
                tri = tuple(sorted(
                    tuple(round(fv[i][k], 4) for k in range(3)) for i in (a, b, cc)))
                py_kept[tri] += 1

        cpp_kept = canon(filtered["vertices"], filtered["triangles"])

        # Equivalence modulo the 5-dp vertex dedup + float32/float64 differences,
        # which can flip a vanishing number of triangles right at the Lmax boundary.
        tol = max(8, round(0.02 * full["num_triangles"]))
        sym_diff = sum((py_kept - cpp_kept).values()) + sum((cpp_kept - py_kept).values())
        assert sym_diff <= tol, (
            f"front-end filter diverged from C++ on {sym_diff} triangles "
            f"(py kept {sum(py_kept.values())}, C++ kept {filtered['num_triangles']})")
        assert abs(sum(py_kept.values()) - filtered["num_triangles"]) <= tol

        # The filter genuinely dropped triangles at this Lmax (exercises the logic).
        kept = sum(py_kept.values())
        assert full["num_triangles"] - kept > 0
        assert kept > 0


# ---------------------------------------------------------------------------
# Triangulation filter diagnostics (the candidate / dropped breakdown)
# ---------------------------------------------------------------------------

class TestTriangulationZeroMessage:
    """Pure-function: the 0-triangle explanation derived from the breakdown."""

    def test_no_candidates_blames_data(self):
        diag = {"candidates": 0, "kept": 0, "dropped_lmax": 0,
                "dropped_aspect": 0, "dropped_degenerate": 0}
        msg = main._triangulation_zero_message(diag, 0.05, 4.0)
        assert "no candidate triangles" in msg

    def test_all_dropped_by_lmax_blames_lmax(self):
        diag = {"candidates": 244, "kept": 0, "dropped_lmax": 244,
                "dropped_aspect": 0, "dropped_degenerate": 0}
        msg = main._triangulation_zero_message(diag, 0.01, 4.0)
        assert "Lmax" in msg and "0.01" in msg
        assert "244" in msg

    def test_mostly_aspect_blames_aspect(self):
        diag = {"candidates": 100, "kept": 0, "dropped_lmax": 10,
                "dropped_aspect": 90, "dropped_degenerate": 0}
        msg = main._triangulation_zero_message(diag, 0.5, 4.0)
        assert "aspect" in msg.lower() and "4" in msg


class TestTriangulationQualityWarning:
    """Pure-function: warn when a mesh formed but almost nothing was filtered."""

    def test_warns_when_under_one_percent_filtered(self):
        diag = {"candidates": 1000, "kept": 995, "dropped_lmax": 3,
                "dropped_aspect": 2, "dropped_degenerate": 0}
        warn = main._triangulation_quality_warning(diag)
        assert warn is not None and "bridge" in warn

    def test_no_warning_when_healthy_fraction_filtered(self):
        diag = {"candidates": 1000, "kept": 500, "dropped_lmax": 400,
                "dropped_aspect": 100, "dropped_degenerate": 0}
        assert main._triangulation_quality_warning(diag) is None

    def test_no_warning_when_nothing_kept(self):
        # A genuine zero is handled by the zero-message path, not this one.
        diag = {"candidates": 100, "kept": 0, "dropped_lmax": 100,
                "dropped_aspect": 0, "dropped_degenerate": 0}
        assert main._triangulation_quality_warning(diag) is None


class TestDiagnosticsEndToEnd(TestSphereReproduction):
    """Real pyhelios: the breakdown must reconcile and drive the right verdict."""

    def test_success_diagnostics_reconcile(self):
        pytest.importorskip("pyhelios")
        result = main._do_helios_computation(self._request())
        assert result["success"] is True, result.get("error")
        d = result["diagnostics"]
        # candidates == kept + every drop bucket (single-reason attribution).
        assert d["candidates"] == (
            d["kept"] + d["dropped_lmax"] + d["dropped_aspect"]
            + d["dropped_degenerate"])
        assert d["kept"] == result["num_triangles"]
        assert d["candidates"] > 0

    def test_too_small_lmax_reports_failure_with_lmax_blame(self):
        pytest.importorskip("pyhelios")
        # The coarse sphere scans (~mm-cm spacing) at Lmax=0.001 m (1 mm) leave
        # every candidate over-length: 0 triangles, all dropped by Lmax.
        req = self._request()
        req.lmax = 0.001
        result = main._do_helios_computation(req)
        assert result["success"] is False
        assert result["num_triangles"] == 0
        d = result["diagnostics"]
        assert d["candidates"] > 0          # data DID form candidates...
        assert d["kept"] == 0               # ...but none survived...
        assert d["dropped_lmax"] > 0        # ...because of Lmax.
        assert d["candidates"] == (
            d["kept"] + d["dropped_lmax"] + d["dropped_aspect"]
            + d["dropped_degenerate"])
        assert "Lmax" in result["error"]
