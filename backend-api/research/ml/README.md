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

# Plant organs (herbaceous plants)

The `plant_organ` task labels soil / stem / leaf and splits the leaf into one
instance per leaflet: the input PlantCloudFit's `LabeledCloud` reads (0 soil,
1 stem with petioles, rachises and petiolules, >= 2 one leaflet each).
`organ_predict.py` writes that file from any `x y z` table.

## Data (`organ_corpus.py`)

The six candidate datasets were audited on 2026-09-23. The audit, the per-file
error lists and the downloads are in `/group/bnbaileygrp/bnbailey/phytograph_ml/organ_data/`
(`SUMMARY.md`). Three are used, all dicots; grasses are deferred:

| dataset | plants | labels | licence |
|---|---|---|---|
| Pheno4D tomato | 7 x ~11 days, laser arm, 0.07 mm | soil / stem / leaflet | none stated (used with the authors' agreement) |
| Demeter soybean | 78, photogrammetry | stem / leaflet / flower / pod | Apache-2.0 |
| Sugar4D sugar beet | 48 x 16 visits, TLS | taproot / crown / whole leaf | CC BY 4.0 |

Splits are by plant: Pheno4D Tomato04 and Tomato06 are test (PlantCloudFit's
calibration hold-outs too), Tomato05 is val; Demeter's own 11 test plants are
test; Sugar4D's own 24/12/12 split, with val trimmed to three visits.

## Steps

```
CACHE=$ML_ROOT/cache_organ sbatch research/ml/jobs/preprocess.sbatch --corpus organ   # 1 mm cache, ~5 min
sbatch --job-name=pg-organ_S_real research/ml/jobs/train.sbatch configs/organ_S_real.yaml
python research/ml/organ_tune_cluster.py --cache ... --package ... --out ...     # val only
python research/ml/organ_bench.py --cache ... --package NAME=... --out ... [--decimate 0.005]
```

## Results (2026-09-23)

`organ_S_real` (PointNeXt-S, 2 mm base voxel, 30k steps, real data only),
best checkpoint by validation. Held-out plants, scored on the 1 mm cache
unless noted. "Core" drops a 4 mm band around label changes. Leaflet F1
matches instances at IoU > 0.5. Sugar4D has no petiole/blade line, so it
has no semantic score.

| test set | mIoU / core | stem IoU (core) | leaf IoU (core) | leaflet F1 | mCov | count error |
|---|---|---|---|---|---|---|
| tomato (22 scans) | 0.898 / 0.917 | 0.882 | 0.977 | 0.807 | 0.783 | +2 % |
| soybean (11) | 0.906 / 0.926 | 0.923 | 0.989 | 0.849 | 0.800 | -5 % |
| sugar beet (192) | - | - | - | 0.946 | 0.954 | +9 % |
| tomato at 3 mm | 0.878 / 0.935 | 0.900 | 0.981 | 0.719 | 0.625 | -19 % |
| tomato at 5 mm | 0.818 / 0.839 | 0.732 | 0.945 | 0.451 | 0.438 | -42 % |
| soybean at 5 mm | 0.784 / 0.805 | 0.839 | 0.971 | 0.638 | 0.615 | -20 % |

Inference on a full-resolution 3.4 M-point Pheno4D scan takes about 7 s on
8 CPU threads.

What mattered, in the order it was found:

- **The offset loss has to be in units of the organ.** The first run
  measured the centroid-offset Huber loss in metres, about 50x smaller than
  the class loss. The network learned offsets a third of their true length,
  and leaflet F1 stayed at 0.3. Measured relative to each instance's radius,
  F1 was 0.7 by step 2500.
- **One clustering bandwidth cannot serve a 5 mm cotyledon and a 30 cm beet
  leaf.** The network also predicts each instance's radius, and mean shift
  uses a bandwidth of 0.75 radii (`ml/instances.py`; chosen on val).
- **Partial labels beat ignoring.** With the beet taproot ignored, the model
  called 90 % of it leaf and every beet shoulder became a phantom leaflet.
  Labelled "soil or stem", beet leaflet F1 went 0.88 -> 0.94.
- **Minimum instance size is an area, not a point count.** A fixed count
  drops whole leaflets on a sparse cloud. It must be measured at the spacing
  of the cluster representatives, floored at their voxel: the raw nearest-
  neighbour gap of voxel representatives is far below the voxel, and it made
  full-resolution Pheno4D seedlings lose every leaflet.

## Synthetic herbaceous scans (2026-09-24)

900 SyntheticLiDAR_Organs scenes (`herb_potted.xml`: 600 single potted plants, close-range ring;
`herb_field.xml`: 300 rows of 3-7 plants, TLS at 2.5-5.5 m) of ten library dicots, point spacing
spread over ~0.7-8 mm per scene, with exact soil / pot / stem / petiole / blade / leaflet labels
and leaf age (`read_helios_herb`). Same recipe as leaf/wood: synthetic only, synthetic then
fine-tuned on the real sets, and joint. Checkpoints are chosen on the real val plants throughout.

Held-out real plants, leaflet F1 / mIoU (1 mm cache unless noted):

| model | tomato | soybean | beet F1 | tomato F1 at 5 mm | soybean F1 at 5 mm |
|---|---|---|---|---|---|
| **real only (organ_S_real, kept)** | **0.807** / 0.898 | **0.849** / **0.906** | **0.946** | 0.451 | 0.638 |
| synthetic only | 0.670 / 0.752 | 0.656 / 0.688 | 0.789 | 0.343 | 0.444 |
| synthetic -> real | 0.809 / 0.881 | 0.836 / 0.883 | 0.918 | 0.398 | 0.674 |
| joint | 0.781 / 0.880 | 0.820 / 0.889 | 0.923 | 0.456 | 0.667 |

**Synthetic data did not improve the model on real plants, including on sparse scans, the gap it
was generated to close.** Synthetic-only transfers with a real gap (tomato stem IoU 0.71 vs 0.85;
on soybean it also calls a few points soil on plants that have none, which is most of its low
mIoU). At 5 mm a whole young tomato is 1-2k points and a leaflet a handful, and no training mix
recovers it: treat <= 3 mm as the model's working range rather than a data gap.

Beet petioles (`organ_petiole_eval.py`, against Sugar4D's per-leaf template-matched petiole length,
1,751 held-out leaves): on leaves where a model predicts a petiole, the median predicted petiole
fraction is on target for all four (0.24-0.38 vs 0.31 measured); synthetic-only is the tightest
(median abs error 0.11 vs 0.16 real-only) but no model tracks per-leaf variation (r ~0.1), and
adding real beet (trained only as "stem or leaf") leaves more leaves with no predicted petiole
(45 % vs 31 %). The first version of that script scored a found petiole as zero whenever a
neighbouring blade overlapped the leaf base; it now measures how far the predicted stem reaches.

### Where the synthetic-to-real gap comes from (`organ_gap.py`, 2026-09-24)

- **Not mainly label conventions.** The real-trained model's errors sit at human label boundaries
  (81 % within 4 mm on tomato); the synthetic-only model's do not (41 % of its tomato errors are
  more than 16 mm from any boundary). There is a convention effect, in opposite directions: Pheno4D's
  "leaf" reaches further toward the stem than exact labels, Demeter's "stem" further into the leaf.
- **Hand-built appearance features were real but not the lever.** v1 synthetic leaves were 3x too
  noisy at 4 mm, ~5x too flat at 16 mm, and stems too thin. v2 (`herb_*_v2.xml`: per-scene noise
  spread, per-plant leaf curvature / fold / wave with >= 6 subdivisions, 1-1.8x stem radius) fixed
  the leaf-noise and curvature mismatch on a sample, yet synthetic-only v2 was *not* better on real
  plants (tomato leaflet F1 0.57 vs 0.67), and fine-tuned v2 ties real-only within one-seed noise
  (tomato F1 0.856 vs 0.807, soybean 0.827 vs 0.849, beet 0.935 vs 0.946).
- **What the synthetic model actually gets wrong** (tomato test, synth_v2): 28.5 % of human "stem"
  is called leaf, only 20 % of that at the apex (where Pheno4D labels unexpanded leaves stem: a
  convention); the rest is **leaflet stalks**. 9.1 % of soil is called leaf, 81 % of it within 3 cm
  of the stem base: the **soil mound** where the stem emerges, which synthetic pot soil lacks.
- **The leaflet stalks are missing from the synthetic plants.** Library tomato builds no petiolules
  (its leaflet texture paints a stub of one onto the blade; PlantCloudFit crops it for the same
  reason). Soybean, bean and cowpea build them (`build_petiolule`; PyHelios soybean at 30 d: 8,798
  petiolule primitives) but at a scale a scanner cannot resolve: 3-8 hits in a whole synthetic
  soybean scan. Real petiolules are 3-15 mm long and the human labels call them stem, so a
  synthetic-trained model has never seen what the labellers mean by the stem at a leaflet base.

### v3: the tracer fix, soil mounds and young-leaf partial labels (2026-09-25)

v3 (`herb_*_v3.xml`) keeps v2 and adds three things the error analysis above pointed at:

- **Small triangles are scanned.** Helios <= 1.3.88's ray-triangle test rejected any triangle under
  ~3 mm as "parallel" (an absolute epsilon on the Moller-Trumbore determinant, which scales with
  area), so petiolules and thin stems were near-invisible: 85 petiolule hits in four soybean scans,
  13,310 with the fix (0.006 % -> 0.97 % of blade), and +62 % shoot hits. Fixed upstream in 1.3.89;
  applied locally to a 1.3.88 snapshot (`phytograph_ml/synth_jobs/build_patched.sbatch`,
  `patch_small_triangles.py`) until that release reaches this build. Tomato still has no
  petiolules (library geometry, also fixed upstream).
- **Soil mounds and clods** in pots (`<soil_mound_max>`): 5-15 mm heaps at the stem base.
- **Young synthetic leaves** (< 3 days, `YOUNG_LEAF_DAYS`) are coded `young_leaf` and trained as
  "stem or leaf", so exact synthetic labels no longer fight Pheno4D's stem-labelled shoot tips.

Held-out real plants, 1 mm (single seed each):

| model | tomato mIoU / leaflet F1 | soybean mIoU / F1 | beet F1 | tomato mIoU at 5 mm |
|---|---|---|---|---|
| real only | 0.898 / 0.807 | 0.906 / 0.849 | **0.946** | 0.818 |
| synthetic only v1 / v2 / **v3** | 0.752 / 0.708 / **0.849**; F1 0.670 / 0.574 / **0.814** | 0.688 / 0.655 / 0.683 | 0.789 / 0.789 / 0.826 | 0.485 / 0.515 / 0.649 |
| **synthetic v3 -> real** | **0.905 / 0.834** | **0.909 / 0.858** | 0.927 | **0.831** |

Synthetic-only v3 matches real-only on tomato leaflets and closes most of the tomato semantic
gap; soybean's synthetic-only gap did not move (next suspects: Demeter's undocumented absolute
scale and its photogrammetric surfaces). Fine-tuned v3 is best or tied on tomato and soybean at
1, 3 and 5 mm but 0.02 worse on beet leaflets, and every synthetic-pretrained model leaves more
beet leaves without a predicted petiole (48 % vs 31 %) even though synthetic-only v3 places beet
petioles best (median error 0.10). The margins are within one-seed noise; seeds decide.

### Three seeds: synthetic pre-training does not beat real-only on these test sets (2026-09-26)

Seeds 0-2 of the whole chain (synthetic v3 pre-training -> fine-tune, and real-only), mean ± SD
on the held-out plants (`phytograph_ml/bench/organ_seeds.json`):

| | real only | synthetic v3 -> real |
|---|---|---|
| tomato mIoU / leaflet F1, 1 mm | 0.903 ± 0.009 / 0.822 ± 0.022 | 0.896 ± 0.008 / 0.830 ± 0.029 |
| soybean mIoU / leaflet F1, 1 mm | **0.906 ± 0.003** / 0.845 ± 0.013 | 0.889 ± 0.018 / 0.846 ± 0.033 |
| beet leaflet F1, 1 mm | **0.944 ± 0.004** | 0.932 ± 0.007 |
| soybean mIoU, 3 mm | **0.866 ± 0.005** | 0.841 ± 0.021 |
| tomato leaflet F1, 5 mm | 0.462 ± 0.041 | 0.420 ± 0.023 |

The single-seed advantage of fine-tuned v3 above was seed noise. Real-only is equal or better
everywhere except leaflet F1 on tomato and soybean (within one SD), and varies less between seeds.
The beet-petiole metric is too seed-noisy to rank anything (share of leaves with no predicted
petiole: 23-48 % within one recipe). These three test sets are in-distribution for the real-only
model, so they cannot show the benefit synthetic data is for (species and scanners the real sets
do not cover); revisit with an out-of-domain labelled set, or once Helios 1.3.89 adds tomato
petiolules.

**Model of record: `organ_S_real_s1`** (`phytograph_ml/runs/organ_S_real_s1/package`), best of the
three real-only seeds by validation score (0.910 vs 0.900 / 0.902), not by test. Its test scores:
tomato 0.914 / 0.847, soybean 0.909 / 0.856, beet leaflet F1 0.947.

### v4: Helios 1.3.89 (upstream tracer fix, petiolules) (2026-09-26)

Regenerated on the released 1.3.89 (the small-triangle fix upstream, parametric petiolules and
tomato petiolules) and run through the same three-seed chain (`bench/organ_v4_seeds.json`),
mean ± SD on the test plants at 1 mm unless marked:

| | real only | synth v3 (s0) | synth v4 | synth v3 -> real | synth v4 -> real |
|---|---|---|---|---|---|
| tomato mIoU | **0.903 ± 0.008** | 0.849 | 0.819 ± 0.011 | 0.896 ± 0.006 | 0.897 ± 0.015 |
| tomato leaflet F1 | 0.822 ± 0.018 | 0.814 | 0.762 ± 0.034 | 0.830 ± 0.024 | **0.837 ± 0.018** |
| soybean mIoU | **0.906 ± 0.002** | 0.683 | 0.694 ± 0.024 | 0.889 ± 0.014 | 0.902 ± 0.003 |
| soybean leaflet F1 | 0.845 ± 0.010 | 0.644 | 0.646 ± 0.019 | 0.846 ± 0.027 | 0.842 ± 0.019 |
| beet leaflet F1 | **0.944 ± 0.003** | 0.826 | 0.840 ± 0.015 | 0.932 ± 0.006 | 0.936 ± 0.004 |
| soybean mIoU, 3 mm | **0.866 ± 0.004** | 0.736 | 0.715 ± 0.005 | 0.841 ± 0.017 | 0.855 ± 0.006 |
| tomato leaflet F1, 5 mm | **0.462 ± 0.034** | 0.447 | 0.434 ± 0.014 | 0.420 ± 0.019 | 0.423 ± 0.011 |

Fine-tuned v4 closes most of v3's soybean deficit (0.889 -> 0.902) and is still within noise of
real-only everywhere. Synthetic-only v4 is WORSE than v3 on tomato: stem precision falls 0.90 ->
0.81-0.84 while stem recall rises, i.e. it calls stem on points Pheno4D labels leaf. The likely
cause is the new tomato petiolules, which the synthetic labeller calls stem and Pheno4D's
annotators appear to include in the leaflet: a labelling convention, not a rendering error, and
the choice matters for PlantCloudFit (whose model has petiolules). Synthetic-only v4 places beet
petioles best of anything so far (median fraction error 0.098 on all three seeds, 27-31 % of
leaves with none), fine-tuned v4 worse (0.14-0.16).

On a closer look (six Pheno4D test plants, confusion of synthetic-only v3 vs v4 s0) the petiolule
convention explains about half of the extra stem calls: +725 leaf -> stem points, 90 % within 5 mm
of the true stem at leaflet bases; the other half is soil -> stem (+885), a soil regression in v4
(soil -> leaf also rose 170 -> 1,901) that is not yet explained. Decision (2026-09-27): petiolules
are LEAF, joined to the leaflet they carry (`readers._join_petiolules`), cached as
`synth_herb_{potted,field}_v4pl` (symlinks to the v4 scene directories). The runs above used the
old stem convention from `synth_herb_*_v4`.

### Leave one dataset out: synthetic data is what generalises (2026-09-26)

The in-distribution benchmarks above cannot show what synthetic data is for, so each real dataset
was held out in turn: `organ_lodo_<held-out>_{real,ftv4}_s{0,1,2}` train on the OTHER two real
sets (real only, or synthetic v4 pre-training then those two), validate on the other two, and are
scored on the held-out dataset's test plants alongside synthetic-only v4 (which never saw any real
set). Mean of three seeds at 1 mm (`bench/lodo_{tomato,soybean,beet}.json`):

| held out | | real only (other two) | synth v4 -> other two | **synthetic only** | in-distribution real only |
|---|---|---|---|---|---|
| tomato | mIoU | 0.317 | 0.318 | **0.819** | 0.903 |
| | leaflet F1 | 0.449 | 0.552 | **0.762** | 0.822 |
| | soil IoU | 0.000 | 0.000 | **0.977** | 0.994 |
| soybean | mIoU | 0.571 | 0.622 | **0.694** | 0.906 |
| | leaflet F1 | 0.561 | 0.585 | **0.646** | 0.845 |
| beet | leaflet F1 | 0.558 | 0.610 | **0.840** | 0.944 |
| | leaf count error | +1.30 | +1.08 | **+0.33** | +0.10 |

The same ordering holds at 3 and 5 mm on every fold (e.g. soybean mIoU at 5 mm: 0.44 / 0.40 /
0.65). Synthetic-only is the best model on every dataset it was not trained on, and on tomato it
comes within 0.06 leaflet F1 of a model trained on tomato. Two failure modes of the real-only
corpus show up here that the in-distribution test sets hide: neither soybean nor beet has soil
labels, so a model without tomato never learns soil; and a model that has only seen leaflets
(tomato, soybean) cuts each whole beet leaf in two (count error +1.30).

Sequential fine-tuning throws most of that away: pre-trained on synthetic scenes that have soil,
then fine-tuned on two real sets that do not, the model forgets soil entirely (0.977 -> 0.000 on
tomato) and keeps only part of the leaflet gain. The recipe for a general model is therefore joint
training (synthetic and real mixed throughout), not pre-train-then-fine-tune; that is the next
experiment, scored on both the in-distribution and the held-out benchmarks. Beet petiole
placement is the one metric where held-out real-only does as well (median error 0.09-0.10 for all
three recipes): tomato and soybean carry petiole labels.

### Joint synthetic + real training, and petiolules as leaf (2026-09-27)

Petiolules relabelled leaf (above), then three recipes, three seeds each: synthetic-only on the
relabelled scenes (`organ_S_synth_v4pl_s*`), and joint training, 60 % real / 40 % synthetic
throughout, both in-distribution (`organ_S_joint_v4pl_s*`, all three real sets) and with each real
set held out (`organ_lodo_<fold>_joint_s*`). Leaflet F1 / mIoU, mean of three seeds at 1 mm
(`bench/organ_joint_seeds.json`, `bench/lodo_joint_<fold>.json`):

| | real only | synth v4 (petiolule stem) | synth v4pl (petiolule leaf) | joint (v4pl) |
|---|---|---|---|---|
| **in-distribution** tomato F1 | **0.822** | 0.762 | 0.714 | 0.799 |
| soybean mIoU | **0.906** | 0.694 | 0.702 | 0.889 |
| beet F1 | **0.944** | 0.840 | 0.831 | 0.925 |
| tomato F1, 5 mm | 0.462 | 0.434 | 0.400 | **0.497** |
| **held out** tomato F1 / soil IoU | 0.449 / 0.000 | **0.762 / 0.977** | 0.714 / 0.977 | 0.617 / 0.882 |
| soybean F1 | 0.561 | **0.646** | 0.593 | 0.616 |
| beet F1 (1 / 3 / 5 mm) | 0.558 / 0.741 / 0.779 | **0.840** / 0.874 / 0.891 | 0.831 / 0.870 / 0.892 | 0.710 / 0.875 / **0.902** |

(Synthetic-only never sees real data, so its in-distribution and held-out numbers are the same
models.) Joint training keeps soil, which sequential fine-tuning lost, and lands between the other
two on both axes: 0.01-0.03 below real-only on the datasets it trained on, and below synthetic-only
on the one it did not (tomato leaflet F1 0.617 vs 0.762). With 60 % real, the model learns the
real sets' scanners and conventions at the expense of what transfers. Lower real weights are the
obvious next point on that curve.

Petiolules as leaf did not pay: semantics are unchanged (tomato stem IoU 0.763 -> 0.759; stem
precision rose 0.83 -> 0.88 but recall fell as much), leaflet F1 fell on tomato and soybean
(0.762 -> 0.714, 0.646 -> 0.593, ~1-1.5 SD), beet unchanged. So Pheno4D's annotators do not
consistently put petiolules in the leaflet either; the stem convention (Helios, PlantCloudFit)
loses nothing measurable. Reverted to stem the same day (user decision); the `*_v4pl` cache
entries are orphaned leftovers of that experiment.

Next point on the curve (submitted 2026-09-27, `phytograph_ml/synth_jobs/pipeline_sweep.sh`):
joint at 10 % and 25 % real, petiolules as stem (`organ_S_joint_r{10,25}_s*`,
`organ_lodo_<fold>_joint_r{10,25}_s*`), scored into `bench/organ_sweep_seeds.json` and
`bench/lodo_sweep_<fold>.json`.

### Real-weight sweep: 10 % real is the compromise (2026-09-27)

Share of real data per batch, mean of three seeds at 1 mm (60 % used petiolules-as-leaf, see above):

| % real | 0 | 10 | 25 | 60 | 100 |
|---|---|---|---|---|---|
| in-dist. tomato leaflet F1 | 0.762 | 0.802 | 0.786 | 0.799 | **0.822** |
| in-dist. soybean mIoU / leaflet F1 | 0.694 / 0.646 | 0.835 / 0.779 | 0.874 / 0.775 | 0.889 / 0.818 | **0.906 / 0.845** |
| in-dist. beet leaflet F1 | 0.840 | 0.915 | 0.921 | 0.925 | **0.944** |
| in-dist. tomato leaflet F1, 5 mm | 0.434 | **0.504** | 0.497 | 0.497 | 0.462 |
| held-out tomato leaflet F1 / soil IoU | **0.762 / 0.977** | 0.743 / 0.950 | 0.699 / 0.951 | 0.617 / 0.882 | 0.449 / 0.000 |
| held-out soybean leaflet F1 | **0.646** | 0.589 | 0.635 | 0.616 | 0.561 |
| held-out beet leaflet F1, 1 / 5 mm | **0.840** / 0.891 | 0.728 / 0.892 | 0.740 / **0.903** | 0.710 / 0.902 | 0.558 / 0.779 |

The first 10 % of real data buys most of what real data can: in-distribution soybean mIoU
0.694 -> 0.835 and leaflet F1 0.646 -> 0.779, beet 0.840 -> 0.915, tomato to within 0.02 of real-only,
and the best sparse-cloud tomato leaflets of any recipe. Held out, tomato gives up little
(0.762 -> 0.743, within one SD; soil kept at 0.95). What it costs is beet at full resolution
(0.840 -> 0.728): any real leaflet-annotated data teaches the model to cut an undivided beet leaf
into pieces (count error +0.33 -> +0.72), which disappears at 3-5 mm. More real data past 10 %
keeps trading generalisation for in-distribution scores, with no point dominating another.

**Shipped (2026-09-28): `organ_S_joint_r10_s1`**, best of the three 10 % seeds by validation
score (0.8796 vs 0.8778 / 0.8794), bundled as `resources/ml_models/plant-organ-pointnext-s-v1`
and wired into the app (Segment Plant Organs; `ml/organs.py`). Test scores: tomato mIoU 0.880 /
leaflet F1 0.780, soybean 0.851 / 0.789, beet leaflet F1 0.922. The previous model of record,
real-only `organ_S_real_s1`, scores higher on data like the three real sets and lower on
anything else. `organ_make_fixtures.py` writes the test fixtures (a val_synth tomato and a
Sugar4D test beet), which `tests/test_ml_organ.py` and `tests/e2e/organ-segment.spec.ts` gate.


### Tomato's small leaflets are limited by the votes, not the clustering floor (2026-09-26)

Tomato leaflets under ~30 mm are the ones lost. The votes on them are accurate (2.6 mm median
error, against 8.5 mm to the nearest other leaflet), and diagnostics on the test plants pointed
at the clustering step: fed PERFECT votes and radii, `cluster()` scored tomato F1 0.977 and found 15
of 27 leaflets under 15 mm, because the `min_area` floor removes them; without the floor, and on a
1 mm grid, it scored 1.000 and 27 of 27. Swapping the model's votes for true ones lifted F1
0.876 -> 0.928. That is also why synthetic data could not help here: the network already votes
well, and the loss happened after it.

The floor cannot simply go: on the model's votes it is what removes fragments (~40 more on the
test plants without it). Two tests to tell a small leaflet from a fragment were tried, tuned on
the VALIDATION plants of all three real-only seeds (`organ_tune_cluster.py`, votes saved per seed):

- **Spatial coherence** (share of a cluster's neighbours that carry its own label): made every
  setting worse. A leaflet the model splits in two gives two contiguous halves, as coherent as
  two real leaflets.
- **Radius consistency** (`radius_ratio_min`: measured RMS radius over the radius the members
  predicted): separates well: small clusters at >= 0.9 matched a true leaflet 120 times in 134,
  below 0.7 5 in 115. But over three seeds, rescuing with 0.75 while raising the floor to 4e-4
  moved mean validation leaflet F1 only 0.884 -> 0.888: beet +0.035 (the higher floor removes
  its over-segmentation, count error +0.12 -> +0.03), soybean +0.007, tomato **-0.029**.
- A 1 mm representative grid alone: tomato 0.888 -> 0.856 on validation.

So the floor's cost under perfect votes does not carry over to the model's own votes: tomato's
remaining leaflet errors are merges and splits in the votes themselves. `radius_ratio_min` stays
in `cluster()`, off by default; the defaults are unchanged. What should move tomato is better
votes (more small-leaflet training signal), not a smarter clustering step.

## Open gaps

- **Sparse clouds.** Semantics hold at 5 mm, but tomato leaflets do not: a
  whole young plant is ~1-2k points there. Synthetic scans at 0.7-8 mm did
  not fix it (above); <= 3 mm is the working range.
- **Beet petioles.** Measured now (above): right on average, not per leaf,
  and absent on ~30 % of leaves (many hidden under blades in a top-down scan).
- **Leaflet order.** PlantCloudFit reads increasing ids as increasing age.
  `organ_predict.py` orders by height, which is only a proxy, and ids are not
  tracked across days.
- **No soil or pot outside Pheno4D**, and none of the three datasets is a
  field scan. The synthetic scenes have both, but no real test set can
  score them.
