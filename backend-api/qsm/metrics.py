"""Horticultural output metrics computed from a finished QSM.

These are the user-facing numbers an orchardist / phenotyping researcher reads off
a reconstructed tree (findings.md "Horticultural output metrics"): trunk vigor,
scaffold structure, branch diameter and crotch angle BY RANK, shoot lengths, and
woody volume split stem-vs-branch. They are pure functions of a ``QSM`` -- no point
cloud, no ground truth -- so they apply identically to a reconstruction and to a
ground-truth model, and feed the ``/api/qsm/build`` response.

This is distinct from ``qsm.validation.metrics``: that module COMPARES two QSMs
(recon vs GT) to validate the pipeline; this module DESCRIBES one QSM for the user.

All lengths/areas/volumes in SI (m, m^2, m^3); angles in degrees; diameters are
reported in both meters and millimeters (orchardists quote branch diameter in mm).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .model import QSM, NO_PARENT


@dataclass
class RankMetrics:
    """Per-rank aggregates (rank 0 = trunk, 1 = scaffolds, ...)."""

    rank: int
    n_shoots: int  # number of distinct shoots at this rank
    total_length_m: float  # summed axis length of all shoots at this rank
    mean_shoot_length_m: float
    woody_volume_m3: float  # summed cylinder volume at this rank
    mean_diameter_mm: float  # length-weighted mean cylinder diameter
    mean_branch_angle_deg: float | None  # crotch angle vs parent shoot (None for trunk)


@dataclass
class QSMMetrics:
    """Whole-tree horticultural summary."""

    # Trunk vigor.
    tcsa_m2: float  # trunk cross-sectional area at the base (vigor normalizer)
    trunk_diameter_mm: float  # diameter at the trunk base
    tree_height_m: float  # vertical extent (max z - min z of all cylinders)

    # Structure counts.
    n_scaffolds: int  # rank-1 shoots (primary scaffolds)
    n_shoots_total: int
    max_rank: int

    # Woody volume + length.
    total_woody_volume_m3: float
    stem_volume_m3: float  # rank 0
    branch_volume_m3: float  # rank >= 1
    total_length_m: float

    # Canopy extent.
    canopy_width_m: float  # max horizontal (xy) extent
    canopy_height_m: float  # vertical extent of rank>=1 wood (crown)

    per_rank: list[RankMetrics] = field(default_factory=list)


# ---------------------------------------------------------------------------


def _length_weighted_mean_diameter(cyls) -> float:
    """Length-weighted mean diameter (m) over a set of cylinders. Weighting by
    length (not count) so a long thick cylinder counts more than a short one."""
    num = sum(2.0 * c.radius * c.length for c in cyls)
    den = sum(c.length for c in cyls)
    return float(num / den) if den > 0 else 0.0


def _shoot_length(qsm: QSM, shoot, by_id) -> float:
    return float(sum(by_id[c].length for c in shoot.cylinder_ids if c in by_id))


def _crotch_angle_deg(qsm: QSM, shoot, by_id) -> float | None:
    """Angle (deg) between a shoot's initial axis and its parent cylinder's axis
    at the fork. None for the trunk / a shoot with no usable parent."""
    if shoot.parent_shoot_id == NO_PARENT or not shoot.cylinder_ids:
        return None
    child0 = by_id.get(shoot.cylinder_ids[0])
    if child0 is None or child0.length == 0:
        return None
    parent = by_id.get(child0.parent_id)
    if parent is None or parent.length == 0:
        return None
    cosang = float(np.clip(np.dot(child0.axis, parent.axis), -1.0, 1.0))
    return float(np.degrees(np.arccos(cosang)))


def _trunk_base_cylinder(qsm: QSM):
    """The trunk base cylinder: the rank-0 cylinder with no parent (lowest start),
    or, failing that, the lowest cylinder overall. Returns None for an empty QSM."""
    if not qsm.cylinders:
        return None
    roots = [c for c in qsm.cylinders if c.parent_id == NO_PARENT]
    pool = roots or qsm.cylinders
    # Lowest base (min z of start) -- the true ground-end of the trunk.
    return min(pool, key=lambda c: min(c.start[2], c.end[2]))


def compute_metrics(qsm: QSM) -> QSMMetrics:
    """Compute the whole-tree horticultural summary for a finished QSM."""
    if not qsm.cylinders:
        return QSMMetrics(
            tcsa_m2=0.0, trunk_diameter_mm=0.0, tree_height_m=0.0,
            n_scaffolds=0, n_shoots_total=0, max_rank=0,
            total_woody_volume_m3=0.0, stem_volume_m3=0.0, branch_volume_m3=0.0,
            total_length_m=0.0, canopy_width_m=0.0, canopy_height_m=0.0,
            per_rank=[],
        )

    by_id = qsm.cylinder_by_id()
    cyls = qsm.cylinders

    # Trunk vigor: TCSA + diameter from the base cylinder.
    base = _trunk_base_cylinder(qsm)
    tcsa = float(np.pi * base.radius * base.radius) if base else 0.0
    trunk_dia_mm = float(2.0 * base.radius * 1000.0) if base else 0.0

    # Bounding extents.
    all_pts = np.vstack([np.vstack([c.start, c.end]) for c in cyls])
    zmin, zmax = float(all_pts[:, 2].min()), float(all_pts[:, 2].max())
    tree_height = zmax - zmin
    xy = all_pts[:, :2]
    canopy_width = float(
        np.linalg.norm(xy.max(axis=0) - xy.min(axis=0))
    )  # diagonal of the xy bbox
    crown_pts = np.vstack(
        [np.vstack([c.start, c.end]) for c in cyls if c.rank >= 1]
    ) if any(c.rank >= 1 for c in cyls) else None
    canopy_height = (
        float(crown_pts[:, 2].max() - crown_pts[:, 2].min())
        if crown_pts is not None else 0.0
    )

    # Volumes.
    stem_vol = float(sum(c.volume for c in cyls if c.rank == 0))
    branch_vol = float(sum(c.volume for c in cyls if c.rank >= 1))
    total_vol = stem_vol + branch_vol
    total_len = float(sum(c.length for c in cyls))

    # Per-rank aggregates.
    ranks = sorted({c.rank for c in cyls})
    cyls_by_rank: dict[int, list] = {r: [] for r in ranks}
    for c in cyls:
        cyls_by_rank[c.rank].append(c)
    shoots_by_rank: dict[int, list] = {r: [] for r in ranks}
    for s in qsm.shoots:
        shoots_by_rank.setdefault(s.rank, []).append(s)

    per_rank: list[RankMetrics] = []
    for r in ranks:
        rcyls = cyls_by_rank[r]
        rshoots = shoots_by_rank.get(r, [])
        shoot_lengths = [_shoot_length(qsm, s, by_id) for s in rshoots]
        angles = [
            a for s in rshoots
            if (a := _crotch_angle_deg(qsm, s, by_id)) is not None
        ]
        per_rank.append(
            RankMetrics(
                rank=r,
                n_shoots=len(rshoots),
                total_length_m=float(sum(c.length for c in rcyls)),
                mean_shoot_length_m=float(np.mean(shoot_lengths)) if shoot_lengths else 0.0,
                woody_volume_m3=float(sum(c.volume for c in rcyls)),
                mean_diameter_mm=_length_weighted_mean_diameter(rcyls) * 1000.0,
                mean_branch_angle_deg=float(np.mean(angles)) if angles else None,
            )
        )

    return QSMMetrics(
        tcsa_m2=tcsa,
        trunk_diameter_mm=trunk_dia_mm,
        tree_height_m=tree_height,
        n_scaffolds=len(shoots_by_rank.get(1, [])),
        n_shoots_total=len(qsm.shoots),
        max_rank=max(ranks) if ranks else 0,
        total_woody_volume_m3=total_vol,
        stem_volume_m3=stem_vol,
        branch_volume_m3=branch_vol,
        total_length_m=total_len,
        canopy_width_m=canopy_width,
        canopy_height_m=canopy_height,
        per_rank=per_rank,
    )
