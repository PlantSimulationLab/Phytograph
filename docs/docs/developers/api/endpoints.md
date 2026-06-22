# HTTP Endpoints

All endpoints listed below are served by `backend-api/main.py` on
`http://127.0.0.1:8008`. The table is grouped by feature area; the
**source** column points at the line in `main.py` where the route handler
is defined.

## Health & metadata

| Method | Path | Source | Purpose |
|---|---|---|---|
| GET | `/` | `main.py:49` | Root ping |
| GET | `/health` | `main.py:54` | Liveness probe |
| GET | `/version` | `main.py:60` | Returns `BACKEND_VERSION` (used by the supervisor) |

## Curve / surface fitting

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/fit` | `main.py:98` | Fit a built-in model to data |
| GET | `/api/models` | `main.py:156` | List available fitting models |
| POST | `/api/fit/custom` | `main.py:346` | Fit a user-supplied model expression |
| POST | `/api/fit/prospect` | `main.py:1219` | PROSPECT leaf optical model |

## LaTeX & export

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/latex` | `main.py:714` | Render expressions to LaTeX |
| GET | `/api/latex` | `main.py:730` | Retrieve a previously rendered expression |
| POST | `/api/export` | `main.py:771` | Export fit results |

## Meshing & sampling

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/triangulate` | `main.py:1291` | Triangulate a point cloud |
| POST | `/api/triangulate/helios` | `main.py:2334` | Helios-style triangulation. Each `scans[]` entry carries its own acquisition geometry (`origin`, `n_theta`/`n_phi`, `theta_min`/`max`, `phi_min`/`max`); an optional `grid` (center/size + `nx`/`ny`/`nz`) comes from a voxel box. With no `grid` the backend auto-fits a single cell over all points and sets `grid_warning` on the response. Each scan is triangulated independently, so the response includes `triangle_scan_ids` — the source scan index per triangle — for coloring by scan |
| POST | `/api/lidar/scan` | `main.py` | True ray-traced synthetic LiDAR scan via the PyHelios `lidar` plugin. `meshes[]` carry world-space `vertices`/`triangles` (+ optional per-vertex `colors`); `scanners[]` carry each scanner's renderer `id` plus its `ScanParameters` (`origin`, `n_theta`/`n_phi`, `theta_min_deg`/`max`, `phi_min_deg`/`max`, `return_mode` (`single`/`multi`), `max_returns` (multi), `return_selection` (`strongest`/`first`/`last`, single), `exit_diameter_m`, `beam_divergence_mrad`). A legacy `return_type` (`single`/`multi`) is still accepted and mapped to `return_mode`. Optional `extra_fields[]` names custom primitive-data labels to sample onto hits (column-format driven). All meshes load into one Helios `Context`; scanners are added in order so the Helios scanID equals the request index, and each scan's stored `ReturnMode`/`maxReturns`/selection is set via the per-scan setters. `syntheticScan` ray-traces once (one global `rays_per_pulse`: every scan fires that many sub-rays across its beam cone, and `rays_per_pulse=1` collapses the cone to one exact ray per pulse — the idealized scan) and hits are partitioned back per scanner via `getHitScanID`. Optional `synthetic_scan_memory_budget_mb` caps the transient ray-tracing scratch buffers (via `LiDARCloud.setSyntheticScanMemoryBudget`) so a large fan-out is chunked instead of traced in one OOM-prone batch; omitted/`null`/≤0 leaves Helios's automatic path-dependent default (4 GiB CPU / 8 GiB GPU) in place, and chunking is result-invariant. Returns `results[]` — one per scanner (`scanner_id`, `points`, `colors`, and `scalars{}`: intensity/distance/timestamp/target_index/target_count read via `getHitData`) — occlusion-aware, unlike random surface sampling |
| POST | `/api/mesh/import` | `main.py` | Parse a textured `.obj` (+ sibling `.mtl` + images) from a disk `path` into geometry, V-flipped per-vertex UVs, per-material triangle groups, and base64-encoded textures — the same response shape the textured renderer consumes for plant models |

## Skeleton extraction

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/skeleton/extract` | `main.py:3101` | Extract a topological skeleton |

## QSM (Quantitative Structure Model)

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/qsm/build` | `main.py` | Reconstruct a dormant tree as connected cylinders with radii + topology, segment continuous shoots, and classify them by **shoot rank** (trunk=0, scaffolds=1, …) |

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

## Plant models & sessions

| Method | Path | Source | Purpose |
|---|---|---|---|
| GET | `/api/plant/models` | `main.py:3482` | List available plant models |
| POST | `/api/plant/session/create` | `main.py:3588` | Start a new plant simulation session |
| POST | `/api/plant/session/{session_id}/advance` | `main.py:3693` | Advance a session in time |
| GET | `/api/plant/session/{session_id}` | `main.py:3754` | Get session status |
| DELETE | `/api/plant/session/{session_id}` | `main.py:3787` | Destroy a session |
| GET | `/api/plant/sessions` | `main.py:3815` | List active sessions |
| POST | `/api/plant/morph/parse` | `main.py:4043` | Parse a morph expression |
| POST | `/api/plant/morph` | `main.py:4074` | Apply a morph to a plant |
| POST | `/api/plant/generate` | `main.py:4235` | Generate a plant from parameters |
| POST | `/api/plant/canopy/generate` | `main.py:5035` | Generate a grid of plants as one merged mesh |
| POST | `/api/plant/generate/stream` | `main.py:5205` | Generate a plant or canopy with SSE progress |

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
| POST | `/api/pointcloud/import` | `main.py:4650` | Import a LAS/LAZ file (multipart upload) |
| POST | `/api/pointcloud/preview` | `main.py` | Cheaply inspect a file for the import wizard: reads only the header + first ~20 rows (ASCII) or header + a few points (PLY/PCD/LAS) and returns the detected delimiter, per-column auto-detected role, a `type_hint` (integer/float/categorical/empty) used to pre-tick the categorical box, sample rows, and `remappable` (true for ASCII, false for in-file-layout formats). Never 500s on a parse problem — returns a 200 with a `warning` so the wizard can still offer auto-detect |
| POST | `/api/pointcloud/import_by_path` | `main.py` | Parse a point cloud from a path on disk (dispatches `.xyz`/`.txt`/`.csv`/`.pts`/`.asc` to pandas, `.ply`/`.pcd` to open3d). Returns a packed binary stream so multi-GB scans aren't bottlenecked by JSON encoding. Accepts an optional `column_plan` (the import wizard's explicit per-column roles + custom scalar slug/label + `rgb_is_255` scale) that overrides auto-detection; absent → identical to the previous behaviour |
| POST | `/api/pointcloud/export` | `main.py` | Export a point cloud to LAS/LAZ — or, for octree-backed clouds (via a `source` descriptor), to any of LAS/LAZ/XYZ/TXT/CSV/PLY/OBJ. The backend streams from the source file and applies any pending translation |

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
| POST | `/api/cloud/session/create` | `main.py` | Load a source file fully into a new in-RAM session and build its first octree (hits-only). Also builds a SECOND projected-miss octree when the scan has placeable sky/miss points, returned as `miss_octree_cache_id`. Honours the wizard `column_plan` once (survives all edits). Returns `session_id` + octree metadata. The ONLY point the file is read |
| POST | `/api/cloud/session/{id}/delete_region` | `main.py` | Set the per-point deleted mask for points in a `region` (box/polygon/squares_union). Instant — array mask only, no rebuild. **Excludes `is_miss` points from the selection** (a crop only ever deletes hits). Returns counts, plus `backfilled_misses_stale: true` when the crop invalidated a separately-backfilled miss buffer (kept, but flagged so the UI + LAD warn to re-backfill) |
| POST | `/api/cloud/session/{id}/reset_edits` | `main.py` | Undo: restore the deleted mask to an earlier snapshot (`edit_count` deletes kept) |
| POST | `/api/cloud/session/{id}/bake` | `main.py` | Permanently apply deletions — rebuild the octree from the surviving array points (`_session_to_las` → PotreeConverter), compact the arrays, clear the mask. Also reprojects + rebuilds the miss octree from the survivors, returned as `miss_octree_cache_id`. The one deliberately-slow step. No file read |
| POST | `/api/cloud/session/{id}/filter` | `main.py` | Delete the points a spatial+scalar filter excludes (array columns), rebuild from the survivors. Composes on the current survivors. Empty result → `point_count: 0`, no commit/rebuild |
| POST | `/api/cloud/session/{id}/split` | `main.py` | Keep the filter-passing points on this session; move the excluded points to a NEW leftover session. Both rebuilt from arrays. Powers crop/filter "Segment" |
| POST | `/api/cloud/session/{id}/extract` | `main.py` | Create a NEW child session from the filter-selected points, parent untouched. Powers ground/tree "split into clouds" |
| POST | `/api/cloud/session/{id}/segment_ground` | `main.py` | Run CSF on the array, append a `ground_class` column, rebuild from arrays |
| POST | `/api/cloud/session/{id}/segment_trees` | `main.py` | Run TreeIso on the array, append a `tree_instance` column, rebuild from arrays |
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
| POST | `/api/c2m/distance` | `main.py:4772` | Cloud-to-mesh distance |
| POST | `/api/c2m/icp-register` | `main.py:4937` | Cloud-to-mesh ICP |
| POST | `/api/c2c/icp-register` | `main.py:5064` | Cloud-to-cloud ICP |
| POST | `/api/m2m/icp-register` | `main.py:5193` | Mesh-to-mesh ICP |

!!! note "Reading points from disk — the `source` descriptor (M4)"
    Octree-backed clouds keep no point positions in the renderer (the geometry
    lives only in the on-disk Potree octree, streamed to the GPU). So the
    downstream endpoints — `/api/skeleton/extract`, `/api/triangulate`,
    `/api/c2m/distance`, `/api/c2m/icp-register`, `/api/c2c/icp-register`, and
    `/api/pointcloud/export` — accept an **optional `source`** object in place
    of the inline `points` array:

    ```json
    "source": {
      "source_path": "/path/to/scan.xyz",
      "ascii_format": "x y z r255 g255 b255 reflectance",
      "max_points": 20000,
      "translation": [tx, ty, tz],
      "want_colors": true
    }
    ```

    When `source` is set the backend reads (and optionally stride-downsamples)
    the points from the original file via `_read_points_from_source`, applies
    the pending translation (added to every point), and runs the same
    computation. There is no octree reader — the source file is always the
    point of truth. Flat (PLY/PCD) clouds keep sending inline `points`
    unchanged. `/api/triangulate` returns `points_used` so the UI can warn when
    the global *triangulate max points* cap downsampled a large cloud.
    `/api/triangulate/helios` already reads each scan from `file_path`; M4 also
    passes the known `ascii_format` so column mapping isn't guessed.

!!! tip "Live API docs"
    FastAPI's interactive docs are exposed at
    [http://127.0.0.1:8008/docs](http://127.0.0.1:8008/docs) while the
    backend is running, with request/response schemas auto-generated from
    the Pydantic models in `main.py`.
