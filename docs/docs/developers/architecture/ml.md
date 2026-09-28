# ML point classification

Phytograph's learned per-point classifier lives in `backend-api/ml/`. Leaf/wood
is its first shipped task. Plant organs (soil / stem / leaf plus leaflet
instances, below) and fruit use the same machinery. One
package serves three callers, so the model the benchmark scores is exactly the
model users run:

| Caller | Entry point |
|---|---|
| Headless trainer (HPC or a workstation) | `python -m ml.train config.yaml` |
| Benchmark | `backend-api/research/ml/bench.py` |
| The app | `segment_wood(method="ml")` and `ml.organs.label_plant`, inside the killable seg worker |

## The network

`ml/models/pointnext.py` is a PointNeXt-style segmentation network (Qian et
al. 2022). It has a stem, four set-abstraction stages with InvResMLP blocks,
and a feature-propagation decoder. PointNeXt's farthest-point sampling and
ball-query CUDA kernels are replaced by a neighbor hierarchy that
`ml/hierarchy.py` builds on the CPU with numpy/scipy:

- **Downsampling** uses voxel-grid barycenters, grown until each level has at
  most a quarter of the points of the level before it.
- **Grouping** uses kNN, clamped to a radius.

The network itself is then only gathers, matmuls and max-pools, so it runs
unchanged on CUDA, Apple MPS and a plain CPU. Nothing native ships per
platform. torch was already in the PyInstaller bundle (via `phytorch-lib`).

## Inference

`ml/infer.py` covers a cloud with overlapping crops:

1. Grid-sample to the model's base voxel (1 cm) and keep the inverse map.
2. Take the next uncovered voxel as a seed and crop its 24k nearest voxels.
3. Mark the inner 70 % of the crop, by distance, as covered.
4. Average the softmax outputs, weighted by closeness to the crop center.
5. Scatter the per-voxel argmax back to every input point.

Training crops are built the same way (`ml/data/crops.py`) and share
`crop_features`, so the network's input is only ever built one way.

## Model packages

A model is a directory holding `model.json` and `weights.pt`. `model.json`
records:

- the architecture and hyperparameters, plus the hierarchy geometry
- the input channels and crop size
- the class schema (`value`/`name`/`color`, which maps onto a renderer
  `ClassPalette`) and the output column
- provenance and metrics

The weights load with `torch.load(weights_only=True)`, so importing a package
someone else trained can never execute code. `ml/package.py` validates every
field and names the first problem it finds.

`ml/registry.py` knows two roots, and only the backend knows either path. The
renderer sees models through `/api/ml/models`, so the path is never computed
twice (see the octree cache root in `CLAUDE.md`).

| Root | Location |
|---|---|
| Bundled | `resources/ml_models/<id>/`, shipped via `extraResources`, and resolved under `PHYTOGRAPH_RESOURCES` or its parent |
| User | the per-user data directory's `Phytograph/ml_models/`. `PHYTOGRAPH_ML_MODELS_DIR` overrides it |

## Where torch runs

Torch is never imported into the FastAPI server process, because it costs
about 0.5 GB of RSS for the life of the backend. Inference, the device probe
(`/api/ml/device`) and import validation all run as `_run_killable` tools in
`seg_worker.py`, which also makes them cancelable.

`ml/device.py` checks that a kernel actually executes rather than trusting
`torch.cuda.is_available()`. The cu13 wheel reports True on a V100 (sm_70) and
then fails the first kernel.

## Plant organs (herbaceous plants)

The `plant_organ` task labels a potted or single herbaceous plant in the
scheme PlantCloudFit reads: soil, stem (petioles, rachises and petiolules
included) and leaf, plus one instance per leaflet blade.

In the app it is the **Segment Plant Organs** tool. `ml/organs.py`
(`label_plant`) runs the model and the clustering in the seg worker (tool
`organs`) and returns two columns, written by `/api/segment/organs` (inline
points) and `/api/cloud/session/{id}/segment_organs` (session clouds, hit
points only, misses 0):

| Column | Values |
|---|---|
| `plant_organ` | 1 soil, 2 stem, 3 leaf (mapped from the package's classes by name) |
| `leaflet_id` | 0 none, 1..N one per leaflet, numbered by centroid height |

The model works in meters. `units` ("auto", "m", "cm", "mm") says what the
cloud is in; "auto" (`resolve_units`) reads more than 30 units across as
millimeters, and the response reports the units used plus a warning when the
cloud is not plant-sized in them (outside 2 cm-5 m), or when "auto" read 30-300
units as millimeters, which is also a plausible plant in centimeters. The bundled default is
`resources/ml_models/plant-organ-pointnext-s-v1` (`registry.DEFAULT_MODELS`),
gated by `backend-api/tests/test_ml_organ.py` on two fixtures no model was
trained on. `backend-api/research/ml/organ_predict.py` still writes a
PlantCloudFit input file (`x y z label`, 0 soil, 1 stem, >= 2 leaflets) from
the command line.

Three things differ from leaf/wood:

- **Scale.** The base voxel is 2 mm, not 1 cm: a tomato petiolule is about
  1 mm across.
- **Partial labels.** A source code may map to a *set* of classes
  (`sem_to_allowed` in `ml/tasks.py`), and the loss maximizes the probability
  of the set. Sugar4D labels a whole beet leaf without separating petiole
  from blade, so its leaf points train "stem or leaf". A beet taproot is
  "soil or stem": certainly not leaf. A singleton set is ordinary
  cross-entropy, so single-label sources are unaffected.
- **Instances.** A second head predicts, per point, the offset to its
  leaflet's centroid and the log of that leaflet's RMS radius. Offsets are
  metric vectors in the cloud's frame, so sliding-crop inference averages
  them like the class probabilities. `ml/instances.py` then mean-shifts the
  votes with a bandwidth proportional to each vote's predicted radius and
  links the modes. Organs range from a 5 mm cotyledon to a 30 cm beet leaf,
  and no fixed bandwidth separates both. The offset loss is measured in
  units of the instance radius for the same reason.

The corpus (`research/ml/organ_corpus.py`) is Pheno4D tomato, Demeter
soybean and Sugar4D sugar beet, split by plant. Known label errors are
listed there and applied by the readers, never by editing the source files.
`research/ml/organ_bench.py` scores semantics per point and instances by
leaflet F1, coverage and count error.

## Training and the benchmark

`backend-api/research/ml/README.md` covers:

- corpus splits (by tree, with the pytest-fixture trees held out)
- the preprocessing cache
- Slurm jobs for UC Davis Farm
- the experiment matrix

The benchmark compares each model against `segment_wood(method="sota")` and a
gradient-boosted-trees baseline on held-out real trees. Scores are reported
over all points and with the 2 cm label-boundary band excluded, because hand
labels are least reliable there.

Tests:

- `backend-api/tests/test_ml_core.py` pins the hierarchy, package, reader and
  inference contracts on a tiny random model.
- `backend-api/tests/test_ml_wood.py` gates the bundled model's accuracy on the
  held-out fixture trees and pins the packaged layout against `package.json`.
