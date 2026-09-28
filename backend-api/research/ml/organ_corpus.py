"""The herbaceous organ corpus: every labelled plant, its reader, its split and
its known label errors.

Three hand-labelled datasets, all dicots (grasses are deferred: a sheath and a
whorl are not a petiole and a stem). Their audit notes are under
``$PHYTOGRAPH_ORGAN_DATA/<dataset>/NOTES.md``:

- **Pheno4D tomato** (Uni Bonn, laser arm, 7 plants x ~11 days): soil / stem /
  one instance per leaflet. Maize is not used.
- **Demeter soybean** (UIUC, ICCV 2025, photogrammetry, 78 plants, Apache-2.0):
  stem / leaflet / flower / pod, no soil.
- **Sugar4D** (Uni Bonn, Sci Data 2026, TLS, 48 plants x 16 visits, CC BY 4.0):
  taproot / crown / whole leaf (petiole inside), no soil.
- **Synthetic Helios scenes** (``$PHYTOGRAPH_ORGAN_DATA/synthetic/<config>/``,
  made by SyntheticLiDAR_Organs with its herbaceous configs): potted plants and
  field rows of the plant library's dicots, scanned at 0.3-8 mm spacing, with
  exact soil / pot / stem / petiole / blade / leaflet labels. They fill what the
  real sets lack: soil and pots outside Pheno4D, a petiole/blade line on every
  species, sparse scans, and leaf age.

Splits are by plant, never by scan, so a plant's other days cannot leak into
its test score:

- Pheno4D: Tomato04 and Tomato06 are test (PlantCloudFit's calibration
  hold-outs too, so a predicted-label fit can be compared with the hand-label
  one), Tomato05 is val, the other four train.
- Demeter: the authors' 11 test plants are test; a hash slice of the rest by
  plant NUMBER (``N_i`` and ``N_o`` go together) is val.
- Sugar4D: the authors' 24/12/12 plant split. Checkpoint selection uses the
  val plants at three visits only (``val``); the other visits are ``val_all``.

Known label errors are listed here and applied by the readers. Nothing in the
source files is edited:

- Pheno4D ``T02_0325_a``: soil and stem codes exchanged.
- Demeter ``324_i`` organ 32 and ``14_o`` organ 60: leaflet-sized planar
  blades labelled stem, with no children. Ignored rather than relabelled.
- Demeter ``169_o`` organ 37: a byte-identical copy of organ 39.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from corpus import Entry

ROOT = Path(os.environ.get("PHYTOGRAPH_ORGAN_DATA", "/group/bnbaileygrp/bnbailey/phytograph_ml/organ_data"))

PHENO4D_SPLIT = {"Tomato01": "train", "Tomato02": "train", "Tomato03": "train", "Tomato07": "train",
                 "Tomato05": "val", "Tomato04": "test", "Tomato06": "test"}
PHENO4D_SWAPPED = {"T02_0325_a"}
DEMETER_IGNORE = {"324_i": (32,), "14_o": (60,)}
DEMETER_DROP = {"169_o": (37,)}
SUGAR4D_VAL_VISITS = {"44_das", "65_das", "86_das"}


def _hash_frac(key: str) -> float:
    return int(hashlib.sha1(key.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def entries() -> list[Entry]:
    out: list[Entry] = []

    p4 = ROOT / "Pheno4D" / "data" / "Pheno4D"
    for plant, split in sorted(PHENO4D_SPLIT.items()):
        for f in sorted((p4 / plant).glob("T*_a.txt")):
            out.append(Entry("pheno4d_tomato", f.stem, "pheno4d", (str(f),), split, True,
                             {"swap_soil_stem": f.stem in PHENO4D_SWAPPED}))

    dm = ROOT / "Demeter" / "raw"
    manifest = dm / "point_transformer" / "data" / "point_transformer" / "soybean" / "manifest.json"
    test = set(json.loads(manifest.read_text())["splits"]["test"])
    for d in sorted((dm / "sample_params" / "soybean" / "instances").iterdir()):
        if not (d / "info" / "class.txt").exists():
            continue
        name = d.name
        if name in test:
            split = "test"
        else:
            split = "val" if _hash_frac(f"demeter/{name.split('_')[0]}") < 0.15 else "train"
        out.append(Entry("demeter_soybean", name, "demeter", (str(d),), split, True,
                         {"ignore_organs": DEMETER_IGNORE.get(name, ()),
                          "drop_organs": DEMETER_DROP.get(name, ())}))

    s4 = ROOT / "Sugar4D" / "data" / "point_clouds"
    for split in ("train", "val", "test"):
        for line in (s4 / "splits" / f"{split}.txt").read_text().split():
            visit = line.split("_plant_")[0]
            sp = split
            if split == "val" and visit not in SUGAR4D_VAL_VISITS:
                sp = "val_all"
            out.append(Entry("sugar4d", Path(line).stem, "sugar4d", (str(s4 / visit / line),), sp, True))

    # Synthetic: 5 % of scenes per config (by hash) are val_synth, the rest train.
    # They are never test data: the question is always how a model does on real plants.
    for d in sorted((ROOT / "synthetic").glob("*")):
        if not d.is_dir():
            continue
        for f in sorted(d.glob("scene_*.xyz")):
            split = "val_synth" if _hash_frac(f"{d.name}/{f.stem}") < 0.05 else "train"
            out.append(Entry(f"synth_{d.name}", f.stem, "helios_herb", (str(f),), split, False, domain="synthetic"))
    return out


if __name__ == "__main__":
    from collections import Counter

    es = entries()
    c = Counter((e.dataset, e.split) for e in es)
    for (ds, sp), n in sorted(c.items()):
        print(f"{ds:20s} {sp:8s} {n}")
    print(len(es), "items")
