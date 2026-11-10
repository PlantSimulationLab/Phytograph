# Reading QSM and skeleton results

Part of the `phytograph` skill. Parameters named here are keywords of `Cloud.qsm`,
`Cloud.tree_qsms` and `Cloud.skeleton`; `help()` gives their units and defaults.

## QSM (`qsm`, `tree_qsms`, `recipes.tree_qsm`)

- Run it on ONE tree, wood only, thinned to ~60 000 points. `recipes.tree_qsm` does all three.
- Leaf-on trees: leaves are fitted as spurious branches. Separate wood first.
- `metrics["trunk_diameter_mm"]` is in **mm**; cylinder `radius` is in **m**.
  `metrics["tree_height_m"]` is in m.
- `fork_symmetry` 0.6-0.7 for open-center trees, 0.85-0.95 for a central leader. A trunk running
  up a scaffold means lower it; a leader cut short means raise it.
- `twig_radius_mm` anchors the radius taper at the tips; 4.23 is rTwig's published example, not
  your species.
- Cylinders with `surf_cov < 0.7` have radii inferred from the taper model, not measured. Stem
  volume is trustworthy; branch volume much less so.
- "No cylinders could be fitted: the skeleton reached only N of M points" means the crown is
  disconnected from the base (over-cropped trunk, over-thinned, or a single view).
- Below 50 points, nothing is fitted.
- `tree_qsms` leaves a failed tree out and reports it as a Python *warning*; catch warnings
  before counting trees.
- `QSM.to_csv` is a flat dump of the cylinders, not the SimpleForest/rTwig layout the app
  exports.

## Skeleton (`skeleton`)

- Spurs: raise `threshold_filter`, or separate wood first.
- Missing branches: raise `search_radius` (or `search_radius=0` for automatic), merge scans, or
  lower `threshold_filter`.
- `branch_orders` are Strahler orders counted from the tips, not QSM ranks.
