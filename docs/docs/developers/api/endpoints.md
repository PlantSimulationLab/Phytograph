# HTTP Endpoints

All endpoints listed below are served by `backend-api/main.py` on
`http://127.0.0.1:<backend-port>` — the port is chosen dynamically per app
instance (see [Processes & IPC](../architecture/processes.md#port-wiring)).
The tables are grouped by feature area. To find a handler, grep `^@app\.` in
`main.py`.

## Health & metadata

| Method | Path | Source | Purpose |
|---|---|---|---|
| GET | `/` | `main.py` | Root ping |
| GET | `/health` | `main.py` | Liveness probe |
| GET | `/version` | `main.py` | Returns `BACKEND_VERSION` (used by the supervisor) |
| GET | `/api/device-info` | `main.py` | Reports whether synthetic-scan ray tracing runs on **GPU** or **CPU**. Shipped Windows/Linux builds always contain the CUDA path (the release CI fails otherwise) and macOS never does, so the path is decided by a runtime probe for a usable NVIDIA GPU (`gpu_present`/`gpu_count`/`gpu_name`/`driver_version`, via `pyhelios.runtime.get_gpu_runtime_info` — mainly `nvidia-smi`). `effective_path` is `"gpu"` when a GPU is present on a non-macOS host, else `"cpu"` (Helios falls back to CPU/OpenMP; cudart is statically linked so a GPU build still runs driverless). `reason` is a human-readable explanation. The renderer surfaces this as the GPU/CPU pill in the Synthetic Scan Options dialog |

## Curve / surface fitting

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/fit` | `main.py` | Fit a built-in model to data |
| GET | `/api/models` | `main.py` | List available fitting models |
| POST | `/api/fit/custom` | `main.py` | Fit a user-supplied model expression |
| POST | `/api/fit/prospect` | `main.py` | PROSPECT leaf optical model |
| POST | `/api/fit/crown` | `main.py` | Fit crown shapes + derive per-tree metrics. Streams PHP1 progress ahead of a JSON tail (one entry per fitted crown: mesh arrays, a `metrics` block, and a shape-dependent `params` block giving the fit's defining parameters); cancelable via the run-id token |

## LaTeX & export

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/latex` | `main.py` | Render expressions to LaTeX |
| GET | `/api/latex` | `main.py` | Retrieve a previously rendered expression |
| POST | `/api/export` | `main.py` | Export fit results |

## Meshing & sampling

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/triangulate` | `main.py` | Triangulate a point cloud |
| POST | `/api/triangulate/helios` | `main.py` | Helios-style triangulation. Each `scans[]` entry carries its own acquisition geometry (`origin`, `n_theta`/`n_phi`, `theta_min`/`max`, `phi_min`/`max`); an optional `grid` (center/size + `nx`/`ny`/`nz`) comes from a voxel box. With no `grid` the backend auto-fits a single cell over all points and sets `grid_warning` on the response. Each scan is triangulated independently, so the response includes `triangle_scan_ids` — the source scan index per triangle — for coloring by scan |
| POST | `/api/lidar/scan` | `main.py` | True ray-traced synthetic LiDAR scan via the PyHelios `lidar` plugin. `meshes[]` carry world-space `vertices`/`triangles` (+ optional per-vertex `colors`); `scanners[]` carry each scanner's renderer `id` plus its `ScanParameters` (`origin`, `n_theta`/`n_phi`, `theta_min_deg`/`max`, `phi_min_deg`/`max`, `return_mode` (`single`/`multi`), `max_returns` (multi), `return_selection` (`strongest`/`first`/`last`, single), `exit_diameter_m`, `beam_divergence_mrad`). A legacy `return_type` (`single`/`multi`) is still accepted and mapped to `return_mode`. Optional `extra_fields[]` names custom primitive-data labels to sample onto hits (column-format driven). All meshes load into one Helios `Context`; scanners are added in order so the Helios scanID equals the request index, and each scan's stored `ReturnMode`/`maxReturns`/selection is set via the per-scan setters. `syntheticScan` ray-traces once (one global `rays_per_pulse`: every scan fires that many sub-rays across its beam cone, and `rays_per_pulse=1` collapses the cone to one exact ray per pulse — the idealized scan) and hits are partitioned back per scanner via `getHitScanID`. Optional `synthetic_scan_memory_budget_mb` caps the transient ray-tracing scratch buffers (via `LiDARCloud.setSyntheticScanMemoryBudget`) so a large fan-out is chunked instead of traced in one OOM-prone batch; omitted/`null`/≤0 leaves Helios's automatic path-dependent default (4 GiB CPU / 8 GiB GPU) in place, and chunking is result-invariant. Returns `results[]` — one per scanner (`scanner_id`, `points`, `colors`, and `scalars{}`: intensity/distance/timestamp/target_index/target_count read via `getHitData`) — occlusion-aware, unlike random surface sampling |
| POST | `/api/mesh/import` | `main.py` | Parse a textured `.obj` (+ sibling `.mtl` + images) or a `.ply` polygon mesh (ASCII or binary, with per-vertex colour) from a disk `path` into geometry, V-flipped per-vertex UVs, per-material triangle groups, and base64-encoded textures. Returns a **PHB1** binary frame: geometry rides in the buffers (`vertices`, `indices`, and optional `normals`/`colors`/`uv_coordinates`) while materials/textures ride in the JSON meta. JSON would break here — a scanner-grade mesh (millions of triangles) serializes past V8's ~512 MB string cap, where the renderer's `response.json()` throws `ERR_STRING_TOO_LONG` regardless of timeout |
| POST | `/api/triangulate/check-spacing` | `main.py` | Opt-in diagnostic cross-checking the auto-estimated `Lmax` against actual in-grid point spacing (the renderer offers it when the Otsu indicators aren't both High). Builds a KD-tree over up to tens of millions of points, so it streams keepalive whitespace to survive WebKit's ~60s stall timeout, then yields the JSON verdict. Reuses `HeliosTriangulationRequest` |

## Scanning support & job control

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/scan/export-xml` | `main.py` | Export objects to a Helios XML + per-scan data bundle (or, with `write_xml: false`, one data file per object in `data_format`). Entries need only `origin` + a point source — the Export window lists every cloud, so a plain import with no scan geometry exports fine to the data formats (only the XML bundle and PTX need the sweep/grid, and the UI blocks those rows). **Streams PHP1 progress markers** ahead of its JSON tail, one per object (weighted by point count), and is **cancellable** via `/api/cancel/{run_id}` — a cancel unlinks the files it had already written so a partial batch never looks complete. Set **`dest_dir`** (absolute) and the backend writes every file itself, returning metadata only with `data: null` and `written: true` — the app always does this, and it's the only form that works for more than one scan: this response carries *every* selected scan at once, so base64 (~1.33x inflation) overruns V8's ~512 MB string cap in the renderer's `response.json()` and fails as "Unexpected end of JSON input" — the same trap as `dest_path` on `/api/pointcloud/export`, but reached sooner because the payload scales with the number of scans. Omitting `dest_dir` keeps the legacy base64-in-`data` response for callers with no filesystem destination |
| POST | `/api/trajectory/parse` | `main.py` | Parse a **binary** trajectory (SBET `.sbet`/`.out`) into the canonical PoseStream wire dict. Server-side because it needs `pyproj` for the geographic→UTM projection. Text trajectories (`.csv`/`.txt`/`.tsv`/`.traj`) are parsed in the renderer and never reach this endpoint |
| POST | `/api/cancel/{id}` | `main.py` | Cancel an in-flight streaming op (point-cloud import / synthetic scan / triangulation / LAD / DEM / crown fit / point-cloud + object export). Streaming endpoints emit their `run_id` as the first PHP1 marker; POSTing it here stops the work and frees the C++/numpy memory without waiting for the computation to finish. Idempotent — an unknown or already-finished id returns `cancelled: false` rather than an error |

## Skeleton extraction

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/skeleton/extract` | `main.py` | Extract a topological skeleton |

## QSM (Quantitative Structure Model)

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/qsm/build` | `main.py` | Reconstruct a dormant tree as connected cylinders with radii + topology, segment continuous shoots, and classify them by **shoot rank** (trunk=0, scaffolds=1, …) |
| POST | `/api/qsm/import` | `main.py` | Read a QSM back from a per-cylinder CSV (`qsm/csv_io.py`), reconstructing the shoot table and recomputing metrics. Returns the same `QSMBuildResponse` shape as `/api/qsm/build`, so an imported QSM needs no separate renderer path |
| POST | `/api/qsm/phyllotaxis` | `main.py` | Auto-detect the phyllotactic angle from the QSM's branching geometry (child-shoot azimuths around each parent). Returns a canonical angle + pattern + leaves-per-node + confidence; pre-fills the Add Leaves modal |
| POST | `/api/qsm/leaves` | `main.py` | Place leaves on the QSM's terminal shoots and return a textured mesh |
| GET | `/api/qsm/leaf-textures` | `main.py` | List the curated built-in leaf textures available for QSM leaf placement |
| POST | `/api/qsm/adjust-leaf-angles` | `main.py` | Rotate placed leaves so each voxel cell's leaf-angle distribution matches a target measured from a leaf-on triangulation, via per-cell optimal assignment. Takes either a `triangulation` or precomputed `cell_targets` |

Takes inline `points` or a `source` descriptor (octree-backed clouds). The full
pipeline lives in the `qsm/` package and is a thin call from the endpoint:
geodesic level-set **skeleton** → **segment** tree + GrowthLength continuation +
**shoot rank** (largest-GrowthLength axis continuation; trunk=0) → robust IRLS
**cylinder fit** + SurfCov/mad → monotone-taper **radius correction** (anchored to
a per-species `twig_radius_mm`, default 4.23 mm) → horticultural **metrics**.

Returns `cylinders[]` (each with `start`/`end`/`radius`/`parent_id`/`shoot_id`/
`rank`/`surf_cov`/`mad`), `shoots[]` (continuous axes with `rank` + parent/child
links), and a `metrics` block (TCSA, trunk diameter, height, scaffold count, woody
volume split stem-vs-branch, plus per-rank length/diameter/crotch-angle). The
headline output is the per-shoot **rank** — topological branching order with axis
continuation (NOT Strahler). Validated against PyHelios ground-truth fixtures
(`backend-api/tests/qsm/`) on both determinate-trunk and central-leader
architectures.

## Ground segmentation

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/segment/ground` | `main.py` | Classify points into ground (1) / plant (2) via the Cloth Simulation Filter. Takes inline `points` or a `source` descriptor (read at full resolution — no downsampling, so labels align 1:1). Returns per-point `labels` + counts. Used for flat (in-memory) clouds; session clouds use `/api/cloud/session/{id}/segment_ground` instead |

The classifier is the `cloth-simulation-filter` package (`import CSF`), a
SWIG C-extension bundled via `collectAll` in `scripts/build-backend.mjs`.

## Tree segmentation

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/segment/trees` | `main.py` | Segment individual trees with **TreeIso** (cut-pursuit graph method, CPU-only). Takes inline `points` or a `source` descriptor (full resolution; labels align 1:1) and optional `seed_points` (trunk seeds for human-in-the-loop — each seed yields one tree). Returns per-point `labels` (`0` = unassigned, `1..N` = trees), `num_trees`, and a `ground_warning` flag. Used for flat clouds; session clouds use `/api/cloud/session/{id}/segment_trees` instead |

TreeIso is vendored (MIT) under `backend-api/vendor/treeiso/`; its graph-cut
backend `cut_pursuit_py` is bundled via `collectAll` in
`scripts/build-backend.mjs`. No GPU or PyTorch required.

## Wood / leaf segmentation

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/segment/wood` | `main.py` | Classify points into wood (1) / leaf (2) from local geometry. Aggregates multiple `sources` at full resolution (concatenated in order so labels slice back per source) and accepts optional per-point reflectance. Returns per-point `labels` aligned to input order. Session clouds use `/api/cloud/session/{id}/segment_wood` instead |

## DEM (digital elevation model)

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/dem` | `main.py` | Generate a DEM from a flat cloud (inline `points` / `source`). Returns a **PHB1** binary frame (heightmap mesh + regular grid); cancelable |
| POST | `/api/dem/export-raster` | `main.py` | Write a DEM grid to ESRI ASCII (`.asc`) or GeoTIFF (`.tif`), returned base64. The renderer round-trips the grid it got from `/api/dem`, with voids encoded as `nodata` (JSON can't carry NaN) and the origin shifted back to true-world coordinates. GeoTIFF uses `tifffile` (pure-Python — no GDAL) |

## Leaf area density

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/lad/compute` | `main.py` | Per-voxel leaf area density via PyHelios. Accepts either a JSON `LADComputeRequest` (fresh-triangulation path) or a **PHB1** binary frame carrying the request fields plus the mesh as raw buffers — the binary path lets a 1M+ triangle mesh ride back compactly to be injected via `setExternalTriangulation` instead of re-triangulated. Streams PHP1 progress ahead of the JSON result. **Requires misses** (see the admonition below) |
| POST | `/api/lad/snap-grid` | `main.py` | Sample a DEM under each voxel column so the grid can be displaced to follow the ground. Returns the authoritative per-column offsets (`column_offsets`) the UI renders and feeds to the inversion, plus `kept_columns` / `dropped_columns` |

## Plant models & sessions

| Method | Path | Source | Purpose |
|---|---|---|---|
| GET | `/api/plant/models` | `main.py` | List available plant models |
| POST | `/api/plant/session/create` | `main.py` | Start a new plant simulation session |
| POST | `/api/plant/session/{session_id}/advance` | `main.py` | Advance a session in time |
| GET | `/api/plant/session/{session_id}` | `main.py` | Get session status |
| DELETE | `/api/plant/session/{session_id}` | `main.py` | Destroy a session |
| GET | `/api/plant/sessions` | `main.py` | List active sessions |
| POST | `/api/plant/morph/parse` | `main.py` | Parse a morph expression |
| POST | `/api/plant/morph` | `main.py` | Apply a morph to a plant |
| POST | `/api/plant/generate` | `main.py` | Generate a plant from parameters |
| POST | `/api/plant/canopy/generate` | `main.py` | Generate a grid of plants as one merged mesh |
| POST | `/api/plant/generate/stream` | `main.py` | Generate a plant or canopy with SSE progress |

### `POST /api/plant/generate/stream`

Generates a single plant or a canopy and streams **progress** as
[Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events),
so the UI can show a live progress bar (and cancel by aborting the request).
This is the path the Generate Plant popup uses.

Request (`PlantStreamRequest`) carries a `mode` (`"single"` or `"canopy"`)
plus the relevant fields from `PlantGenerationRequest` / `PlantCanopyRequest`.
The stream emits:

```
event: progress
data: {"progress": 0.0-1.0, "message": "Growing plants..."}

event: result
data: <PlantGenerationResponse-shaped JSON>

event: error
data: {"detail": "..."}
```

Progress maps the C++ growth phase (via `pyhelios`
`PlantArchitecture.setProgressCallback`) to 0–0.6, geometry extraction to
0.6–0.95, and serialization to the final 1.0. Single-plant builds create a
retained session (returned as `session_id` in the result) so the age slider
keeps working; canopies are stateless and include the canopy echo fields.

### `POST /api/plant/canopy/generate`

Builds a regularly spaced grid of plants from one library species
(`pyhelios` `buildPlantCanopyFromLibrary`) and returns the whole canopy as a
single merged mesh — the same `PlantGenerationResponse` shape as
`/api/plant/generate`, so the renderer is identical.

Request (`PlantCanopyRequest`):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `plant_type` | str | `"bean"` | Library species (see `/api/plant/models`) |
| `age` | float | `30.0` | Age of every plant, days (≥ 0) |
| `center_x/y/z` | float | `0.0` | Canopy center, meters |
| `spacing_x/y` | float | `0.5` | Spacing between plants, meters |
| `count_x/y` | int | `3` | Plants in X / Y (must be > 0) |
| `germination_rate` | float | `1.0` | Probability (0–1) each position is filled |
| `random_seed` | int? | `null` | Optional seed for reproducibility |

The response echoes back `plant_count` (plants actually built after
germination), `count_x`, `count_y`, `spacing_x`, and `spacing_y`. Invalid
counts, age, or germination rate return `success: false` with an `error`
message (no `pyhelios` work is done). `helios_xml` holds the first plant's
structure as a representative sample.

## Point cloud I/O

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/pointcloud/import` | `main.py` | Import a LAS/LAZ file (multipart upload) |
| POST | `/api/pointcloud/preview` | `main.py` | Cheaply inspect a file for the import wizard: reads only the header + first ~20 rows (ASCII) or header + a few points (PLY/PCD/LAS) and returns the detected delimiter, per-column auto-detected role, a `type_hint` (integer/float/categorical/empty) used to pre-tick the categorical box, sample rows, and `remappable` (true for ASCII, false for in-file-layout formats). Never 500s on a parse problem — returns a 200 with a `warning` so the wizard can still offer auto-detect |
| POST | `/api/pointcloud/import_by_path` | `main.py` | Parse a point cloud from a path on disk (dispatches `.xyz`/`.txt`/`.csv`/`.pts`/`.asc` to pandas, `.ply`/`.pcd` to open3d). Returns a packed binary stream so multi-GB scans aren't bottlenecked by JSON encoding. Accepts an optional `column_plan` (the import wizard's explicit per-column roles + custom scalar slug/label + `rgb_is_255` scale) that overrides auto-detection; absent → identical to the previous behaviour |
| POST | `/api/pointcloud/export` | `main.py` | Export a point cloud to LAS/LAZ — or, for octree-backed clouds (via a `source` descriptor), to any of LAS/LAZ/XYZ/TXT/CSV/PLY/OBJ. The backend streams from the source file and applies any pending translation. Set **`dest_path`** (absolute) and the backend writes the file itself, returning metadata only with `data: null` — the app always does this, and it's the only form that works at scale: base64-in-JSON inflates the body ~1.8x, so a 25 M-point XYZ export lands near 1 GB and the renderer's `response.json()` throws `ERR_STRING_TOO_LONG` ("Unexpected end of JSON input"). Omitting `dest_path` keeps the legacy base64-in-`data` response for callers with no filesystem destination |

Octree building, cropping, and filtering for imported clouds go through the
**cloud-session** endpoints (next section) — the in-RAM array is the source of
truth and the octree is derived from it. There is no longer a standalone
"convert/crop/segment a file into an octree" endpoint; those were removed when
the session model landed.

## Mutable cloud sessions (the in-RAM source-of-truth model)

Every path-imported point cloud is loaded into a **cloud session**: the full
attribute set (positions + colours + intensity + scalar extra-dims) is held in
RAM on the backend as the authoritative copy. The **source file is read exactly
once, at `create`** (`_source_to_las` → `_read_las_into_arrays`); afterwards
every edit mutates the in-RAM arrays and rebuilds the derived Potree octree from
them (`_session_to_las` → PotreeConverter) — the file is never re-read. The
octree is a disposable render cache; the array is the source of truth.

Deletions are an exact per-point boolean mask (instant, no rebuild); undo is a
mask-snapshot stack. Compute endpoints (triangulate/skeleton/c2m/icp/export)
read the masked array directly via `PointSource.session_id`, so they honour
unbaked deletions with no rebuild. Filter and ground/tree segment run their
algorithms on the array and append columns; "split"/"extract" spin off child
sessions from the array. All of it is file-read-free after import.

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/cloud/session/create` | `main.py` | Load a source file fully into a new in-RAM session and build its first octree (hits-only). Also builds a SECOND projected-miss octree when the scan has placeable sky/miss points, returned as `miss_octree_cache_id`. Honours the wizard `column_plan` once (survives all edits). The ONLY point the file is read. The source path is validated before the response opens (a missing file is a clean 404); the import then runs OFF the event loop and **streams PHP1 progress markers** (`Reading source file…` → `Loading points into memory…` → `Building octree…`) ahead of a JSON tail carrying `session_id` + octree metadata. **Cancellable** via `/api/cancel/{run_id}`: a cancel unwinds the worker and SIGKILLs the PotreeConverter child, so the work really stops. Because the stream is already open by then, in-flight failures come back as `error` in the JSON tail rather than an HTTP error status. Nothing is left behind — the temp dir and octree staging dir unwind, and the session is registered only as the final step, so a cancelled import strands neither RAM nor a half-built cache entry |
| POST | `/api/cloud/session/{id}/delete_region` | `main.py` | Set the per-point deleted mask for points in a `region` (box/polygon/squares_union). Instant — array mask only, no rebuild. **Excludes `is_miss` points from the selection** (a crop only ever deletes hits). Returns counts, plus `backfilled_misses_stale: true` when the crop invalidated a separately-backfilled miss buffer (kept, but flagged so the UI + LAD warn to re-backfill) |
| POST | `/api/cloud/session/{id}/reset_edits` | `main.py` | Undo: restore the deleted mask to an earlier snapshot (`edit_count` deletes kept) |
| POST | `/api/cloud/session/{id}/bake` | `main.py` | Permanently apply deletions — rebuild the octree from the surviving array points (`_session_to_las` → PotreeConverter), compact the arrays, clear the mask. Also reprojects + rebuilds the miss octree from the survivors, returned as `miss_octree_cache_id`. The one deliberately-slow step. No file read |
| POST | `/api/cloud/session/{id}/filter` | `main.py` | Delete the points a spatial+scalar filter excludes (array columns), rebuild from the survivors. Composes on the current survivors. Empty result → `point_count: 0`, no commit/rebuild |
| POST | `/api/cloud/session/{id}/split` | `main.py` | Keep the filter-passing points on this session; move the excluded points to a NEW leftover session. Both rebuilt from arrays. Powers crop/filter "Segment" |
| POST | `/api/cloud/session/{id}/extract` | `main.py` | Create a NEW child session from the filter-selected points, parent untouched. Powers ground "split into clouds" |
| POST | `/api/cloud/session/{id}/extract_by_column` | `main.py` | Batch form of `extract`: fan a categorical column (`{slug}`, e.g. `tree_instance`) out into ONE child session per distinct value, parent untouched. `exclude_values` defaults to `[0]` (ground/miss/unassigned). Powers **split into one cloud per tree**. All subsets are sliced under a single lock — one stable argsort of the column, then a per-child gather by absolute row index, so a K-way split costs O(N) in total rather than K full-survivor copies — and the per-child octree builds then run concurrently in a bounded pool (`_EXTRACT_BUILD_POOL`). The slug is validated before the response opens (a typo is a clean 400); the builds then **stream PHP1 progress markers** ahead of the JSON tail so the renderer can show a cancellable *Building n of N clouds…* pill. A cancel or failure drops the child sessions it had already registered, so a half-finished split doesn't strand a second copy of the cloud in RAM |
| POST | `/api/cloud/session/{id}/duplicate` | `main.py` | Copy a session's surviving points into a NEW independent session (parent untouched) and build its octree. A pure array copy — no file read, so every wizard customization is preserved. Powers scan "Duplicate" |
| POST | `/api/cloud/session/merge` | `main.py` | Concatenate the surviving points of **≥2 sessions** (body `{session_ids}`) into one NEW session and build its octree. Reconciles differing global shifts (re-expresses every input into a common `world_shift`) and **unions** scalar extra-dim columns (zero-filling inputs that lack a column). Builds a projected-miss octree when any input carried misses. Returns `{merged: {session_id, point_count, world_shift, cache_id, has_misses, miss_octree_cache_id, …octree}}`. Powers **Stitch Clouds** — the merge runs here, not in the renderer, because octree clouds hold their points in the session (the renderer's flat `positions` is empty) |
| POST | `/api/cloud/session/{id}/segment_ground` | `main.py` | Run CSF on the array, append a `ground_class` column, rebuild from arrays |
| POST | `/api/cloud/session/{id}/segment_trees` | `main.py` | Run TreeIso on the array, append a `tree_instance` column, rebuild from arrays |
| POST | `/api/cloud/session/{id}/segment_wood` | `main.py` | Wood/leaf segmentation on the in-RAM survivors → append `wood_class` → rebuild the octree. No file read. The compute runs in a **killable subprocess** so Cancel can SIGKILL it; the column write + rebuild happen in the parent afterwards, so a cancel mid-compute leaves the session pristine |
| POST | `/api/cloud/session/{id}/dem` | `main.py` | DEM from the session's in-RAM survivors (ground-aware). Returns a PHB1 frame (heightmap mesh + grid). With `add_height_column`, also appends a `height_above_ground` scalar and rebuilds the octree |
| POST | `/api/cloud/session/{id}/transform` | `main.py` | Bake a rigid 4×4 (row-major, world-frame) transform into the session geometry. The session stores points with `world_shift` subtracted, so the matrix is conjugated by the shift. A permanent, **non-undoable** geometry change — this is what commits a Translate. `octree_mode` chooses what happens to the derived octree: `"rebuild"` (default) returns a CURRENT octree — a pure translation takes the in-place rewrite (`octree_transform.translate_octree_dir`, ~1.8 s on 10 M points), a rotation reconverts (~83 s, since rotation re-buckets the octree's nodes). `"pose"` leaves the octree ALONE: the geometry moves (~0.5 s, and that is what every compute path reads via `_read_points_from_source`), the existing octree is returned unchanged, `octree_posed: true` is reported, and `CloudSession.octree_pose` is set. The renderer then draws that octree through a stored pose — correct for rendering, LOD, picking and GPU clipping alike, because potree composes the octree object's matrix. |
| POST | `/api/cloud/session/{id}/rebuild_octree` | `main.py` | Rebuild a session's octree(s) from its CURRENT arrays, clearing `octree_pose`. The repayment step for a deferred transform. Needed only by operations that ship a **screen-space region** (lasso/rect crop, erase brush, label brush): those freeze a camera looking at the posed octree and the backend replays it against session positions, so the frames must agree first. Compute and export never need it. |
| POST | `/api/cloud/session/{id}/backfill-misses` | `main.py` | Recover sky/miss points and persist them in a lightweight per-session buffer (`CloudSession.backfilled_misses`). Builds an ephemeral PyHelios cloud from the surviving points, runs `gapfillMisses()` (auto-selects the row/column or timestamp path; `row_index`/`column_index` are relabelled to the bare `row`/`column` keys the C++ dispatcher probes), and slices the synthesised misses via the bulk getters. Hit arrays are untouched. Rebuilds the projected-miss octree and returns its `miss_octree_cache_id`. Session-resolve + eligibility run up front (404 / 400-when-no-timestamp-or-grid); the heavy build/gapfill/extract **streams PHP1 progress markers** ahead of the JSON tail (`_do_backfill_misses` + `_bin_frame_streaming_response`) so the renderer shows a per-stage progress bar. Short-circuits (plain JSON) when the scan already has misses; a Helios reconstruction failure (too-sparse grid) returns an `error` field in the JSON tail rather than a 500 |
| DELETE | `/api/cloud/session/{id}` | `main.py` | Free the session's in-RAM arrays (called when a cloud is removed from the scene) |

!!! note "LAD requires misses — no silent gapfill"
    `/api/lad/compute` no longer recovers misses on the fly. A scan must already
    carry sky/miss points — retained by the source format (E57 / structured PLY)
    or recovered up front via `backfill-misses`, which persists them so
    `_session_to_lad_arrays` appends them to the LAD cloud. If none are present
    the endpoint returns a structured `success: false` error directing the user
    to Backfill Misses (the Helios C++ `calculateLeafArea` fail-fast still
    backstops). This applies to every LAD source path, including the
    non-session `file_path` / inline-`points` paths, which have no backfill step
    and therefore must ship recorded misses.

## Registration & comparison

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/c2m/distance` | `main.py` | Cloud-to-mesh distance |
| POST | `/api/c2m/icp-register` | `main.py` | Cloud-to-mesh ICP |
| POST | `/api/c2c/icp-register` | `main.py` | Cloud-to-cloud ICP |
| POST | `/api/m2m/icp-register` | `main.py` | Mesh-to-mesh ICP |

!!! note "Reading points — the `source` descriptor"
    Octree-backed clouds keep no point positions in the renderer (the geometry
    lives only in the on-disk Potree octree, streamed to the GPU). So the
    downstream endpoints — `/api/skeleton/extract`, `/api/triangulate`,
    `/api/c2m/distance`, `/api/c2m/icp-register`, `/api/c2c/icp-register`, and
    `/api/pointcloud/export` — accept an **optional `source`** object in place
    of the inline `points` array:

    ```json
    "source": {
      "session_id": "3f2a…",
      "max_points": 20000,
      "translation": [tx, ty, tz],
      "want_colors": true
    }
    ```

    **`session_id` is required.** A cloud's file is read exactly once, at import
    (`/api/cloud/session/create`); from then on the session's in-RAM arrays are
    the source of truth, and they carry every edit — deletions, translation,
    filtering, segmentation labels — that the file on disk does not. Computing
    from the file would therefore return a silently wrong answer, so
    `_read_points_from_source` **rejects a file-only source with a 400** for
    every compute and export path. This is enforced at that single chokepoint,
    not per-endpoint, so the rule holds for every caller.

    `source_path` may still be sent alongside `session_id`, but it is
    **provenance only** and is never re-read. The `allow_file_source: true`
    escape hatch exists for files that are not live clouds (unit tests driving
    the loaders directly); the app never sets it.

    When `source` is set the backend reads (and optionally stride-downsamples)
    the session's points, applies the pending translation (added to every
    point), and runs the same computation. Flat (PLY/PCD) clouds keep sending
    inline `points` unchanged. `/api/triangulate` returns `points_used` so the
    UI can warn when the global *triangulate max points* cap downsampled a large
    cloud.

!!! tip "Live API docs"
    FastAPI's interactive docs are exposed at `/docs` on the backend's port
    while it's running, with request/response schemas auto-generated from
    the Pydantic models in `main.py`. In a dev session the port is printed in
    the `[dev]` startup lines.
