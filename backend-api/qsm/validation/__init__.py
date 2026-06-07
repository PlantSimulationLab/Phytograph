"""QSM validation harness.

Compares a reconstructed QSM against a ground-truth QSM (from the PyHelios
synthetic-tree generator) *statistically* -- never cylinder-by-cylinder, because
the ground-truth internode tessellation is arbitrary relative to where the
reconstruction places its cylinders. Every comparison runs on arc-length-uniform
resampled centerline / surface samples (see ``resample``) so the two
discretizations compare fairly.

Design notes (the user's "statistics can lie" requirement):
- every gameable scalar metric is paired with a guard that closes the loophole;
- a visual overlay (``overlay``) is emitted on every run for eyeball sanity.
"""
