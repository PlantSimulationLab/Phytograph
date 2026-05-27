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
| POST | `/api/pointcloud/import_by_path` | `main.py:4970` | Parse a point cloud from a path on disk (dispatches `.xyz`/`.txt`/`.csv`/`.pts`/`.asc` to pandas, `.ply`/`.pcd` to open3d). Returns a packed binary stream so multi-GB scans aren't bottlenecked by JSON encoding |
| POST | `/api/pointcloud/export` | `main.py:4539` | Export a point cloud |

## Registration & comparison

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/api/c2m/distance` | `main.py:4772` | Cloud-to-mesh distance |
| POST | `/api/c2m/icp-register` | `main.py:4937` | Cloud-to-mesh ICP |
| POST | `/api/c2c/icp-register` | `main.py:5064` | Cloud-to-cloud ICP |
| POST | `/api/m2m/icp-register` | `main.py:5193` | Mesh-to-mesh ICP |

!!! tip "Live API docs"
    FastAPI's interactive docs are exposed at
    [http://127.0.0.1:8008/docs](http://127.0.0.1:8008/docs) while the
    backend is running, with request/response schemas auto-generated from
    the Pydantic models in `main.py`.
