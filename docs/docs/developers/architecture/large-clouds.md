# Large clouds: memory budget, cost advisories, benchmarks

Phytograph holds an imported cloud in RAM as the source of truth (see
[Backend sidecar](backend.md)), so "how big a cloud can it handle" is a
question about memory first and time second. This page documents the
machinery that makes both visible and bounded, and the measurements it is
built on. The phased plan toward arbitrarily large clouds (memory-mapped
sessions, tiled processing, streaming import) builds on these pieces.

## What a cloud costs

A `CloudSession` stores positions as float64 (24 B/pt), every scalar column
as float32 (4 B/pt each), colours as three uint16 (6 B/pt), intensity as
uint16 (2 B/pt), timestamps as float64 (8 B/pt), and a one-byte delete mask.
A typical terrestrial LAS import is ~57 B/pt; a RIEGL position with its
thirteen attributes is ~87 B/pt. So:

| Points | Resident session | Peak during import |
|---|---|---|
| 10 M | 0.6–0.9 GB | ~0.7–1.0 GB |
| 30 M | 1.7–2.6 GB | ~2–3 GB |
| 100 M | 5.7–8.7 GB | ~6.5–10 GB |

`memory_budget.bytes_per_point()` and `estimate_session_bytes()` are the
single source of these numbers in code.

### Import reads in chunks

`_read_las_into_arrays` used to `reader.read()` the whole LAS and then
`np.stack(...).astype(float64)` it, so the entire laspy record and the
float64 position copy were resident at once — a 2x transient. It now sizes
every column from the header and fills them from `chunk_iterator`
(`_LAS_READ_CHUNK` = 2 M rows), so the peak is the session plus one chunk.
Columns whose fate depends on their contents (constant standard dims and
all-zero intensity are pruned; `gps_time` is kept only when it varies) are
tracked per chunk in their native dtype and cast to float32 only if kept.
The same chunked read backs `_file_miss_mask`, which used to load a whole
LAS to get one byte per point. The PLY converter writes its LAS in blocks
straight from plyfile's memory map (binary PLY; an ASCII PLY is parsed into
RAM by plyfile itself), and the E57 converter converts and writes one scan
at a time instead of accumulating every scan and concatenating — the LAS
schema is decided from the scan headers' field lists and the offset placed
at the first scanner position, both known before a point is read. PCD still
goes through open3d's whole-file read.

### Undo history is deltas, not snapshots

Each committed delete used to push `sess.deleted.copy()` — a full (N,) bool
mask — onto `deleted_history`, so fifty erase clicks on a 100 M-point cloud
were 5 GB of undo history, more than the positions. It now records the
indices each step *newly* deleted and `reset_edits` replays them; when the
bounded stack (`_MAX_DELETED_HISTORY`) drops its oldest step, that step's
deletions fold into `deleted_base`, the floor the replay starts from.

## Store-backed sessions (memory-mapped columns)

Above `_session_store_min_points()` — 10 % of the memory budget divided by
the per-point cost, so ~12 M points on a 16 GB laptop and ~50 M on 64 GB;
`PHYTOGRAPH_SESSION_STORE_MIN_POINTS` pins it — a session's arrays live in a
`session_store.SessionStore`: one memory-mapped `.npy` per column under
`<octree cache root>/.sessions/<pid>-<nonce>/<session_id>.store/`. What
changes and what does not:

- **Import writes the columns there directly.** `_read_las_into_arrays(store=…)`
  allocates each kept column in the store and fills it chunk by chunk, so a
  large cloud is disk-backed from the first chunk and never exists as a RAM
  copy. The renderer, the octree build and every tool see the same
  `CloudSession` fields as before; a memmap is an ndarray.
- **In-place edits persist by themselves.** `deleted |= mask`,
  `positions -= shift`, a label brush writing into an extras column — all go
  through the map. Wholesale replacements (a bake compacting `positions`, a
  new `ground_class` column) stay RAM arrays until the session is next
  evicted, when `_session_write_back_to_store` writes anything that is not
  already the store's own map (identity, not equality) and updates the
  extras mapping.
- **Spill is a write-back plus a small pickle.** `_spill_cloud_session`
  writes back, then pickles `_session_detach_for_pickle(sess)` — the session
  with every store-backed array stripped — beside the store. Restore
  unpickles that and `_session_reattach_store` hands the maps back. The live
  object is never mutated by a spill, so the mid-spill claim-back the spill
  design relies on stays safe. A session born with RAM arrays (a split child,
  a merge, a synthetic scan) gets its store at its first eviction.
- **Eviction now also fires on memory pressure.** `_eviction_victims_locked`
  adds, after the TTL and count victims, the least recently used RAM-resident
  sessions while together they exceed `_SESSION_RAM_FRACTION` (50 %) of the
  budget. Store-backed columns count as nothing there: they are page cache
  the OS reclaims on its own, and evicting such a session costs one small
  pickle.
- **Delete removes the directory**, whether the session was live or spilled;
  a run that dies leaves directories that the next launch's dead-pid reaping
  removes (they live under the per-process spill root).

**Export streams from the session.** A session exported to a LAS/LAZ *file*
goes through `_export_session_to_las`: the survivor indices are taken once
under the session lock, then each 2 M-row block is gathered under the lock
and written outside it, so the transient is one block and the lock is never
held across LAZ compression. The generic path (`_read_points_and_extras`
plus one `laspy.LasData` for everything, ~10 GB of transient at 100 M
points) remains for the base64 response and for text formats, which were
already chunked at the write. Same columns, same classification byte, same
point-format choice; intensity and RGB are written verbatim rather than
through the generic path's float32 round trip.

What is *not* yet chunked: compute tools still call `positions[keep].copy()`
through `_read_points_and_extras`, so a tool on a 100 M-point store still
materialises a full copy of the hits — the tiled runner (next section) is the
answer for neighbourhood tools, and per-block reads for the point-local ones
(C2M, DEM pre-binning).

## Tiled processing (the lidR engine)

`backend-api/tiled.py` runs a whole-cloud algorithm per XY tile plus a collar
of neighbouring points, keeps only the tile's own results, and merges — what
lidR's `LAScatalog`, LAStools' `lastile -buffer` and PDAL's `filters.splitter`
do. Points are binned once by cell id (one `argsort`), so a tile's core and
collar are contiguous ranges of the sorted order rather than a pass over N.
The collar is the algorithm's own scale; too small a collar shows up as
seams, which `tests/test_tiled.py` checks separately within 0.5 m of tile
boundaries rather than letting the whole-cloud average hide it.

**Ground segmentation** is the first tool on it. From
`PHYTOGRAPH_GROUND_TILE_MIN_POINTS` (default 4 M) up, `segment_ground` runs
per tile of about `PHYTOGRAPH_GROUND_TILE_TARGET_POINTS` (3 M) points with a
collar of 30 cloth resolutions (2–30 m). The CSF working set (two copies of
the points plus the cloth, ~60 B/pt) is then bounded by one tile instead of
the cloud, which is what keeps a 100 M-point run inside a 16 GB laptop's
budget. With **Measure from the scan** on, the ground tolerance is measured
once on an even stride sample and applied to every tile, so tiles cannot
disagree about where the ground is; the session endpoint reports the plan
(`tiled: {tiles, tile_m, buffer_m, workers, …}`).

**Tiles run on every core.** `tiled.run_tiled_parallel` fans the tiles out
to a `multiprocessing` **spawn** pool (never fork: the worker has open3d
loaded and the backend libhelios, and a forked copy of either crashes in
the post-fork window). Children memory-map the worker's staged `input.npy`
(`PHYTOGRAPH_TILE_POINTS_NPY`, set by `seg_worker`) and gather their own
tile by index, so a task pickle is a few strings plus one index array, and
only the core rows' results come back. `tiled.worker_count` picks
min(cores, tiles, what the memory budget allows at one tile plus ~400 MB
per child); `PHYTOGRAPH_TILE_WORKERS` pins it, `1` disables the pool. The
children inherit the worker's process group, so a cancel that `killpg`s the
worker reaps them. **A pool is only ever opened inside the seg worker**
(`worker_count` returns 1 without `PHYTOGRAPH_SEG_WORKER`): multiprocessing's
POSIX launcher forks before it execs, and the backend process has libhelios
(GLFW) and open3d loaded — a forked copy of that dies with SIGSEGV in the
post-fork window (the reason `_SegProc` uses `posix_spawn`), which leaves the
pool blocked on its start-up pipe. Seen as a hang in pytest, whose process
has `main` imported; the pool tests therefore drive `tests/tile_pool_probe.py`
in a fresh interpreter launched with `posix_spawn`, never `subprocess.run`. In the frozen bundle the children are the backend
binary itself: `backend_wrapper.py` calls `multiprocessing.freeze_support()`
before anything else so a pool child runs its task loop and exits, and the
seg-worker dispatch is guarded by `__name__ == "__main__"` so a child that
imports the wrapper as `__mp_main__` cannot start a second segmentation.
Both are pinned at source level, and the pool's answer is pinned equal to
the sequential one for ground segmentation and both denoise criteria.

**Outlier removal** (`denoise.py`) tiles its two local criteria the same
way from `PHYTOGRAPH_DENOISE_TILE_MIN_POINTS` (4 M): radius outlier removal
with a collar of the radius, voxel-count with a collar of the voxel and the
grid anchored at one origin for every tile (a per-tile minimum would shift
the grid at every seam). Parameters are resolved once, on every k-th small
cell of a fine probe grid — spatially contiguous inside each cell, so the
nearest-neighbour spacing is the true one, and spread across the cloud so a
dense tile does not understate the sparse far field. SOR's threshold is a
mean over the whole cloud by definition and stays untiled.

**Point-local tools stream instead.** `_iter_session_hit_positions` yields a
session's surviving hits in 2 M-row blocks (deletions, misses, world shift
and translation applied) under a per-block lock; cloud-to-mesh distance
consumes it and keeps only the float32 distance per point.

Remaining candidates, each with its natural collar: local PCA wood/leaf
features (the largest scale), normals (the search radius), DEM pre-binning
(none, a per-block consumer of the same iterator).

### The octree LAS write no longer holds the session lock

`_session_rebuild` used to hold the global session lock across the whole
`_session_to_las` encode — "the longest lock hold in the process", ~1 s per
10 M points with extras, during which every other session request stalled.
`_session_to_las(block_lock=…)` now snapshots the survivor set and the array
*references* once under the lock and takes it again only per 2 M-row block
for the gather; the laspy encode runs unlocked. Capturing references means a
bake that replaces `positions` mid-write cannot desynchronise the block
indices from the arrays they index; an in-place edit landing between blocks
can differ between blocks, which the next rebuild reconciles and the renderer
masks in the meantime. Pinned by racing a slowed write against a request on
another session.

### Filter commits rebuild in the background

`Remove points` on a session cloud used to await the reconversion inline:
`session_filter` with `rebuild: true`, i.e. the point deletion (milliseconds)
plus a full PotreeConverter run (a minute on a large plot) before the panel
closed. It now commits with `rebuild: false` and hands the rebuild to the
same `octreeRefreshQueue` that crop and erase use. Until the swap, the
committed predicate stays on the cloud's edit state as `committedFilters`
and is drawn through the very per-tile mask that showed the live preview,
so nothing the user can see changes at the moment of commit; the scan row's
count drops immediately from the backend's cumulative `deleted_count`. Every
compute and export path reads the session arrays, so the cloud *is*
filtered the moment the request returns. The refresh runner clears the
mask in the same state update that installs the rebuilt octree. A second
filter on a cloud whose rebuild is still queued waits for it to settle
first, because the rebuilt octree is what the next mask must be drawn over.


## The memory budget

`backend-api/memory_budget.py` measures the machine (via `psutil`, with an
`os.sysconf` fallback) and derives a **budget**: `PHYTOGRAPH_MEMORY_BUDGET_BYTES`
if pinned, otherwise `PHYTOGRAPH_MEMORY_BUDGET_FRACTION` (default 0.5) of
physical RAM. A fraction rather than a constant so the same build scales from
a 16 GB laptop (~8 GB budget) to a 64 GB workstation (~32 GB) without a
setting — and the user can still pin it: **Settings → Performance → Memory
budget (MB)** is passed to the sidecar as `PHYTOGRAPH_MEMORY_BUDGET_BYTES`
at spawn (`memoryBudgetEnv()` in `src/main/backend.ts`, pinned by
`memoryBudgetEnv.test.ts`), so it takes effect on the next backend start.
Every large-cloud threshold in the backend derives from this number.

`GET /health` reports the budget, the backend's resident set, and what is
currently admitted against the budget; the slow-request log line
(`[slow] POST /api/... took 12.3s, rss 1.2 GB -> 4.8 GB of a 16.0 GB budget`)
says what a slow request cost.

### Admission control

Heavy paths declare their working set to `_ADMISSION.admit(bytes, label)`
before allocating it: the import read (the session's columns plus one
chunk), the killable segmentation workers (parent copy + worker copy +
labels), and export (a copy of every surviving column).
A job waits until it fits beside what is already running; a job larger than
the whole budget is admitted **alone** and logged rather than refused. The
budget is advisory for a lone job and a hard cap only on concurrency, because
paging is recoverable and a refused export is not. Refusing or prompting
happens *before* the work is committed to, via the cost advisory.

## Cost advisories (the 409 prompt)

Ground segmentation estimates its wall time and transient memory before
spawning anything, from measured throughputs (`_RATE_*` constants next to
`_cost_advisory` in `main.py`, deliberately about half the measured rate so
the estimate errs long):

- cloth filter: worker start (~4.5 s) + staging + CSF at ~10 M pts/s + the
  cloth simulation at ~50 M node-iterations/s (nodes = (extent / cloth)²,
  500 iterations);
- octree rebuild: LAS write at ~10 M pts/s + PotreeConverter at the rate of
  the sampling method it will be given (below); a run that will split into
  ground/plant children counts the parent's points twice.

Past `PHYTOGRAPH_COST_WARNING_SECONDS` (default 90) — or when the transient
working set alone exceeds the memory budget — the endpoint answers **409**
with a structured `cost_warning` (`message`, `estimated_seconds`,
`estimated_bytes`, `budget_bytes`, `over_time`, `over_memory`). The renderer's
existing `CostWarningError` path (shared with TreeIso) turns that into an
amber advisory and a **Segment Anyway** button, which re-sends with
`acknowledge_cost: true`. A cloth resolution that would build more than
25 M cloth nodes is refused outright (400) with the coarsest resolution that
fits, because that is a hang, not a slowdown, and independent of point count.

## Octree LOD sampling policy

PotreeConverter builds each inner node's level-of-detail sample either with
`poisson` (blue-noise; its default) or `random`. Measured on a 10 M-point
cloud on an M-series laptop:

| Stage | Time |
|---|---|
| LAS write (laspy, chunked) | 0.4 s |
| sha1 of the LAS | 0.2 s |
| PotreeConverter `-m poisson` | 32.2 s (0.31 M pts/s) |
| PotreeConverter `-m random` | 5.1 s (1.97 M pts/s; 6.1 M pts/s on the 100 M cloud, where start-up no longer dominates) |

The converter is the largest cost of every import, bake, filter, split and
segmentation on a large cloud, and a ground segmentation with split
reconverts about 2N points. So the backend passes `-m random` from
2 M points up (`_POTREE_RANDOM_SAMPLING_MIN_POINTS`) and `-m poisson` below,
where the user cannot feel the difference. Random sampling is what
Entwine/untwine (COPC) and QGIS use; the full-resolution leaves are identical
either way and only the coarse LOD nodes differ. Pin a method with
`PHYTOGRAPH_POTREE_SAMPLING=poisson|random`, or move the knee with
`PHYTOGRAPH_POTREE_RANDOM_SAMPLING_MIN_POINTS`.

**The cloth filter itself is not the wall.** Measured at 10 M points: CSF
0.27 s, copying its result out of the SWIG vector 0.30 s, converting labels
to JSON 0.04 s, staging the worker's input 0.08 s. What made "ground
segmentation above ~20 M points" slow was the three Poisson reconverts that
followed it.

## Measured so far (10 M points, M-series laptop, 10 cores)

Synthetic terrestrial cloud from `tools/make_big_cloud.py` (10 % misses),
through the real API via `tests/bench/`. Peak = resident set of the backend
plus its children (worker, PotreeConverter) above the idle baseline.

| Stage | Before (Poisson LOD, whole-file read) | After (random LOD from 2 M, chunked read) |
|---|---|---|
| import | 14.8 s, +2.9 GB | 9.7 s, +2.9 GB |
| ground segmentation (no rebuild) | 2.4 s, +2.5 GB | 2.6 s, +2.5 GB |
| split into ground + plant (3 rebuilds) | 16.5 s, +5.7 GB | 12.5 s, +4.1 GB |
| delete region + rebuild | 11.0 s, +4.1 GB | 6.0 s, +3.1 GB |
| export LAZ | 2.2 s | 2.3 s |
| LAS read alone (`_read_las_into_arrays`) | 0.22 s, 1138 MB peak | 0.43 s, 905 MB peak |

At 30 M points, store-backed from import, tiled ground segmentation and the
streamed export (one run, same machine):

| Stage | Time | Peak over baseline |
|---|---|---|
| import (store-backed) | 25 s | +7.7 GB |
| ground segmentation (tiled, no rebuild) | 8 s | +8.4 GB |
| split into ground + plant (3 rebuilds) | 30 s | +8.6 GB |
| delete region + rebuild | 16 s | +7.2 GB |
| export LAZ (streamed) | 5 s | +4.0 GB |

At 100 M points (same machine, 32 GB; store-backed, tiled ground on a
spawn pool, streamed export; the whole workflow in 4.4 min):

| Stage | Time | Peak over baseline |
|---|---|---|
| import (store-backed) | 65 s | +13.3 GB |
| ground segmentation (tiled, pooled, no rebuild) | 26 s | +12.7 GB |
| split into ground + plant (3 rebuilds) | 84 s | +14.1 GB |
| delete region + rebuild | 48 s | +9.0 GB |
| export LAZ (streamed) | 15 s | +9.8 GB |

PotreeConverter alone, measured with `/usr/bin/time -l` on the 100 M-point
LAS (random sampling): 16 s and a **7.06 GB** peak resident set, about 70 B
per point, in its own process. That is the largest single allocation any
edit makes on a large cloud, and a ground segmentation with split launches
three of them (parent plus two children). Every build is therefore admitted
against the memory budget at `_POTREE_BYTES_PER_POINT` (72) per point, which
serialises concurrent builds on a machine that cannot hold them side by side
— on a 16 GB laptop (8 GB budget) the three converts of a 100 M split run
one after another instead of stacking to 14 GB.

Read the peaks with two caveats. They are resident-set sizes of the backend
plus its children, so they include the session's memory-mapped pages (file-
backed, reclaimable by the OS under pressure — about 1.9 GB here) and
PotreeConverter's own working set during the rebuild stages; they are an
upper bound on what the machine must find, not on what it must keep.
Attributing the remainder (the worker's input copy, the tile plan's sort,
CSF per tile) with a per-process breakdown is the next measurement, and the
converter's footprint at 100 M decides how many rebuilds may overlap under
the budget.

## Benchmark harness

`backend-api/tools/make_big_cloud.py` writes a synthetic terrestrial-style
LAS at any size in chunks: 1/r² areal density from a central scanner, a
ground plane with mm noise, ellipsoidal tree crowns, optional sky/miss
returns projected 1 km out, plus intensity, RGB, gps_time, a `ground_truth`
column and a `target_index`/`target_count` pair.

`backend-api/tests/bench/test_large_cloud_bench.py` (gated on
`PHYTO_BENCH=1`) drives import → ground segmentation → split → delete +
rebuild → LAZ export through the real HTTP API and records wall time and
peak resident memory of the backend *and its children* per stage, plus the
agreement of the CSF result with the generator's ground truth. Results land
in `perf/bench-large-<N>M-<timestamp>.json`.

```bash
cd backend-api
PHYTO_BENCH=1 PHYTO_BENCH_POINTS=10e6,30e6 venv/bin/python -m pytest tests/bench -s --no-cov
```

Compare runs on the same machine and the same point counts; the generated
LAS is cached under `tmp/bench/` so only the pipeline is re-measured.
