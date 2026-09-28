"""Write the committed plant-organ test fixtures from the organ training cache.

    PYTHONPATH=backend-api python backend-api/research/ml/organ_make_fixtures.py \\
        --cache .../phytograph_ml/cache_organ

Neither fixture was trained on:

- ``potted_tomato_synth.xyz``: Helios synthetic scene herb_potted_v4/scene_00165
  (a 31-day tomato in a pot), from the ``val_synth`` split that training never
  reads. Cropped to the pot and plant, thinned to one point per 2 mm (the
  model's own voxel). Metres. Columns ``x y z organ leaflet``: organ 1 soil,
  2 stem, 3 leaf, 0 unscored (fruit, flowers); leaflet 0 none, else one id per
  leaflet blade.
- ``sugar_beet_real.xyz``: Sugar4D (CC BY 4.0) plant 029 at 44 days after
  sowing, a TEST-split plant, thinned to 2 mm and written in MILLIMETRES so the
  tests exercise ``units="auto"``. Sugar4D draws no petiole/blade line and has
  no soil, so organ is 0 (unscored) except the leaves' instance ids, which are
  whole leaves (``leaflet``), and 9 marks the crown (young leaves the labellers
  never separated; not scored).

Also writes, ``x y z`` only, for the end-to-end test: ``tests/e2e/fixtures/
potted-tomato.xyz`` (the synthetic tomato at 3 mm with 2 cm of soil around the
plant, metres) and ``sugar-beet-mm.xyz`` (the beet above, millimetres).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ml.data.cache import open_cache  # noqa: E402
from ml.data.readers import (SEM_BLADE, SEM_CROWN, SEM_GROUND, SEM_LEAF_WHOLE, SEM_STEM,  # noqa: E402
                             SEM_YOUNG_LEAF)
from ml.grid import grid_sample  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
SUGAR4D_ATTRIBUTION = """# sugar-beet-mm.xyz

One sugar-beet plant (plant 029, 44 days after sowing) from the **Sugar4D**
dataset, thinned to one point per 2 mm and written as `x y z` in millimetres.
Used by `organ-segment.spec.ts`.

Sugar4D is published under the Creative Commons Attribution 4.0 licence
(CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). Changes from the
original: thinned, labels dropped, coordinates converted to millimetres.
Written by `backend-api/research/ml/organ_make_fixtures.py`.
"""
OUT = REPO / "backend-api" / "tests" / "fixtures" / "organs"


def _thin(xyz, *cols, voxel):
    keep, _ = grid_sample(xyz, voxel)
    return (xyz[keep],) + tuple(c[keep] for c in cols)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    args = ap.parse_args()
    items = open_cache(args.cache)
    OUT.mkdir(parents=True, exist_ok=True)

    it = items["synth_herb_potted_v4/scene_00165"]
    assert it.meta["split"] == "val_synth"
    xyz, sem, inst = np.asarray(it.xyz, np.float64), np.asarray(it.sem), np.asarray(it.inst)
    plant = np.isin(sem, (SEM_STEM, SEM_BLADE, SEM_YOUNG_LEAF))
    lo, hi = xyz[plant].min(0) - 0.05, xyz[plant].max(0) + 0.05
    box = np.all((xyz[:, :2] >= lo[:2]) & (xyz[:, :2] <= hi[:2]), axis=1)
    xyz, sem, inst = xyz[box], sem[box], inst[box]
    organ = np.zeros(len(xyz), np.int32)
    organ[sem == SEM_GROUND] = 1
    organ[sem == SEM_STEM] = 2
    organ[np.isin(sem, (SEM_BLADE, SEM_YOUNG_LEAF))] = 3
    leaflet = np.where((inst >= 0) & (organ == 3), inst + 1, 0)
    t_xyz, t_organ, t_leaf = _thin(xyz, organ, leaflet, voxel=0.002)
    np.savetxt(OUT / "potted_tomato_synth.xyz", np.column_stack([t_xyz, t_organ, t_leaf]),
               fmt=["%.4f"] * 3 + ["%d", "%d"], header="x y z organ leaflet (metres)")
    tight = np.all((xyz[:, :2] >= lo[:2] + 0.03) & (xyz[:, :2] <= hi[:2] - 0.03), axis=1)
    e2e, = _thin(xyz[tight], voxel=0.003)
    np.savetxt(REPO / "tests" / "e2e" / "fixtures" / "potted-tomato.xyz", e2e, fmt="%.4f")
    print(f"tomato: {len(t_xyz):,} points, {len(np.unique(t_leaf)) - 1} leaflets; e2e {len(e2e):,}")

    it = items["sugar4d/44_das_plant_029"]
    assert it.meta["split"] == "test"
    xyz, sem, inst = np.asarray(it.xyz, np.float64), np.asarray(it.sem), np.asarray(it.inst)
    organ = np.where(sem == SEM_CROWN, 9, 0).astype(np.int32)
    leaflet = np.where((sem == SEM_LEAF_WHOLE) & (inst >= 0), inst + 1, 0)
    b_xyz, b_organ, b_leaf = _thin(xyz, organ, leaflet, voxel=0.002)
    np.savetxt(OUT / "sugar_beet_real.xyz", np.column_stack([b_xyz * 1000.0, b_organ, b_leaf]),
               fmt=["%.2f"] * 3 + ["%d", "%d"], header="x y z organ leaflet (millimetres; Sugar4D, CC BY 4.0)")
    np.savetxt(REPO / "tests" / "e2e" / "fixtures" / "sugar-beet-mm.xyz", b_xyz * 1000.0, fmt="%.2f")
    (REPO / "tests" / "e2e" / "fixtures" / "sugar-beet-mm.README.md").write_text(SUGAR4D_ATTRIBUTION)
    print(f"beet: {len(b_xyz):,} points, {len(np.unique(b_leaf)) - 1} leaves")


if __name__ == "__main__":
    main()
