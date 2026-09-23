"""Readers for labelled point clouds, each returning a :class:`Cloud`.

Label conventions disagree between the public datasets, and silently training
on inverted labels is the easiest mistake to make here. Each reader therefore
owns its source's convention and translates it to the unified :data:`SEM` code
once:

- LeWoS ASCII ``x y z label``: 1 = wood, 0 = leaf.
- Weiser LAS ``classification``: 0 = wood, 1 = leaf, the opposite of LeWoS.
- BCI / GBSeparation: one file per class (``*_wood*`` / ``*_leaf*``).
- Wan plots: the polarity differs between the three files. The minority
  class is wood in all of them (the SyntheticLiDAR_Organs data README
  verifies this geometrically), so the rule is applied per file.
- Helios synthetic ``.xyz``: a ``#`` header names 14 columns; ``class_id`` is
  0 leaf, 1 wood, 2 fruit, 3 ground and ``organ_id`` is kept as-is. Readers
  that treat ``.xyz`` as bare 3-column files discard every label silently,
  which is why this one reads the header.
- Phytograph's own label columns (``wood_class`` 1 = wood, 2 = leaf), as in
  ``tests/fixtures/leafwood``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

# Unified semantic codes. UNKNOWN is never trained on.
SEM = {"leaf": 0, "wood": 1, "fruit": 2, "ground": 3, "unknown": 255}
SEM_LEAF, SEM_WOOD, SEM_FRUIT, SEM_GROUND, SEM_UNKNOWN = 0, 1, 2, 3, 255


@dataclass
class Cloud:
    xyz: np.ndarray                       # (N, 3) float64
    sem: np.ndarray                       # (N,) uint8, SEM codes
    organ: np.ndarray | None = None       # (N,) uint8, source organ id (255 = none)
    reflectance: np.ndarray | None = None  # (N,) float32, source units
    meta: dict = field(default_factory=dict)

    def __post_init__(self):
        n = len(self.xyz)
        for name in ("sem", "organ", "reflectance"):
            a = getattr(self, name)
            if a is not None and len(a) != n:
                raise ValueError(f"{name} has {len(a)} rows, xyz has {n}")

    def __len__(self):
        return len(self.xyz)


def _sniff_sep(path: Path) -> str:
    """',' or whitespace, from the first data line. Most of BCI is
    space-separated, but 46 of its trees are CSV."""
    with open(path, "r") as f:
        for line in f:
            if line.strip() and not line.startswith("#"):
                return "," if "," in line else r"\s+"
    return r"\s+"


def _read_table(path: Path, usecols=None, header_names=None) -> pd.DataFrame:
    """Delimited ASCII via pandas' C parser (np.loadtxt is ~20x slower on the
    multi-GB Wan plots). ``#`` lines are comments."""
    return pd.read_csv(path, sep=_sniff_sep(path), comment="#", header=None, usecols=usecols,
                       names=header_names, engine="c", dtype=np.float64)


def _header_columns(path: Path) -> list[str] | None:
    with open(path, "r") as f:
        first = f.readline()
    if first.startswith("#"):
        return first.lstrip("#").split()
    return None


def read_helios_synthetic(path: str | Path) -> Cloud:
    """A SyntheticLiDAR_Organs scene: 14 named columns. Requires the header,
    because the column order is only defined there."""
    path = Path(path)
    cols = _header_columns(path)
    if not cols or "class_id" not in cols:
        raise ValueError(f"{path}: no '# x y z ... class_id' header; not a labelled Helios scene")
    want = ["x", "y", "z", "class_id"] + [c for c in ("organ_id", "reflectance") if c in cols]
    df = pd.read_csv(path, sep=r"\s+", comment="#", header=None, names=cols,
                     usecols=want, engine="c")
    cls = df["class_id"].to_numpy()
    sem = np.full(len(df), SEM_UNKNOWN, np.uint8)
    for src, dst in ((0, SEM_LEAF), (1, SEM_WOOD), (2, SEM_FRUIT), (3, SEM_GROUND)):
        sem[cls == src] = dst
    organ = None
    if "organ_id" in df:
        o = df["organ_id"].to_numpy()
        organ = np.where((o >= 0) & (o < 255), o, 255).astype(np.uint8)
    refl = df["reflectance"].to_numpy(np.float32) if "reflectance" in df else None
    return Cloud(df[["x", "y", "z"]].to_numpy(np.float64), sem, organ, refl,
                 {"reader": "helios_synthetic"})


def read_lewos(path: str | Path) -> Cloud:
    df = _read_table(Path(path), usecols=[0, 1, 2, 3])
    lab = df[3].to_numpy()
    sem = np.where(lab == 1, SEM_WOOD, np.where(lab == 0, SEM_LEAF, SEM_UNKNOWN)).astype(np.uint8)
    return Cloud(df[[0, 1, 2]].to_numpy(), sem, meta={"reader": "lewos"})


def read_weiser(path: str | Path) -> Cloud:
    import laspy

    las = laspy.read(str(path))
    xyz = np.column_stack([las.x, las.y, las.z]).astype(np.float64)
    c = np.asarray(las.classification)
    sem = np.where(c == 0, SEM_WOOD, np.where(c == 1, SEM_LEAF, SEM_UNKNOWN)).astype(np.uint8)
    refl = None
    names = set(las.point_format.dimension_names)
    for cand in ("Reflectance", "reflectance"):
        if cand in names:
            refl = np.asarray(las[cand], dtype=np.float32)
            break
    return Cloud(xyz, sem, reflectance=refl, meta={"reader": "weiser"})


def read_pcd_xyz(path: str | Path) -> np.ndarray:
    """x y z from a PCD (GBSeparation) or PLY (one BCI tree), via open3d."""
    import open3d as o3d

    pc = o3d.io.read_point_cloud(str(path))
    return np.asarray(pc.points, dtype=np.float64)


def read_pair(wood_path: str | Path, leaf_path: str | Path) -> Cloud:
    """One tree stored as a wood file and a leaf file (BCI, GBSeparation)."""
    def load(p):
        p = Path(p)
        if p.stat().st_size == 0:
            # Five BCI trees ship an empty leaf file: they are all wood.
            return np.empty((0, 3), np.float64)
        if p.suffix.lower() in (".pcd", ".ply"):
            return read_pcd_xyz(p)
        return _read_table(p, usecols=[0, 1, 2]).to_numpy()
    w, l = load(wood_path), load(leaf_path)
    xyz = np.concatenate([w, l])
    sem = np.concatenate([np.full(len(w), SEM_WOOD, np.uint8), np.full(len(l), SEM_LEAF, np.uint8)])
    return Cloud(xyz, sem, meta={"reader": "pair"})


def read_wan(path: str | Path) -> Cloud:
    """A Wan et al. plot. Column 7 is binary with per-file polarity; the
    minority class is wood. Ground and understory are labelled leaf in these
    files, which is why they are evaluation-only in the benchmark."""
    df = _read_table(Path(path), usecols=[0, 1, 2, 6])
    lab = df[6].to_numpy()
    vals, counts = np.unique(lab, return_counts=True)
    if len(vals) != 2:
        raise ValueError(f"{path}: expected a binary label column, found values {vals[:10]}")
    wood_val = vals[np.argmin(counts)]
    sem = np.where(lab == wood_val, SEM_WOOD, SEM_LEAF).astype(np.uint8)
    return Cloud(df[[0, 1, 2]].to_numpy(), sem,
                 meta={"reader": "wan", "wood_value": float(wood_val)})


def read_phytograph_xyz(path: str | Path) -> Cloud:
    """x y z wood_class (1 = wood, 2 = leaf), the test-fixture layout."""
    df = _read_table(Path(path), usecols=[0, 1, 2, 3])
    lab = df[3].to_numpy()
    sem = np.where(lab == 1, SEM_WOOD, np.where(lab == 2, SEM_LEAF, SEM_UNKNOWN)).astype(np.uint8)
    return Cloud(df[[0, 1, 2]].to_numpy(), sem, meta={"reader": "phytograph_xyz"})


def read_las_all(path: str | Path, sem_value: int, ground_band: float = 0.0) -> Cloud:
    """An unlabelled LAS/LAZ whose every point has one known class, such as a
    leaf-off tree (all wood once ground is gone). Points within
    ``ground_band`` metres of the lowest point are marked unknown, because
    whatever ground a tree crop kept sits there."""
    import laspy

    las = laspy.read(str(path))
    xyz = np.column_stack([las.x, las.y, las.z]).astype(np.float64)
    sem = np.full(len(xyz), sem_value, np.uint8)
    if ground_band > 0 and len(xyz):
        # 0.1th percentile, not the minimum: one stray low return would
        # otherwise set the band.
        sem[xyz[:, 2] < np.percentile(xyz[:, 2], 0.1) + ground_band] = SEM_UNKNOWN
    return Cloud(xyz, sem, meta={"reader": "las_all", "ground_band": ground_band})


READERS = {
    "helios_synthetic": read_helios_synthetic,
    "lewos": read_lewos,
    "weiser": read_weiser,
    "pair": read_pair,
    "wan": read_wan,
    "phytograph_xyz": read_phytograph_xyz,
    "las_all": read_las_all,
}
