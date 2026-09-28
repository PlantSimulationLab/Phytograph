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
#
# 0-3 are the tree corpus's. 4-8 are the herbaceous organ datasets', kept
# apart because their boundaries are drawn elsewhere: a tree labeller's "leaf"
# includes the petiole, a phenotyping labeller's "stem" does (Pheno4D tomato,
# Demeter), and Sugar4D draws no petiole/blade line at all. A task maps each
# code to the SET of output classes it is consistent with (``ml.tasks``).
SEM = {"leaf": 0, "wood": 1, "fruit": 2, "ground": 3,
       "stem": 4,        # stem, branches, petioles, rachises and petiolules
       "blade": 5,       # leaf lamina; one instance per leaflet
       "leaf_whole": 6,  # blade + petiole, undivided (Sugar4D)
       "crown": 7,       # petiole bases + unresolved young leaves (Sugar4D "core")
       "root": 8,        # exposed storage root (Sugar4D taproot)
       "young_leaf": 9,  # a synthetic leaf still unexpanded at the apex (see read_helios_herb)
       "unknown": 255}
SEM_LEAF, SEM_WOOD, SEM_FRUIT, SEM_GROUND, SEM_UNKNOWN = 0, 1, 2, 3, 255
SEM_STEM, SEM_BLADE, SEM_LEAF_WHOLE, SEM_CROWN, SEM_ROOT, SEM_YOUNG_LEAF = 4, 5, 6, 7, 8, 9

# Synthetic leaves younger than this (days) are unexpanded apex leaves. Hand labellers do not agree
# on them: Pheno4D paints the tomato shoot tip stem, Sugar4D folds young beet leaves into its crown.
# They are coded young_leaf, which the organ task trains as "stem or leaf" so exact synthetic labels
# do not contradict the human convention the real data then teaches.
YOUNG_LEAF_DAYS = 3.0


@dataclass
class Cloud:
    xyz: np.ndarray                       # (N, 3) float64
    sem: np.ndarray                       # (N,) uint8, SEM codes
    organ: np.ndarray | None = None       # (N,) uint8, source organ id (255 = none)
    reflectance: np.ndarray | None = None  # (N,) float32, source units
    meta: dict = field(default_factory=dict)
    inst: np.ndarray | None = None        # (N,) int32 organ instance id, -1 = none
    age: np.ndarray | None = None         # (N,) float32 leaf age in days, -1 = not a leaf / unknown

    def __post_init__(self):
        n = len(self.xyz)
        for name in ("sem", "organ", "reflectance", "inst", "age"):
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


def read_helios_synthetic(path: str | Path, human_wood_min_length: float = 0.0) -> Cloud:
    """A SyntheticLiDAR_Organs scene: 14 named columns. Requires the header,
    because the column order is only defined there.

    ``human_wood_min_length`` > 0 relabels wood the way a person labelling a
    real scan would (``ml.data.relabel.human_visible_wood``): only connected
    runs of visible wood at least that long stay wood."""
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
    xyz = df[["x", "y", "z"]].to_numpy(np.float64)
    meta = {"reader": "helios_synthetic"}
    if human_wood_min_length > 0:
        from .relabel import human_visible_wood
        n_wood = int((sem == SEM_WOOD).sum())
        sem = human_visible_wood(xyz, sem, SEM_WOOD, SEM_LEAF, human_wood_min_length)
        meta.update(human_wood_min_length=human_wood_min_length,
                    wood_relabelled_leaf=n_wood - int((sem == SEM_WOOD).sum()))
    return Cloud(xyz, sem, organ, refl, meta)


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


def read_las_class(path: str | Path, column: str = "wood_class",
                   wood: int = 1, leaf: int = 2) -> Cloud:
    """A LAS/LAZ labelled in Phytograph (its Label tool or a wood/leaf run)
    and exported: the ``wood_class`` extra-dim, 1 = wood, 2 = leaf. Anything
    else (0 = unclassified) is unknown."""
    import laspy

    las = laspy.read(str(path))
    xyz = np.column_stack([las.x, las.y, las.z]).astype(np.float64)
    lab = np.asarray(las[column]).astype(np.int64)
    sem = np.where(lab == wood, SEM_WOOD, np.where(lab == leaf, SEM_LEAF, SEM_UNKNOWN)).astype(np.uint8)
    return Cloud(xyz, sem, meta={"reader": "las_class", "column": column})


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


def read_pheno4d(path: str | Path, swap_soil_stem: bool = False) -> Cloud:
    """A labelled Pheno4D tomato scan (``T0N_MMDD_a.txt``): ``x y z label`` in
    millimetres, +z up. 0 soil, 1 stem (petioles, rachises and petiolules
    included), >= 2 one instance per leaflet. ``swap_soil_stem`` is for the one
    scan whose 0/1 codes are exchanged (T02_0325_a): nothing in the file says
    so, only the geometry does (see organ_corpus.py)."""
    df = _read_table(Path(path), usecols=[0, 1, 2, 3])
    lab = df[3].to_numpy().astype(np.int64)
    soil, stem = (1, 0) if swap_soil_stem else (0, 1)
    sem = np.full(len(lab), SEM_UNKNOWN, np.uint8)
    sem[lab == soil] = SEM_GROUND
    sem[lab == stem] = SEM_STEM
    sem[lab >= 2] = SEM_BLADE
    inst = np.where(lab >= 2, lab, -1).astype(np.int32)
    # The stem grows out of the soil, so its top must be above the soil's.
    # Over all 77 labelled tomato scans the worst correct one clears it by
    # 9 mm and the swapped one fails by 96 mm, so a swap nobody listed fails
    # here rather than training a model to call the pot "stem".
    z = df[2].to_numpy()
    if (sem == SEM_GROUND).any() and (sem == SEM_STEM).any():
        margin = z[sem == SEM_STEM].max() - z[sem == SEM_GROUND].max()
        if margin < 0:
            raise ValueError(f"{path}: the soil class reaches {-margin:.1f} mm above the stem class; "
                             "its soil/stem codes look swapped (list it in organ_corpus.py)")
    return Cloud(df[[0, 1, 2]].to_numpy() / 1000.0, sem, inst=inst,
                 meta={"reader": "pheno4d", "swap_soil_stem": swap_soil_stem})


def _ply_vertices(path: Path) -> dict:
    from plyfile import PlyData

    v = PlyData.read(str(path))["vertex"].data
    return {name: np.asarray(v[name]) for name in v.dtype.names}


def read_demeter(plant_dir: str | Path, ignore_organs: tuple = (), drop_organs: tuple = ()) -> Cloud:
    """A Demeter soybean plant: ``raw/NNN.ply`` holds organ NNN, ``info/class.txt``
    its class (0 leaflet blade, 1 stem incl. petioles/petiolules, 2 flower,
    3 pod), and ``transform.json``'s ``T_raw2canonical`` puts the main-stem base
    at the origin with +z up. Units are metres as far as anyone can tell (see
    the audit notes: plausible, not documented).

    Pure-black points are hand-drawn stem repairs on no scanned surface; the
    authors' own training release drops them, and so does this. A point that
    appears in two organs with different labels (24_o, 34_i, 169_o) is marked
    unknown. ``ignore_organs`` are organs whose label is judged wrong (kept as
    geometry, never trained on); ``drop_organs`` are exact duplicates."""
    import json

    d = Path(plant_dir)
    cls = {}
    for line in (d / "info" / "class.txt").read_text().split("\n"):
        if line.strip():
            oid, c = line.split()
            cls[int(oid)] = int(c)
    T = np.asarray(json.loads((d / "transform.json").read_text())["T_raw2canonical"], np.float64)
    code = {0: SEM_BLADE, 1: SEM_STEM, 2: SEM_FRUIT, 3: SEM_FRUIT}
    xyzs, sems, insts = [], [], []
    for oid, c in sorted(cls.items()):
        if oid in drop_organs:
            continue
        v = _ply_vertices(d / "raw" / f"{oid:03d}.ply")
        xyz = np.column_stack([v["x"], v["y"], v["z"]]).astype(np.float64)
        if all(k in v for k in ("red", "green", "blue")):
            black = (v["red"] == 0) & (v["green"] == 0) & (v["blue"] == 0)
            xyz = xyz[~black]
        if not len(xyz):
            continue
        sem_code = SEM_UNKNOWN if oid in ignore_organs else code[c]
        xyzs.append(xyz)
        sems.append(np.full(len(xyz), sem_code, np.uint8))
        insts.append(np.full(len(xyz), oid if sem_code == SEM_BLADE else -1, np.int32))
    xyz = np.concatenate(xyzs)
    sem, inst = np.concatenate(sems), np.concatenate(insts)
    xyz = xyz @ T[:3, :3].T + T[:3, 3]
    # Same position, different labels: keep the point, trust neither label.
    _, first, cnt = np.unique(np.round(xyz, 7), axis=0, return_inverse=True, return_counts=True)
    if (cnt > 1).any():
        key = first.astype(np.int64)
        lab = sem.astype(np.int64) * 100_000 + inst.astype(np.int64) + 1
        lo = np.full(len(cnt), np.iinfo(np.int64).max)
        hi = np.full(len(cnt), np.iinfo(np.int64).min)
        np.minimum.at(lo, key, lab)
        np.maximum.at(hi, key, lab)
        clash = (lo != hi)[key]
        sem[clash] = SEM_UNKNOWN
        inst[clash] = -1
    return Cloud(xyz, sem, inst=inst, meta={"reader": "demeter", "ignore_organs": list(ignore_organs),
                                           "drop_organs": list(drop_organs)})


def read_sugar4d(path: str | Path) -> Cloud:
    """A Sugar4D sugar-beet cloud: binary PLY in metres, +z up, soil and pot
    already removed. ``label_semantic`` 0 taproot, 1 core (the crown: petiole
    bases and leaves too young to separate), 2 leaf; ``label_instance`` is the
    leaf id, in order of emergence and stable across visits. A leaf instance is
    the WHOLE leaf, petiole included, so it maps to ``leaf_whole``, not
    ``blade``."""
    v = _ply_vertices(Path(path))
    lab = v["label_semantic"].astype(np.int64)
    sem = np.full(len(lab), SEM_UNKNOWN, np.uint8)
    sem[lab == 0] = SEM_ROOT
    sem[lab == 1] = SEM_CROWN
    sem[lab == 2] = SEM_LEAF_WHOLE
    inst = np.where(lab == 2, v["label_instance"], -1).astype(np.int32)
    xyz = np.column_stack([v["x"], v["y"], v["z"]]).astype(np.float64)
    return Cloud(xyz, sem, inst=inst, meta={"reader": "sugar4d"})


# SyntheticLiDAR_Organs organ_id -> herbaceous SEM code. Petioles, petiolules,
# shoots and peduncles are stem, as PlantCloudFit and the Helios model draw it;
# raised veins are part of the blade. Reproductive organs are fruit, which the
# organ task ignores. The pot is soil: everything that is not plant.
#
# Petiolules as LEAF (joined to their leaflet) was tried on 2026-09-27, since
# Pheno4D's annotators seemed to draw them that way: semantics did not move
# (tomato stem IoU 0.763 -> 0.759) and leaflet F1 fell ~0.05 on tomato and
# soybean, so the real labellers are not consistent either way and stem stays.
# research/ml/README.md, "Joint synthetic + real training".
HELIOS_ORGAN_TO_SEM = {0: SEM_BLADE, 1: SEM_STEM, 2: SEM_STEM, 3: SEM_STEM, 4: SEM_STEM, 5: SEM_FRUIT, 6: SEM_GROUND,
                       7: SEM_FRUIT, 8: SEM_FRUIT, 9: SEM_FRUIT, 10: SEM_BLADE, 11: SEM_GROUND}


def read_helios_herb(path: str | Path) -> Cloud:
    """A herbaceous SyntheticLiDAR_Organs scene, labelled by fine organ rather
    than by the tree-oriented ``class_id`` (which puts petioles in the leaf).
    Leaf blades carry their compound-object id as the instance (one per
    leaflet) and the leaf's age in days, when the scene exported it."""
    path = Path(path)
    cols = _header_columns(path)
    if not cols or "organ_id" not in cols:
        raise ValueError(f"{path}: no '# x y z ... organ_id' header; not a labelled Helios scene")
    want = ["x", "y", "z", "organ_id", "instance_id"] + [c for c in ("leaf_age",) if c in cols]
    df = pd.read_csv(path, sep=r"\s+", comment="#", header=None, names=cols, usecols=want, engine="c")
    organ = df["organ_id"].to_numpy().astype(np.int64)
    sem = np.full(len(df), SEM_UNKNOWN, np.uint8)
    for src, dst in HELIOS_ORGAN_TO_SEM.items():
        sem[organ == src] = dst
    inst = np.where(sem == SEM_BLADE, df["instance_id"].to_numpy(), -1).astype(np.int64)  # before young_leaf recoding
    # Object ids are large and sparse; renumber so the cache's centroid tables stay small.
    ids, inv = np.unique(inst, return_inverse=True)
    inst = np.where(inst >= 0, inv.reshape(-1) - int((ids < 0).any()), -1).astype(np.int32)
    age = df["leaf_age"].to_numpy(np.float32) if "leaf_age" in df else None
    if age is not None:
        age = np.where(sem == SEM_BLADE, age, -1.0).astype(np.float32)
        sem[(sem == SEM_BLADE) & (age >= 0) & (age < YOUNG_LEAF_DAYS)] = SEM_YOUNG_LEAF
    return Cloud(df[["x", "y", "z"]].to_numpy(np.float64), sem, np.clip(organ, 0, 255).astype(np.uint8),
                 inst=inst, age=age, meta={"reader": "helios_herb"})


READERS = {
    "helios_herb": read_helios_herb,
    "pheno4d": read_pheno4d,
    "demeter": read_demeter,
    "sugar4d": read_sugar4d,
    "helios_synthetic": read_helios_synthetic,
    "lewos": read_lewos,
    "weiser": read_weiser,
    "pair": read_pair,
    "wan": read_wan,
    "phytograph_xyz": read_phytograph_xyz,
    "las_all": read_las_all,
    "las_class": read_las_class,
}
