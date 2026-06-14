"""Procedural leaf placement on a QSM (Phase 1).

Given a built :class:`~qsm.model.QSM` (woody cylinders grouped into shoots), this
module places leaves on the **terminal shoots** ("last year's growth") following
the phyllotaxis of the tree, and emits a textured triangle mesh that the existing
``TexturedPlantMesh.tsx`` renderer draws directly.

This is the **forward / procedural** phase: leaves are placed geometrically from
user parameters + the QSM topology. It deliberately does **not** call PyHelios --
deriving leaf angle / area distributions from the Helios backend is a later phase.
The orientation math here follows the Helios plantarchitecture leaf convention so
that later phase can swap in cleanly:

    Canonical leaf prototype local frame
    ------------------------------------
    - base (petiole attachment) at the origin,
    - tip along +x,
    - width along +/- y (midrib at y = 0),
    - leaf surface in the x-y plane, normal +z.

A placed leaf carries an orthonormal ``basis`` whose columns are
``[tip_dir, width_dir, normal_dir]`` in world space; a local leaf vertex
``(x, y, z)`` maps to ``base + basis @ (x, y, z)``.

All lengths are in meters (matching the QSM).
"""

from __future__ import annotations

import base64
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

from .model import QSM, Shoot

# ---------------------------------------------------------------------------
# Canonical phyllotaxis values (degrees) and the pattern / leaves-per-node each
# implies. Used both to snap auto-detected angles and to infer arrangement.
# ---------------------------------------------------------------------------
CANONICAL_PHYLLOTAXIS: List[float] = [180.0, 137.5, 144.0, 150.0, 90.0]


def phyllotaxis_pattern(angle_deg: float) -> Tuple[str, int]:
    """Map a phyllotactic angle to (pattern, leaves_per_node).

    180 -> opposite/decussate (2 per node); 90 -> decussate (2 per node);
    137.5/144/150 (spiral) -> alternate (1 per node). Anything else defaults to
    alternate.
    """
    a = round(float(angle_deg), 1)
    if abs(a - 180.0) < 1e-6:
        return ("opposite", 2)
    if abs(a - 90.0) < 1e-6:
        return ("decussate", 2)
    if abs(a - 137.5) < 1e-6 or abs(a - 144.0) < 1e-6 or abs(a - 150.0) < 1e-6:
        return ("spiral", 1)
    return ("alternate", 1)


# ---------------------------------------------------------------------------
# Options / placement records
# ---------------------------------------------------------------------------
@dataclass
class LeafPlacementOptions:
    leaf_spacing: float = 0.05      # m between successive nodes along a shoot (req 3a)
    leaf_pitch_deg: float = 45.0    # leaf angle from the SHOOT AXIS (req 3b);
    #                                 90 deg => leaf sticks straight out radially,
    #                                 0 deg  => leaf lies along the stem.
    leaf_size_m: float = 0.08       # physical leaf length along the tip axis (req 3d)
    phyllotaxis_deg: float = 137.5  # azimuth increment between successive nodes (req 4)
    leaves_per_node: int = 1        # leaves emitted at each node
    texture_aspect: float = 0.6     # width / length of the leaf image (sets leaf width)
    max_leaves: int = 200000        # hard cap (triangle-budget guard)
    # Extra radial clearance, as a multiple of the local branch radius, added on
    # top of the radius itself so the leaf base sits OUTSIDE the tube surface
    # rather than on the centerline (otherwise the blade intersects the branch).
    clearance_frac: float = 0.5


@dataclass
class LeafPlacement:
    """One placed leaf: a world attachment point + an orthonormal world basis."""

    position: np.ndarray  # (3,) world base / petiole attachment point
    basis: np.ndarray     # (3,3) columns = [tip_dir, width_dir, normal_dir]
    length: float         # leaf length (scales the +x / tip axis)
    width: float          # leaf width (scales the +/- y / width axis)


# ---------------------------------------------------------------------------
# Vector helpers
# ---------------------------------------------------------------------------
def _normalize(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-12 else v


def terminal_shoots(qsm: QSM) -> List[Shoot]:
    """All terminal shoots -- those with no child shoots -- regardless of rank.

    This captures both the highest-rank tips AND the terminating tip of a
    lower-rank axis (e.g. the central leader's own tip), which is what
    "last year's growth" means across the whole crown.
    """
    return [s for s in qsm.shoots if not s.child_shoot_ids and s.cylinder_ids]


def shoot_centerline(qsm: QSM, shoot: Shoot) -> Tuple[np.ndarray, np.ndarray]:
    """Build the base->tip polyline of a shoot and a per-vertex radius.

    The shoot's cylinders are a continuation-linked chain (``cylinder_ids`` is
    ordered base->tip), so consecutive cylinders share an endpoint. Returns
    ``(pts (N,3), radii (N,))``. Zero-length cylinders are skipped. ``radii`` at a
    shared joint takes the owning segment's radius (the segment starting there).
    """
    by_id = qsm.cylinder_by_id()
    pts: List[np.ndarray] = []
    radii: List[float] = []
    for cid in shoot.cylinder_ids:
        c = by_id.get(cid)
        if c is None:
            continue
        if float(np.linalg.norm(c.end - c.start)) <= 1e-9:
            continue  # degenerate segment
        if not pts:
            pts.append(np.asarray(c.start, dtype=np.float64))
            radii.append(float(c.radius))
        # Append the end; radius of the vertex at `end` is this segment's radius.
        pts.append(np.asarray(c.end, dtype=np.float64))
        radii.append(float(c.radius))
    if not pts:
        return np.zeros((0, 3)), np.zeros((0,))
    return np.asarray(pts), np.asarray(radii)


def march_nodes(
    pts: np.ndarray, radii: np.ndarray, spacing: float, start: float = 0.0
) -> List[Tuple[np.ndarray, np.ndarray, float]]:
    """Arc-length march along a polyline, emitting ``(point, tangent, radius)``.

    Stations are placed every ``spacing`` meters from arc length ``start`` up to
    the tip. ``tangent`` is the unit direction of the polyline segment the station
    falls on. At least ONE node is always emitted at ``start`` (so even a leafable
    stretch shorter than one spacing gets a leaf).
    """
    if pts.shape[0] < 2 or spacing <= 0:
        if pts.shape[0] >= 1:
            tan = np.array([0.0, 0.0, 1.0])
            if pts.shape[0] >= 2:
                tan = _normalize(pts[1] - pts[0])
            return [(pts[0], tan, float(radii[0]) if radii.size else 0.0)]
        return []

    # Cumulative arc length at each polyline vertex.
    seg_vecs = np.diff(pts, axis=0)
    seg_lens = np.linalg.norm(seg_vecs, axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg_lens)])
    total = float(cum[-1])
    start = max(0.0, min(float(start), total))

    nodes: List[Tuple[np.ndarray, np.ndarray, float]] = []
    s = start
    while s <= total + 1e-9:
        # Find the segment containing arc length s.
        seg = int(np.searchsorted(cum, s, side="right") - 1)
        seg = max(0, min(seg, len(seg_lens) - 1))
        seg_len = seg_lens[seg]
        if seg_len <= 1e-12:
            t = 0.0
        else:
            t = (s - cum[seg]) / seg_len
        point = pts[seg] + t * seg_vecs[seg]
        tangent = _normalize(seg_vecs[seg])
        radius = float(radii[seg + 1]) if seg + 1 < radii.shape[0] else float(radii[seg])
        nodes.append((point, tangent, radius))
        s += spacing

    if not nodes:  # spacing larger than the leafable stretch -> at least one node
        seg = int(np.searchsorted(cum, start, side="right") - 1)
        seg = max(0, min(seg, len(seg_lens) - 1))
        seg_len = seg_lens[seg]
        t = (start - cum[seg]) / seg_len if seg_len > 1e-12 else 0.0
        nodes.append((pts[seg] + t * seg_vecs[seg], _normalize(seg_vecs[seg]), float(radii[seg])))
    return nodes


def azimuth_frame(tangent: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Two orthonormal vectors (u, v) spanning the plane perpendicular to tangent.

    The reference is world-up, falling back to world-x when tangent is (nearly)
    vertical. (u, v, tangent) is right-handed (v = tangent x u).
    """
    t = _normalize(tangent)
    ref = np.array([0.0, 0.0, 1.0])
    if abs(float(np.dot(t, ref))) > 0.99:
        ref = np.array([1.0, 0.0, 0.0])
    u = _normalize(ref - np.dot(ref, t) * t)
    v = _normalize(np.cross(t, u))
    return u, v


def orient_leaf(
    tangent: np.ndarray,
    u: np.ndarray,
    v: np.ndarray,
    azimuth_rad: float,
    pitch_rad: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """Build the world ``basis`` and outward ``radial`` for a leaf.

    ``pitch`` is measured from the SHOOT AXIS: pitch=90deg => the leaf points
    straight out radially; pitch=0 => the leaf lies along the stem. Returns
    ``(basis (3,3) [tip_dir, width_dir, normal_dir], radial (3,))``.
    """
    radial = _normalize(math.cos(azimuth_rad) * u + math.sin(azimuth_rad) * v)
    t = _normalize(tangent)
    tip_dir = _normalize(math.sin(pitch_rad) * radial + math.cos(pitch_rad) * t)
    # Width runs tangentially around the stem; normal completes the right-handed frame.
    width_dir = _normalize(np.cross(t, radial))
    if float(np.linalg.norm(width_dir)) < 1e-9:
        # tip_dir parallel to radial degenerate guard
        width_dir = _normalize(np.cross(tip_dir, radial))
    normal_dir = _normalize(np.cross(tip_dir, width_dir))
    # Re-orthogonalize width against tip & normal to guarantee orthonormality.
    width_dir = _normalize(np.cross(normal_dir, tip_dir))
    basis = np.column_stack([tip_dir, width_dir, normal_dir])
    return basis, radial


def leafable_start(qsm: QSM, shoot: Shoot) -> float:
    """Arc length along ``shoot`` (from its base) at which leafing should begin.

    Leaves only go on the distal stretch of "last year's growth": the portion
    from the FURTHEST-OUT child fork to the tip. A shoot with no children is
    leafable from its base (0.0). For a shoot with children midway, leaves start
    at the end of the distal-most cylinder that carries a child -- so the segment
    between the last branch and the tip gets foliage, while the older wood below
    the forks stays bare.

    Returns the start arc length; 0.0 for a childless shoot.
    """
    if not shoot.child_shoot_ids:
        return 0.0

    by_id = qsm.cylinder_by_id()
    by_shoot = qsm.shoot_by_id()

    # Cumulative arc length at the END of each non-degenerate cylinder in the
    # shoot's base->tip order, keyed by cyl_id.
    end_arclen: Dict[int, float] = {}
    cum = 0.0
    for cid in shoot.cylinder_ids:
        c = by_id.get(cid)
        if c is None:
            continue
        seg = float(np.linalg.norm(c.end - c.start))
        if seg <= 1e-9:
            end_arclen[cid] = cum  # degenerate: same position as previous end
            continue
        cum += seg
        end_arclen[cid] = cum

    # Distal-most fork: the largest end-arc-length among cylinders that a child
    # of this shoot attaches to (child.parent_cyl_id).
    start = 0.0
    for child_id in shoot.child_shoot_ids:
        child = by_shoot.get(child_id)
        if child is None:
            continue
        fork_arclen = end_arclen.get(child.parent_cyl_id)
        if fork_arclen is not None and fork_arclen > start:
            start = fork_arclen
    return start


def place_leaves(qsm: QSM, opts: LeafPlacementOptions) -> List[LeafPlacement]:
    """Place leaves on the terminal (current-year) stretch of EVERY shoot.

    For each shoot, leaves are placed only from its distal-most child fork to the
    tip (the whole shoot if it has no children); see :func:`leafable_start`. This
    covers both shoots that terminate cleanly AND the bare tip beyond the last
    branch of a shoot that forks midway. A running phyllotactic azimuth is carried
    across nodes, emitting ``leaves_per_node`` leaves per node. Leaf bases sit
    just OUTSIDE the branch surface (radius + clearance) so blades clear the tube.
    """
    placements: List[LeafPlacement] = []
    pitch_rad = math.radians(opts.leaf_pitch_deg)
    phyllo_rad = math.radians(opts.phyllotaxis_deg)
    per_node = max(1, int(opts.leaves_per_node))
    length = float(opts.leaf_size_m)
    width = float(opts.leaf_size_m) * float(opts.texture_aspect)
    offset_mult = 1.0 + max(0.0, float(opts.clearance_frac))

    for shoot in qsm.shoots:
        if not shoot.cylinder_ids:
            continue
        pts, radii = shoot_centerline(qsm, shoot)
        if pts.shape[0] == 0:
            continue
        start = leafable_start(qsm, shoot)
        nodes = march_nodes(pts, radii, opts.leaf_spacing, start=start)
        phi = 0.0  # running phyllotactic azimuth, accumulated across nodes
        for (point, tangent, radius) in nodes:
            u, v = azimuth_frame(tangent)
            for k in range(per_node):
                az = phi + k * (2.0 * math.pi / per_node)
                basis, radial = orient_leaf(tangent, u, v, az, pitch_rad)
                base = point + radial * (float(radius) * offset_mult)
                placements.append(
                    LeafPlacement(position=base, basis=basis, length=length, width=width)
                )
                if len(placements) >= opts.max_leaves:
                    return placements
            phi += phyllo_rad
    return placements


# ---------------------------------------------------------------------------
# Geometry builders -- emit dicts mirroring PlantGenerationResponse fields so
# the frontend's plantResponseToMeshData() consumes them unchanged.
# ---------------------------------------------------------------------------
def _empty_geometry(error: Optional[str] = None) -> dict:
    return {
        "vertices": [],
        "indices": [],
        "normals": [],
        "uv_coordinates": [],
        "materials": [],
        "material_groups": [],
        "textures": {},
        "leaf_count": 0,
        "error": error,
    }


# Local quad corners for a planar leaf: base at origin, tip along +x, width +/-y.
#   c0 = (0, -w/2, 0)  base-right
#   c1 = (0, +w/2, 0)  base-left
#   c2 = (L, +w/2, 0)  tip-left
#   c3 = (L, -w/2, 0)  tip-right
# Two triangles: (c0, c1, c2) and (c0, c2, c3). UVs map base->tip to U 0->1 and
# the width across V; V is flipped (1 - v) to match the renderer's flipY=false.
_QUAD_TRIS = ((0, 1, 2), (0, 2, 3))


def build_leaf_quad_geometry(
    placements: List[LeafPlacement],
    texture_name: str,
    texture_b64: str,
    has_alpha: bool = True,
) -> dict:
    """Build planar textured quads (2 triangles each) for every placement.

    All quads share one material referencing ``texture_name``. Output is
    non-indexed (6 expanded vertices per leaf).
    """
    if not placements:
        return _empty_geometry()

    vertices: List[List[float]] = []
    normals: List[List[float]] = []
    uvs: List[List[float]] = []
    indices: List[List[int]] = []

    vidx = 0
    for p in placements:
        L = p.length
        w = p.width
        corners_local = np.array(
            [
                [0.0, -0.5 * w, 0.0],
                [0.0, 0.5 * w, 0.0],
                [L, 0.5 * w, 0.0],
                [L, -0.5 * w, 0.0],
            ]
        )
        # World corners: base + basis @ local.
        corners_world = p.position[None, :] + corners_local @ p.basis.T
        normal = p.basis[:, 2].tolist()  # normal_dir column
        # UVs: U along leaf length (x: 0->L => 0->1), V along width
        # (y: -w/2->+w/2 => 0->1), then V-flipped to match the renderer's
        # flipY=false convention.
        corner_uv = [
            [0.0, 0.0],  # c0 (x=0,   y=-w/2)
            [0.0, 1.0],  # c1 (x=0,   y=+w/2)
            [1.0, 1.0],  # c2 (x=L,   y=+w/2)
            [1.0, 0.0],  # c3 (x=L,   y=-w/2)
        ]
        corner_uv = [[u, 1.0 - vv] for (u, vv) in corner_uv]

        for tri in _QUAD_TRIS:
            face = []
            for ci in tri:
                vertices.append(corners_world[ci].tolist())
                normals.append(normal)
                uvs.append(corner_uv[ci])
                face.append(vidx)
                vidx += 1
            indices.append(face)

    n_tris = len(indices)
    material = {
        "name": "leaf",
        "color": [0.3, 0.5, 0.1],
        "texture_name": texture_name,
        "has_alpha": bool(has_alpha),
    }
    material_group = {
        "material_name": "leaf",
        "triangle_indices": list(range(n_tris)),
    }
    return {
        "vertices": vertices,
        "indices": indices,
        "normals": normals,
        "uv_coordinates": uvs,
        "materials": [material],
        "material_groups": [material_group],
        "textures": {texture_name: texture_b64},
        "leaf_count": len(placements),
        "error": None,
    }


def build_leaf_obj_geometry(placements: List[LeafPlacement], template: dict) -> dict:
    """Instance an OBJ leaf template at each placement.

    ``template`` is the dict from :func:`qsm.obj_loader.load_obj_template`. The
    template is normalized so its base sits at the origin and its longest extent
    matches the placement length (``LeafPlacement.length``), then transformed by
    each placement's basis + position. Per-template materials / textures are
    preserved; triangle indices are offset per instance.
    """
    if not placements:
        return _empty_geometry()

    tpl_verts = np.asarray(template["vertices"], dtype=np.float64)  # (M,3) expanded
    tpl_normals = np.asarray(template["normals"], dtype=np.float64)
    tpl_uvs = template["uvs"]
    tpl_faces = template["faces"]            # [[i,j,k], ...] into tpl_verts
    tpl_tri_material = template["tri_material"]
    material_texture_name = template["material_texture_name"]
    mtl_materials = template["mtl_materials"]
    textures = dict(template["textures"])    # already base64, keyed by basename

    if tpl_verts.shape[0] == 0 or not tpl_faces:
        return _empty_geometry("OBJ template has no geometry")

    # Normalize: translate base (min along principal/long axis) to origin, scale
    # the longest bounding-box extent to 1 (length scaling applied per placement).
    bb_min = tpl_verts.min(axis=0)
    bb_max = tpl_verts.max(axis=0)
    extent = bb_max - bb_min
    long_axis = int(np.argmax(extent))
    longest = float(extent[long_axis]) if extent[long_axis] > 1e-9 else 1.0
    # Shift so the base of the long axis is at origin; keep the other axes centered.
    shift = np.array(
        [
            bb_min[0] if 0 == long_axis else 0.5 * (bb_min[0] + bb_max[0]),
            bb_min[1] if 1 == long_axis else 0.5 * (bb_min[1] + bb_max[1]),
            bb_min[2] if 2 == long_axis else 0.5 * (bb_min[2] + bb_max[2]),
        ]
    )
    norm_verts = (tpl_verts - shift) / longest  # base-at-origin, long axis spans [0,1]

    # Reorder so the long axis maps to +x (tip), matching the canonical leaf frame.
    # Build a permutation putting long_axis first. An odd permutation mirrors the
    # mesh (flipping handedness), so negate the last axis to keep it a proper
    # rotation -- otherwise an uploaded leaf modelled along Y/Z would come out
    # mirrored. (For the canonical Helios assets long_axis==0 -> identity.)
    order = [long_axis] + [a for a in (0, 1, 2) if a != long_axis]
    perm = np.array(order)
    # Parity of the permutation: count inversions.
    inversions = sum(
        1 for i in range(3) for j in range(i + 1, 3) if order[i] > order[j]
    )
    sign = np.array([1.0, 1.0, -1.0 if inversions % 2 == 1 else 1.0])
    norm_verts = norm_verts[:, perm] * sign
    tpl_normals_p = (
        tpl_normals[:, perm] * sign
        if tpl_normals.shape[0] == tpl_verts.shape[0]
        else None
    )

    # Build the merged output.
    out_vertices: List[List[float]] = []
    out_normals: List[List[float]] = []
    out_uvs: List[List[float]] = []
    out_faces: List[List[int]] = []
    out_tri_material: List[Optional[str]] = []

    m = tpl_verts.shape[0]
    for p in placements:
        scale = p.length  # long axis already normalized to [0,1]
        local = (norm_verts * scale)              # (M,3)
        world = p.position[None, :] + local @ p.basis.T
        base_v = len(out_vertices)
        out_vertices.extend(world.tolist())
        if tpl_normals_p is not None:
            world_n = tpl_normals_p @ p.basis.T
            # renormalize
            lens = np.linalg.norm(world_n, axis=1, keepdims=True)
            lens[lens < 1e-12] = 1.0
            out_normals.extend((world_n / lens).tolist())
        else:
            out_normals.extend([[0.0, 0.0, 1.0]] * m)
        out_uvs.extend(tpl_uvs)
        for f, mat in zip(tpl_faces, tpl_tri_material):
            out_faces.append([base_v + f[0], base_v + f[1], base_v + f[2]])
            out_tri_material.append(mat)

    # Material groups: one per material that has a loaded texture.
    materials_list: List[dict] = []
    groups: Dict[str, List[int]] = {}
    for ti, mat in enumerate(out_tri_material):
        if mat and mat in material_texture_name and material_texture_name[mat] in textures:
            groups.setdefault(mat, []).append(ti)
    for mat, tris in groups.items():
        tex_name = material_texture_name[mat]
        kd = mtl_materials.get(mat, {}).get("Kd")
        materials_list.append(
            {
                "name": mat,
                "color": kd,
                "texture_name": tex_name,
                "has_alpha": tex_name.lower().endswith(".png"),
            }
        )
    material_groups_list = [
        {"material_name": mat, "triangle_indices": tris} for mat, tris in groups.items()
    ]
    # Only keep textures actually referenced by a group.
    used_tex = {material_texture_name[m] for m in groups}
    textures_out = {k: v for k, v in textures.items() if k in used_tex}

    return {
        "vertices": out_vertices,
        "indices": out_faces,
        "normals": out_normals,
        "uv_coordinates": out_uvs if materials_list else None,
        "materials": materials_list or None,
        "material_groups": material_groups_list or None,
        "textures": textures_out or None,
        "leaf_count": len(placements),
        "error": None,
    }


# ---------------------------------------------------------------------------
# Phyllotaxis auto-detection
# ---------------------------------------------------------------------------
def detect_phyllotaxis(qsm: QSM) -> dict:
    """Estimate the phyllotactic angle from child-shoot azimuths around parents.

    Branches follow the phyllotaxis of leaves, but not every bud breaks -- so the
    observed azimuthal gaps between successive child shoots are (approximately)
    *integer multiples* of the true phyllotactic angle. We therefore score each
    candidate canonical angle by how well the observed gaps cluster as multiples
    of it, and pick the best.

    Returns ``{angle_deg, pattern, leaves_per_node, confidence, n_parents_sampled}``.
    """
    by_cyl = qsm.cylinder_by_id()
    by_shoot = qsm.shoot_by_id()

    # Per parent, the azimuths (radians) of its child shoots around the parent
    # axis. We score candidate angles by how well each parent's azimuth SET fits
    # the lattice {phi0 + n*theta}: a good theta makes every azimuth, reduced mod
    # theta, land at the same phase. This is order-free (no sorting/sequence
    # assumption) and robust to unbroken buds (a skipped bud is just a missing
    # lattice point, not a wrong phase). Sorting + successive gaps does NOT work
    # for spiral patterns -- the sorted gaps are not theta.
    per_parent_azimuths: List[List[float]] = []

    for parent in qsm.shoots:
        children = [by_shoot.get(cid) for cid in parent.child_shoot_ids]
        children = [c for c in children if c is not None and c.cylinder_ids]
        if len(children) < 2:
            continue  # need >= 2 children to measure phyllotaxis

        azimuths: List[float] = []
        for child in children:
            # Fork point: the parent cylinder the child attaches to.
            fork_cyl = by_cyl.get(child.parent_cyl_id)
            if fork_cyl is None:
                continue
            parent_axis = fork_cyl.axis
            if float(np.linalg.norm(parent_axis)) < 1e-9:
                continue
            u, v = azimuth_frame(parent_axis)
            first = by_cyl.get(child.cylinder_ids[0])
            if first is None:
                continue
            emerge = first.axis
            if float(np.linalg.norm(emerge)) < 1e-9:
                emerge = np.asarray(first.end - first.start, dtype=np.float64)
            # Project onto the plane perpendicular to the parent axis.
            proj = emerge - np.dot(emerge, parent_axis) * parent_axis
            if float(np.linalg.norm(proj)) < 1e-9:
                continue
            az = math.atan2(float(np.dot(proj, v)), float(np.dot(proj, u)))
            azimuths.append(az)

        if len(azimuths) >= 2:
            per_parent_azimuths.append(azimuths)

    n_parents = len(per_parent_azimuths)
    if n_parents == 0:
        return {
            "angle_deg": 137.5,
            "pattern": "spiral",
            "leaves_per_node": 1,
            "confidence": 0.0,
            "n_parents_sampled": 0,
        }

    # For each candidate theta, reduce every azimuth modulo theta (i.e. wrap onto a
    # circle of circumference theta) and measure the circular concentration
    # (resultant length R in [0,1]) of those reduced phases. R near 1 => the
    # azimuths lie on a {phi0 + n*theta} lattice => theta fits. We average R over
    # parents (weighting by child count) and pick the theta with the highest R.
    def _concentration(azs: List[float], theta_deg: float) -> Tuple[float, int]:
        theta = math.radians(theta_deg)
        # Phase of each azimuth within its mod-theta cell, mapped to [0, 2pi).
        phases = [((a % theta) / theta) * 2.0 * math.pi for a in azs]
        cx = sum(math.cos(p) for p in phases)
        cy = sum(math.sin(p) for p in phases)
        R = math.hypot(cx, cy) / len(phases)
        return R, len(phases)

    scores: Dict[float, float] = {}
    for theta_deg in CANONICAL_PHYLLOTAXIS:
        num = 0.0
        den = 0
        for azs in per_parent_azimuths:
            R, n = _concentration(azs, theta_deg)
            num += R * n
            den += n
        scores[theta_deg] = num / den if den else 0.0

    best_theta = max(scores, key=scores.get)
    best_score = scores[best_theta]

    # The three spiral angles (137.5/144/150) have very similar lattices, so with a
    # handful of branches their scores are nearly tied and the exact pick is noisy.
    # 137.5 (the golden angle) is by far the most common spiral in trees, so prefer
    # it within the spiral family when it scores within a small margin of the best.
    SPIRAL = {137.5, 144.0, 150.0}
    if best_theta in SPIRAL and best_theta != 137.5:
        if scores.get(137.5, 0.0) >= best_score - 0.10:
            best_theta = 137.5

    confidence = max(0.0, min(1.0, best_score))
    pattern, per_node = phyllotaxis_pattern(best_theta)
    return {
        "angle_deg": float(best_theta),
        "pattern": pattern,
        "leaves_per_node": per_node,
        "confidence": float(confidence),
        "n_parents_sampled": n_parents,
    }


# ---------------------------------------------------------------------------
# Builtin texture resolution
# ---------------------------------------------------------------------------
# Curated tree-leaf subset of the plantarchitecture texture library. Allow-listed
# to prevent path traversal via a user-supplied builtin name.
CURATED_LEAF_TEXTURES: List[str] = [
    "AlmondLeaf.png",
    "AppleLeaf.png",
    "WalnutLeaf.png",
    "PistachioLeaf.png",
    "OliveLeaf_upper.png",
    "GrapeLeaf.png",
    "RedbudLeaf.png",
]


def _plantarch_texture_dir() -> Path:
    """Resolve the plantarchitecture textures directory (dev + bundled).

    The PyInstaller bundle collects PyHelios assets under
    ``pyhelios/assets/build/plugins/...`` (the wheel layout), NOT the
    ``pyhelios/helios-core/plugins/...`` source layout — and the frozen ``qsm``
    package has no real on-disk ``__file__`` to walk up from. So ask PyHelios's
    own asset manager for the build directory first (it already resolves dev,
    wheel, and frozen layouts), then fall back to source-tree guesses.
    """
    candidates: list[Path] = []

    # PRIORITY 1: PyHelios asset manager — the single source of truth for where
    # the collected assets live, correct in the frozen bundle and the dev wheel.
    try:
        from pyhelios.assets import get_asset_manager

        build_path = get_asset_manager()._get_helios_build_path()
        if build_path:
            candidates.append(
                Path(build_path)
                / "plugins"
                / "plantarchitecture"
                / "assets"
                / "textures"
            )
    except Exception:
        # Asset manager unavailable (e.g. PyHelios import issue) — fall through
        # to the source-tree guesses below rather than failing hard.
        pass

    # PRIORITY 2: source-tree layout, for a plain `python main.py` from the repo.
    # qsm/leaves.py -> backend-api/ -> repo root has pyhelios/...
    here = Path(__file__).resolve()
    candidates.append(
        here.parent.parent.parent
        / "pyhelios"
        / "helios-core"
        / "plugins"
        / "plantarchitecture"
        / "assets"
        / "textures"
    )
    # Bundled-ish layout: pyhelios collected next to the binary; search a few ups.
    for up in (here.parent.parent, here.parent.parent.parent.parent):
        candidates.append(
            up
            / "pyhelios"
            / "helios-core"
            / "plugins"
            / "plantarchitecture"
            / "assets"
            / "textures"
        )

    for c in candidates:
        if c.is_dir():
            return c
    return candidates[0]


def read_png_dimensions(data: bytes) -> Tuple[int, int]:
    """Return (width, height) from a PNG byte buffer (IHDR), or (1, 1)."""
    # PNG signature (8) + length(4) + 'IHDR'(4) + width(4) + height(4)
    if len(data) >= 24 and data[12:16] == b"IHDR":
        width = int.from_bytes(data[16:20], "big")
        height = int.from_bytes(data[20:24], "big")
        if width > 0 and height > 0:
            return width, height
    return 1, 1


def _leaf_aspect(width: int, height: int) -> float:
    """Leaf width-to-length aspect = short side / long side of the image.

    Leaf textures put the midrib along the image's LONG dimension, so the leaf's
    physical length maps to the long side and its width to the short side. The
    quad builder multiplies leaf length by this to get leaf width.
    """
    if width <= 0 or height <= 0:
        return 0.6
    lo, hi = (width, height) if width <= height else (height, width)
    return float(lo) / float(hi)


def resolve_builtin_texture(name: str) -> Tuple[str, str, float]:
    """Resolve a curated builtin texture name to (basename, base64, aspect).

    ``aspect`` is the leaf width/length ratio. Raises ``ValueError`` if the name
    is not in the curated allow-list or the file is missing.
    """
    base = os.path.basename(name)
    if base not in CURATED_LEAF_TEXTURES:
        raise ValueError(f"Unknown builtin leaf texture: {name}")
    path = _plantarch_texture_dir() / base
    if not path.is_file():
        raise ValueError(f"Builtin leaf texture not found on disk: {base}")
    data = path.read_bytes()
    w, h = read_png_dimensions(data)
    return base, base64.b64encode(data).decode("utf-8"), _leaf_aspect(w, h)


def read_texture_file(path: Path) -> Tuple[str, str, float]:
    """Read an uploaded image file to (basename, base64, aspect)."""
    if not path.is_file():
        raise ValueError(f"Texture file not found: {path}")
    data = path.read_bytes()
    if path.suffix.lower() == ".png":
        w, h = read_png_dimensions(data)
        aspect = _leaf_aspect(w, h)
    else:
        aspect = 0.6  # unknown; default leaf-ish aspect
    return path.name, base64.b64encode(data).decode("utf-8"), aspect
