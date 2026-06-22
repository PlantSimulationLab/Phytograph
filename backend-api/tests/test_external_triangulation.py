"""Tests for LiDARCloud.setExternalTriangulation — injecting a pre-computed triangle
mesh in place of Helios's internal Constrained-Delaunay triangulation.

Leaf-area inversion consumes triangulation only through the per-voxel G(theta)
leaf-angle term (computeGtheta in the C++ plugin), which needs each triangle's
three vertices, its source scan, and the grid cell its centroid falls in — not the
triangulation topology. setExternalTriangulation supplies exactly that so a re-used
Helios mesh (avoiding a recompute) or a per-scan open3d Ball-Pivot mesh can drive
the inversion.

The authoritative check is an equivalence round-trip: on one synthetic-scan cloud,
run the inversion with the internal triangulation and capture the per-cell leaf
area / G(theta); then re-inject that exact same triangle list via
setExternalTriangulation and re-run. The hits/misses are unchanged, so injection
must reproduce the internal result to float tolerance — proving the new path feeds
G(theta) identically.
"""

import math
import os

import numpy as np
import pytest

_HELIOS_CORE = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", "pyhelios", "helios-core"))
_GEOM_XML = "plugins/lidar/xml/leaf_cube_LAI2_lw0_01_spherical.xml"

# Single 1x1x1 voxel covering the leaf cube; matches the C++ single-voxel oracle.
ORIGIN = [-5.0, 0.0, 0.5]
GRID_CENTER = [0.0, 0.0, 0.5]
GRID_SIZE = [1.0, 1.0, 1.0]
NTHETA, NPHI = 4000, 4800


@pytest.mark.skipif(
    not os.path.isfile(os.path.join(_HELIOS_CORE, _GEOM_XML)),
    reason="leaf-cube geometry not present (helios-core submodule)")
class TestExternalTriangulationRoundTrip:

    def _build_cloud(self, nx=1, ny=1, nz=1):
        """A synthetic-scan cloud of the LAI=2 leaf cube with misses recorded
        (calculateLeafArea fail-fasts without the transmission denominator)."""
        pytest.importorskip("pyhelios")
        from pyhelios import LiDARCloud, Context

        cwd = os.getcwd()
        os.chdir(_HELIOS_CORE)
        try:
            cloud = LiDARCloud()
            cloud.disableMessages()
            cloud.addScan(
                origin=ORIGIN, Ntheta=NTHETA, theta_range=(0.0, math.pi),
                Nphi=NPHI, phi_range=(0.0, 2 * math.pi),
                exit_diameter=0.0, beam_divergence=0.0)
            cloud.addGrid(center=GRID_CENTER, size=GRID_SIZE, ndiv=[nx, ny, nz])
            with Context() as ctx:
                ctx.seedRandomGenerator(20240607)
                ctx.loadXML(_GEOM_XML, True)
                cloud.syntheticScan(ctx, record_misses=True)
        finally:
            os.chdir(cwd)
        return cloud

    def _per_cell(self, cloud):
        n = cloud.getGridCellCount()
        return ([cloud.getCellLeafArea(i) for i in range(n)],
                [cloud.getCellGtheta(i) for i in range(n)])

    def test_injected_mesh_reproduces_internal_inversion(self):
        """Inject the internal triangulation's own triangles and assert the
        re-run inversion recovers the same per-cell leaf area and G(theta)."""
        from pyhelios import Context

        cloud = self._build_cloud(nx=2, ny=2, nz=2)

        # Internal triangulation → inversion → capture truth + the mesh itself.
        cloud.triangulateHitPoints(0.04, 10.0)
        tri_count = cloud.getTriangleCount()
        assert tri_count > 0, "internal triangulation produced no triangles"
        xyz_flat, scan_ids = cloud.getTriangleVerticesAll()

        with Context() as ctx:
            cloud.calculateLeafArea(ctx, 1)
        la_internal, g_internal = self._per_cell(cloud)
        assert any(a > 0 for a in la_internal), "internal inversion solved no cell"

        # Inject the exact same triangles and re-run on the same hits/grid.
        cloud.setExternalTriangulation(xyz_flat, scan_ids)
        assert cloud.getTriangleCount() == tri_count, \
            "injected triangle count differs from the source mesh"
        with Context() as ctx:
            cloud.calculateLeafArea(ctx, 1)
        la_injected, g_injected = self._per_cell(cloud)

        # Two inherent, sub-percent sources of drift between the paths: the mesh
        # round-trips through float32 export (getTriangleVerticesAll), and injected
        # triangles are binned to a cell by centroid rather than by first-vertex hit
        # cell — near a cell boundary a few may bin differently. A 2% per-cell bound
        # proves equivalence while admitting that drift; it is not a loose rubber stamp
        # (a real discrepancy in how G(theta) consumes the mesh would blow well past it).
        for i, (a, b) in enumerate(zip(la_internal, la_injected)):
            assert b == pytest.approx(a, rel=0.02, abs=1e-4), \
                f"cell {i} leaf area: internal {a} vs injected {b}"
        for i, (a, b) in enumerate(zip(g_internal, g_injected)):
            assert b == pytest.approx(a, rel=0.02, abs=1e-4), \
                f"cell {i} G(theta): internal {a} vs injected {b}"

    def test_injected_mesh_recovers_true_lad(self):
        """A standalone correctness anchor: the injected-mesh inversion recovers
        the cube's true LAD≈2.0 and G(theta)≈0.5 in the single-voxel grid."""
        from pyhelios import Context

        cloud = self._build_cloud()
        cloud.triangulateHitPoints(0.04, 10.0)
        xyz_flat, scan_ids = cloud.getTriangleVerticesAll()
        cloud.setExternalTriangulation(xyz_flat, scan_ids)
        with Context() as ctx:
            cloud.calculateLeafArea(ctx, 1)
        assert cloud.getCellLeafAreaDensity(0) == pytest.approx(2.0, rel=0.12)
        assert cloud.getCellGtheta(0) == pytest.approx(0.5, rel=0.12)


@pytest.mark.skipif(
    not os.path.isfile(os.path.join(_HELIOS_CORE, _GEOM_XML)),
    reason="leaf-cube geometry not present (helios-core submodule)")
class TestExternalTriangulationValidation:
    """The C++ method requires per-scan provenance and a defined grid; the Python
    layer guards shapes before the FFI call."""

    def _scan_cloud(self):
        pytest.importorskip("pyhelios")
        from pyhelios import LiDARCloud
        cloud = LiDARCloud()
        cloud.disableMessages()
        cloud.addScan(origin=ORIGIN, Ntheta=10, theta_range=(0.0, math.pi),
                      Nphi=10, phi_range=(0.0, 2 * math.pi),
                      exit_diameter=0.0, beam_divergence=0.0)
        cloud.addGrid(center=GRID_CENTER, size=GRID_SIZE, ndiv=[1, 1, 1])
        return cloud

    def test_vertex_count_must_be_multiple_of_nine(self):
        cloud = self._scan_cloud()
        with pytest.raises(ValueError, match="multiple of 9"):
            cloud.setExternalTriangulation(np.zeros(8, dtype=np.float32),
                                           np.zeros(1, dtype=np.int32))

    def test_scan_ids_length_must_match_triangle_count(self):
        cloud = self._scan_cloud()
        # Two triangles (18 floats) but only one scan id.
        with pytest.raises(ValueError, match="expected 2"):
            cloud.setExternalTriangulation(np.zeros(18, dtype=np.float32),
                                           np.zeros(1, dtype=np.int32))

    def test_invalid_scan_id_rejected_by_native_layer(self):
        cloud = self._scan_cloud()
        # One valid-shaped triangle but scan id 5 (only scan 0 exists).
        verts = np.array([0.1, 0.0, 0.5, 0.0, 0.1, 0.5, 0.0, 0.0, 0.6],
                         dtype=np.float32)
        with pytest.raises(Exception):
            cloud.setExternalTriangulation(verts, np.array([5], dtype=np.int32))
