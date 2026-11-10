---
name: phytograph
description: Process LiDAR point clouds of plants and trees headless with the phytograph Python package - clean, segment ground/trees/wood/organs, DEM and heights, QSM, skeleton, inventory, registration, leaf area density. Use when a task needs measurements from a point cloud (.las/.laz/.e57/.ply/.pcd/.ptx/.xyz) or a cloud from a simulation reduced the way a real scan would be.
---

# Phytograph from Python

The `phytograph` package drives the processing engine of the Phytograph desktop app from a
script. The package is a thin client: `pg.Backend()` starts a private engine process and talks to
it over loopback HTTP. The engine is a ~400 MB download, fetched once per version and cached; set
`PHYTOGRAPH_BACKEND_CACHE` to put that cache somewhere specific, or run
`python -m phytograph download` ahead of time. This skill matches the package version it ships in.

```python
import phytograph as pg
from phytograph import recipes

with pg.Backend() as be, be.open("plot.laz") as cloud:
    n, rec = recipes.plot_trees(cloud)       # ground -> DEM -> stem seeds -> trees
    inv, rec2 = recipes.plot_inventory(cloud)
    print(n, inv.trees[0]["dbh_m"], rec2.advisories)
```

Every tool has an explicit signature: read `help(pg.Cloud.qsm)` (or any tool) for its
parameters, units, defaults and which way to move them. A misspelled keyword, or one the chosen
`method` does not use, raises at once and names the valid ones. Never guess a parameter name.

## Start from a recipe, not from the tools

`phytograph.recipes` holds the sequences an expert runs the same way every time. Each one uses
the app's settings where the bare API's default differs, checks its own result, and returns a
`RecipeRecord` (`.to_dict()` is JSON) saying what ran, with what, on which version, and what
each step reported. Keep the record beside the outputs. `RecipeError` means the result failed a
check, and its message says what to change. Read `rec.advisories`: they are the warnings the app
would show as toasts, and the API shows them nowhere else.

| Recipe | For | Notes |
|---|---|---|
| `clean(cloud)` | outliers, per scan | Refuses above 20% flagged; real noise is 0.1-3%. |
| `ground_and_heights(cloud)` | `ground_class`, `height_above_ground`, DTM | Measures the ground tolerance from the scan. |
| `plot_trees(cloud)` | `tree_instance` in a plot | Stem seeds from breast height, then TreeIso. |
| `plot_inventory(cloud)` | DBH, height, crown per tree | Counts the per-tree flags. |
| `tree_qsm(cloud)` | QSM of ONE tree | Ground off, ML wood, thinned to 60 000, then the QSM. |
| `register_pair(moving, target)` | align two scans | Global, then ICP. Judged by RMSE against size. |
| `herbaceous_organs(cloud)` | `plant_organ`, `leaflet_id` | One dicot plant, at about 3 mm spacing or finer. |

Use the tools on `Cloud` directly only for what no recipe covers, and then follow the order
below.

## Rules that hold for every tool

- **Units.** Everything is meters after import. A file with no unit information is read as
  meters, so pass `be.open(path, source_units="mm")` for a millimeter scan. A cloud imported in
  the wrong units is wrong in every later step, and nothing warns. Compare
  `cloud.defaults()["robust_extent"]` (m) with the plant's real size before going on.
- **Multiple scans.** `be.open()` raises on a multi-scan E57 or multi-block PTX. Use
  `be.open_scans()` for one cloud per scan (each keeps its scanner pose), or `scan_index=i`.
- **Results are columns, not new clouds.** Segmentation never deletes points. Isolate a class
  with `cloud.extract(where={"wood_class": [pg.WOOD]})`, `filter(...)` (in place) or
  `split("tree_instance")`, which skips 0 by default.
- **Edits are permanent in the session and never touch the file.** `export()` what you keep.
- **Sky/miss points** (beams that hit nothing) are excluded from every tool except `be.lad()`,
  which needs them. `cloud.info()["row_count"] > len(cloud)` means misses are present.
- **World coordinates everywhere.** The import shift is handled for you, for seeds, boxes and
  results alike.
- **The cost gate** confirms costly jobs automatically. `pg.Backend(confirm_costly=False)` raises
  `pg.CostWarning` with the estimate instead; use it when a budget matters.

## Where the API's defaults are not the app's

The recipes already correct the first two. Correct them yourself when calling the tools directly.

| Tool | API default | App default, and what to pass |
|---|---|---|
| `segment_ground` | `auto_class_threshold=False` | measured: `auto_class_threshold=True` |
| `segment_wood` | `method="sota"` (wood IoU ~0.61) | `method="ml"` (~0.80) |
| `skeleton` | `search_radius=0.05` m | auto radius: `search_radius=0` |
| `skeleton` | `threshold_filter=30` | the app's block minimum: `threshold_filter=5` |
| `be.lad` | `lmax=0.1` m fixed | the app estimates it; set `lmax` for the scene's spacing |
| `cloud.qsm` | no thinning, refuses above 3 000 000 points | thin to ~60 000 first (`tree_qsm` does) |

## Order of operations

1. **Clean**, per scan, before registering or merging: `denoise(method="ror")`, then filter on
   `noise_class`. Run `sor` once only, because it removes more on every pass. Doubled surfaces are
   a registration error, not noise.
2. **Register**: `global` for no initial pose, `icp` to polish a pose already within ~10 cm and a
   few degrees. Never trust `fitness`. A zero error can mean no overlap. On a built scene, pass
   `scene_type="urban"` or `scene_type_confirmed=True`. Loop closure over 3+ scans and stitching
   exist only in the app.
3. **Ground** (`segment_ground`) and then **DEM** with `add_height_column=True`. Stem detection
   and the inventory both need `height_above_ground`. Use `fill_voids=True` under closed canopy.
   A grid above ~4 000 000 cells is refused, so raise `cell_size`.
4. **Trees**: `detect_stems()` (1-2 m layer) as seeds, then `segment_trees(seeds=...)`.
   - TreeIso for terrestrial or mobile scans with visible trunks; `method="chm"` for airborne or
     closed canopy.
   - Re-segmenting renumbers the trees.
5. **Wood/leaf** before any QSM or skeleton, and before thinning.
6. **Per-tree products**: `tree_inventory`, `tree_qsms` (failures are Python *warnings* and the
   tree is left out; catch them), `qsm` and `skeleton` on one extracted tree.

## Reading results: load the reference you need

Each file says what a good result looks like, what failure looks like, and which parameter to
move. Read the one for the tool you ran before reporting its numbers.

- [references/segmentation.md](references/segmentation.md): ground, trees, wood, organs.
- [references/qsm-and-skeleton.md](references/qsm-and-skeleton.md): QSM units and metrics,
  inferred radii, skeleton spurs and gaps.
- [references/inventory.md](references/inventory.md): the per-tree flags and breast height.
- [references/lad.md](references/lad.md): leaf area density inputs and its traps.
- [references/not-in-the-api.md](references/not-in-the-api.md): what only the app does, and the
  workarounds.

## When something here is wrong

The fix belongs in this package: a recipe, its check, or this skill. Do not work around it in the
calling project. Open an issue or PR on PlantSimulationLab/Phytograph with what you ran (the
recipe record) and what you saw.

If you were tripped up while using the package (a misread unit, a wrong call order, a silent bad
result, an error message that did not say what to do), end your response to the user with a
**candidate addition to the phytograph skill**: one line, worded as it would appear here. Do not
edit the skill yourself; the user decides what goes in.
