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
| POST | `/api/triangulate/helios` | `main.py:1773` | Helios-style triangulation |
| POST | `/api/mesh/sample` | `main.py:1910` | Sample points on a mesh |

## Skeleton extraction

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/skeleton/extract` | `main.py:3101` | Extract a topological skeleton |

## Ground segmentation

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/segment/ground` | `main.py` | Classify points into ground (1) / plant (2) via the Cloth Simulation Filter. Takes inline `points` or a `source` descriptor (read at full resolution — no downsampling, so labels align 1:1). Returns per-point `labels` + counts |
| POST | `/api/segment/ground/apply` | `main.py` | Run CSF and re-convert the source XYZ into a new Potree 2.0 octree carrying a `ground_class` extra-dimension attribute the renderer can colour by. With `keep_class` (1 or 2) it writes only that class's points — the "split into ground + plant clouds" path. Returns the same octree-ref shape as `convert_to_octree` |

The classifier is the `cloth-simulation-filter` package (`import CSF`), a
SWIG C-extension bundled via `collectAll` in `scripts/build-backend.mjs`.

## Tree segmentation

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/segment/trees` | `main.py` | Segment individual trees with **TreeIso** (cut-pursuit graph method, CPU-only). Takes inline `points` or a `source` descriptor (full resolution; labels align 1:1) and optional `seed_points` (trunk seeds for human-in-the-loop — each seed yields one tree). Returns per-point `labels` (`0` = unassigned, `1..N` = trees), `num_trees`, and a `ground_warning` flag |
| POST | `/api/segment/trees/apply` | `main.py` | Run TreeIso and re-convert the source XYZ into a new Potree 2.0 octree carrying a `tree_instance` extra-dimension attribute. With `keep_instance` (1..N) it writes only that tree's points — a split sub-cloud. Returns the same octree-ref shape as `convert_to_octree` |

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

## Point cloud I/O

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/pointcloud/import` | `main.py:4650` | Import a LAS/LAZ file (multipart upload) |
| POST | `/api/pointcloud/import_by_path` | `main.py` | Parse a point cloud from a path on disk (dispatches `.xyz`/`.txt`/`.csv`/`.pts`/`.asc` to pandas, `.ply`/`.pcd` to open3d). Returns a packed binary stream so multi-GB scans aren't bottlenecked by JSON encoding |
| POST | `/api/pointcloud/crop_by_path` | `main.py` | Re-read a point cloud from its `sourcePath` and apply an AABB box crop (with optional `translation` baked in and `crop_invert` flag), returning the kept points in the same PHX1 binary format. Used by the viewer's "Apply crop" for flat-array (PLY/PCD) clouds so the renderer doesn't have to hold the filtered intermediate in V8's 4 GB old-space — NumPy handles the filter without that constraint |
| POST | `/api/pointcloud/convert_to_octree` | `main.py` | Build a Potree 2.0 octree from an XYZ/LAS source. Pre-converts XYZ ASCII → LAS via laspy streaming, then runs the bundled PotreeConverter binary. Result is cached under `~/Library/Application Support/Phytograph/cache/octrees/<sha1>/`; repeat calls hit the cache. Returns `cache_id`, `tight_bounds`, attribute list. The renderer streams `metadata.json`/`hierarchy.bin`/`octree.bin` from that dir via the `app://octree/<cache_id>/...` Electron custom protocol |
| GET | `/api/pointcloud/octree_metadata` | `main.py` | Look up metadata for a previously-converted octree by `cache_id`. Used when the renderer has only a cache id and needs the bounds/attribute schema (e.g. after a project reload) |
| POST | `/api/pointcloud/crop_octree` | `main.py` | Re-convert a source XYZ into a new Potree 2.0 octree with a crop region and/or scalar-attribute filters applied. `region` (box or screen-space polygon, with optional translation baked in) is **optional**; `scalar_filters` is an optional list of `{slug, min, max}` that keeps only points whose imported scalar attribute falls in `[min, max]`. All filters AND together; the region's `invert` flips only the spatial mask (scalar filters are never inverted). `invert_all` (optional, default false) complements the ENTIRE combined mask as the final step — the true leftover/out-of-range set — which the filter tool's "Segment" action uses to build the second cloud (kept + leftover == the source). At least one of `region` / `scalar_filters` is required. Chunked streaming filter via laspy → PotreeConverter → atomic cache write. Returns the new `cache_id`; the renderer hot-swaps to it on the existing `OctreePointCloud` primitive. Powers the crop, scalar "Filter Points", and "Segment" paths for octree-backed clouds — keeps renderer JS heap bounded regardless of source size |
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
