# Scripting with Python

The `phytograph` Python package runs Phytograph's point-cloud processing from a
script, with no window. Use it for batch jobs over many files and for
reproducible pipelines.

!!! note "Early version"
    Scripts can import, edit and export clouds and run the main analysis tools:
    normals, ground, DEM, denoise, tree, wood and organ segmentation,
    inventory, QSM, skeleton, triangulation, crown fitting, registration and
    LAD. Opening and saving `.phyto` projects, and the in-app scripting window,
    are planned for later.

## Install

```bash
pip install phytograph
```

That's all you need; the desktop app doesn't have to be installed. The package
itself is small (it depends only on `httpx` and `numpy`). The first time a
script starts, it downloads Phytograph's processing engine for your computer,
about 400 MB. It checks the download against a fingerprint built into the
package, stores it in your user cache, and reuses it from then on:

| System | Engine cache |
|---|---|
| macOS (Apple Silicon or Intel) | `~/Library/Caches/Phytograph/backend` |
| Windows 10/11 (x64) | `%LOCALAPPDATA%\Phytograph\cache\backend` |
| Linux (x64, glibc 2.38 or newer: Ubuntu 23.10+/24.04, Debian 13, Fedora 39+) | `~/.cache/Phytograph/backend` |

To download it ahead of time, for example before working offline, run:

```bash
python -m phytograph download
```

`python -m phytograph where` shows which engine your scripts will use.

When scripts run from a Phytograph source checkout, the engine recompiles its
native library the first time it starts after the C++ sources change. That can
take a few minutes. The script prints `Phytograph engine: [pyhelios] …` lines
while it does, rather than waiting silently.

**If you already have the app,** and its version matches the package, scripts
use the app's engine and nothing is downloaded. The app also includes the
matching package. You can install it from there instead of PyPI, for example
`pip install /Applications/Phytograph.app/Contents/Resources/resources/python/phytograph-*.whl`
on macOS.

**On a machine with no internet** (an HPC compute node, for example), copy two
files from the [release page](https://github.com/PlantSimulationLab/Phytograph/releases):
`phytograph-backend-<version>-<system>.tar.gz` (`.zip` on Windows) and the
`.sha256` file next to it. Then install the archive from where you copied it:

```bash
python -m phytograph download --archive phytograph-backend-0.98.0-linux-x64.tar.gz
```

**Versions.** The package and the engine version always match. Engines are
kept for download for the two newest releases. To run an older pinned version
(`pip install phytograph==X`), you need either a Phytograph app of that version
or that engine already downloaded. Otherwise the script stops and tells you how
to upgrade.

## A first script

```python
import phytograph as pg

with pg.Backend(progress=True) as be:
    cloud = be.open("plot.laz")
    print(len(cloud), "points; columns:", cloud.columns)

    # Keep a 20 m x 20 m square, from the ground up to 40 m (world coordinates).
    cloud.crop([0, 0, -5], [20, 20, 40])

    # Keep the bright returns only.
    cloud.filter(where={"intensity": (0.2, None)})

    cloud.export("plot-clean.laz")
```

`pg.Backend()` starts a private processing engine in the background. The engine
shuts down when the `with` block ends, and also if the script crashes or you
press Ctrl-C.

## Working with clouds

| Call | What it does |
|---|---|
| `be.open(path)` | Import LAS/LAZ/E57/PLY/PCD/PTX/XYZ with the same importer the app uses. Accepts `world_shift=[x, y, z]` and `source_units="ft"`, like the import wizard. A file holding several scan positions (multi-scan E57, multi-block PTX) is not merged into one cloud: pass `scan_index=i` to get one scan. |
| `be.from_numpy(xyz, colors=..., intensity=..., timestamp=..., columns={...})` | A cloud made from arrays you already have, such as simulation output or points edited with NumPy. `xyz` is `(N, 3)` in world coordinates; colors and intensity are 0–1 (uint8/uint16 colors are rescaled). Each entry in `columns` becomes a per-point column, and `{"is_miss": ...}` marks sky/miss points as on an imported scan. Rows keep their order, so a tool's result column lines up with your input arrays. |
| `be.open_scans(path)` | One cloud per scan position, each with its own scanner pose, as the app does. Any other file gives a list of one. |
| `len(cloud)`, `cloud.columns`, `cloud.info()` | Point count (sky/miss points not counted), scalar column names, and details, including `source_units` (the unit you imported with) and each column's source type. |
| `cloud.positions` | An `(N, 3)` NumPy array of world coordinates, as float64. |
| `cloud.to_numpy()` | Positions, colors, intensity, and every scalar column, all in the same row order. A column comes back in the type its source file declared (a PLY `int` is `int32`), else `int32` for whole numbers, so the same column has the same dtype from every file. |
| `cloud.column("ground_class")` | One scalar column, in the same row order as `positions`. |
| `cloud.crop(min, max, invert=False)` | Keep the points inside a box, or outside it with `invert=True`. |
| `cloud.filter(box=..., where={...})` | Keep only the points that pass. In `where`, a tuple `(lo, hi)` is an inclusive range (use `None` for an open end), and a list such as `[1, 2]` matches those class numbers. Intensity is 0–1 here, the same as when you read it. |
| `cloud.extract(...)` | Same arguments as `filter`, but returns the selected points as a **new** cloud and leaves this one unchanged. |
| `cloud.split("tree_instance")` | One new cloud per class value, as `{value: Cloud}`. Value 0 is skipped by default. |
| `cloud.transform(m)`, `cloud.translate(dx, dy, dz)` | Move the cloud with a 4×4 matrix in world coordinates. Rotation, translation and positive scaling are allowed; mirroring is not. |
| `cloud.export(path, columns=[...], las_scale=None)` | Write LAS/LAZ/XYZ/TXT/CSV/PLY. The format comes from the file extension. LAS/LAZ keep the grid the points are already on, else 10 µm; pass `las_scale=0.001` (meters) for a smaller file on a 1 mm grid. Integer columns are written as integers. |
| `cloud.close()` | Free the cloud's memory. A `with` block does this for you. |

**Units.** Clouds are in meters once imported. A file with no unit
information is read as meters, so pass `source_units` (`"mm"`, `"cm"`, `"ft"`,
…) for anything else; `cloud.info()["source_units"]` records what you chose.

**Coordinates are always world coordinates.** If you import with a large
`world_shift` (UTM coordinates, for example), you still crop with, read and
export real-world values. The script never sees the shift.

**Sky/miss points** (beams that hit nothing) are left out of `positions`,
`to_numpy()` and every tool by default, just as in the app. To get them, pass
`to_numpy(include_misses=True)`. `export` writes them, so a round trip keeps
everything you imported.

## Analysis tools

A forest plot, from file to tree list:

```python
import phytograph as pg

with pg.Backend(progress=True) as be:
    plot = be.open("plot.laz")
    plot.segment_ground()                    # adds the ground_class column
    plot.dem(add_height_column=True).to_raster("dtm.tif")
    plot.segment_trees(seeds=plot.detect_stems())   # adds tree_instance
    plot.tree_inventory().to_csv("trees.csv")       # DBH, height, crown, ...
    for tree_id, qsm in plot.tree_qsms().items():
        qsm.to_csv(f"qsm-{tree_id}.csv")
```

Each segmentation tool writes its result as a **column** on the cloud, just as
the app does. Read the column with `cloud.column(...)`, filter on it, or split by
it. Parameters you leave out get the values the app would fill in. For ground,
DEM and tree segmentation those values are based on the size of this cloud;
`cloud.defaults()` shows them.

| Call | Result |
|---|---|
| `cloud.compute_normals()` | Columns `nx`, `ny`, `nz`, `curvature`, `verticality`. |
| `cloud.segment_ground()` | Column `ground_class`: `pg.GROUND` (1) or `pg.NON_GROUND` (2). |
| `cloud.dem(cell_size=..., surface="dtm"/"dsm", add_height_column=False)` | A `DEM`: `.z` grid (NaN in empty cells), `.origin`, `.cell_size`, `.mesh`, `.layers` (slope, aspect, …). Write it with `.to_raster("dem.tif")` or `.asc`. `add_height_column=True` also adds a `height_above_ground` column. |
| `cloud.denoise(method="ror"/"sor")` | Column `noise_class` (`pg.NOISE` = 2). No points are deleted; use `filter(where={"noise_class": [pg.NOISE_CLEAN]})` to remove the flagged points. |
| `cloud.detect_stems()` | An `(N, 3)` array of trunk positions at breast height. Needs `height_above_ground`, so run `dem(add_height_column=True)` first. |
| `cloud.segment_trees(seeds=None, method="treeiso"/"chm")` | Column `tree_instance` (0 = ground or unassigned). Run `segment_ground()` first. |
| `cloud.segment_wood()` | Column `wood_class`: `pg.WOOD` (1) or `pg.LEAF` (2). |
| `cloud.segment_organs()` | Columns `plant_organ` and `leaflet_id` (uses an ML model). |
| `cloud.tree_inventory()` | An `Inventory`: `.trees` (one dict per tree: `dbh_m`, `height_m`, `stem_base`, lean, crown, …), `.stem_curve`, `.stand`. Write it with `.to_csv()`. |
| `cloud.tree_qsms()` | `{tree_id: QSM}`, one QSM per segmented tree. |
| `cloud.qsm()` | A `QSM` of the whole cloud as one tree: `.cylinders`, `.metrics` (height, trunk diameter, woody volume, …), `.to_csv()`. |
| `cloud.skeleton()` | A `Skeleton`: `.points` `(N, 3)`, `.edges` `(M, 2)`. |
| `cloud.triangulate(method="ball_pivoting"/"poisson"/"alpha_shape"/"delaunay")` | A `Mesh`: `.vertices`, `.faces`, `.area`, `.to_ply()`, `.to_obj()`. |
| `cloud.fit_crown("ellipsoid"/"prism"/"cone"/"alpha")` | Crown envelopes with their volume and area. |
| `cloud.register_to(target, method="icp"/"global")` | Moves this cloud onto `target` and returns a `Registration` holding the 4×4 `.matrix`, `.fitness` and `.rmse`. Pass `apply=False` to compute the alignment without moving the cloud. |

### Leaf area density

LAD needs the sky/miss points, because they are the beams that passed through
the canopy. It also needs the geometry of each scan. You can find this in the
scanner's metadata or in a Helios scan XML file.

```python
cloud = be.open("leafcube.xyz", ascii_format="x y z is_miss", origin=[-5, 0, 0.5])
scan = pg.Scan(cloud, origin=[-5, 0, 0.5], n_theta=2600, n_phi=5200,
               theta=(0, 180), phi=(0, 360))
grid = pg.Grid(center=[0, 0, 0.5], size=[1, 1, 1], n=[2, 2, 2])
res = be.lad([scan], grid)
res.lad              # (nx, ny, nz) array in m²/m³
res.total_leaf_area
res.to_csv("lad.csv")   # one row per voxel
```

## Long runs, cancel and cost warnings

- `pg.Backend(progress=True)` shows a progress bar if `tqdm` is installed, and
  prints one line per step otherwise. You can also pass your own
  `callback(fraction, message)`.
- **Ctrl-C** always stops your script, and it also cancels the work in the
  engine for import, filter, split, export and the analysis tools. Two quick
  edits, `extract` and `transform`, still finish in the engine even if you
  interrupt them.
- Some heavy tools first estimate how long they will take, and the app asks you
  before running a long job. A script goes ahead by default. To get an error
  instead, use `pg.Backend(confirm_costly=False)`; the error is
  `pg.CostWarning`, and it includes the estimate.

## Where the engine comes from

`pg.Backend()` looks for an engine in this order:

1. `pg.Backend(executable=...)` or the `PHYTOGRAPH_BACKEND_EXE` environment variable.
2. A Phytograph source checkout that contains the package, using its `backend-api/venv`.
3. An installed Phytograph app **of the same version**:
    - macOS: `/Applications/Phytograph.app`
    - Windows: `%LOCALAPPDATA%\Programs\Phytograph`
    - Linux: an extracted AppImage (`squashfs-root/`) in your home folder
4. An engine downloaded earlier.
5. Otherwise, it downloads one (see [Install](#install)).

Pass `pg.Backend(source="download")` to always use the downloaded engine, or
`source="app"` to require the installed app.
