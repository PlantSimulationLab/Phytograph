"""Layer-2 fixture loader: the PyHelios-generated ground-truth cases.

Each case in ``example-datasets/`` is a tree simulated by the Helios C++ generator
(qsm_handoff_helios_cpp.md) at a known plant age, exported as:

  - ``<case>_topology.json`` -- the ground-truth QSM (cylinders + shoots + per-
    cylinder rank), parsed by ``gt_io.parse_ground_truth``.
  - ``<case>_cloud_<0..3>.xyz`` -- 4 simulated TLS scans from 4 scanner positions
    ~90 deg apart. Each scan already covers the whole tree; merging the four gives
    the most complete (least-occluded) cloud, which is what a real 4-position
    survey produces after registration.

``.xyz`` columns (7): x y z deviation range scanner_id rank. We use only x y z for
reconstruction (a real scan has no rank channel); the rank column is the same
ground truth as the JSON (verified 98-99% concordant) and is NOT read here -- the
authoritative rank for validation comes from the JSON via ``gt_io``.

The cases span complexity tiers AND two trunk architectures:
  - ``simple``      -- short determinate trunk + 3 scaffolds (whorl); sub-branches.
  - ``tricky_fork`` -- adversarial fork geometry (a straight decoy lateral).
  - ``moderate``    -- a fuller determinate-trunk tree (rank up to 3, ~65 shoots).
  - ``central_leader``         -- a MONOPODIAL trunk that CONTINUES as one rank-0
    axis through its lateral junctions (eastern redbud). The complement of the
    whorl cases: here our largest-GrowthLength continuation should follow the
    leader and give high trunk precision -- the generalization test.
  - ``central_leader_branched`` -- central leader with rank-2 sub-branching too.

These files are large and gitignored (see example-datasets/README -- which covers a
DIFFERENT, TreeIso, dataset; the QSM fixtures are the simple/tricky_fork/moderate
sets). ``available_cases()`` reports which are present so tests skip cleanly when a
fixture hasn't been downloaded.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..model import QSM
from .gt_io import parse_ground_truth

# Repo-root-relative location of the fixtures. This file is
# backend-api/qsm/validation/datasets.py -> repo root is parents[3].
DATASET_DIR = Path(__file__).resolve().parents[3] / "example-datasets"

CASES = (
    "simple",
    "tricky_fork",
    "moderate",
    "central_leader",
    "central_leader_branched",
)
# Cases whose trunk is a MONOPODIAL central leader (rank-0 continues through its
# junctions) rather than a determinate whorl. On these the continuation rule
# should achieve HIGH trunk precision -- the generalization test.
CENTRAL_LEADER_CASES = ("central_leader", "central_leader_branched")
N_SCANS = 4


@dataclass
class Layer2Case:
    name: str
    cloud: np.ndarray  # (N, 3) merged xyz from all scans, meters
    gt: QSM  # parsed ground-truth QSM
    scans: list[np.ndarray]  # per-scan (Ni, 3) clouds (for single-scan/occlusion tests)
    n_scans: int


def case_paths(name: str, dataset_dir: Path | None = None) -> tuple[Path, list[Path]]:
    """Return (topology_json, [scan_xyz, ...]) paths for a case (existence not
    checked)."""
    d = dataset_dir or DATASET_DIR
    topo = d / f"{name}_topology.json"
    scans = [d / f"{name}_cloud_{i}.xyz" for i in range(N_SCANS)]
    return topo, scans


def case_available(name: str, dataset_dir: Path | None = None) -> bool:
    """True iff the topology JSON and at least one scan file exist."""
    topo, scans = case_paths(name, dataset_dir)
    return topo.exists() and any(s.exists() for s in scans)


def available_cases(dataset_dir: Path | None = None) -> list[str]:
    return [c for c in CASES if case_available(c, dataset_dir)]


def _load_scan(path: Path) -> np.ndarray:
    """Load one .xyz scan, returning only the (N, 3) xyz columns."""
    arr = np.loadtxt(path)
    if arr.ndim == 1:  # single row
        arr = arr[None, :]
    if arr.shape[1] < 3:
        raise ValueError(f"{path}: expected >=3 columns, got {arr.shape[1]}")
    return np.ascontiguousarray(arr[:, :3], dtype=np.float64)


def load_case(
    name: str,
    dataset_dir: Path | None = None,
    max_scans: int | None = None,
) -> Layer2Case:
    """Load a Layer-2 case: merge the scans into one cloud and parse the GT.

    ``max_scans`` limits how many of the 4 scans are merged (1 = a single-view,
    heavily-occluded cloud, useful for the radius-bias-under-occlusion test; None =
    all available, the least-occluded cloud). Missing scan files are skipped.
    """
    if name not in CASES:
        raise ValueError(f"unknown case {name!r}; known: {CASES}")
    topo, scan_paths = case_paths(name, dataset_dir)
    if not topo.exists():
        raise FileNotFoundError(f"missing ground-truth topology: {topo}")

    present = [p for p in scan_paths if p.exists()]
    if not present:
        raise FileNotFoundError(f"no scan files for case {name!r} in {topo.parent}")
    if max_scans is not None:
        present = present[:max_scans]

    scans = [_load_scan(p) for p in present]
    cloud = np.concatenate(scans, axis=0) if len(scans) > 1 else scans[0]
    gt = parse_ground_truth(topo)
    return Layer2Case(
        name=name, cloud=cloud, gt=gt, scans=scans, n_scans=len(scans)
    )
