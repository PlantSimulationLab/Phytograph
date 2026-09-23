"""Learned per-point classification (leaf/wood first; fruit and organ later).

One implementation serves three callers, so a model that scores well in the
benchmark is byte-for-byte the model users run:

- the headless trainer (``python -m ml.train cfg.yaml``, run on HPC or a
  workstation),
- the benchmark (``research/ml/bench.py``), which evaluates through
  :func:`ml.infer.predict`, the same call the app makes,
- the backend, which runs inference inside ``seg_worker.py`` so a click on
  Cancel can kill it.

Layout:

- ``grid``: voxel grid sampling, shared by the training crops and inference.
- ``hierarchy``: the multi-resolution neighbour structure a crop is fed through.
  It is built in numpy/scipy on the CPU, so the network itself is only gathers
  and matmuls and runs unchanged on CUDA, Apple MPS or a plain CPU. No compiled
  extension ships, unlike openpoints' ball-query and FPS kernels.
- ``models``: the PointNeXt-style segmentation network.
- ``package``: the model package on disk (``model.json`` + ``weights.pt``).
- ``infer``: sliding-crop inference over a whole cloud.
- ``data``: corpus readers, the voxel cache, and the training crop sampler.

Torch is imported lazily by the modules that need it, so ``import ml`` stays
cheap for the backend's startup path.
"""
