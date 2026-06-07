"""QSM (Quantitative Structure Model) reconstruction package.

Reconstructs a dormant-tree TLS point cloud as a set of connected cylinders with
estimated radii and topology, segmenting continuous shoots and classifying them
by shoot rank (trunk = rank 0, scaffolds = rank 1, ...).

Pure-Python, deterministic, non-ML. All heavy numerics go through numpy / scipy /
open3d. FastAPI endpoints live in ``main.py`` and call into this package; nothing
here imports FastAPI.

See the approved plan and ``qsm_implementation_plan.md`` / ``findings.md`` at the
repo root for the algorithm and verified formula references.
"""
