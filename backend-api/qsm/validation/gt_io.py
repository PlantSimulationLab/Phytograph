"""Parse the PyHelios ground-truth topology JSON into a ``QSM``.

Schema (from ``qsm_handoff_helios_cpp.md``)::

    {
      "units": "meters",
      "seed": 12345,
      "plant_age": 90,
      "scanner_positions": [[x,y,z], ...],
      "shoots": [
        {"shoot_id", "rank", "parent_shoot_id", "parent_node_index",
         "base_position":[x,y,z], "child_shoot_ids":[...], "length"} ...
      ],
      "cylinders": [
        {"cyl_id", "shoot_id", "rank", "phytomer_index", "segment_index",
         "parent_cyl_id", "start":[x,y,z], "end":[x,y,z], "radius"} ...
      ]
    }

The handoff doc notes ``parent_cyl_id`` may be omitted (the C++ side may give us
only shoot_id/parent_shoot_id/parent_node + ordered cylinders). We derive
``parent_cyl_id`` when missing.

Invariants are checked on load so a malformed fixture fails loudly rather than
silently corrupting metrics: exactly one rank-0 shoot, units == meters, acyclic
parent links.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from ..model import NO_PARENT, QSM, Cylinder, Shoot


class GroundTruthError(ValueError):
    """Raised when a ground-truth file violates an expected invariant."""


def _point_segment_distance(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
    """Distance from point ``p`` to the finite segment a->b."""
    ab = b - a
    L2 = float(ab @ ab)
    if L2 == 0:
        return float(np.linalg.norm(p - a))
    t = float(np.clip((p - a) @ ab / L2, 0.0, 1.0))
    return float(np.linalg.norm(p - (a + t * ab)))


def _as_xyz(v, what: str) -> np.ndarray:
    arr = np.asarray(v, dtype=np.float64).reshape(-1)
    if arr.shape[0] != 3:
        raise GroundTruthError(f"{what} must be [x, y, z], got {v!r}")
    return arr


def parse_ground_truth(path: str | Path) -> QSM:
    """Load and validate a ground-truth topology JSON into a ``QSM``."""
    path = Path(path)
    with path.open() as fh:
        data = json.load(fh)
    return ground_truth_from_dict(data, source=str(path))


def ground_truth_from_dict(data: dict, source: str = "<dict>") -> QSM:
    units = data.get("units", "meters")
    if units != "meters":
        raise GroundTruthError(
            f"{source}: units must be 'meters' (point cloud is meters), got {units!r}"
        )

    raw_shoots = data.get("shoots", [])
    raw_cyls = data.get("cylinders", [])
    if not raw_cyls:
        raise GroundTruthError(f"{source}: no cylinders in ground truth")

    shoots: list[Shoot] = []
    for s in raw_shoots:
        shoots.append(
            Shoot(
                shoot_id=int(s["shoot_id"]),
                rank=int(s["rank"]),
                cylinder_ids=[],  # filled below from cylinder ordering
                parent_shoot_id=int(s.get("parent_shoot_id", NO_PARENT)),
                parent_cyl_id=int(s.get("parent_cyl_id", NO_PARENT)),
                child_shoot_ids=[int(c) for c in s.get("child_shoot_ids", [])],
            )
        )

    cylinders: list[Cylinder] = []
    for c in raw_cyls:
        cylinders.append(
            Cylinder(
                cyl_id=int(c["cyl_id"]),
                start=_as_xyz(c["start"], "cylinder.start"),
                end=_as_xyz(c["end"], "cylinder.end"),
                radius=float(c["radius"]),
                parent_id=int(c.get("parent_cyl_id", NO_PARENT)),
                shoot_id=int(c.get("shoot_id", NO_PARENT)),
                rank=int(c.get("rank", 0)),
            )
        )

    # Deterministic ordering: by shoot, then phytomer, then segment when present,
    # else by cyl_id. Keep the original index so we can recover (phytomer, seg).
    def sort_key(item):
        idx, raw = item
        return (
            int(raw.get("shoot_id", 0)),
            int(raw.get("phytomer_index", 0)),
            int(raw.get("segment_index", 0)),
            int(raw["cyl_id"]),
        )

    order = [i for i, _ in sorted(enumerate(raw_cyls), key=sort_key)]
    cylinders = [cylinders[i] for i in order]

    qsm = QSM(cylinders=cylinders, shoots=shoots, units="meters", meta={
        "source": source,
        "seed": data.get("seed"),
        "plant_age": data.get("plant_age"),
        "scanner_positions": data.get("scanner_positions"),
    })

    _populate_shoot_cylinder_lists(qsm)
    _derive_missing_parents(qsm)
    _validate(qsm, source)
    return qsm


def _populate_shoot_cylinder_lists(qsm: QSM) -> None:
    """Fill each Shoot.cylinder_ids with its cylinders in base->tip order
    (cylinders are already globally sorted by shoot/phytomer/segment)."""
    by_shoot: dict[int, list[int]] = {}
    for c in qsm.cylinders:
        by_shoot.setdefault(c.shoot_id, []).append(c.cyl_id)
    for s in qsm.shoots:
        s.cylinder_ids = by_shoot.get(s.shoot_id, [])


def _derive_missing_parents(qsm: QSM) -> None:
    """When ``parent_cyl_id`` is absent (== NO_PARENT) derive it: within a shoot,
    the previous ordered cylinder is the parent; the shoot's first cylinder's
    parent is the parent shoot's cylinder nearest the child's base."""
    by_id = qsm.cylinder_by_id()
    shoot_by_id = qsm.shoot_by_id()

    for s in qsm.shoots:
        prev = NO_PARENT
        for cid in s.cylinder_ids:
            c = by_id[cid]
            if c.parent_id == NO_PARENT and prev != NO_PARENT:
                c.parent_id = prev
            prev = cid

    # First cylinder of each non-trunk shoot: attach to nearest parent-shoot cylinder.
    for s in qsm.shoots:
        if not s.cylinder_ids:
            continue
        first = by_id[s.cylinder_ids[0]]
        if first.parent_id != NO_PARENT:
            continue
        if s.parent_shoot_id == NO_PARENT or s.parent_shoot_id not in shoot_by_id:
            continue  # trunk: leave NO_PARENT
        parent_shoot = shoot_by_id[s.parent_shoot_id]
        parent_cyls = [by_id[c] for c in parent_shoot.cylinder_ids if c in by_id]
        if not parent_cyls:
            continue
        base = first.start
        # Attach to the parent cylinder whose AXIS SEGMENT (not midpoint) passes
        # closest to the child's base. Midpoint distance picks the wrong cylinder
        # on a long parent -- the true fork can be near a cylinder's end, far from
        # its midpoint -- yielding a wrong fork location / branch angle.
        nearest = min(
            parent_cyls,
            key=lambda pc: (
                float(_point_segment_distance(base, pc.start, pc.end)), pc.cyl_id
            ),
        )
        first.parent_id = nearest.cyl_id


def _validate(qsm: QSM, source: str) -> None:
    # Exactly one rank-0 shoot (the trunk).
    if qsm.shoots:
        rank0 = [s for s in qsm.shoots if s.rank == 0]
        if len(rank0) != 1:
            raise GroundTruthError(
                f"{source}: expected exactly one rank-0 (trunk) shoot, found {len(rank0)}"
            )

    # Acyclic parent_id chains.
    by_id = qsm.cylinder_by_id()
    for c in qsm.cylinders:
        seen = set()
        cur = c.cyl_id
        while cur != NO_PARENT and cur in by_id:
            if cur in seen:
                raise GroundTruthError(f"{source}: cycle in cylinder parent chain at {cur}")
            seen.add(cur)
            cur = by_id[cur].parent_id

    # Positive radii.
    bad = [c.cyl_id for c in qsm.cylinders if not (c.radius > 0)]
    if bad:
        raise GroundTruthError(f"{source}: non-positive radius on cylinders {bad[:5]}...")

    # Rank consistency: each cylinder's rank must match its shoot's rank, and each
    # child shoot's rank must be exactly parent_shoot.rank + 1 (the continuation/+1
    # invariant). A malformed GT with inconsistent ranks would silently skew the
    # rank-confusion metric (the headline number), so fail loudly here.
    shoot_by_id = qsm.shoot_by_id()
    for c in qsm.cylinders:
        if c.shoot_id in shoot_by_id and c.rank != shoot_by_id[c.shoot_id].rank:
            raise GroundTruthError(
                f"{source}: cylinder {c.cyl_id} rank {c.rank} != its shoot "
                f"{c.shoot_id} rank {shoot_by_id[c.shoot_id].rank}"
            )
    for s in qsm.shoots:
        if s.parent_shoot_id in shoot_by_id:
            pr = shoot_by_id[s.parent_shoot_id].rank
            if s.rank != pr + 1:
                raise GroundTruthError(
                    f"{source}: shoot {s.shoot_id} rank {s.rank} != parent shoot "
                    f"{s.parent_shoot_id} rank {pr} + 1"
                )
