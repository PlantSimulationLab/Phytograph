"""Phase F: /api/qsm/build endpoint integration test.

Drives the REAL FastAPI app (via the session `client` TestClient -- no mocks) with
a deterministic synthetic cloud sampled from a known tree, and asserts CONCRETE
correctness on the response: schema-valid cylinders + shoots, exactly one rank-0
trunk shoot, ranks present, parent links consistent, and metrics in plausible
ranges that track the known geometry. Per CLAUDE.md this exercises the live
backend end-to-end (the same code path a packaged build runs).
"""

from __future__ import annotations

import numpy as np
import pytest

from qsm.validation.synthetic import sample_cloud, simple_tree


@pytest.fixture(scope="module")
def cloud_points() -> list[list[float]]:
    """A dense, low-noise cloud sampled from the known simple_tree. Committable
    (generated in-process, deterministic seed), and exercises the real pipeline."""
    gt = simple_tree()
    cloud = sample_cloud(gt, seed=7, points_per_m2=12000, noise_sigma=0.0006)
    return cloud.tolist()


def test_build_qsm_returns_valid_schema(client, cloud_points):
    resp = client.post("/api/qsm/build", json={"points": cloud_points})
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True, body.get("error")
    assert body["n_cylinders"] > 0
    assert body["n_shoots"] > 0
    assert body["points_used"] == len(cloud_points)
    assert len(body["cylinders"]) == body["n_cylinders"]
    assert len(body["shoots"]) == body["n_shoots"]


def test_build_qsm_headline_shoot_rank(client, cloud_points):
    """The headline feature: continuous shoots classified by rank. Exactly one
    rank-0 (trunk) shoot, at least one rank-1 (scaffold), and every cylinder
    carries a rank/shoot id."""
    body = client.post("/api/qsm/build", json={"points": cloud_points}).json()
    shoots = body["shoots"]
    rank0 = [s for s in shoots if s["rank"] == 0]
    assert len(rank0) == 1, f"expected one trunk shoot, got {len(rank0)}"
    assert any(s["rank"] == 1 for s in shoots), "no scaffold (rank-1) shoot"
    for c in body["cylinders"]:
        assert c["rank"] >= 0
        assert c["shoot_id"] >= 0


def test_build_qsm_topology_consistent(client, cloud_points):
    """Parent links are valid: exactly one root cylinder (parent -1), and every
    other parent_id references an existing cylinder."""
    body = client.post("/api/qsm/build", json={"points": cloud_points}).json()
    ids = {c["cyl_id"] for c in body["cylinders"]}
    roots = [c for c in body["cylinders"] if c["parent_id"] == -1]
    assert len(roots) == 1, f"expected one root cylinder, got {len(roots)}"
    for c in body["cylinders"]:
        if c["parent_id"] != -1:
            assert c["parent_id"] in ids


def test_build_qsm_metrics_plausible(client, cloud_points):
    """Metrics track the known simple_tree geometry: trunk ~100mm diameter, height
    ~2 m, positive woody volume split into stem + branch, ~3 scaffolds."""
    body = client.post("/api/qsm/build", json={"points": cloud_points}).json()
    m = body["metrics"]
    assert m is not None
    assert 70.0 < m["trunk_diameter_mm"] < 120.0, m["trunk_diameter_mm"]
    assert 1.5 < m["tree_height_m"] < 3.5, m["tree_height_m"]
    assert m["total_woody_volume_m3"] > 0
    assert m["stem_volume_m3"] > 0 and m["branch_volume_m3"] > 0
    assert m["total_woody_volume_m3"] == pytest.approx(
        m["stem_volume_m3"] + m["branch_volume_m3"], rel=1e-6
    )
    # 3 true scaffolds; allow +-1 for the whorl over-extension edge case.
    assert abs(m["n_scaffolds"] - 3) <= 1, m["n_scaffolds"]
    # Per-rank diameters present and tapering.
    by_rank = {pr["rank"]: pr for pr in m["per_rank"]}
    assert by_rank[0]["mean_diameter_mm"] > by_rank[1]["mean_diameter_mm"]


def test_build_qsm_radii_corrected_and_quality_populated(client, cloud_points):
    """Cylinders carry fitted radii + SurfCov (Phase D/E ran): radii are in a
    sane range and most cylinders report a coverage value."""
    body = client.post("/api/qsm/build", json={"points": cloud_points}).json()
    radii = [c["radius"] for c in body["cylinders"]]
    assert all(0.0005 < r < 0.2 for r in radii), (min(radii), max(radii))
    with_cov = [c for c in body["cylinders"] if c["surf_cov"] is not None]
    assert len(with_cov) > 0.5 * len(body["cylinders"])
    assert all(0.0 <= c["surf_cov"] <= 1.0 for c in with_cov)


def _write_xyz(path, pts) -> str:
    """Write an [N,3] array to a plain XYZ file and return its path."""
    arr = np.asarray(pts, dtype=np.float64)
    np.savetxt(path, arr, fmt="%.6f")
    return str(path)


def test_build_qsm_aggregate_sources_fuses_one_tree(client, cloud_points, tmp_path):
    """Aggregate mode: two file `sources` (two halves of ONE tree, the multi-view
    case) fuse into a SINGLE QSM whose points_used equals the combined count and
    whose structure matches a single-cloud build (one trunk, scaffolds present).

    This exercises the `sources` server-side read+concatenate path that octree
    clouds depend on (their display points are empty client-side)."""
    pts = np.asarray(cloud_points, dtype=np.float64)
    half = len(pts) // 2
    a = _write_xyz(tmp_path / "view_a.xyz", pts[:half])
    b = _write_xyz(tmp_path / "view_b.xyz", pts[half:])

    resp = client.post(
        "/api/qsm/build",
        json={"sources": [{"source_path": a}, {"source_path": b}]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True, body.get("error")
    # Every point from BOTH files was used — nothing dropped.
    assert body["points_used"] == len(pts)
    # One fused tree: exactly one rank-0 trunk shoot, at least one scaffold.
    rank0 = [s for s in body["shoots"] if s["rank"] == 0]
    assert len(rank0) == 1, f"expected one trunk shoot, got {len(rank0)}"
    assert any(s["rank"] == 1 for s in body["shoots"]), "no scaffold shoot"
    assert body["n_cylinders"] > 0


def test_build_qsm_aggregate_sources_plus_inline_points(client, cloud_points, tmp_path):
    """A mixed selection (one file `source` + one flat cloud's inline `points`)
    fuses both: points_used is the sum, proving inline points aren't dropped when
    `sources` is also present."""
    pts = np.asarray(cloud_points, dtype=np.float64)
    half = len(pts) // 2
    a = _write_xyz(tmp_path / "octree_view.xyz", pts[:half])
    inline = pts[half:].tolist()

    body = client.post(
        "/api/qsm/build",
        json={"sources": [{"source_path": a}], "points": inline},
    ).json()
    assert body["success"] is True, body.get("error")
    assert body["points_used"] == len(pts)


def test_build_qsm_too_few_points(client):
    resp = client.post("/api/qsm/build", json={"points": [[0, 0, 0], [0, 0, 1]]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is False
    assert "50 points" in body["error"]


def test_build_qsm_twig_radius_option(client, cloud_points):
    """The twig_radius_mm option flows through (a larger anchor yields >= total
    woody volume, since low-coverage tips lean on the larger-anchored taper)."""
    small = client.post(
        "/api/qsm/build", json={"points": cloud_points, "twig_radius_mm": 2.0}
    ).json()
    large = client.post(
        "/api/qsm/build", json={"points": cloud_points, "twig_radius_mm": 10.0}
    ).json()
    assert small["success"] and large["success"]
    assert (
        large["metrics"]["total_woody_volume_m3"]
        >= small["metrics"]["total_woody_volume_m3"]
    )


# ==================== QSM LEAF ENDPOINTS (Phase 1) ====================
# Drive /api/qsm/leaves and /api/qsm/phyllotaxis against the REAL app. The QSM
# topology is built once from the live /api/qsm/build response, then round-tripped
# back into the leaf endpoints exactly as the renderer does.

@pytest.fixture(scope="module")
def built_qsm(client, cloud_points):
    resp = client.post("/api/qsm/build", json={"points": cloud_points})
    body = resp.json()
    assert body["success"] is True, body.get("error")
    return {"cylinders": body["cylinders"], "shoots": body["shoots"]}


def test_phyllotaxis_endpoint_returns_canonical_angle(client, built_qsm):
    resp = client.post("/api/qsm/phyllotaxis", json=built_qsm)
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True, body.get("error")
    assert body["angle_deg"] in (180.0, 137.5, 144.0, 150.0, 90.0)
    assert body["pattern"] in ("opposite", "spiral", "decussate", "alternate")
    assert body["leaves_per_node"] >= 1
    assert 0.0 <= body["confidence"] <= 1.0


def test_leaves_endpoint_builtin_texture(client, built_qsm):
    req = {
        **built_qsm,
        "leaf_spacing": 0.08,
        "leaf_pitch_deg": 45.0,
        "leaf_size_m": 0.06,
        "phyllotaxis_deg": 137.5,
        "leaves_per_node": 1,
        "builtin_texture_name": "AlmondLeaf.png",
    }
    resp = client.post("/api/qsm/leaves", json=req)
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True, body.get("error")
    assert body["leaf_count"] > 0
    assert body["triangle_count"] > 0
    assert body["vertex_count"] == body["triangle_count"] * 3  # non-indexed quads
    # One textured leaf material with alpha cutout, and the PNG travels along.
    assert body["materials"] and body["materials"][0]["has_alpha"] is True
    assert "AlmondLeaf.png" in (body["textures"] or {})
    assert len(body["uv_coordinates"]) == body["vertex_count"]


def test_leaves_endpoint_rejects_unknown_builtin(client, built_qsm):
    req = {**built_qsm, "builtin_texture_name": "SoybeanLeaf.png"}
    resp = client.post("/api/qsm/leaves", json=req)
    body = resp.json()
    assert body["success"] is False
    assert "Unknown builtin leaf texture" in body["error"]


def test_leaves_endpoint_requires_texture(client, built_qsm):
    resp = client.post("/api/qsm/leaves", json=built_qsm)
    body = resp.json()
    assert body["success"] is False
    assert "No leaf texture" in body["error"]


def test_leaf_textures_endpoint_lists_curated(client):
    resp = client.get("/api/qsm/leaf-textures")
    assert resp.status_code == 200
    textures = resp.json()["textures"]
    assert "AlmondLeaf.png" in textures
    assert "SoybeanLeaf.png" not in textures  # crop leaf excluded from the curated set


# ==================== QSM ADJUST-LEAF-ANGLES ENDPOINT (Phase 2) ====================
# Build a QSM -> place leaves -> adjust their angles to an injected per-cell target
# and to a synthetic triangulation, asserting the inclination shifts toward target.

import math as _math
import numpy as _np


def _leaf_request(built_qsm):
    return {
        **built_qsm,
        "leaf_spacing": 0.06,
        "leaf_size_m": 0.05,
        "phyllotaxis_deg": 137.5,
        "leaves_per_node": 1,
        "builtin_texture_name": "AlmondLeaf.png",
    }


def _covering_grid(cylinders):
    pts = _np.array([c["start"] for c in cylinders] + [c["end"] for c in cylinders])
    lo = pts.min(0) - 0.2
    hi = pts.max(0) + 0.2
    return {"center": ((lo + hi) / 2).tolist(), "size": (hi - lo).tolist(),
            "nx": 1, "ny": 1, "nz": 1}


def _mean_leaf_inclination(resp):
    """Mean inclination (deg) of leaf normals from a leaf response (quad mesh:
    6 verts per leaf, constant normal)."""
    n = _np.array(resp["normals"])
    zs = []
    for i in range(0, len(n), 6):
        nn = n[i] / (_np.linalg.norm(n[i]) + 1e-12)
        zs.append(_math.degrees(_math.acos(min(1.0, abs(nn[2])))))
    return float(_np.mean(zs))


def test_adjust_leaf_angles_with_cell_targets(client, built_qsm):
    leaf_req = _leaf_request(built_qsm)
    placed = client.post("/api/qsm/leaves", json=leaf_req).json()
    assert placed["success"], placed.get("error")

    adj_req = {
        **leaf_req,
        "grid": _covering_grid(built_qsm["cylinders"]),
        "cell_targets": [{"cell_id": 0, "beta_mu": 1.0, "beta_nu": 8.0,
                          "ecc": 0.0, "phi0_deg": 0.0, "n_measured": 100}],
        "seed": 1,
    }
    resp = client.post("/api/qsm/adjust-leaf-angles", json=adj_req)
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"], body.get("error")
    assert body["leaf_count"] == placed["leaf_count"]      # count preserved
    assert body["triangle_count"] > 0
    # Erectophile target (sampler mean ~80 deg) pulls the inclination up from the
    # phyllotaxis default.
    before = _mean_leaf_inclination(placed)
    after = _mean_leaf_inclination(body)
    assert after > before + 5.0
    assert after > 65.0


def test_adjust_leaf_angles_with_triangulation(client, built_qsm):
    from qsm import leaf_angles as _A
    leaf_req = _leaf_request(built_qsm)
    placed = client.post("/api/qsm/leaves", json=leaf_req).json()
    grid = _covering_grid(built_qsm["cylinders"])
    center = _np.array(grid["center"])

    # Synthetic near-vertical (erectophile) triangulation in cell 0.
    rng = _np.random.default_rng(0)
    verts = []
    tris = []
    cids = []
    for _ in range(400):
        zen = float(_np.clip(rng.normal(82, 5), 0, 90))
        az = rng.uniform(0, 360)
        nrm = _A.sphere2cart(1.0, _math.pi / 2 - _math.radians(zen), _math.radians(az))
        t1 = _A._orthonormal_axis(nrm)
        t2 = _np.cross(nrm, t1)
        i0 = len(verts)
        verts += [center.tolist(), (center + 0.01 * t1).tolist(), (center + 0.01 * t2).tolist()]
        tris += [i0, i0 + 1, i0 + 2]
        cids.append(0)

    adj_req = {
        **leaf_req,
        "triangulation": {"vertices": list(_np.array(verts).ravel()),
                          "indices": tris, "triangle_cell_ids": cids, "grid": grid},
        "seed": 2,
    }
    body = client.post("/api/qsm/adjust-leaf-angles", json=adj_req).json()
    assert body["success"], body.get("error")
    after = _mean_leaf_inclination(body)
    before = _mean_leaf_inclination(placed)
    assert after > before + 5.0  # shifted toward the measured ~82 deg distribution


def test_adjust_leaf_angles_requires_a_target(client, built_qsm):
    body = client.post("/api/qsm/adjust-leaf-angles", json=_leaf_request(built_qsm)).json()
    assert body["success"] is False
    assert "triangulation or precomputed cell_targets" in body["error"]
