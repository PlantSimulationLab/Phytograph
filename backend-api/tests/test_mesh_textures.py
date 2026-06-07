"""Tests for textured mesh support:

- /api/plant/generate now emits Helios's real per-vertex texture UVs (not a PCA
  projection), so leaf textures sample the correct cell of the leaf atlas.
- /api/mesh/import parses an OBJ + sibling MTL + texture images from disk into
  geometry + UVs + base64 textures.

The plant test needs a built pyhelios (libhelios); it skips if the import
fails. The OBJ-import test has no native dependency and always runs.
"""
import base64
import io
from pathlib import Path

import pytest

import main

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _pyhelios_available() -> bool:
    try:
        from pyhelios import Context, PlantArchitecture  # noqa: F401
        return True
    except Exception:
        return False


requires_pyhelios = pytest.mark.skipif(
    not _pyhelios_available(),
    reason="pyhelios not built; run node scripts/build-pyhelios.mjs",
)


# ---------------------------------------------------------------------------
# Plant generation: real Helios UVs
# ---------------------------------------------------------------------------

@requires_pyhelios
def test_plant_generate_uses_real_helios_uvs(client):
    """A leafy bean must come back with per-vertex UVs aligned to vertices,
    in [0,1], plus decodable PNG textures and per-material triangle groups."""
    resp = client.post(
        "/api/plant/generate",
        json={"plant_type": "bean", "age": 20, "random_seed": 1},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True
    assert body["vertex_count"] > 0
    assert body["triangle_count"] > 0

    uvs = body["uv_coordinates"]
    assert uvs is not None
    # One UV per vertex (the geometry is non-indexed / triangle-expanded).
    assert len(uvs) == body["vertex_count"]
    for u, v in uvs:
        assert -1e-6 <= u <= 1.0 + 1e-6
        assert -1e-6 <= v <= 1.0 + 1e-6

    # Textures present and decodable PNGs.
    textures = body["textures"]
    assert textures, "expected leaf textures"
    for b64 in textures.values():
        raw = base64.b64decode(b64)
        assert raw[:4] == b"\x89PNG"

    # Each textured material maps to a non-empty triangle group, and the union
    # of grouped triangles never exceeds the total triangle count.
    groups = body["material_groups"]
    assert groups, "expected material groups for textured leaves"
    grouped = set()
    for g in groups:
        assert len(g["triangle_indices"]) > 0
        grouped.update(g["triangle_indices"])
    assert max(grouped) < body["triangle_count"]


@requires_pyhelios
def test_plant_generate_uvs_not_degenerate_pca(client):
    """Regression guard: the old PCA projection normalized every leaf to span
    the full [0,1] box. Real Helios UVs vary per leaf, so the per-triangle UV
    bounding boxes must NOT all be the unit square."""
    resp = client.post(
        "/api/plant/generate",
        json={"plant_type": "bean", "age": 20, "random_seed": 7},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    uvs = body["uv_coordinates"]
    indices = body["indices"]

    full_box = 0
    sampled = 0
    for tri in indices[: min(len(indices), 400)]:
        us = [uvs[i][0] for i in tri]
        vs = [uvs[i][1] for i in tri]
        # Skip untextured triangles (degenerate 0,0 UVs).
        if max(us) == 0 and max(vs) == 0:
            continue
        sampled += 1
        if (min(us) <= 1e-6 and max(us) >= 1 - 1e-6
                and min(vs) <= 1e-6 and max(vs) >= 1 - 1e-6):
            full_box += 1

    assert sampled > 0, "no textured triangles sampled"
    # If these were PCA-normalized, essentially every leaf triangle pair would
    # cover the unit box. Real atlas UVs do not.
    assert full_box < sampled, "UVs look PCA-normalized (every leaf spans 0..1)"


@requires_pyhelios
def test_plant_session_advance_returns_textures(client):
    """The primary plant flow goes through a session (create + advance), which
    must now return the same texture payload as /api/plant/generate — otherwise
    popup-generated plants render untextured (the original bug)."""
    create = client.post(
        "/api/plant/session/create",
        json={"plant_type": "bean", "initial_age": 20},
    )
    assert create.status_code == 200, create.text
    cbody = create.json()
    assert cbody["success"] is True
    session_id = cbody["session_id"]

    try:
        advance = client.post(
            f"/api/plant/session/{session_id}/advance",
            json={"dt": 0},
        )
        assert advance.status_code == 200, advance.text
        body = advance.json()
        assert body["success"] is True
        assert body["vertex_count"] > 0

        # Texture payload must be present and aligned to vertices.
        assert body["uv_coordinates"] is not None
        assert len(body["uv_coordinates"]) == body["vertex_count"]
        assert body["materials"], "session advance should return leaf materials"
        assert body["material_groups"]
        assert body["textures"], "session advance should return base64 textures"
        for b64 in body["textures"].values():
            assert base64.b64decode(b64)[:4] == b"\x89PNG"
    finally:
        client.delete(f"/api/plant/session/{session_id}")


# ---------------------------------------------------------------------------
# Plant canopy generation
# ---------------------------------------------------------------------------

@requires_pyhelios
def test_plant_canopy_builds_grid_of_plants(client):
    """A 2x2 bean canopy must build 4 plants into one merged mesh: it returns
    the canopy echo fields and substantially more geometry than a single plant
    of the same species/age, plus decodable leaf textures."""
    single = client.post(
        "/api/plant/generate",
        json={"plant_type": "bean", "age": 15, "random_seed": 3},
    )
    assert single.status_code == 200, single.text
    single_tris = single.json()["triangle_count"]
    assert single_tris > 0

    canopy = client.post(
        "/api/plant/canopy/generate",
        json={
            "plant_type": "bean",
            "age": 15,
            "spacing_x": 0.5,
            "spacing_y": 0.5,
            "count_x": 2,
            "count_y": 2,
            "germination_rate": 1.0,
            "random_seed": 3,
        },
    )
    assert canopy.status_code == 200, canopy.text
    body = canopy.json()
    assert body["success"] is True

    # Echo fields describe the grid actually built.
    assert body["count_x"] == 2
    assert body["count_y"] == 2
    assert body["spacing_x"] == 0.5
    assert body["spacing_y"] == 0.5
    assert body["plant_count"] == 4

    # 4 plants → meaningfully more geometry than one. Use a conservative 2.5x
    # lower bound to stay robust to per-plant stochastic variation.
    assert body["triangle_count"] > single_tris * 2.5
    assert body["vertex_count"] == body["triangle_count"] * 3

    # Same textured payload as the single-plant path.
    assert body["uv_coordinates"] is not None
    assert len(body["uv_coordinates"]) == body["vertex_count"]
    assert body["materials"], "canopy should return leaf materials"
    assert body["textures"], "canopy should return base64 textures"
    for b64 in body["textures"].values():
        assert base64.b64decode(b64)[:4] == b"\x89PNG"


@requires_pyhelios
def test_plant_canopy_germination_rate_reduces_plant_count(client):
    """A germination rate below 1.0 leaves some grid positions empty, so a large
    grid germinates fewer than the full count_x * count_y."""
    resp = client.post(
        "/api/plant/canopy/generate",
        json={
            "plant_type": "bean",
            "age": 10,
            "count_x": 4,
            "count_y": 4,
            "germination_rate": 0.5,
            "random_seed": 11,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True
    # 16 positions at 50% germination: expect fewer than all, and at least one.
    assert 0 < body["plant_count"] < 16


def test_plant_canopy_rejects_invalid_count(client):
    """Validation happens before any pyhelios work, so this runs without a
    native build: a non-positive count returns success=False with a message."""
    resp = client.post(
        "/api/plant/canopy/generate",
        json={"plant_type": "bean", "age": 10, "count_x": 0, "count_y": 3},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is False
    assert "count" in (body["error"] or "").lower()


@requires_pyhelios
def test_plant_stream_emits_progress_then_result(client):
    """The SSE endpoint streams progress events (fractions in [0,1], with at
    least one between 0 and 1) and ends with a result carrying the merged
    canopy geometry."""
    import json as _json

    progresses = []
    result = None
    with client.stream(
        "POST", "/api/plant/generate/stream",
        json={"mode": "canopy", "plant_type": "bean", "age": 10,
              "count_x": 2, "count_y": 2},
    ) as resp:
        assert resp.status_code == 200, resp.text
        event = None
        for line in resp.iter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data = _json.loads(line.split(":", 1)[1].strip())
                if event == "progress":
                    progresses.append(data["progress"])
                    assert 0.0 <= data["progress"] <= 1.0
                    assert isinstance(data["message"], str) and data["message"]
                elif event == "result":
                    result = data

    assert progresses, "expected at least one progress event"
    assert any(0.0 < p < 1.0 for p in progresses), "expected mid-build progress"
    assert result is not None and result["success"] is True
    assert result["triangle_count"] > 0
    # 2x2 canopy → echo fields present.
    assert result["plant_count"] == 4


@requires_pyhelios
def test_plant_stream_single_returns_session(client):
    """A single-plant streaming build retains a session (for age scrubbing),
    surfaced as session_id in the result."""
    import json as _json

    session_id = None
    with client.stream(
        "POST", "/api/plant/generate/stream",
        json={"mode": "single", "plant_type": "bean", "age": 10},
    ) as resp:
        assert resp.status_code == 200, resp.text
        event = None
        for line in resp.iter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:") and event == "result":
                session_id = _json.loads(line.split(":", 1)[1].strip()).get("session_id")

    assert session_id, "single-plant stream should retain a session"
    try:
        # The session must be live and advanceable.
        adv = client.post(f"/api/plant/session/{session_id}/advance", json={"dt": 5})
        assert adv.status_code == 200, adv.text
        assert adv.json()["success"] is True
    finally:
        client.delete(f"/api/plant/session/{session_id}")


def test_plant_stream_rejects_invalid_count(client):
    """Validation errors arrive as an SSE error event (no native work)."""
    import json as _json

    err = None
    with client.stream(
        "POST", "/api/plant/generate/stream",
        json={"mode": "canopy", "plant_type": "bean", "age": 10, "count_x": 0, "count_y": 2},
    ) as resp:
        assert resp.status_code == 200, resp.text
        event = None
        for line in resp.iter_lines():
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:") and event == "error":
                err = _json.loads(line.split(":", 1)[1].strip())["detail"]
    assert err and "count" in err.lower()


def test_plant_canopy_rejects_invalid_germination_rate(client):
    """Germination rate must be in [0, 1]; validated before pyhelios work."""
    resp = client.post(
        "/api/plant/canopy/generate",
        json={
            "plant_type": "bean", "age": 10,
            "count_x": 2, "count_y": 2, "germination_rate": 1.5,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is False
    assert "germination" in (body["error"] or "").lower()


# ---------------------------------------------------------------------------
# OBJ + MTL import
# ---------------------------------------------------------------------------

def test_mesh_import_obj_mtl_roundtrip(client):
    obj = FIXTURES / "quad.obj"
    resp = client.post("/api/mesh/import", json={"path": str(obj)})
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["success"] is True
    assert body["has_textures"] is True
    # Two triangles, non-indexed → 6 vertices.
    assert body["triangle_count"] == 2
    assert body["vertex_count"] == 6
    assert len(body["uv_coordinates"]) == 6

    # vt (0,0) is V-flipped to (0,1) for three.js.
    assert body["uv_coordinates"][0] == [0.0, 1.0]

    # One material with the quad's Kd colour and PNG texture.
    mats = body["materials"]
    assert len(mats) == 1
    assert mats[0]["texture_name"] == "quad_texture.png"
    assert mats[0]["color"] == [0.3, 0.55, 0.2]
    assert mats[0]["has_alpha"] is True

    groups = body["material_groups"]
    assert groups[0]["triangle_indices"] == [0, 1]

    # Texture decodes to the fixture PNG.
    raw = base64.b64decode(body["textures"]["quad_texture.png"])
    assert raw[:4] == b"\x89PNG"

    # Per-vertex colours come from Kd.
    assert body["colors"][0] == [0.3, 0.55, 0.2]
    # Normals from vn.
    assert body["normals"][0] == [0.0, 0.0, 1.0]


def test_mesh_import_missing_file(client):
    resp = client.post("/api/mesh/import", json={"path": "/nope/missing.obj"})
    assert resp.status_code == 404


def test_mesh_import_rejects_non_obj(client, tmp_path):
    stl = tmp_path / "thing.stl"
    stl.write_text("solid x\nendsolid x\n")
    resp = client.post("/api/mesh/import", json={"path": str(stl)})
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# PLY mesh import (the ambiguous PLY container, resolved as a polygon mesh)
# ---------------------------------------------------------------------------

# A unit quad as a polygon mesh: 4 vertices with per-vertex RGB, 2 triangles.
_PLY_QUAD_ASCII = """ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
element face 2
property list uchar int vertex_indices
end_header
0 0 0 255 0 0
1 0 0 0 255 0
1 1 0 0 0 255
0 1 0 255 255 0
3 0 1 2
3 0 2 3
"""


def _write_binary_ply_quad(path) -> None:
    """Write the same quad as a binary PLY via open3d (the common real-world case)."""
    import numpy as np
    import open3d as o3d

    mesh = o3d.geometry.TriangleMesh()
    mesh.vertices = o3d.utility.Vector3dVector(
        np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], dtype=float)
    )
    mesh.triangles = o3d.utility.Vector3iVector(
        np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int32)
    )
    mesh.vertex_colors = o3d.utility.Vector3dVector(
        np.array([[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]], dtype=float)
    )
    o3d.io.write_triangle_mesh(str(path), mesh, write_ascii=False)


def test_mesh_import_ply_ascii(client, tmp_path):
    """An ASCII PLY mesh imports as geometry with per-vertex colour, no textures."""
    ply = tmp_path / "quad_ascii.ply"
    ply.write_text(_PLY_QUAD_ASCII)
    resp = client.post("/api/mesh/import", json={"path": str(ply)})
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["success"] is True
    assert body["has_textures"] is False
    assert body["materials"] is None
    assert body["textures"] is None
    # Indexed geometry: 4 vertices, 2 triangles.
    assert body["vertex_count"] == 4
    assert body["triangle_count"] == 2
    assert sorted(tuple(t) for t in body["indices"]) == [(0, 1, 2), (0, 2, 3)]

    # Per-vertex colours preserved (0-1), first vertex is red.
    assert body["colors"] is not None
    assert len(body["colors"]) == 4
    r, g, b = body["colors"][0]
    assert r > 0.9 and g < 0.1 and b < 0.1
    # Normals computed (quad lies in z=0 plane → normal ±z).
    assert body["normals"] is not None
    assert abs(abs(body["normals"][0][2]) - 1.0) < 1e-6


def test_mesh_import_ply_binary(client, tmp_path):
    """Binary PLY meshes (the default export of most tools) import correctly."""
    ply = tmp_path / "quad_binary.ply"
    _write_binary_ply_quad(ply)
    resp = client.post("/api/mesh/import", json={"path": str(ply)})
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["success"] is True
    assert body["vertex_count"] == 4
    assert body["triangle_count"] == 2
    assert body["colors"] is not None and len(body["colors"]) == 4


def test_mesh_import_ply_pointcloud_rejected(client, tmp_path):
    """A vertices-only PLY (no faces) is not a mesh — the mesh endpoint rejects it
    with a 400 so the caller routes it to the point-cloud path instead."""
    ply = tmp_path / "cloud.ply"
    ply.write_text(
        "ply\n"
        "format ascii 1.0\n"
        "element vertex 3\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "end_header\n"
        "0 0 0\n1 0 0\n0 1 0\n"
    )
    resp = client.post("/api/mesh/import", json={"path": str(ply)})
    assert resp.status_code == 400
    assert "face" in resp.json()["detail"].lower()
