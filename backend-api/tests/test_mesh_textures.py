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
