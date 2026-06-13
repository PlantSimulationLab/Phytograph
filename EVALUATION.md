# Phytograph Deep-Dive Evaluation

_Focus: data/compute efficiency, robustness/errors/gotchas, and high-impact memory/compute wins. Evaluation only — no code changed. Findings grounded in code read on 2026-06-13 (v0.14.1, main @ 84fc72c)._

## Overall assessment

The architecture is **fundamentally sound** — better than typical for an app of this kind. The hardest data-movement problems are already solved:

- Point clouds are stored as `Float32Array` (not `{x,y,z}[]`).
- A deliberate binary frame protocol (`PHX1`/`PHB1`) carries heavy payloads instead of JSON.
- An in-RAM "source of truth" cloud-session model reads each file once.
- Octree builds are serialized per cache-key (fixes the batch-import crash).
- three.js GPU buffers are disposed when clouds/meshes are removed.

So this is not a rescue job. The real issues cluster in three places: **(1) backend process lifecycle is fragile, (2) in-memory sessions leak without bound, and (3) a few legacy/fallback code paths bypass the fast machinery the team already built.**

---

## 🔴 Critical — can take down the app in normal use

### 1. Backend crash is unrecoverable; orphans on quit
`src/main/backend.ts:239-242` — the `exit`/`error` handlers do nothing but `child = null`. No respawn, no backoff, no IPC event telling the renderer "backend is down." A single open3d/PyHelios native crash bricks **all** compute features until the user quits and relaunches, with no surfaced reason.

Compounding it: `stopBackend` (`:245`) sends only SIGTERM with no SIGKILL escalation and no process-group kill, and nothing handles `kill -9` / app-crash — so the PyInstaller child orphans. The "stale backend" cleanup documented in `CLAUDE.md` is a real lifecycle gap, not just a dev nuisance.

**Biggest robustness gap in the app.**

### 2. In-memory sessions never evict — unbounded RAM leak
`_cloud_sessions` (`backend-api/main.py:12591`) and `_plant_sessions` (`:6711`) are plain dicts. `created_at` is recorded but **never read** — no TTL/LRU/cap. The only reclaim path is an explicit `DELETE`. If the renderer reloads or crashes without issuing it, each orphaned `CloudSession` leaks the full cloud (float64 positions + colors + intensity + extra dims, ~30–60 bytes/point) until the backend dies.

Worse: `deleted_history` (`:12616`, appended `:13015`) pushes a **full (N,) boolean mask per delete** with no depth cap — a second unbounded growth vector *inside* each session (~30 MB/click on a 30 M-point cloud). The disk octree cache *does* evict; RAM sessions don't.

### 3. WebGL context leak on GIF-export error
`src/renderer/components/PointCloudViewer.tsx:8696` — every success path calls `renderer.dispose()`, but the outer `catch` does not (it only sets state flags). A backend blip mid-render strands an offscreen `WebGLRenderer`. Browsers cap WebGL contexts at ~16, so a handful of failed GIF exports breaks **all** WebGL in the app until reload.

---

## 🟠 High — significant compute/memory wins ("obvious wins")

### 4. Skeleton extraction: O(n) Python loop + per-point KD-tree query, no point cap
`build_neighbor_graph` (`backend-api/main.py:5344-5356`) loops `for i in range(n_points)` doing a per-point `tree.query_ball_point` plus a nested Python distance comprehension, building a list-of-lists. The endpoint (`:6321`) only downsamples if the *client* passes `max_points` — a raw cloud or session hits this at full size and hangs for minutes / OOMs on a multi-million-point TLS cloud.

**The fix model already exists in this file**: wood-segmentation (`:4928-4969`) is chunked + vectorized (`tree.query(..., workers=-1)`, `np.einsum`) with an explicit OOM-avoidance comment, and tree-segmentation caps at `_TREEISO_MAX_POINTS`. The skeleton path predates that and was never modernized. Vectorize + add the same cap.

### 5. Octree protocol buffers hundreds of MB synchronously on the main thread
`src/main/octreeProtocol.ts` advertises `stream: true` (`:54`) but doesn't stream: every request does `Buffer.allocUnsafe(length)` + synchronous `readSync` of the full range (`:167-169`), inside an `async` handler that never awaits. For `octree.bin` (comment: "hundreds of MB"), this spikes main-process RAM and **freezes the entire main process** (all IPC, windows, menu, updater) during the read. Switch to `fs.createReadStream` / `fs.promises`.

### 6. Legacy paths bypass the fast binary protocol
The team built `PHX1`/`PHB1` zero-copy float32 transport, but several paths still JSON-serialize whole clouds:

- `/api/pointcloud/import` (LAS upload) does `points.tolist()` + JSON (`main.py:9385,9392`) — the exact V8 512 MB string ceiling the binary path was built to dodge.
- Text export (`_format_points_as_text`, `main.py:9131`) Python-loops per-point f-string formatting, joins, then **base64-encodes the whole blob into a JSON field** — slowest possible way to write a file, ~3 full copies in RAM. `np.savetxt` / vectorized would be 10–50× faster.
- Renderer mirror: `parseLAZ` (`pointCloudParsers.ts:711-735`) and LAZ/scan export (`PointCloudViewer.tsx:3682-3702, 3963`) build `number[][]` then copy to/from Float32Array, holding both at peak — several × the typed-array size held transiently; can OOM the renderer on a 10 M-point cloud.

### 7. Renderer fs IPC grants arbitrary path read/write
`src/main/ipc.ts:108-128` — `FsReadText/Binary` / `FsWriteText/Binary` take a raw `path` from the renderer and pass it straight to `fs/promises` with **zero validation**, despite the comment and `CLAUDE.md` both claiming "user-selected paths only." Any XSS or compromised dependency in the renderer can read `~/.ssh/id_rsa` or overwrite arbitrary files. The contract is documented but not implemented. (By contrast `octreeProtocol.ts` validates with sha1 + allowlist.)

---

## 🟡 Medium — worth doing, lower blast radius

- **8. `parseXYZ` builds array-of-arrays then copies to Float32Array** (`pointCloudParsers.ts:149-241`) — 2N boxed JS arrays held simultaneously with the final typed arrays, ~3–5× peak + heavy GC. `dataLines` is already materialized, so count-then-fill is nearly free. Same antipattern in `parseLAS` allocating 5 scalar arrays it usually discards (`:543-622`).
- **9. Single global lock serializes all cloud sessions** (`main.py:12592`), held across O(n) numpy work (`_region_mask`, `deleted.copy()`). Unrelated sessions (multiple windows, parallel E2E) block each other on every edit despite touching disjoint arrays.
- **10. `combinedBounds` re-sweeps all mesh/skeleton vertices on every edit-state change** (`PointCloudViewer.tsx:2694-2765`) — `editStates` is in the dep array, so dense Helios meshes/QSM skeletons get fully re-iterated during drags. Drop the dep or split the memo.
- **11. NaN poisoning in PLY/PCD parsers** — `.map(parseFloat)` with no `isNaN` guard (`pointCloudParsers.ts:364, 459, 1253`), unlike `parseXYZ` which guards. A malformed line injects NaN → breaks bounds → broken geometry.
- **12. No startup readiness check** (`backend.ts:139-243`) — `startBackend` resolves immediately; if FastAPI never binds, the renderer gets a dead port and the failure surfaces only as opaque per-request errors later.
- **13. Unbounded input sizes** — C2M/ICP/LAD accept arbitrary `mesh_vertices` / `points` / grid dims with only emptiness checks; no shape/size cap before building Open3D structures.

---

## 🟢 Low / notes

- Bare `except:` clauses swallowing errors incl. `KeyboardInterrupt`/`MemoryError` (`main.py:698, 787, 9387, …`).
- `FsReadBinary` double-copies large blobs over IPC structured-clone (`ipc.ts:113`).
- Synchronous per-frame renderer log writes to disk (`logger.ts`, no rate limit/batching).
- `FEEDBACK_EMAIL = 'feedback@example.com'` placeholder still shipped (`constants.ts:22`).
- `Math.max(...arr)` spread stack-overflow risk on large skeletons (`pointCloudParsers.ts:1353`).

---

## Verified non-issues (don't re-hunt)

- **Octree build serialization** (the batch-import crash fix) is correct: per-cache-key `threading.Lock` registry, re-checks cache inside the lock, atomic staging→rename. Distinct keys still build in parallel.
- **Binary transport** (`_pack_pointcloud_response`, `_bin_frame_bytes`) is zero-copy, float32, 4-byte-aligned — the right approach.
- **Wood segmentation** is properly chunked + vectorized.
- **Point clouds are typed arrays**, passed by reference through React state (shallow diff, not million-point copies).
- **Undo/history does not hold point clouds** — only edit metadata; stack bounded at 100.
- **three.js GPU buffers are disposed** in the renderer subcomponents (create/dispose balance).

---

## Recommended priority order

1. **Backend supervisor: health-monitored respawn + SIGKILL escalation + process-group kill + "backend down" IPC event** (#1). Dominant robustness gap.
2. **Bound the session stores: LRU/TTL eviction + cap `deleted_history` depth** (#2). Dominant memory leak.
3. **Vectorize + cap skeleton `build_neighbor_graph`** (#4). Biggest single compute win; in-repo template already exists.
4. **Fix the GIF `catch` to dispose the renderer** (#3). Small fix, real GPU-context leak.
