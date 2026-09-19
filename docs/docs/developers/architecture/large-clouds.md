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
at the first scanner position, both known before a point is read. PCD
still goes through open3d's whole-file read (its reader is not chunked),
but writes its LAS in the same blocks, so the laspy record — the second
full copy that converter used to hold — is one block at a time.

### Undo history is deltas, not snapshots

Each committed delete used to push `sess.deleted.copy()` — a full (N,) bool
mask — onto `deleted_history`, so fifty erase clicks on a 100 M-point cloud
were 5 GB of undo history, more than the positions. It now records the
indices each step *newly* deleted and `reset_edits` replays them; when the
bounded stack (`_MAX_DELETED_HISTORY`) drops its oldest step, that step's
deletions fold into `deleted_base`, the floor the replay starts from.

### Session caps that scale with it

Three limits used to be constants sitting next to budget-derived ones, which
made them disagree by an order of magnitude across machines. All three keep
their 16 GB values (the machine they were tuned on) and now scale from there:

| Limit | Derivation | 8 GB RAM | 16 GB | 64 GB |
|---|---|---|---|---|
| `_MAX_CLOUD_SESSIONS` (count) | budget / 1 GB nominal, clamped [4, 32] | 4 | 8 | 32 |
| spill directory cap (disk) | 8 x budget, clamped [16, 256] GiB | 32 GiB | 64 GiB | 256 GiB |
| DEM stream cutoff | 15 % of budget / 112 B per point | ~5.8 M pts | ~11 M | ~46 M |

`_MAX_CLOUD_SESSIONS` stays a plain int module attribute (the eviction path and
~30 tests set it directly) and is applied *before* the byte cap, so a count too
low for the machine evicted sessions the budget would have kept. The spill cap
matters most: overflowing it **drops** a session, and for a cloud edited since
import that is unrecoverable work, so a laptop wants a smaller cap than a
workstation for the same reason it wants a smaller budget. Pinned by
`backend-api/tests/test_budget_derived_thresholds.py`, which asserts the
scaling relationship rather than the numbers.

## Store-backed sessions (memory-mapped columns)

Above `_session_store_min_points()` — 10 % of the memory budget divided by
the per-point cost, so ~15 M points on a 16 GB laptop and ~60 M on 64 GB;
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

### A bake re-homes the store

`bake` removes deleted rows for good. Only an explicit **Permanently apply
deletions** does that now: the renderer's background refresh queue calls
`bake?compact=false`, which rebuilds the octree from the survivors but keeps
every row under the mask, because LAD restores the deleted hits outside its
voxel grid from them (`_deleted_hit_grid_masks`). A compacting refresh had
undone a crop-to-grid LAD a few seconds after every crop. Keeping the mask
across rebuilds needs two things compaction had hidden: `reset_edits` needs
an undo floor (`_commit_delete_history_locked` sets `deleted_base` wherever
history is cleared), and the renderer's `pendingDeletedCount` must be
measured against the last installed build (`pending_deleted_count`, from
`octree_point_count`), not the cumulative `deleted_count`. Pinned by
`tests/test_background_refresh_keeps_deletions.py` and
`test_lad.py::test_crop_survives_the_background_octree_refresh`. On a
store-backed session the retained rows cost disk, not RAM.

Rows that leave a session for good are counted in `unrestorable_hit_count`, so
LAD can warn: the hits a compacting bake drops, and, for a child made by
split, extract, duplicate or merge, every parent hit it did not take (plus
what the parent had already lost). Backfill Misses resets the count, because
gap-filling against the remaining hits re-creates those pulses as misses.
Measured on the multi-return fixture: 2.4676 uncropped, 2.8613 after a crop
plus bake, 2.4723 once re-backfilled. Separately, `backfilled_misses_moved`
marks a buffer a transform moved. Its beam directions are not rotated, so LAD
warns from that flag even when every deletion was restored.

On a store-backed session a compacting bake used to
boolean-index every column, which pulled a full in-RAM copy of the survivors
back into the process and left the store recording the pre-bake point
count. The next eviction's write-back then refused the mismatch, the spill
failed, and the sweep dropped the session: a cropped 100 M-point cloud was
lost after 30 idle minutes. `_compact_session_store_locked` now gathers the
survivors block by block into a new `<id>.g<N>.store` directory, points the
session at its maps and unlinks the old directory. The old files are never
truncated in place, because a streaming reader may still hold a map between
its blocks. Session delete removes every generation. Pinned by
`tests/test_bake_store_backed.py` through the real crop, bake, evict and
restore API.

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

**The DEM pre-bin is bounded and no longer sort-bound.** `_compute_dem`
reduces the cloud to one z per grid cell (a low percentile, the robust
near-minimum) before anything is interpolated, so the grid work is bounded
by `_DEM_MAX_CELLS` however many points arrive. The reduction itself used
to cost ~48 B/pt of int64 temporaries plus an `np.lexsort` over two keys —
measured 32 s at 20 M points, i.e. the DEM of a 100 M-point cloud would
have spent nearly three minutes sorting. Cell ids are now int32 computed in
2 M-row blocks (`_dem_cell_ids`, also used by the density layers), and the
cell-then-z order comes from ONE composite float64 key (`_dem_cell_z_order`:
`cell * span + (z - zmin)`, with `span` wider than the z range by a margin
far above the key's float64 spacing so cells never interleave), which
`np.argsort` orders in 2.6 s at 20 M points with 412 MB of transient
against 777 MB before. The result is identical to lexsort's — pinned by a
test with exact ties and cells up to the cap — to within the key's spacing,
about 1e-9 of the z range, which decides only which of two z values closer
than that is picked. A session DEM whose whole-cloud working set would exceed
`_DEM_STREAM_BUDGET_FRACTION` (15 %) of the memory budget — i.e. that fraction
divided by the measured `_DEM_BYTES_PER_POINT`, so ~11 M points on a 16 GB
laptop and ~46 M on 64 GB, with `PHYTOGRAPH_DEM_STREAM_MIN_POINTS` still pinning
an exact count — no longer materialises the hits, the ground subset and the
first-return subset (~24 B/pt each). This was a flat 5 M points, which on a
64 GB workstation took the slower streamed path for a DEM that fit in RAM twenty
times over, and on an 8 GB laptop took it too late.
`_do_session_dem_streamed` reads the session in 2 M-row blocks: one pass for
subset counts and extents, one for per-row counts and the density,
intensity and footprint grids, and one that appends each gridded point's
cell id and z to band files cut at `_DEM_BAND_POINTS` (4 M). Each band is
sorted alone, and its per-cell percentile is the one the whole-cloud sort
would pick, because a band is a contiguous run of grid rows and cells never
span rows. Height above ground is sampled per block from one interpolator.
Everything after the per-cell representatives is shared with the in-memory
path (`_dem_surface_from_reps`, `_dem_layers_result`, `_chm_from_surfaces`),
and `tests/test_dem_streamed.py` requires the two to agree field by field
for DTM, DSM and CHM, with and without void filling and height above ground.
A cloud with no usable ground column and CSF requested still takes the
in-memory path, since CSF needs every point at once.

Measured on the synthetic terrestrial clouds (DTM, 0.5 m cells, TIN, ground
column present), one process per run. Peak is the resident set above the
loaded session. For the store-backed 100 M cloud it includes the store pages
the reads touch, which the OS can reclaim.

| Points | In-memory | Streamed |
|---|---|---|
| 10 M | 4.1 s, +0.37 GB | 3.8 s, +0.35 GB |
| 100 M | 18.3 s, +7.76 GB | 21.0 s, +1.87 GB |

At 10 M the copies are small enough that the two paths cost the same; at
100 M streaming trades about 15 % of wall time for a quarter of the memory,
which is the difference between fitting and paging on the 16 GB baseline.

Remaining candidates, each with its natural collar: normals (the search
radius). **Wood/leaf is left global on purpose.** Its per-point PCA
features are the only tileable stage (collar = the largest neighbourhood
scale); the GMM threshold, the skeleton segments and the cylinder gate that
follow are whole-tree operations on the voxel-decimated cloud
(`PHYTOGRAPH_WOOD_MAX_POINTS`, 1.5 M), so tiling the features alone would
not raise the cap — it stays a global-decimate tool with its cost stated.

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

The ground and wood/leaf splits follow the same rule for their parent. The
segmentation defers the parent's octree (`defer_octree`) and now marks it
stale, and the split builds only the children (`rebuild_parent: false`). The
renderer then queues the parent's rebuild on the refresh queue; the parent is
hidden once the split lands, so nothing waits on it. Measured at 10 M points,
the children alone take 7.7 s against 11.3 s with the parent in the same
build pool, where the three converter runs compete for the same cores. The
stale mark is load-bearing: without it the queued bake would see no deletions,
take its fast path and hand back the pre-column octree as current.


## PyHelios streaming and bulk APIs (helios-core v1.3.86)

PyHelios v0.1.32 exposes the lidar plugin's large-cloud APIs. The backend
uses four of them; each streaming path has a default-on environment switch
so a test can compare it with the retained path on the same input.

**Synthetic scans stream their chunks** (`PHYTOGRAPH_SYNTH_SCAN_STREAM`).
`setSyntheticScanHitSink` fires after each traced chunk lands in the native
cloud; the handler reads the chunk through the bulk readers and releases it
with `deleteHitPoints(first, count)`. Chunks are always the tail of the cloud
and earlier ones are already gone, so the bulk readers return exactly the
chunk, and the native cloud never holds more than one chunk rather than every
return of the scan. Chunk size follows `synthetic_scan_memory_budget_mb`.
`TestStreamedScan` in `tests/test_lidar_scan.py` forces a multi-chunk,
two-scanner trace with misses and requires the streamed result to equal the
retained one exactly.

**Leaf-area triangulation keeps no mesh** (`PHYTOGRAPH_LAD_TRI_STREAM`). The
inversion needs only the per-voxel leaf-angle sums, which the cloud keeps
either way, and nothing in `_do_lad_computation` reads the triangles. So
`setTriangulationSink` counts each scan's triangles and drops them. The
triangle count guard reads the sink's tally, because a streamed cloud reports
zero. `TestTriangulationSink` pins exact per-cell equality with the retained
mesh and that the streamed cloud holds no triangles. Helios triangulation
itself still retains its mesh, since the mesh is what that endpoint returns.

**Hits are ingested in bulk at float64.** Leaf area, scan export and miss
backfill call `addHitPointsBulk` through `_add_hits_bulk`, after one
`reserveHitPoints` for the whole cloud. `addHitPointsWithData` cast
coordinates to float32 and grew the hit array by reallocation, holding old and
new buffers at once. A NaN value now leaves that label absent on that hit,
where the old path stored a NaN the C++ read as present.

**Large grids invert a block at a time.** `calculateLeafAreaBlock` sizes the
per-voxel accumulators, and their per-thread copies, to a block of the
lattice. Tiling is not free: every block call re-walks every beam of every
scan. `_lad_block_cells_limit` therefore tiles only when the estimated scratch
(`_LAD_SCRATCH_BYTES_PER_CELL_THREAD` per voxel per thread) exceeds a quarter
of the memory budget, and `_lad_lattice_blocks` uses the fewest blocks that
fit, in whole voxel columns. Each block reports progress and honours cancel.
Terrain-following grids are not a regular lattice and keep the single call;
a large grid Helios does not recognise as a lattice is inverted whole, with a
warning. Hidden-return inference is per scan and ignores the block, so the
cropped-return statistics after the last block are the whole-grid figures.
`PHYTOGRAPH_LAD_BLOCK_CELLS` pins the block size; `tests/test_lad_blocks.py`
forces single-voxel blocks on both the triangulated and supplied-G(theta)
paths and requires exactly the whole-grid result.

Per-scan column readers are not used yet: every place that reads a native
cloud back either holds a single scan or needs all of it.

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

The renderer's counterpart is **Settings → Performance → Display point
budget (million points)**: potree's scene-wide point budget, the number of
octree points kept resident and drawn per frame whatever the cloud's size
(`DEFAULT_POINT_BUDGET` = 2 M, ~24 MB of positions on the GPU). It is
stored in millions (`displayPointBudgetM`), resolved and clamped by
`resolveDisplayPointBudget` (250 k – 30 M), re-read on every settings-dialog
close like the marker scale, and only ever lowered *further* by the crop
preview's overdraw guard. Rendering cost is O(budget), never O(N), so this
is the one knob that trades detail for frame rate on a 100 M-point plot.

`GET /health` reports the budget, the backend's resident set, and what is
currently admitted against the budget; the slow-request log line
(`[slow] POST /api/... took 12.3s, rss 1.2 GB -> 4.8 GB of a 16.0 GB budget`)
says what a slow request cost. **Settings → Performance shows what the budget
resolved to** (`getMemoryBudget()` reads `/health` when the dialog opens):
`Auto: using 8 GB of 16 GB detected`, or `Using 6 GB (set here)` when pinned.
Without it a blank field gave the user no way to tell half of 64 GB from the
4 GB unmeasurable fallback, which is also why the readout says when `psutil`
could not measure RAM at all.

### The synthetic-scan budget is reconciled against it

**Settings → Performance → Synthetic scan memory budget (MB)** is Helios's own
knob (`setSyntheticScanMemoryBudget`, 4 GiB CPU / 8 GiB GPU by default) and was
wholly independent of the process budget, so the two adjacent, near-identically
labelled fields could contradict each other in silence: a 2 GB process budget
left the ray trace on its 4 GiB default, and a 32 GB scan budget on an 8 GB
machine was accepted without comment. `_synthetic_scan_budget_bytes` now clamps
an explicit request to the process budget and, when nothing is requested,
overrides Helios's default only if the budget is the tighter of the two — so a
machine with plenty of RAM behaves exactly as before. Pinned by
`backend-api/tests/test_synthetic_scan_budget.py`.

### The budget vs. what is free right now

`budget_bytes()` is a property of the MACHINE and deliberately does **not** move
with free memory: it decides a session's on-disk-vs-in-RAM layout at import
(`_session_store_min_points()`), and a value that drifted would make the same
cloud spill or not depending on when it happened to be imported.

Admission is the opposite — a decision about *now* — so it uses
`admission_budget_bytes()`: the budget capped at `_AVAILABLE_HEADROOM` (70 %) of
what the OS reports available, floored at `_MIN_ADMISSION_BYTES` (1 GiB) so a
machine under pressure still makes progress one job at a time. A **pinned**
budget is honoured as-is (the user named a number; quietly admitting less would
make the setting a lie), and unmeasurable availability falls back to the plain
budget. This is the laptop case: 16 GB physical is an 8 GB budget, but with
2.4 GB actually free only ~1.7 GB of concurrent work is admitted instead of
8 GB of page-thrashing. `available_bytes()` was measured and reported for a long
time before anything acted on it.

### Admission control

Heavy paths declare their working set to `_ADMISSION.admit(bytes, label)`
before allocating it: the import read (the session's columns plus one
chunk), the killable segmentation workers (parent copy + worker copy +
labels), export (a copy of every surviving column), every PotreeConverter
run (72 B/pt, measured), and the session DEM (`_DEM_BYTES_PER_POINT` =
112 B/pt: the hits plus the ground and first-return subsets, measured at
10 M points).
A job waits until it fits beside what is already running; a job larger than
the whole budget is admitted **alone** and logged rather than refused. The
budget is advisory for a lone job and a hard cap only on concurrency, because
paging is recoverable and a refused export is not. Refusing or prompting
happens *before* the work is committed to, via the cost advisory.

Two more families were outside the gate until recently, which is worse than it
sounds: `Admission._acquire` admits freely whenever nothing is in flight, so
unadmitted work is **arithmetically invisible** — it neither waits for a running
job nor makes one wait for it.

- **Session mutations** — `merge` (the single largest allocation the backend can
  make: N sessions' survivor slices and the concatenated output are live at
  once), `transform` (a float64 copy of positions and beam origins, charged
  against the FULL count since deleted rows keep their coordinates for undo),
  `split` and `extract` (survivor slice plus the child's columns). Sized by
  `_session_mutation_bytes`, which reads the columns a session actually carries
  rather than a flat per-point figure, so a bare xyz cloud is not charged for
  colour, intensity, timestamps and beam origins it does not have.
- **Registration** — `/api/c2c/icp-register`, `/api/c2m/icp-register` and
  `/api/c2c/global-register`, via `_registration_bytes` (both clouds, Open3D's
  own copies and its KD-trees, `_REGISTRATION_COPIES` = 4). `c2m/distance` is
  deliberately **not** admitted: it streams the cloud in blocks and holds only
  4 B/pt of distances plus the mesh scene, so it is already bounded.

**Admission is always acquired OUTSIDE `_cloud_session_lock`, never under it.**
`_acquire` sleeps on its Condition while it waits, and holding the global
session lock across that sleep would stall every unrelated session request
behind one queued operation — and deadlock against anything that admits while
holding it. `test_admission_coverage.py` pins the ordering (by lock depth at
admit time, since a merge takes and releases the lock several times) as well as
the presence.

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
| DTM from the ground column (0.5 m cells, TIN, no rebuild) | — | 3.5 s, +1.7 GB |

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
`PHYTO_BENCH=1`) drives import → ground segmentation → DTM → split →
delete + rebuild → LAZ export through the real HTTP API and records wall time and
peak resident memory of the backend *and its children* per stage, plus the
agreement of the CSF result with the generator's ground truth. Results land
in `perf/bench-large-<N>M-<timestamp>.json`.

```bash
cd backend-api
PHYTO_BENCH=1 PHYTO_BENCH_POINTS=10e6,30e6 venv/bin/python -m pytest tests/bench -s --no-cov
```

Compare runs on the same machine and the same point counts; the generated
LAS is cached under `tmp/bench/` so only the pipeline is re-measured.
