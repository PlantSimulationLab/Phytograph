"""Alpha-shape triangulation tests for /api/triangulate.

Regression coverage for the near-planar leaf case. Open3D's alpha shape builds
a Delaunay tetrahedralization; on a perfectly planar grid every tetra is
coplanar (zero volume), so Open3D skips them all — logging hundreds of
"[CreateFromPointCloudAlphaShape] invalid tetra in TetraMesh" warnings and
returning a sparse, holey mesh. The endpoint now de-duplicates points and adds
sub-micron jitter to break exact coplanarity before reconstruction, and
suppresses the per-tetra warning stream. These tests pin both effects: clean
output and dense surface coverage on planar input.
"""

import numpy as np

from tests.binframe import decode_bin_frame

# NOTE: open3d is imported lazily inside the one test that needs it, NOT at module
# scope. Importing open3d before `main` (and thus before pyhelios) loads open3d's
# bundled GL dylibs first, which collide with libhelios's native load and make
# `import main` fail with a LibraryLoadError at the client-fixture import. main.py
# itself imports open3d lazily for the same reason; mirror that here.


def _planar_grid(n: int = 30) -> list[list[float]]:
    """An n×n grid on z=0 with a handful of points nudged off-plane — the
    pathological input that makes raw alpha shape produce all-coplanar tetra."""
    g = np.linspace(0.0, 1.0, n)
    xs, ys = np.meshgrid(g, g)
    pts = np.c_[xs.ravel(), ys.ravel(), np.zeros(xs.size)]
    idx = np.random.RandomState(0).choice(len(pts), 20, replace=False)
    pts[idx, 2] = 1e-3
    return pts.tolist()


def test_alpha_shape_planar_grid_is_densely_covered(client):
    """The jitter cleanup must turn the near-degenerate planar grid into a
    mesh that actually covers the surface, not a few stray triangles.

    Baseline (no cleanup) yields ~276 triangles from 900 points. With the fix
    it is several thousand. Assert well above the broken regime so a regression
    that drops the cleanup fails loudly.
    """
    points = _planar_grid(30)
    res = client.post("/api/triangulate", json={"method": "alpha_shape", "points": points})
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)

    assert body["success"] is True
    assert body["method_used"] == "alpha_shape"
    assert body["points_used"] == len(points)
    # Dense coverage: far more than the ~276-triangle broken result.
    assert body["num_triangles"] > 800, body["num_triangles"]
    # A unit-square surface: area is bounded by 1 and should be a real fraction
    # of it, not a degenerate sliver.
    assert 0.3 < body["surface_area"] <= 1.05, body["surface_area"]


def test_alpha_shape_emits_no_invalid_tetra_warnings(client, capfd):
    """The "invalid tetra in TetraMesh" stream must not reach the console.

    Open3D logs to C++ stderr, which capfd captures. The endpoint wraps
    reconstruction in a VerbosityContextManager(Error); after the fix the
    planar grid produces zero such warnings.
    """
    # Open3D's verbosity is process-global; ensure we start from the default so
    # the endpoint's context manager is what does the suppressing. Imported here
    # (not at module scope) so pyhelios loads before open3d's GL dylibs — see the
    # module-header note.
    import open3d as o3d
    o3d.utility.set_verbosity_level(o3d.utility.VerbosityLevel.Warning)

    res = client.post(
        "/api/triangulate",
        json={"method": "alpha_shape", "points": _planar_grid(30)},
    )
    assert res.status_code == 200
    assert decode_bin_frame(res.content)[0]["success"] is True

    out, err = capfd.readouterr()
    assert "invalid tetra" not in out
    assert "invalid tetra" not in err


def test_alpha_shape_is_deterministic(client):
    """Jitter is seeded, so repeated calls on identical input return an
    identical triangle count — no run-to-run drift from the perturbation."""
    points = _planar_grid(24)
    payload = {"method": "alpha_shape", "points": points}
    a, _ = decode_bin_frame(client.post("/api/triangulate", json=payload).content)
    b, _ = decode_bin_frame(client.post("/api/triangulate", json=payload).content)
    assert a["success"] and b["success"]
    assert a["num_triangles"] == b["num_triangles"]
    assert a["num_vertices"] == b["num_vertices"]
