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
| POST | `/api/mesh/sample` | `main.py:1910` | Sample points on a mesh |
| POST | `/api/mesh/import` | `main.py` | Parse a textured `.obj` (+ sibling `.mtl` + images) from a disk `path` into geometry, V-flipped per-vertex UVs, per-material triangle groups, and base64-encoded textures — the same response shape the textured renderer consumes for plant models |

## Skeleton extraction

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/skeleton/extract` | `main.py:3101` | Extract a topological skeleton |

## Ground segmentation

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/segment/ground` | `main.py` | Classify points into ground (1) / plant (2) via the Cloth Simulation Filter. Takes inline `points` or a `source` descriptor (read at full resolution — no downsampling, so labels align 1:1). Returns per-point `labels` + counts |
| POST | `/api/segment/ground/apply` | `main.py` | Run CSF and re-convert the source XYZ into a new Potree 2.0 octree carrying a `ground_class` extra-dimension attribute the renderer can colour by. With `keep_class` (1 or 2) it writes only that class's points — the "split into ground + plant clouds" path. Returns the octree-ref shape of `convert_to_octree` **plus** `segmented_source_path`: the persisted LAS (kept in the cache dir, carrying `ground_class`) the renderer uses as the new cloud's source, so a later Filter/Crop on `ground_class` re-reads a source that has the column rather than the original label-free XYZ |

The classifier is the `cloth-simulation-filter` package (`import CSF`), a
SWIG C-extension bundled via `collectAll` in `scripts/build-backend.mjs`.

## Tree segmentation

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/segment/trees` | `main.py` | Segment individual trees with **TreeIso** (cut-pursuit graph method, CPU-only). Takes inline `points` or a `source` descriptor (full resolution; labels align 1:1) and optional `seed_points` (trunk seeds for human-in-the-loop — each seed yields one tree). Returns per-point `labels` (`0` = unassigned, `1..N` = trees), `num_trees`, and a `ground_warning` flag. Labels-only: any ground-truth fields a source carries (e.g. a benchmark PLY's `instance`/`semantic`) are **not** echoed here — only `/apply` carries source scalars into the octree, and the eval harness reads GT straight from the file |
| POST | `/api/segment/trees/apply` | `main.py` | Run TreeIso and re-convert the source XYZ into a new Potree 2.0 octree carrying a `tree_instance` extra-dimension attribute. With `keep_instance` (1..N) it writes only that tree's points — a split sub-cloud. Returns the octree-ref shape of `convert_to_octree` **plus** `segmented_source_path` (the persisted LAS carrying `tree_instance`, used as the new cloud's source — same rationale as `segment/ground/apply`, so filtering on `tree_instance` works) |

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
| POST | `/api/pointcloud/crop_by_path` | `main.py` | Re-read a point cloud from its `sourcePath` and apply an AABB box crop (with optional `translation` baked in and `crop_invert` flag), returning the kept points in the same PHX1 binary format. Used by the viewer's "Apply crop" for flat-array (PLY/PCD) clouds so the renderer doesn't have to hold the filtered intermediate in V8's 4 GB old-space — NumPy handles the filter without that constraint |
| POST | `/api/pointcloud/convert_to_octree` | `main.py` | Build a Potree 2.0 octree from any supported point-cloud source. `_source_to_las` normalises each format to LAS first — XYZ ASCII via laspy streaming, `.ply` via plyfile (preserving scalar fields as LAS extra dims), `.pcd` via open3d (position + color only), `.las`/`.laz` passed straight through — then runs the bundled PotreeConverter binary. Result is cached under `~/Library/Application Support/Phytograph/cache/octrees/<sha1>/`; repeat calls hit the cache. Accepts an optional `column_plan` (same shape as `import_by_path`) that participates in the cache key, so distinct wizard mappings of the same file get distinct cache entries. Returns `cache_id`, `tight_bounds`, attribute list. The renderer streams `metadata.json`/`hierarchy.bin`/`octree.bin` from that dir via the `app://octree/<cache_id>/...` Electron custom protocol. **Note:** as of 0.3.15 the crop/segment endpoints do **not** yet accept a `column_plan`, so a re-crop of a custom-column import rebuilds with auto-detect (identical for auto-detected imports; a follow-up will thread the plan through) |
| GET | `/api/pointcloud/octree_metadata` | `main.py` | Look up metadata for a previously-converted octree by `cache_id`. Used when the renderer has only a cache id and needs the bounds/attribute schema (e.g. after a project reload) |
| POST | `/api/pointcloud/crop_octree` | `main.py` | Re-convert a source cloud into a new Potree 2.0 octree with a crop region and/or scalar-attribute filters applied. Works for every importable format: ASCII sources stream-filter directly via pandas (`_filtered_xyz_to_las`); PLY/PCD/LAS/LAZ are normalised to LAS first (via `_source_to_las`, preserving PLY scalar fields) then chunk-filtered via `_filtered_las_to_las`. `region` (box, screen-space polygon, or `squares_union` — the erase brush's painted screen-space square stamps under one frozen camera, sent with `invert: true` to remove the union of everything behind them — with optional translation baked in) is **optional**; `scalar_filters` is an optional list of `{slug, min, max}` (continuous range) or `{slug, values: [...]}` (categorical membership — keep points whose rounded value is in the set, used for class fields like `ground_class` / `tree_instance`) that keeps only matching points. All filters AND together; the region's `invert` flips only the spatial mask (scalar filters are never inverted). `invert_all` (optional, default false) complements the ENTIRE combined mask as the final step — the true leftover/out-of-range set — which the filter tool's "Segment" action uses to build the second cloud (kept + leftover == the source). At least one of `region` / `scalar_filters` is required. Chunked streaming filter via laspy → PotreeConverter → atomic cache write. Returns the new `cache_id` **plus `filtered_source_path`**: the kept points are persisted as a LAS in the cache dir, and the renderer points the resulting cloud's source at it so the NEXT crop/filter/segment composes on the current point set (re-reading the original source would make previously-removed points reappear). `filtered_source_path` is `null` for an empty result. Powers the crop, scalar "Filter Points", and "Segment" paths for octree-backed clouds — keeps renderer JS heap bounded regardless of source size |
| POST | `/api/pointcloud/export` | `main.py` | Export a point cloud to LAS/LAZ — or, for octree-backed clouds (via a `source` descriptor), to any of LAS/LAZ/XYZ/TXT/CSV/PLY/OBJ. The backend streams from the source file and applies any pending translation |

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
