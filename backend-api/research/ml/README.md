# Leaf/wood ML benchmark

This is the headless harness that trains and scores learned leaf/wood classifiers against the
geometric `segment_wood`. The model code it drives lives in `backend-api/ml/`, and that package is
what the app will ship. Everything here is dev-only and never bundled.

## Pipeline

| step | command (from `backend-api/`, with `PYTHONPATH=.`) | where it runs |
|---|---|---|
| 1. Cache the corpus | `sbatch research/ml/jobs/preprocess.sbatch` | CPU, about 2 min with 12 workers |
| 2. Train one run | `sbatch --job-name=pg-<run> research/ml/jobs/train.sbatch configs/<run>.yaml` | 1 GPU, about 1 h for 30k steps |
| 3. Score the baselines | `sbatch research/ml/jobs/bench.sbatch --sota --gbdt real --gbdt joint --out …/baselines.json` | CPU |
| 4. Score trained models | `sbatch --gpus=6000_ada:1 research/ml/jobs/bench.sbatch --package NAME=…/runs/<run>/package --out …/models.json` | 1 GPU |

Paths:
- The corpus is `~/Helios/projects/SyntheticLiDAR_Organs/data`; override it with `PHYTOGRAPH_CORPUS`.
- The cache, runs, logs and results live under `/group/bnbaileygrp/bnbailey/phytograph_ml/`. They
  go on group storage because home is 20 GB.

On Farm, use the `gpu-6000_ada-h` (RTX 6000 Ada) or A100/H100 nodes. The V100 in `bgpu` is sm_70.
The venv's cu13 torch wheel no longer ships sm_70 kernels, so on that card `torch.cuda.is_available()`
returns True and then the first kernel fails. `ml/device.py` probes for exactly that.

## Splits (`corpus.py`)

Splits are fixed and made by tree, never by point:

- **test**: the four trees behind `tests/fixtures/leafwood` (Weiser oak, spruce and beech, plus
  LeWoS tree 1), a hash-selected 20% of LeWoS and BCI, and the two GBSeparation trees that appear
  in no other dataset.
- **test**, plot level: all three Wan plots. They label ground and understory as leaf, so read
  their scores as plot-level numbers, not tree-level ones.
- **val**: another 10% by hash, plus Weiser pine. It is used only to pick checkpoints.
- **val_synth**: one scene each of almond, pistachio and redbud.
- **test_synth**: both orchard-row scenes. `_v2` regenerates the same scene, so neither can be
  used for training.
- **leafoff**: nine leaf-off almond trees. Everything above a 20 cm ground band is wood. This split
  measures the false-leaf rate on the target crop, which has no hand-labelled leaf-on trees yet.

Eight of the GBSeparation trees are copies of LeWoS and Weiser trees and are skipped. Every real
score is reported twice: once over all points, and once with a 2 cm band around label boundaries
removed (`core`), because that band is where hand labels are least reliable.

## Runs (`configs/`)

`wl_<S|B>_<regime>` crosses PointNeXt-S and PointNeXt-B with four data regimes:

| regime | trained on |
|---|---|
| `synth` | synthetic scenes only (exact labels, not reality) |
| `real` | hand-labelled real trees only (reality, noisy labels) |
| `finetune` | `synth`'s package, then 15k steps on real trees at a quarter of the learning rate |
| `joint` | both at once: 40% of crops synthetic, 60% real |

Crops are 24k points at a 1 cm base voxel. The augmentations cover rotation, tilt, scale, jitter,
a random coarser grid, and 1/r² thinning from a virtual scanner (see `ml/data/crops.py`). Points
within 2 cm of a label change are down-weighted to 0.3 on real data only.

## Results (2026-09-22)

These are mean-over-trees scores on the 59 held-out real trees (the `test` split,
without Wan). Each cell shows all points / boundary band excluded.

| method | mIoU | wood IoU | leaf-off almond wood recall | mIoU at 3 cm spacing |
|---|---|---|---|---|
| `sota` (geometric, shipped before) | 0.658 / 0.668 | 0.608 / 0.619 | 0.466 | 0.604 |
| GBDT, joint | 0.700 / 0.712 | 0.649 / 0.662 | 0.678 | – |
| PointNeXt-S, synthetic only | 0.760 / 0.776 | 0.705 / 0.725 | 0.773 | – |
| PointNeXt-S, real only | 0.812 / 0.830 | 0.778 / 0.798 | 0.937 | – |
| PointNeXt-B, synthetic → real | 0.833 / 0.852 | 0.807 / 0.829 | 0.825 | – |
| **PointNeXt-S, synthetic → real (shipped)** | **0.834 / 0.853** | **0.805 / 0.827** | **0.888** | **0.782** |

The shipped model is `final_S_finetune_s0`:

- **Training:** 50k steps of synthetic pre-training, then 25k steps of real
  fine-tuning.
- **Selection:** best of three seeds by *validation* mIoU. It was not chosen by
  any test score.
- **Seed spread on real trees:** mIoU ranges 0.828–0.834 across the seeds, so
  real-tree accuracy is stable.
- **Seed spread on leaf-off almond:** wood recall ranges 0.84–0.94, so that number
  is seed-sensitive.

Other findings:

- **Model size:** B matches S within the seed spread, at 4.7× the parameters
  and 1.5× the CPU time, so S ships.
- **Thinning augmentation:** harder thinning during fine-tuning (up to 5 cm,
  `final_S_ftdense_*`) gained 0.003 mIoU at 3 cm spacing and lost 0.009 at full
  resolution. It was not adopted.
- **Inference time for a 2 M-point tree:**

  | device | S | B |
  |---|---|---|
  | 8-thread CPU | 61 s | 93 s |
  | RTX 6000 Ada | about 7 s | about 7 s |

- **Open gap:** no hand-labelled leaf-on orchard tree exists yet. Leaf-on
  almond, pistachio and redbud accuracy is only measured indirectly (forest
  trees plus leaf-off almond). A few labelled orchard trees would be the most
  informative addition to the test set.
