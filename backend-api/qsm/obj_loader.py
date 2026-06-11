"""Shared OBJ (+ MTL + texture) loader.

Reads a Wavefront OBJ into expanded (non-indexed) triangle geometry plus the
material / texture information needed to render it textured. This is the parser
that previously lived inline in ``main.py``'s ``/api/mesh/import`` handler; it is
factored out here so the QSM leaf-placement code (``qsm/leaves.py``) can load a
leaf OBJ "template" and instance it per leaf without duplicating the parser.

Conventions (matching the renderer and the prior inline implementation)
-----------------------------------------------------------------------
- Output is **non-indexed**: every triangle owns 3 fresh vertices, so
  ``triangles[t]`` is ``[t*3, t*3+1, t*3+2]`` and per-triangle material grouping
  is unambiguous. This is exactly what ``TexturedPlantMesh.tsx`` expects.
- UVs are **V-flipped** (``[u, 1 - v]``) because Helios/OBJ texture space is
  V-down while three.js is V-up (the renderer sets ``flipY = false``).
- Textures are returned as base64-encoded file bytes keyed by basename; the MTL
  ``map_Kd`` token is resolved relative to the OBJ directory (then by basename).
- ``has_alpha`` is inferred from a ``.png`` extension (PNG may carry an alpha
  channel; the renderer alpha-tests it to cut out the leaf silhouette).

No FastAPI / pydantic here on purpose: the loader returns plain Python data so it
is trivially unit-testable and reusable from any caller.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np


def parse_mtl(mtl_path: Path) -> Dict[str, dict]:
    """Parse a .mtl file into ``{material_name: {"Kd": [r,g,b], "map_Kd": str}}``.

    ``map_Kd`` keeps the raw token as written in the MTL (may be relative); the
    caller resolves it against the MTL's directory.
    """
    materials: Dict[str, dict] = {}
    current = None
    try:
        with open(mtl_path, "r", errors="ignore") as f:
            for line in f:
                parts = line.split()
                if not parts:
                    continue
                key = parts[0]
                if key == "newmtl" and len(parts) >= 2:
                    current = parts[1]
                    materials[current] = {}
                elif current is None:
                    continue
                elif key == "Kd" and len(parts) >= 4:
                    materials[current]["Kd"] = [
                        float(parts[1]),
                        float(parts[2]),
                        float(parts[3]),
                    ]
                elif key == "map_Kd" and len(parts) >= 2:
                    # The texture path is the last token (skip any options like -s).
                    materials[current]["map_Kd"] = parts[-1]
    except FileNotFoundError:
        pass
    return materials


def load_obj_template(obj_path: Path) -> dict:
    """Read an OBJ (+ MTL + textures) into expanded triangle geometry.

    Returns a dict with:
    - ``vertices``: ``List[List[float]]`` — expanded, one per triangle corner.
    - ``normals``: ``List[List[float]]`` — per vertex (flat-filled where the OBJ
      had no ``vn``); always populated.
    - ``uvs``: ``List[List[float]]`` — per vertex, V-flipped; ``[0,0]`` where the
      OBJ had no ``vt``.
    - ``faces``: ``List[List[int]]`` — triangle index triples into ``vertices``
      (``[[0,1,2],[3,4,5],...]``).
    - ``tri_material``: ``List[Optional[str]]`` — active material name per triangle.
    - ``mtl_materials``: ``Dict[str, dict]`` — parsed MTL props per material name.
    - ``textures``: ``Dict[str, str]`` — base64 PNG/image bytes keyed by basename.
    - ``material_texture_name``: ``Dict[str, str]`` — material -> texture basename.

    Raises ``ValueError`` on a malformed / triangle-free OBJ so callers can map it
    to whatever error surface they use (HTTP 4xx, etc.).
    """
    base_dir = obj_path.parent

    # Pass 1: collect raw vertex / uv / normal tables and material library refs.
    positions: List[List[float]] = []  # v
    tex_coords: List[List[float]] = []  # vt
    vert_normals: List[List[float]] = []  # vn
    mtl_libs: List[str] = []

    # Expanded (non-indexed) output, grouped per active material.
    out_vertices: List[List[float]] = []
    out_normals: List[List[float]] = []
    out_uvs: List[List[float]] = []
    out_faces: List[List[int]] = []
    tri_material: List[Optional[str]] = []  # material name active for each triangle

    current_material: Optional[str] = None
    vertex_index = 0

    def _idx(token: str, table_len: int) -> Optional[int]:
        """Resolve an OBJ index token (1-based, negatives relative to end)."""
        if token == "" or token is None:
            return None
        i = int(token)
        if i < 0:
            return table_len + i
        return i - 1

    try:
        with open(obj_path, "r", errors="ignore") as f:
            for line in f:
                parts = line.split()
                if not parts:
                    continue
                cmd = parts[0]
                if cmd == "v" and len(parts) >= 4:
                    positions.append([float(parts[1]), float(parts[2]), float(parts[3])])
                elif cmd == "vt" and len(parts) >= 3:
                    tex_coords.append([float(parts[1]), float(parts[2])])
                elif cmd == "vn" and len(parts) >= 4:
                    vert_normals.append([float(parts[1]), float(parts[2]), float(parts[3])])
                elif cmd == "mtllib" and len(parts) >= 2:
                    mtl_libs.append(" ".join(parts[1:]))
                elif cmd == "usemtl" and len(parts) >= 2:
                    current_material = parts[1]
                elif cmd == "f" and len(parts) >= 4:
                    # Resolve each corner to (pos, vt, vn) indices.
                    corners = []
                    for tok in parts[1:]:
                        comp = tok.split("/")
                        pi = _idx(comp[0], len(positions)) if len(comp) >= 1 else None
                        ti = _idx(comp[1], len(tex_coords)) if len(comp) >= 2 and comp[1] != "" else None
                        ni = _idx(comp[2], len(vert_normals)) if len(comp) >= 3 and comp[2] != "" else None
                        corners.append((pi, ti, ni))
                    # Fan-triangulate polygons.
                    for k in range(1, len(corners) - 1):
                        tri = [corners[0], corners[k], corners[k + 1]]
                        face_idx: List[int] = []
                        for (pi, ti, ni) in tri:
                            if pi is None or pi < 0 or pi >= len(positions):
                                # Malformed corner; skip the whole triangle.
                                face_idx = []
                                break
                            out_vertices.append(positions[pi])
                            if ni is not None and 0 <= ni < len(vert_normals):
                                out_normals.append(vert_normals[ni])
                            else:
                                out_normals.append([0.0, 0.0, 0.0])  # filled below
                            if ti is not None and 0 <= ti < len(tex_coords):
                                u, v = tex_coords[ti]
                                out_uvs.append([u, 1.0 - v])  # V-flip for three.js
                            else:
                                out_uvs.append([0.0, 0.0])
                            face_idx.append(vertex_index)
                            vertex_index += 1
                        if not face_idx:
                            continue
                        out_faces.append(face_idx)
                        tri_material.append(current_material)
    except Exception as e:  # noqa: BLE001 - surface as a clean error
        raise ValueError(f"Failed to parse OBJ: {e}")

    if not out_faces:
        raise ValueError("No triangles found in OBJ file")

    # Compute flat normals for any triangle that had no vn.
    for face in out_faces:
        if all(out_normals[i] == [0.0, 0.0, 0.0] for i in face):
            a = np.array(out_vertices[face[0]])
            b = np.array(out_vertices[face[1]])
            c = np.array(out_vertices[face[2]])
            n = np.cross(b - a, c - a)
            ln = np.linalg.norm(n)
            n = (n / ln).tolist() if ln > 1e-12 else [0.0, 0.0, 1.0]
            for i in face:
                out_normals[i] = n

    # Parse all referenced MTL files; first definition of a name wins.
    mtl_materials: Dict[str, dict] = {}
    for lib in mtl_libs:
        for name, props in parse_mtl(base_dir / lib).items():
            mtl_materials.setdefault(name, props)

    # Load textures (resolved relative to the OBJ dir) as base64, keyed by basename.
    textures_data: Dict[str, str] = {}
    material_texture_name: Dict[str, str] = {}  # material -> texture basename
    for name, props in mtl_materials.items():
        tex_token = props.get("map_Kd")
        if not tex_token:
            continue
        tex_path = base_dir / tex_token
        if not tex_path.is_file():
            # Try just the basename in the OBJ directory.
            tex_path = base_dir / os.path.basename(tex_token)
        if tex_path.is_file():
            tex_name = tex_path.name
            material_texture_name[name] = tex_name
            if tex_name not in textures_data:
                try:
                    with open(tex_path, "rb") as tf:
                        textures_data[tex_name] = base64.b64encode(tf.read()).decode("utf-8")
                except Exception:
                    pass

    return {
        "vertices": out_vertices,
        "normals": out_normals,
        "uvs": out_uvs,
        "faces": out_faces,
        "tri_material": tri_material,
        "mtl_materials": mtl_materials,
        "textures": textures_data,
        "material_texture_name": material_texture_name,
    }
