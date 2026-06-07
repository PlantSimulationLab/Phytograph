"""Core QSM data structures.

A reconstructed QSM and the ground-truth model share the same shape: a list of
``Cylinder`` records (axis endpoints + radius + parent + shoot membership +
shoot rank) grouped into ``Shoot`` axes. Using one set of types for both means
the validation harness compares like with like.

These are plain dataclasses (no pydantic / FastAPI) so they are trivially
unit-testable and reusable from both the reconstruction code and the test
harness. The FastAPI response models in ``main.py`` are built from these.

Conventions
-----------
- All coordinates and lengths are in **meters**.
- ``rank`` is the topological branching order with axis continuation: the trunk
  shoot is rank 0; at a fork the continuation child keeps the parent's rank and
  every other child is one rank higher. This matches Helios ``Shoot.rank`` and
  TreeQSM ``BranchOrder`` (see findings.md Phase 6), and is the semantics the
  user calls "shoot rank".
- IDs are non-negative ints. A "no parent" link is encoded as ``-1`` (the root
  trunk cylinder's ``parent_id`` and the trunk shoot's ``parent_shoot_id``).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Sentinel for "no parent" (root cylinder / trunk shoot). Matches the convention
# used by the Helios ground-truth exporter (parent_shoot_id = -1 for the trunk).
NO_PARENT = -1


@dataclass
class Cylinder:
    """A single fitted cylinder segment of the tree's woody structure.

    The cylinder is the straight frustum/cylinder between ``start`` and ``end``
    with constant ``radius``. (Taper is represented by consecutive cylinders of
    differing radius along a shoot, not by a per-cylinder taper term -- matching
    TreeQSM/AdTree.)
    """

    cyl_id: int
    start: np.ndarray  # (3,) float64, meters
    end: np.ndarray  # (3,) float64, meters
    radius: float  # meters
    parent_id: int = NO_PARENT  # cyl_id of the parent cylinder, or NO_PARENT
    shoot_id: int = NO_PARENT  # id of the shoot this cylinder belongs to
    rank: int = 0  # topological shoot rank (trunk = 0)
    # Per-fit quality, populated by the cylinder-fitting stage. None until then.
    surf_cov: float | None = None  # surface coverage in [0, 1]; low => one-sided
    mad: float | None = None  # mean absolute point-to-surface distance, meters

    def __post_init__(self) -> None:
        self.start = np.asarray(self.start, dtype=np.float64).reshape(3)
        self.end = np.asarray(self.end, dtype=np.float64).reshape(3)
        self.radius = float(self.radius)

    @property
    def axis(self) -> np.ndarray:
        """Unit axis direction start->end. Zero vector if degenerate."""
        v = self.end - self.start
        n = float(np.linalg.norm(v))
        return v / n if n > 0 else v

    @property
    def length(self) -> float:
        """Axial length of the cylinder, meters."""
        return float(np.linalg.norm(self.end - self.start))

    @property
    def volume(self) -> float:
        """Cylinder volume pi * r^2 * L, cubic meters."""
        return float(np.pi * self.radius * self.radius * self.length)

    @property
    def midpoint(self) -> np.ndarray:
        return 0.5 * (self.start + self.end)


@dataclass
class Shoot:
    """A continuous botanical axis: a maximal chain of continuation-linked
    cylinders. Trunk = rank 0; scaffolds = rank 1; etc.
    """

    shoot_id: int
    rank: int
    cylinder_ids: list[int] = field(default_factory=list)  # ordered base->tip
    parent_shoot_id: int = NO_PARENT
    # Index of the parent shoot's cylinder where this shoot attaches (fork point).
    parent_cyl_id: int = NO_PARENT
    child_shoot_ids: list[int] = field(default_factory=list)


@dataclass
class QSM:
    """A complete quantitative structure model: cylinders + shoots + metadata.

    ``cylinders`` and ``shoots`` are the two views of the same tree. Helper
    accessors index by id. Both reconstructed models and parsed ground-truth
    models are represented as a ``QSM`` so the harness compares like with like.
    """

    cylinders: list[Cylinder] = field(default_factory=list)
    shoots: list[Shoot] = field(default_factory=list)
    units: str = "meters"
    # Free-form provenance / processing stats (seed, params, stage timings...).
    meta: dict = field(default_factory=dict)

    def cylinder_by_id(self) -> dict[int, Cylinder]:
        return {c.cyl_id: c for c in self.cylinders}

    def shoot_by_id(self) -> dict[int, Shoot]:
        return {s.shoot_id: s for s in self.shoots}

    @property
    def total_length(self) -> float:
        return float(sum(c.length for c in self.cylinders))

    @property
    def total_volume(self) -> float:
        return float(sum(c.volume for c in self.cylinders))

    def max_rank(self) -> int:
        return max((c.rank for c in self.cylinders), default=0)

    def shoots_of_rank(self, rank: int) -> list[Shoot]:
        return [s for s in self.shoots if s.rank == rank]

    def root_cylinders(self) -> list[Cylinder]:
        """Cylinders with no parent (normally exactly one: the trunk base)."""
        return [c for c in self.cylinders if c.parent_id == NO_PARENT]
