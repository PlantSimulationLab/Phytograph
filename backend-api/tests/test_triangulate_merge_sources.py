"""Merged multi-scan triangulation for /api/triangulate.

The unified Triangulation modal can fuse several selected scans into one mesh.
Octree-backed clouds hold their points in the backend session (the renderer's
positions buffer is empty), so they can't be concatenated on the client — the
renderer sends every contributing source in `sources[]` and the backend reads +
vstacks them (folding in any inline `points` too) before meshing.

These tests pin that fusion: a mesh built from `sources` over two files covers
the SAME points as one built from the inline union of both files, and the
inline-`points` fold-in composes with `sources`.
"""

import numpy as np
import pandas as pd
import pytest

from tests.binframe import decode_bin_frame

FORMAT = "x y z"


def _write_xyz(path, pts):
    lines = [f"{x:.6f} {y:.6f} {z:.6f}" for x, y, z in pts]
    path.write_text("\n".join(lines) + "\n")
    return path


def _read_xyz(path):
    df = pd.read_csv(path, sep=r"\s+", header=None, names=["x", "y", "z"], engine="c")
    return df[["x", "y", "z"]].to_numpy(dtype=np.float64)


@pytest.fixture
def two_clouds(tmp_path):
    """Two overlapping dense grids near z=0, written to separate files. Each is a
    valid surface on its own; their union is a wider surface. A small seeded
    z-jitter breaks exact coplanarity (perfectly planar points make Open3D's
    normal-orientation Delaunay raise a qhull cospherical error)."""
    rng = np.random.RandomState(0)
    g = np.linspace(0.0, 1.0, 20)
    xs, ys = np.meshgrid(g, g)
    a = np.c_[xs.ravel(), ys.ravel(), rng.uniform(0, 1e-3, xs.size)]
    # Second grid shifted +0.5 in x so the union is a 1.5-wide strip.
    b = np.c_[xs.ravel() + 0.5, ys.ravel(), rng.uniform(0, 1e-3, xs.size)]
    fa = _write_xyz(tmp_path / "a.xyz", a)
    fb = _write_xyz(tmp_path / "b.xyz", b)
    return fa, fb, _read_xyz(fa), _read_xyz(fb)


def test_merged_sources_matches_inline_union(client, two_clouds):
    fa, fb, a, b = two_clouds
    union = np.vstack([a, b])

    inline, _ = decode_bin_frame(client.post("/api/triangulate", json={
        "points": union.tolist(), "method": "alpha_shape", "alpha": 0.2,
    }).content)
    merged, _ = decode_bin_frame(client.post("/api/triangulate", json={
        "sources": [
            {"source_path": str(fa), "ascii_format": FORMAT},
            {"source_path": str(fb), "ascii_format": FORMAT},
        ],
        "method": "alpha_shape", "alpha": 0.2,
    }).content)

    assert inline["success"] and merged["success"]
    # Same fused point set → same mesh. The source loader reads the file at
    # float32 precision then upcasts, so a point sitting exactly on the alpha
    # boundary can land on either side and shift a few triangles — the meshes
    # are equivalent, not bit-identical (cf. test_downstream_octree_source).
    assert merged["points_used"] == len(union)
    assert merged["num_vertices"] == inline["num_vertices"]
    assert abs(merged["num_triangles"] - inline["num_triangles"]) <= 8


def test_merged_sources_uses_all_points(client, two_clouds):
    """The merge must use BOTH clouds, not just one — points_used is the sum and
    the surface spans the full 1.5-wide union, not a single 1.0-wide grid."""
    fa, fb, a, b = two_clouds
    merged, _ = decode_bin_frame(client.post("/api/triangulate", json={
        "sources": [
            {"source_path": str(fa), "ascii_format": FORMAT},
            {"source_path": str(fb), "ascii_format": FORMAT},
        ],
        "method": "alpha_shape", "alpha": 0.2,
    }).content)
    assert merged["success"]
    assert merged["points_used"] == len(a) + len(b)
    # A single 1×1 grid meshes to ~1.0; the fused 1.5×1 strip is meaningfully
    # larger (the alpha shape doesn't fully fill, so it lands a bit under 1.5).
    assert merged["surface_area"] > 1.05, merged["surface_area"]


def test_merged_sources_folds_in_inline_points(client, two_clouds):
    """`sources` and inline `points` compose: one cloud from a file, the other
    inline, must fuse to the same mesh as both inline."""
    fa, fb, a, b = two_clouds
    union = np.vstack([a, b])

    inline, _ = decode_bin_frame(client.post("/api/triangulate", json={
        "points": union.tolist(), "method": "alpha_shape", "alpha": 0.2,
    }).content)
    mixed, _ = decode_bin_frame(client.post("/api/triangulate", json={
        "sources": [{"source_path": str(fa), "ascii_format": FORMAT}],
        "points": b.tolist(),
        "method": "alpha_shape", "alpha": 0.2,
    }).content)

    assert inline["success"] and mixed["success"]
    assert mixed["points_used"] == len(union)
    assert mixed["num_vertices"] == inline["num_vertices"]
    # Equivalent, not bit-identical (the file-read source is float32; the inline
    # half is float64), so allow a few boundary triangles of slack.
    assert abs(mixed["num_triangles"] - inline["num_triangles"]) <= 8
