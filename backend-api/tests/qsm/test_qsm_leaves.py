"""Unit tests for procedural QSM leaf placement + phyllotaxis detection.

Exercises the real ``qsm.leaves`` module on hand-built and synthetic QSMs and
asserts concrete geometric correctness: terminal-shoot selection, node counts for
known spacing, leaf vertex/triangle counts, orientation-frame orthonormality and
the pitch convention, base-on-surface offset, phyllotaxis snapping (including the
unbroken-bud caveat), and builtin-texture resolution + allow-listing.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from qsm.model import QSM, Cylinder, Shoot
from qsm import leaves as L
from qsm.validation.synthetic import simple_tree


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------
def _straight_shoot_qsm(length: float = 1.0, n_seg: int = 2, radius: float = 0.02) -> QSM:
    """A single vertical terminal shoot of `length` split into `n_seg` cylinders."""
    cyls = []
    seg_len = length / n_seg
    for i in range(n_seg):
        cyls.append(
            Cylinder(
                cyl_id=i,
                start=[0, 0, i * seg_len],
                end=[0, 0, (i + 1) * seg_len],
                radius=radius,
                parent_id=i - 1 if i > 0 else -1,
                shoot_id=0,
                rank=0,
            )
        )
    shoot = Shoot(
        shoot_id=0, rank=0, cylinder_ids=list(range(n_seg)),
        parent_shoot_id=-1, parent_cyl_id=-1, child_shoot_ids=[],
    )
    return QSM(cylinders=cyls, shoots=[shoot])


def _star_qsm(child_azimuths_deg) -> QSM:
    """A vertical trunk with child shoots emerging at the given azimuths (deg)."""
    cyls = [Cylinder(cyl_id=0, start=[0, 0, 0], end=[0, 0, 1.0], radius=0.05,
                     parent_id=-1, shoot_id=0, rank=0)]
    trunk = Shoot(shoot_id=0, rank=0, cylinder_ids=[0], parent_shoot_id=-1,
                  parent_cyl_id=-1, child_shoot_ids=[])
    shoots = [trunk]
    cid = 1
    sid = 1
    for az in child_azimuths_deg:
        a = math.radians(az)
        d = np.array([math.cos(a), math.sin(a), 0.3])
        d /= np.linalg.norm(d)
        start = np.array([0.0, 0.0, 1.0])
        end = start + d * 0.3
        cyls.append(Cylinder(cyl_id=cid, start=start.tolist(), end=end.tolist(),
                             radius=0.02, parent_id=0, shoot_id=sid, rank=1))
        shoots.append(Shoot(shoot_id=sid, rank=1, cylinder_ids=[cid],
                            parent_shoot_id=0, parent_cyl_id=0, child_shoot_ids=[]))
        trunk.child_shoot_ids.append(sid)
        cid += 1
        sid += 1
    return QSM(cylinders=cyls, shoots=shoots)


# ---------------------------------------------------------------------------
# Terminal shoot detection
# ---------------------------------------------------------------------------
def test_terminal_shoots_excludes_parents():
    qsm = simple_tree()
    terminals = L.terminal_shoots(qsm)
    term_ids = {s.shoot_id for s in terminals}
    # No terminal shoot may have children.
    for s in terminals:
        assert not s.child_shoot_ids
    # A shoot WITH children must not be terminal.
    for s in qsm.shoots:
        if s.child_shoot_ids:
            assert s.shoot_id not in term_ids
    # simple_tree has 3 rank-2 sub-branches that are terminal.
    assert len(terminals) >= 3


def test_terminal_shoots_all_ranks():
    """A lower-rank axis whose own tip terminates is a terminal shoot too."""
    qsm = _straight_shoot_qsm()  # single rank-0 shoot, no children
    terminals = L.terminal_shoots(qsm)
    assert len(terminals) == 1
    assert terminals[0].rank == 0


def _midfork_qsm() -> QSM:
    """A 1.0 m main shoot (5 x 0.2 m) with two children forking at cyl 2 (the
    cylinder ending at z=0.6). The distal stretch z=0.6..1.0 is bare wood that
    should still be leafed; z<0.6 carries the forks and must stay bare."""
    cyls = []
    for i in range(5):
        cyls.append(Cylinder(cyl_id=i, start=[0, 0, i * 0.2], end=[0, 0, (i + 1) * 0.2],
                             radius=0.02, parent_id=i - 1 if i > 0 else -1, shoot_id=0, rank=0))
    cyls.append(Cylinder(cyl_id=10, start=[0, 0, 0.6], end=[0.3, 0, 0.7], radius=0.01,
                         parent_id=2, shoot_id=1, rank=1))
    cyls.append(Cylinder(cyl_id=11, start=[0, 0, 0.6], end=[-0.3, 0, 0.7], radius=0.01,
                         parent_id=2, shoot_id=2, rank=1))
    shoots = [
        Shoot(shoot_id=0, rank=0, cylinder_ids=[0, 1, 2, 3, 4], parent_shoot_id=-1,
              parent_cyl_id=-1, child_shoot_ids=[1, 2]),
        Shoot(shoot_id=1, rank=1, cylinder_ids=[10], parent_shoot_id=0, parent_cyl_id=2,
              child_shoot_ids=[]),
        Shoot(shoot_id=2, rank=1, cylinder_ids=[11], parent_shoot_id=0, parent_cyl_id=2,
              child_shoot_ids=[]),
    ]
    return QSM(cylinders=cyls, shoots=shoots)


def test_leafable_start_distal_to_last_fork():
    qsm = _midfork_qsm()
    main = qsm.shoot_by_id()[0]
    # Children fork at the cylinder ending at z=0.6 -> leafing starts at 0.6 m.
    assert np.isclose(L.leafable_start(qsm, main), 0.6, atol=1e-6)
    # The childless children leaf from their own base.
    assert L.leafable_start(qsm, qsm.shoot_by_id()[1]) == 0.0


def test_mid_shoot_tip_gets_leaves_but_not_older_wood():
    """The bare stretch from the last fork to the tip is leafed; wood below the
    forks stays bare. This is the case a child-empty `terminal_shoots` filter
    misses."""
    qsm = _midfork_qsm()
    opts = L.LeafPlacementOptions(leaf_spacing=0.1, leaf_size_m=0.04,
                                  leaves_per_node=1, clearance_frac=0.5)
    placements = L.place_leaves(qsm, opts)
    # Leaves on the MAIN shoot are those near the z-axis (children are offset in x).
    main_z = [float(p.position[2]) for p in placements
              if abs(p.position[0]) < 0.05 and abs(p.position[1]) < 0.05]
    assert main_z, "the distal stretch of the forking shoot should be leafed"
    # Every main-shoot leaf is on the distal stretch (z >= 0.6), none on older wood.
    assert min(main_z) >= 0.6 - 1e-6
    assert max(main_z) <= 1.0 + 1e-6


# ---------------------------------------------------------------------------
# Centerline + node marching
# ---------------------------------------------------------------------------
def test_node_count_for_known_spacing():
    qsm = _straight_shoot_qsm(length=1.0, n_seg=2)
    pts, radii = L.shoot_centerline(qsm, qsm.shoots[0])
    assert np.isclose(np.linalg.norm(pts[-1] - pts[0]), 1.0)
    nodes = L.march_nodes(pts, radii, spacing=0.1)
    # Stations every 0.1 m from 0..1.0 inclusive -> 11.
    assert len(nodes) == 11


def test_short_shoot_emits_at_least_one_node():
    qsm = _straight_shoot_qsm(length=0.02, n_seg=1)  # shorter than spacing
    pts, radii = L.shoot_centerline(qsm, qsm.shoots[0])
    nodes = L.march_nodes(pts, radii, spacing=0.5)
    assert len(nodes) >= 1


def test_centerline_skips_degenerate_segments():
    cyls = [
        Cylinder(cyl_id=0, start=[0, 0, 0], end=[0, 0, 0], radius=0.02,  # degenerate
                 parent_id=-1, shoot_id=0, rank=0),
        Cylinder(cyl_id=1, start=[0, 0, 0], end=[0, 0, 0.5], radius=0.02,
                 parent_id=0, shoot_id=0, rank=0),
    ]
    shoot = Shoot(shoot_id=0, rank=0, cylinder_ids=[0, 1], parent_shoot_id=-1,
                  parent_cyl_id=-1, child_shoot_ids=[])
    qsm = QSM(cylinders=cyls, shoots=[shoot])
    pts, _ = L.shoot_centerline(qsm, shoot)
    assert np.isclose(np.linalg.norm(pts[-1] - pts[0]), 0.5)


# ---------------------------------------------------------------------------
# Orientation frame
# ---------------------------------------------------------------------------
def test_orientation_basis_orthonormal_right_handed():
    qsm = _straight_shoot_qsm()
    opts = L.LeafPlacementOptions(leaf_spacing=0.2, leaf_pitch_deg=45,
                                  leaf_size_m=0.08, leaves_per_node=1)
    placements = L.place_leaves(qsm, opts)
    assert placements
    for p in placements:
        b = p.basis
        assert np.allclose(b.T @ b, np.eye(3), atol=1e-6)  # orthonormal
        assert np.isclose(np.linalg.det(b), 1.0, atol=1e-6)  # right-handed


def test_pitch_90_tip_perpendicular_to_shoot():
    qsm = _straight_shoot_qsm()  # vertical shoot, tangent ~ +z
    opts = L.LeafPlacementOptions(leaf_spacing=0.2, leaf_pitch_deg=90,
                                  leaf_size_m=0.08, leaves_per_node=1)
    placements = L.place_leaves(qsm, opts)
    for p in placements:
        tip = p.basis[:, 0]
        assert abs(float(np.dot(tip, [0, 0, 1]))) < 1e-6  # tip ⟂ vertical tangent


def test_base_offset_clears_shoot_surface():
    qsm = _straight_shoot_qsm(radius=0.03)
    opts = L.LeafPlacementOptions(leaf_spacing=0.25, leaf_pitch_deg=45,
                                  leaf_size_m=0.08, leaves_per_node=1,
                                  clearance_frac=0.5)
    placements = L.place_leaves(qsm, opts)
    # Vertical shoot on the z-axis: each leaf base is offset radially by
    # radius * (1 + clearance_frac) so the blade clears the tube. Its horizontal
    # distance from the axis must EXCEED the radius (not sit on the surface).
    for p in placements:
        horiz = float(np.linalg.norm(p.position[:2]))
        assert np.isclose(horiz, 0.03 * 1.5, atol=1e-6)
        assert horiz > 0.03  # strictly outside the branch surface


def test_zero_clearance_sits_on_surface():
    qsm = _straight_shoot_qsm(radius=0.03)
    opts = L.LeafPlacementOptions(leaf_spacing=0.25, leaf_size_m=0.08,
                                  leaves_per_node=1, clearance_frac=0.0)
    placements = L.place_leaves(qsm, opts)
    for p in placements:
        assert np.isclose(float(np.linalg.norm(p.position[:2])), 0.03, atol=1e-6)


# ---------------------------------------------------------------------------
# Quad geometry
# ---------------------------------------------------------------------------
def test_quad_vertex_and_triangle_counts():
    qsm = _straight_shoot_qsm(length=1.0, n_seg=2)
    opts = L.LeafPlacementOptions(leaf_spacing=0.1, leaf_size_m=0.08, leaves_per_node=1)
    placements = L.place_leaves(qsm, opts)
    geo = L.build_leaf_quad_geometry(placements, "AlmondLeaf.png", "ZZ==", True)
    n = len(placements)
    assert len(geo["vertices"]) == n * 6   # 2 triangles * 3 verts per leaf
    assert len(geo["indices"]) == n * 2
    assert len(geo["uv_coordinates"]) == n * 6
    assert geo["materials"][0]["has_alpha"] is True
    assert geo["textures"] == {"AlmondLeaf.png": "ZZ=="}
    assert geo["leaf_count"] == n


def test_leaves_per_node_multiplies():
    qsm = _straight_shoot_qsm(length=1.0, n_seg=2)
    one = L.place_leaves(qsm, L.LeafPlacementOptions(leaf_spacing=0.1, leaves_per_node=1))
    two = L.place_leaves(qsm, L.LeafPlacementOptions(leaf_spacing=0.1, leaves_per_node=2))
    assert len(two) == 2 * len(one)


def test_max_leaves_cap():
    qsm = _straight_shoot_qsm(length=1.0, n_seg=2)
    opts = L.LeafPlacementOptions(leaf_spacing=0.01, leaves_per_node=1, max_leaves=5)
    placements = L.place_leaves(qsm, opts)
    assert len(placements) == 5


# ---------------------------------------------------------------------------
# Phyllotaxis detection
# ---------------------------------------------------------------------------
def test_phyllotaxis_spiral():
    qsm = _star_qsm([0, 137.5, 275, 52.5, 190])
    d = L.detect_phyllotaxis(qsm)
    assert d["pattern"] == "spiral"
    assert d["leaves_per_node"] == 1
    assert d["angle_deg"] == 137.5


def test_phyllotaxis_opposite():
    qsm = _star_qsm([0, 180])
    d = L.detect_phyllotaxis(qsm)
    assert d["angle_deg"] == 180.0
    assert d["pattern"] == "opposite"
    assert d["leaves_per_node"] == 2
    assert d["confidence"] > 0.9


def test_phyllotaxis_decussate():
    qsm = _star_qsm([0, 90, 180, 270])
    d = L.detect_phyllotaxis(qsm)
    assert d["angle_deg"] == 90.0
    assert d["pattern"] == "decussate"
    assert d["leaves_per_node"] == 2


def test_phyllotaxis_missing_bud_still_spiral():
    """An unbroken bud removes a lattice point but must not change the angle."""
    qsm = _star_qsm([0, 137.5, 52.5])  # 275 deg position absent (skipped bud)
    d = L.detect_phyllotaxis(qsm)
    assert d["pattern"] == "spiral"
    assert d["angle_deg"] == 137.5


def test_phyllotaxis_no_signal_defaults():
    """A QSM with no multi-child parent yields the spiral default at confidence 0."""
    qsm = _straight_shoot_qsm()
    d = L.detect_phyllotaxis(qsm)
    assert d["angle_deg"] == 137.5
    assert d["pattern"] == "spiral"
    assert d["confidence"] == 0.0
    assert d["n_parents_sampled"] == 0


# ---------------------------------------------------------------------------
# Builtin texture resolution
# ---------------------------------------------------------------------------
def test_builtin_texture_resolves():
    name, b64, aspect = L.resolve_builtin_texture("AlmondLeaf.png")
    assert name == "AlmondLeaf.png"
    assert len(b64) > 100              # non-empty base64
    assert 0.05 < aspect <= 1.0        # leaf width/length ratio (<=1: long axis is length)


def test_builtin_texture_rejects_non_curated():
    with pytest.raises(ValueError):
        L.resolve_builtin_texture("SoybeanLeaf.png")


def test_builtin_texture_rejects_traversal():
    with pytest.raises(ValueError):
        L.resolve_builtin_texture("../../../etc/passwd")
