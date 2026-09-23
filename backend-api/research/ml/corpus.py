"""The SyntheticLiDAR_Organs corpus: every labelled item, its reader and its split.

Splits are by tree (by scene for synthetic data), never by point, and they are
fixed here rather than drawn at random each run. Every experiment is then
scored on the same trees, and the trees the pytest gates use can never leak
into training:

- **test** holds out the four trees behind ``backend-api/tests/fixtures/
  leafwood`` (Weiser oak, spruce and beech; LeWoS tree 1), a stable hash
  slice of LeWoS and BCI, the two GBSeparation trees that appear in no other
  dataset, and all three Wan plots. The Wan plots label ground and understory
  as leaf, so they are a plot-level test only.
- **val** is a smaller hash slice, used for checkpoint selection. Test is
  never looked at during training.
- **test_synth**: both orchard-row scenes (``_v2`` regenerates the same scene,
  so neither may train). **val_synth** is one scene per species.
- **leafoff**: the nine leaf-off almond trees, all wood apart from a ground
  band. They measure false-leaf rate on the crop this is ultimately for.

GBSeparation's other eight trees are copies of LeWoS and Weiser trees and are
skipped, so no tree is counted twice.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(os.environ.get(
    "PHYTOGRAPH_CORPUS",
    str(Path.home() / "Helios/projects/SyntheticLiDAR_Organs/data"),
))
REAL = ROOT / "real"


@dataclass
class Entry:
    dataset: str
    name: str
    reader: str
    args: tuple
    split: str
    noisy: bool                     # hand-labelled (True) or exact synthetic (False)
    kwargs: dict = field(default_factory=dict)
    domain: str = "real"            # "real" | "synthetic"


def _hash_split(key: str, test: float = 0.2, val: float = 0.1) -> str:
    h = int(hashlib.sha1(key.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    if h < test:
        return "test"
    if h < test + val:
        return "val"
    return "train"


def entries() -> list[Entry]:
    out: list[Entry] = []

    # LeWoS: 61 tropical trees, "<id>_avec_feuilles_Ref.txt".
    for f in sorted((REAL / "LeWoS_leaf_classification").glob("*_avec_feuilles_Ref.txt")):
        tid = f.name.split("_")[0]
        split = "test" if tid == "1" else _hash_split(f"lewos/{tid}")
        out.append(Entry("lewos", f"tree_{tid}", "lewos", (str(f),), split, True))

    # Weiser: 5 European trees; the 3 fixture species are test.
    weiser_split = {"QuePet": "test", "PicAbi": "test", "FagSyl": "test",
                    "PinSyl": "val", "AcePse": "train"}
    for f in sorted((REAL / "Weiser_leaf_classification").glob("*.laz")):
        sp = f.name.split("_")[0]
        out.append(Entry("weiser", f.stem, "weiser", (str(f),), weiser_split[sp], True))

    # BCI: 202 tropical trees as <tree>_wood.* + <tree>_leaf.txt.
    bci = REAL / "BCI_tropical_leafwood" / "Pointclouds"
    for leaf in sorted(bci.glob("*_leaf.txt")):
        tree = leaf.name[: -len("_leaf.txt")]
        wood = next((p for p in (bci / f"{tree}_wood.txt", bci / f"{tree}_wood.ply") if p.exists()), None)
        if wood is None:
            continue
        out.append(Entry("bci", tree, "pair", (str(wood), str(leaf)), _hash_split(f"bci/{tree}"), True))

    # GBSeparation: only the two trees found nowhere else.
    gb = REAL / "GBSeparation_leafwood"
    for species in ("Cinnamomum camphor", "Magnolia grandiflora"):
        wood = gb / f"{species}_SOR_space0.005_manual_wood.pcd"
        leaf = gb / f"{species}_SOR_space0.005_manual_leaf.pcd"
        if wood.exists() and leaf.exists():
            out.append(Entry("gbsep", species.replace(" ", "_"), "pair", (str(wood), str(leaf)),
                             "test", True))

    # Wan: 3 plots, test only.
    for f in sorted((REAL / "Wan_plot_leafwood").glob("reference_pc_*.txt")):
        out.append(Entry("wan", f.stem.replace("reference_pc_", ""), "wan", (str(f),), "test", True))

    # Leaf-off almond: all wood above a 20 cm ground band.
    for f in sorted((REAL / "almond").glob("tree_*.laz")):
        out.append(Entry("almond_leafoff", f.stem, "las_all", (str(f), 1), "leafoff", True,
                         {"ground_band": 0.2}))

    # Synthetic Helios scenes.
    val_synth = {("synthetic_almond", "scene_00002"), ("synthetic_pistachio_v2", "scene_00001"),
                 ("synthetic_redbud_v2", "scene_00002")}
    for d in sorted(ROOT.glob("synthetic*")):
        if not d.is_dir():
            continue
        for f in sorted(d.glob("scene_*.xyz")):
            if "orchard" in d.name:
                split = "test_synth"
            elif (d.name, f.stem) in val_synth:
                split = "val_synth"
            else:
                split = "train"
            out.append(Entry(d.name, f.stem, "helios_synthetic", (str(f),), split, False,
                             domain="synthetic"))
    return out


if __name__ == "__main__":
    from collections import Counter

    es = entries()
    c = Counter((e.dataset, e.split) for e in es)
    for (ds, sp), n in sorted(c.items()):
        print(f"{ds:32s} {sp:11s} {n}")
    print(len(es), "items")
