"""The SyntheticLiDAR_Organs corpus: every labeled item, its reader and its split.

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
- **dense_eastern** / **dense_western**: two hand-labeled leaf-on redbuds
  with dense crowns, split apart so either can be held out.
- ``*_hl`` twins of every synthetic scene, and ``synthdense_*_hl`` sets, carry
  hand-label-like wood (``HUMAN_WOOD_MIN_LENGTH``); split names gain ``_hl``.
- **leafoff**: four leaf-off almond trees (the other five are
  ``leafoff_train``, which only the dense-crown configs train on), all wood apart from a ground
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
SYNTH_DENSE = Path(os.environ.get(
    "PHYTOGRAPH_SYNTH_DENSE", "/group/bnbaileygrp/bnbailey/phytograph_ml/synth_dense/data"))
# A synthetic wood point stays wood only in a connected run of visible wood at
# least this long (ml.data.relabel). 0.5 m makes an open synthetic redbud match
# the hand-labeled western redbud (25-30 % vs 33 % of leaf > 30 cm from wood)
# and a dense one the eastern (65-69 % vs 78 %); exact labels give 0 % on both.
HUMAN_WOOD_MIN_LENGTH = 0.5
REDBUD_LABELED = Path(os.environ.get(
    "PHYTOGRAPH_REDBUD_LABELED",
    "/group/bnbaileygrp/bnbailey/phytograph_ml/real_labeled/redbud",
))


@dataclass
class Entry:
    dataset: str
    name: str
    reader: str
    args: tuple
    split: str
    noisy: bool                     # hand-labeled (True) or exact synthetic (False)
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
    # Five of the nine can train (split "leafoff_train", opt-in by config):
    # the dense-crown redbuds taught the model that a dense fine-textured
    # crown mass is leaf, and a leafless almond's twig mass is exactly that
    # shape, so its wood recall fell 0.89 -> 0.61. The other four, one or two
    # per cultivar, stay the leaf-off test.
    leafoff_test = {"tree_3_Aldrich", "tree_14_Nonpareil", "tree_35_Independence",
                    "tree_36_Independence"}
    for f in sorted((REAL / "almond").glob("tree_*.laz")):
        split = "leafoff" if f.stem in leafoff_test else "leafoff_train"
        out.append(Entry("almond_leafoff", f.stem, "las_all", (str(f), 1), split, True,
                         {"ground_band": 0.2}))

    # Hand-labeled leaf-on redbuds (Phytograph wood_class, 1 wood / 2 leaf),
    # the first real trees with a DENSE crown: eastern is 0.8 % wood, with
    # almost none visible in the crown; western 4.0 %. The public benchmark
    # trees are 13-42 % wood. Each has its own split so configs can hold
    # either one out.
    for f in sorted(REDBUD_LABELED.glob("*_redbud_*woodclass.laz")):
        side = f.name.split("_")[0]
        out.append(Entry("redbud_labeled", side, "las_class", (str(f),), f"dense_{side}", True))

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
            # The same scene with hand-label-like wood (see HUMAN_WOOD_MIN_LENGTH).
            out.append(Entry(d.name + "_hl", f.stem, "helios_synthetic", (str(f),), split + "_hl",
                             False, {"human_wood_min_length": HUMAN_WOOD_MIN_LENGTH},
                             domain="synthetic"))

    # Crowns from every woody library species, including redbud and almond grown
    # past the library's age cap (<max_age>) into dense crowns. Only ever used
    # with hand-label-like wood: with exact labels none of them, dense or not,
    # has a leaf point more than 30 cm from wood.
    for d in sorted(SYNTH_DENSE.glob("*")):
        if not d.is_dir():
            continue
        for f in sorted(d.glob("scene_*.xyz")):
            split = "val_synth_hl" if (d.name, f.stem) == ("redbud", "scene_00011") else "train_hl"
            out.append(Entry(f"synthdense_{d.name}_hl", f.stem, "helios_synthetic", (str(f),), split,
                             False, {"human_wood_min_length": HUMAN_WOOD_MIN_LENGTH},
                             domain="synthetic"))
    return out


if __name__ == "__main__":
    from collections import Counter

    es = entries()
    c = Counter((e.dataset, e.split) for e in es)
    for (ds, sp), n in sorted(c.items()):
        print(f"{ds:32s} {sp:11s} {n}")
    print(len(es), "items")
