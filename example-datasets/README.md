# Benchmark datasets (tree-segmentation eval)

This folder holds the ground-truth benchmark clouds used to quantitatively
evaluate TreeIso individual-tree segmentation. The data is **not committed**
(large; CC-BY but not redistributable here) — everything except this README is
gitignored. Download the sets you want into this folder, then run the harness.

## E57 sky/miss test scans (LAD)

Real structured terrestrial scans from the libE57 reference dataset, for testing
E57 import + sky/miss recovery for the leaf-area-density inversion. Both are the
same scene (a 345×1074 grid = 370,530 cells; 155,201 returns + 215,329 sky/miss
cells), differing only in how the misses are encoded:

| File | Miss encoding | On import |
|---|---|---|
| `pumpASpherical.e57` | spherical angles | all 215,329 misses **placed** at 20 km (works fully today) |
| `pumpARowColumnIndex.e57` | cartesian grid (misses zeroed) + `rowIndex`/`columnIndex` | misses **kept + flagged** `is_miss=1`, directions recovered from the grid in Helios C++ |

Source: [libE57 example data](https://sourceforge.net/projects/e57-3d-imgfmt/files/E57Example-data/)
(`pumpA*` variants). Gitignored like the rest of this folder; re-download with:

```bash
curl -L -o example-datasets/pumpASpherical.e57 \
  "https://sourceforge.net/projects/e57-3d-imgfmt/files/E57Example-data/pumpASpherical.e57/download"
curl -L -o example-datasets/pumpARowColumnIndex.e57 \
  "https://sourceforge.net/projects/e57-3d-imgfmt/files/E57Example-data/pumpARowColumnIndex.e57/download"
```

## Datasets

| Dataset | Sensor | Trees | License | Download |
|---|---|---|---|---|
| **FOR-instance** | UAV/ALS LiDAR | 1,130 | CC BY 4.0 | Zenodo `10.5281/zenodo.8287792` |
| **Cherlet TLS benchmark** | TLS | 2,983 / 4 plots | CC BY 4.0 | Zenodo `10.5281/zenodo.14615493` |
| Wytham Woods (supplement) | TLS | 876 | CC BY 4.0 | Zenodo `10.5281/zenodo.7307956` |

Ground-truth instance labels:
- **FOR-instance**: `.las/.laz` with a `treeID` extra dimension (+ semantic class).
- **Cherlet**: `.ply` with scalar fields `instance` (1..N, `-1` = ground) and
  `semantic` (0 ground, 1 tree).

## Run the harness

```bash
# from the repo root, with the backend venv active (or use its python directly)
python backend-api/scripts/eval_tree_segmentation.py example-datasets/for-instance/
python backend-api/scripts/eval_tree_segmentation.py example-datasets/cherlet/plot1.ply
```

The script auto-detects the format and the GT instance field, drops ground
points (`--ground-ids 0,-1` by default), runs TreeIso, and prints per-file and
mean **precision / recall / F1** (IoU-matched at `--iou 0.5`), **coverage**
(mean IoU of matched trees), and **over/under-segmentation** counts.

Large plots are slow; use `--max-points` to voxel-downsample for a quick read,
and `--reg-strength2` / `--max-gap` to sweep the key TreeIso parameters.

## Expected ballpark

TreeIso is a classical baseline: roughly **F1 ~0.6–0.7 on dense FOR-instance**
forest and higher on well-separated / structured plots (per Xi & Hopkinson 2022
and the ForAINet comparison). Treat these as a regression baseline, not SOTA —
deep-learning methods score higher on the hard dense-canopy case.
