# ML point classification

Phytograph's learned per-point classifier lives in `backend-api/ml/`. Leaf/wood
is its first task, and fruit and organ classes use the same machinery. One
package serves three callers, so the model the benchmark scores is exactly the
model users run:

| Caller | Entry point |
|---|---|
| Headless trainer (HPC or a workstation) | `python -m ml.train config.yaml` |
| Benchmark | `backend-api/research/ml/bench.py` |
| The app | `segment_wood(method="ml")`, inside the killable seg worker |

## The network

`ml/models/pointnext.py` is a PointNeXt-style segmentation network (Qian et
al. 2022). It has a stem, four set-abstraction stages with InvResMLP blocks,
and a feature-propagation decoder. PointNeXt's farthest-point sampling and
ball-query CUDA kernels are replaced by a neighbour hierarchy that
`ml/hierarchy.py` builds on the CPU with numpy/scipy:

- **Downsampling** uses voxel-grid barycentres, grown until each level has at
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
4. Average the softmax outputs, weighted by closeness to the crop centre.
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
`seg_worker.py`, which also makes them cancellable.

`ml/device.py` checks that a kernel actually executes rather than trusting
`torch.cuda.is_available()`. The cu13 wheel reports True on a V100 (sm_70) and
then fails the first kernel.

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
