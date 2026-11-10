# Reading a tree inventory

Part of the `phytograph` skill. `Cloud.tree_inventory` and `recipes.plot_inventory` return an
`Inventory`: `.trees` (one dict per tree: `dbh_m`, `height_m`, `stem_base`, lean, crown,
`flags`), `.stem_curve`, `.stand`, `.warnings`.

## Before running it

- It needs `tree_instance` (`segment_trees`) and `height_above_ground` (`dem(add_height_column=True)`).
- US breast height is `breast_height_m=1.37`; the default is 1.3.

## Per-tree flags

- `partial_arc` is normal for one scan.
- `few_points` and `high_residual` mean a doubtful DBH.
- `no_stem` means merged or occluded.
- `ground_from_tree_min` means no ground was found under the tree, which biases height on
  slopes.

`recipes.plot_inventory` counts each flag into its record and turns `no_stem` into an advisory.
