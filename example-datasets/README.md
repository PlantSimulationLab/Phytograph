# Benchmark datasets (tree-segmentation eval)

This folder holds the ground-truth benchmark clouds used to quantitatively
evaluate TreeIso individual-tree segmentation. The data is **not committed**
(large; CC-BY but not redistributable here) — everything except this README is
gitignored. Download the sets you want into this folder, then run the harness.

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
