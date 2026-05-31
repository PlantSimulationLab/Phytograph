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

The algorithm itself (3D cut-pursuit → 2D cut-pursuit → similarity merging) is
unchanged.
