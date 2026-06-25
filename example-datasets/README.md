# Benchmark datasets (tree-segmentation eval)

This folder holds the ground-truth benchmark clouds used to quantitatively
evaluate TreeIso individual-tree segmentation. The data is **not committed**
(large; CC-BY but not redistributable here) — everything except this README is
gitignored. Download the sets you want into this folder, then run the harness.

## E57 sky/miss test scans (LAD)

Real structured terrestrial scans from the libE57 reference dataset, for testing
E57 import + sky/miss recovery for the leaf-area-density inversion. Both are the
same scene (a 345×1074 grid = 370,530 cells; 155,201 returns + 215,329 sky/miss
cells), differing only in how the misses are encoded:

| File | Miss encoding | On import |
|---|---|---|
| `pumpASpherical.e57` | spherical angles | all 215,329 misses **placed** at 20 km (works fully today) |
| `pumpARowColumnIndex.e57` | cartesian grid (misses zeroed) + `rowIndex`/`columnIndex` | misses **kept + flagged** `is_miss=1`, directions recovered from the grid in Helios C++ |

Source: [libE57 example data](https://sourceforge.net/projects/e57-3d-imgfmt/files/E57Example-data/)
(`pumpA*` variants). Gitignored like the rest of this folder; re-download with:

```bash
curl -L -o example-datasets/pumpASpherical.e57 \
  "https://sourceforge.net/projects/e57-3d-imgfmt/files/E57Example-data/pumpASpherical.e57/download"
curl -L -o example-datasets/pumpARowColumnIndex.e57 \
  "https://sourceforge.net/projects/e57-3d-imgfmt/files/E57Example-data/pumpARowColumnIndex.e57/download"
```

## Moving-platform trajectory files

Example platform trajectories for testing moving-platform scans (drone / UAV / mobile
mapping). Attach one in the **Add Scan** popup → **Import trajectory file…**. All
describe the same illustrative UAV pass; they exercise the different import paths:

| File | Format | Path | Notes |
|---|---|---|---|
| `drone_pass_trajectory.csv` | text, quaternion | in-app | `t x y z qx qy qz qw` |
| `drone_pass_trajectory_euler.csv` | text, Euler (radians) | in-app | `t x y z roll pitch yaw` |
| `drone_pass_trajectory_syssifoss.txt` | text, Euler (**degrees**), tab-sep | in-app | HELIOS++ / SYSSIFOSS export form; degrees are auto-detected |
| `drone_pass_trajectory.sbet` | binary Applanix SBET | backend | 500 poses near Heidelberg → projected to UTM zone 32N |
| `drone_pass_trajectory.smrmsg` | SBET accuracy companion | backend | place beside the `.sbet`; surfaces a position-RMS QC note |
| `drone_pass_beam_origins.las` | LAS with per-beam-origin ExtraBytes | — | `ox`/`oy`/`oz` per-pulse origins; LAD uses them directly and skips the trajectory join |

Notes:

- **SBET** (`.sbet`/`.out`) is parsed on the backend (it needs `pyproj` for the
  geographic→UTM projection). Its latitude/longitude are projected to UTM and the NED
  attitude converted to Phytograph's ENU frame. The `.smrmsg` companion is optional.
- **`drone_pass_beam_origins.las`** demonstrates the ExtraBytes-origin path: import it as
  a point cloud and it auto-creates a **moving-platform scan** — the backend reconstructs a
  decimated platform trajectory from the per-pulse `ox/oy/oz` origins (ordered by
  `gps_time`), so the scan is flagged moving with its path drawn. Moving-platform LAD then
  uses the exact per-pulse origins as ground truth.
- These `drone_pass_*` files are **small synthetic format samples** (a clean straight
  UAV pass; the trajectories are not tied to a committed point cloud). For an end-to-end
  moving-LAD numerics check, see the committed E2E fixture
  `tests/e2e/fixtures/lad-leafcube-moving/`. For a **real, processable** aerial dataset,
  see the SYSSIFOSS BR04 section below.

## Real aerial dataset — SYSSIFOSS BR04 (testing all three origin paths)

A real airborne LiDAR plot from the SYSSIFOSS project (Weiser et al. 2022, central
European forest near Bretten, Germany), used to exercise the three ways origin
information can enter Phytograph on **genuine drone/aircraft data** (not toy fixtures).

Source: PANGAEA [doi:10.1594/PANGAEA.942856](https://doi.pangaea.de/10.1594/PANGAEA.942856),
plot **BR04** (`BR04.zip`, 5.58 GB), licence **CC-BY-SA-4.0**. Frame: ETRS89 / UTM
zone 32N (EPSG:25832). The full zip is not kept here (gitignored anyway); re-download
and extract the ALS cloud + trajectory with:

```bash
curl -L -o example-datasets/BR04.zip \
  "https://download.pangaea.de/dataset/942856/files/BR04.zip"
unzip -o -j example-datasets/BR04.zip \
  "ALS/ALS-on_BR04_2019-07-05_140m.laz" \
  "ALS/ALS-on_BR04_2019-07-05_trajectory.txt" -d example-datasets/
rm example-datasets/BR04.zip   # optional: the two extracted files are all we need
```

| File | Path tested | Notes |
|---|---|---|
| `ALS-on_BR04_2019-07-05_140m.laz` | — (base cloud) | Real ALS: **2.64 M pts**, up to 7 returns, per-point `gps_time`, full-waveform `Amplitude`/`Reflectance`/`Deviation`. Ground/canopy Z ≈ 245–327 m |
| `ALS-on_BR04_2019-07-05_trajectory.txt` | **3. sidecar trajectory** | Real flight path, 5 376 poses, native PANGAEA form: header `Easting Northing Height Time Roll Pitch Yaw` (deg, tab-sep), position-first. **Imports directly** — the importer maps columns by their header names. Import via Add Scan → Import trajectory file |
| `ALS-on_BR04_2019-07-05_trajectory_phytograph.txt` | **3. sidecar trajectory** | Same poses pre-reordered to time-first `t x y z roll pitch yaw`. No longer required (the raw file imports natively); kept as a plain-`t`-first sample |
| `BR04_ALS_origins.las` | **1. LAS `ox/oy/oz`** | 200 k-pt real subset; per-point sensor origin (interpolated from the real trajectory at each point's `gps_time`) written as **float64** `ox/oy/oz` ExtraBytes. Origins sit at the ~953–961 m sensor altitude |
| `BR04_ALS_origins.xyz` | **2. ASCII `ox/oy/oz`** | Same 200 k subset as plain text, header `# x y z timestamp return_number number_of_returns ox oy oz`. Auto-detect maps `ox/oy/oz` → beam-origin roles; origins are kept float64 (not float32 extras) and feed LAD |

Notes:

- The SYSSIFOSS/HELIOS++ *export* form is position-first (`Easting Northing Height Time
  …`). The importer now reads the labeled header and maps columns by name, so the raw file
  imports as-is; a headerless file still falls back to positional time-first `t x y z …`.
  The `_phytograph.txt` companion (a pre-permuted time-first copy) is kept only as a plain
  sample and is no longer needed.
- `BR04_ALS_origins.las` / `.xyz` are **derived** (their `ox/oy/oz` come from interpolating
  the real trajectory at each point's `gps_time`, lever-arm ≈ 0). Regenerate them from the
  base cloud + trajectory with `scripts/make_br04_origin_fixtures.py`.
- All three paths are verified end-to-end against the live backend: the ASCII path captures
  `ox/oy/oz` as float64 `beam_origins` to <1 mm (not the lossy float32 extras), matching the
  LAS ExtraBytes path.

## Datasets

| Dataset | Sensor | Trees | License | Download |
|---|---|---|---|---|
| **FOR-instance** | UAV/ALS LiDAR | 1,130 | CC BY 4.0 | Zenodo `10.5281/zenodo.8287792` |
| **Cherlet TLS benchmark** | TLS | 2,983 / 4 plots | CC BY 4.0 | Zenodo `10.5281/zenodo.14615493` |
| Wytham Woods (supplement) | TLS | 876 | CC BY 4.0 | Zenodo `10.5281/zenodo.7307956` |

Ground-truth instance labels:
- **FOR-instance**: `.las/.laz` with a `treeID` extra dimension (+ semantic class).
- **Cherlet**: `.ply` with scalar fields `instance` (1..N, `-1` = ground) and
  `semantic` (0 ground, 1 tree).

## Run the harness

```bash
# from the repo root, with the backend venv active (or use its python directly)
python backend-api/scripts/eval_tree_segmentation.py example-datasets/for-instance/
python backend-api/scripts/eval_tree_segmentation.py example-datasets/cherlet/plot1.ply
```

The script auto-detects the format and the GT instance field, drops ground
points (`--ground-ids 0,-1` by default), runs TreeIso, and prints per-file and
mean **precision / recall / F1** (IoU-matched at `--iou 0.5`), **coverage**
(mean IoU of matched trees), and **over/under-segmentation** counts.

Large plots are slow; use `--max-points` to voxel-downsample for a quick read,
and `--reg-strength2` / `--max-gap` to sweep the key TreeIso parameters.

## Expected ballpark

TreeIso is a classical baseline: roughly **F1 ~0.6–0.7 on dense FOR-instance**
forest and higher on well-separated / structured plots (per Xi & Hopkinson 2022
and the ForAINet comparison). Treat these as a regression baseline, not SOTA —
deep-learning methods score higher on the hard dense-canopy case.
