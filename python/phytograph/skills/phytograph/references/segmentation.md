# Reading segmentation results: ground, trees, wood, organs

Part of the `phytograph` skill. Parameters named here are keywords of the tool; `help()` on the
tool gives their units and defaults.

## Ground (`segment_ground` → `ground_class`)

- Flat ground labeled non-ground in patches means the tolerance was too small for the band's
  thickness. Measure it (`auto_class_threshold=True`), or set `class_threshold` to the middle of
  the gap between ground and canopy.
- Canopy tops labeled ground mean the cloth is up there. Lowering the tolerance will not help;
  use `rigidness=3`, `slope_smooth=False` or a coarser `cloth_resolution`.
- Crop people, tripods and buildings out first.

## Trees (`segment_trees` → `tree_instance`)

- "Instance(s) contain more than one trunk" means trees merged, and the tree count is a minimum.
  Lower `max_outlier_gap` first, then `max_gap`; the first must stay below the second or nothing
  separates.
- A tree in pieces means raising `reg_strength2`.
- Several trees coming back as one instance (for example a whole orchard row) is a known solver
  defect that no parameter fixes. Re-run on a slightly cropped or thinned cloud.
- Seeds can join segments but cannot split them.
- For CHM, `chm_crown_scale` is the width of the smaller crowns, not the trunk spacing, and
  should err low.

## Wood (`segment_wood` → `wood_class`)

- `ml` is the most accurate (wood IoU ~0.80) and the app's default.
- `sota` and `connectivity` root at the lowest points, so remove the ground first.
- `geometric` when the ground cannot be removed cleanly.
- `connectivity` keeps twigs, which a QSM wants.
- `wood_bias` lower calls more points wood.

## Organs (`segment_organs` → `plant_organ`, `leaflet_id`)

- `plant_organ` is 1 soil, 2 stem, 3 leaf.
- It is for herbaceous dicots only, not trees, grasses or cereals.
- Leaflets under ~3 cm merge.
- Expect ~0.85 mIoU and ~0.78 leaflet F1.
- Pass `units="m"` for an imported cloud.
