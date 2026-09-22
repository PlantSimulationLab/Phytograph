# TreeIso (vendored)

`treeiso_core.py` is adapted from **TreeIso** for Phytograph's tree-segmentation
feature.

- **Upstream:** https://github.com/truebelief/artemis_treeiso
- **Source file:** `PythonCpp/treeiso.py`
- **Commit:** `dcf4a743c87f7f06d29a987fdd358714434436f3` (main, fetched 2026-05-30)
- **Paper:** Xi, Z.; Hopkinson, C. *TreeIso: 3D Graph-Based Individual-Tree
  Isolation from TLS Point Clouds.* Remote Sensing 2022, 14(23), 6116.
  https://doi.org/10.3390/rs14236116

## License

The TreeIso core (`treeiso` + `cutpursuit`) is **MIT licensed** — see
`UPSTREAM_LICENSE.txt` (© 2022 Zhouxin Xi, © 2018 Loïc Landrieu). MIT permits
the modification and redistribution done here.

The upstream repository's single `LICENSE` file also documents an **LGPL 2.1**
component (`matlas_tools`, in the repo's `Matlab/` folder) and CC-BY-4.0 docs.
**None of that is vendored here** — only the MIT-licensed Python algorithm was
adapted. No MATLAB code, no `matlas_tools`.

The graph-cut backend `cut_pursuit_py` is installed from PyPI (not vendored).

## Adaptation summary

`treeiso_core.py` differs from `PythonCpp/treeiso.py` as follows:

- Module-level `PR_*` constants → a `TreeIsoParams` dataclass threaded through
  every stage, so parameters are set per request.
- File/laspy I/O removed (`process_las_file`, `process_csv_file`,
  `read_csv_file`, `main`).
- Single entry point `segment_trees(xyz, params) -> np.ndarray` returns the
  per-point tree id (contiguous 1..K) at full resolution.
- `verbose=False` on the cut-pursuit calls (was `True`).

The three main stages (3D cut-pursuit → 2D cut-pursuit → similarity merging) are
unchanged.

One behavioural difference: upstream's gap-splitting post-process is applied by
DEFAULT here, where upstream leaves it opt-in.

- Upstream runs `isolate_gaps` only when `process_las_file(..., if_isolate_outlier=True)`,
  inside the laspy I/O this adaptation dropped — so the helper survived the port
  but its only call site did not, leaving `max_outlier_gap` wired from the UI all
  the way to the dataclass and read by nothing.
- Phytograph runs it every time, from `segment_trees` via `_split_across_gaps`.
  The reason is the shape of our input: users routinely segment a cloud CROPPED
  AROUND ONE TREE, so the surrounding trees appear as trunkless crown fragments.
  Stage 3 flags a trunkless fragment as a merge candidate and merges it into the
  best-scoring neighbour with no distance ceiling (`min3DSpacing` only enters the
  score exponentially), so a neighbouring tree 0.878 m away in mid-air was
  absorbed into the focal tree on the Nickels almond scan.
- Two guards were added that upstream has no equivalent of: components must be a
  meaningful share of their parent AND clear an absolute node floor before being
  split off, so occlusion debris never becomes an instance.
- The connectivity test is run on a cloud coarsened to `gap/8` rather than at
  full stage-1 resolution. Upstream's k-NN formulation (`search_K=20`) is wrong
  at TLS densities — the whole neighbour budget is spent within a few cm, so no
  edge ever reaches across a gap — while an uncoarsened radius query is
  quadratic in the neighbourhood (measured 369 s at a 3 m gap).
- The default `max_outlier_gap` is 0.65 m, not upstream's 3.0. Upstream's value
  is not a comparable default: it is commented *"trivial: post-processing to
  remove isolated points with great gaps"* — noise cleanup behind an opt-in flag,
  not tree separation — and the CloudCompare TreeIso plugin, the reference
  implementation, exposes no outlier-gap parameter at all. At 3.0 m nothing
  splits on close-range TLS (measured inter-tree merges at 0.92 m / 1.72 m).

  0.65 m is the midpoint of the range correct on BOTH calibration clouds:
  0.55–0.90 m on TreeIso's own 9-ground-truth-tree demo cloud (0.5 splits it into
  10, 0.4 into 22 at recall 0.968) and 0.50–0.75 m on the Nickels almond scan
  (1.0 reabsorbs the neighbouring tree). For outside corroboration, treeX (2025)
  uses a 0.5 m maximum crown region-growing radius for the same decision — the
  same order of magnitude, and measurably a shade too tight here.

## Divergence: stage-1 cut-pursuit collapse guard (2026-09-21)

`_process_point_cloud` records whether stage-1 cut-pursuit returned a single
segment, exposed as `stage1_collapsed()`. Upstream has no such check.

`cut_pursuit_py` 1.0.12 (the latest release) has an order-dependent failure mode:
on some inputs it saturates at iteration 1 without splitting and returns ONE
segment for the whole graph. Stages 2-3 then have no segment structure to group
and can only subdivide that blob geometrically, which on a row-planted orchard
yields one instance per ROW — the reported case is a 5-tree almond plot returning
2 instances that are a clean coarsening of the correct 5.

It is the solver, not the data: a pure permutation of the identical node set
flips the outcome (17,443 nodes, natural order -> 1 segment, shuffled -> 302).
`reg_strength1` is inert when it fires (swept 0.05-100, always 1 segment), and
coordinate scaling, lattice snapping and edge deduplication all leave it in
place. See the `CutPursuitDegenerate` docstring in `treeiso_core.py` for the full
measurement set.

The vendored layer only REPORTS it, and the algorithm is otherwise untouched —
in particular upstream's node ordering is preserved, because every reordering
tried drives the solver to the opposite degenerate extreme (>90% singleton
segments), including at resolutions where the natural order works. Policy lives
in Phytograph's `main.py`: `_treeiso_segment_retrying_degenerate` retries at a
nudged `decimate_res1` when the collapse fused everything into one instance, and
`_treeiso_row_fusion_warning` flags instances holding several trunks so a
plausible-looking-but-fused count reaches the user.

Not reported upstream as a patch because the defect is in the compiled
`cut_pursuit_py` extension, which is a PyPI dependency rather than vendored code.
