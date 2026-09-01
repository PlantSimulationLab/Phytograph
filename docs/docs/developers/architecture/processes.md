# Processes & IPC

Three processes, three boundaries:

## Renderer (`src/renderer/`)

React + Vite, **no Node access**. Talks to:

- Python over HTTP to `127.0.0.1:<backend-port>/api/*`
- The OS via `window.electronAPI` (exposed by the preload script)

The port is **dynamic per app instance** — the renderer does not hardcode it.
`initBackendUrl()` in `src/renderer/utils/backendApi.ts` runs from
`src/renderer/main.tsx` before the first render: it fetches the real port from
the main process over the `backend.getInfo` IPC and caches it, so the
synchronous `getBackendUrl()` callers get the right base URL. To point at a
different backend, set `PHYTOGRAPH_BACKEND_PORT` rather than editing code.

## Main (`src/main/`)

Electron lifecycle, written as ESM. Responsibilities:

| File | Responsibility |
|---|---|
| `main.ts` | `BrowserWindow` creation, app lifecycle |
| `backend.ts` | Spawns and supervises the Python sidecar |
| `ipc.ts` | `ipcMain` handlers for dialog, fs, persistent store, logs |
| `updater.ts` | `electron-updater` wiring |
| `logger.ts` | Central `electron-log` config; unified session log file |

## Backend (`backend-api/main.py`)

A **single ~23,000-line FastAPI file** containing all endpoints:
`/api/fit`, `/api/triangulate`, `/api/plant/*`, `/api/c2m/*`,
`/api/skeleton/extract`, and more.

`backend_wrapper.py` is the PyInstaller entrypoint.

!!! tip "Grep for routes"
    When grepping for routes, use `^@app\.` to find them quickly in
    `backend-api/main.py`.

## The IPC bridge is intentionally narrow

Only these surfaces are exposed to the renderer:

- `dialog` (open/save file dialogs)
- `fs` (filesystem ops the renderer can't do over HTTP — **restricted to
  user-selected paths**, see *Filesystem access* below)
- `store` (persistent settings via `electron-store`)
- `backend.getInfo` (version + port reporting)
- `shell.openExternal` (open https/mailto URLs)
- `logs` (forward renderer logs, get the log path, export a combined log file)
- `webUtils.getPathForFile` (drag-and-drop path resolution)
- `onBackendStatus` (one-way main → renderer push of backend crash/restart status)
- `onUpdaterStatus` (one-way main → renderer push of auto-update download
  progress, rendered as a `StatusPill`)
- `onOpenFiles` / `notifyRendererReady` (OS "Open With" / file-association
  support — main pushes the paths the OS handed Phytograph; the renderer
  acknowledges readiness so main can flush paths queued during cold start)

**Anything compute-heavy goes over HTTP, not IPC.** This keeps the
Electron main process responsive and lets the backend be developed and
tested as a normal HTTP server.

## Backend supervision & recovery

`backend.ts` doesn't just spawn the sidecar — it keeps it alive:

- **Crash → respawn.** If the Python process dies and we didn't ask it to
  (a native open3d/PyHelios crash, an OOM kill), the supervisor respawns it
  on the **same port** with a capped backoff (3 attempts: 500 ms → 2 s → 5 s).
  Spawn *failures* take the same path — both the async `'error'` event
  (EACCES, missing dyld) and a synchronous `spawn()` throw (EBADARCH `-86`,
  a wrong-architecture binary) — so a backend that can't even start still
  ends in the `failed` dialog rather than a windowless, dialogless app.
  The same port matters because the renderer fetches the backend URL once at
  startup (`initBackendUrl`) and never re-fetches it. On a healthy respawn
  the attempt counter resets; on exhaustion the supervisor gives up.
- **Status push.** Each transition is pushed to the renderer over the
  `backend:status` channel (`restarting` / `ready` / `failed`). `App.tsx`
  toasts these — notably, after a `ready` it tells the user to **re-import**,
  because the sidecar holds imported clouds and plant sessions in RAM and a
  crash loses them.
- **Clean shutdown.** `stopBackend()` sends SIGTERM, then escalates to
  SIGKILL after 3 s if the process is still alive, so a sidecar stuck in a
  long native call can't orphan and hold its port/RAM.

## Octree cache location (cross-process contract)

Cached Potree octrees are written by one process and read by another, so the
two must resolve the same directory:

- The **backend writes** them — `_octree_cache_root()` in
  `backend-api/main.py`.
- The **main process reads** them back out through the `app://octree/...`
  protocol handler — `resolveOctreeCacheRoot()` in
  `src/main/octreeCacheRoot.ts`.

| Platform | Cache root |
| --- | --- |
| macOS | `~/Library/Caches/Phytograph/octrees` |
| Windows | `%LOCALAPPDATA%\Phytograph\cache\octrees` |
| Linux | `$XDG_CACHE_HOME/Phytograph/octrees` (or `~/.cache/...`) |

`PHYTOGRAPH_OCTREE_CACHE_ROOT` overrides all of it, and the supervisor **pins
its own resolved value into the sidecar's spawn environment**
(`spawnChild` in `src/main/backend.ts`). That pin is what actually guarantees
agreement at runtime; the Python fallback above only applies to a standalone
`backend_wrapper.py` launch. `scripts/dev.mjs` and the E2E launcher set the
same variable to per-session temp dirs.

!!! warning "Never derive this from `app.getPath('userData')`"

    That's what shipped, and it broke every import on Windows (issue #4).
    `userData` is `%APPDATA%` — the **Roaming** profile — while the backend
    writes to `%LOCALAPPDATA%`. The renderer fetched an octree that was never
    at that path, the handler returned a plain-text 404, and potree-core's
    `JSON.parse` failed on the body, so the cloud silently never rendered.
    Linux diverged the same way (`~/.config` vs `~/.cache`). macOS agreed
    only by accident — `app.getName()` returns `phytograph` while the backend
    hardcodes `Phytograph`, and the default APFS volume is case-insensitive
    — which is precisely why the dev loop and E2E never caught it.

    A multi-gigabyte regenerable cache also does not belong in a roaming
    profile, which is why the fix moved the reader to the backend's location
    rather than the reverse.

!!! warning "Never put it under `<userData>` on macOS either"

    The macOS row used to read
    `~/Library/Application Support/Phytograph/cache/octrees`, and that is a
    *different* bug with the same shape. `<userData>/Cache` is **Chromium's**
    HTTP cache, and the default APFS volume is case-insensitive — so `cache`
    and `Cache` were one and the same directory. Chromium empties that
    directory when it initialises its disk cache, which means **every app
    launch deleted the entire octree cache**, and a second concurrent instance
    (a dev or E2E app running alongside the packaged one) deleted it out from
    under the running app mid-session.

    Most of the time this was invisible — a missing octree is rebuilt from the
    source file on demand. It surfaced only for a cloud **edited since import**,
    whose cached octree is the *only* copy of those edits: recovery correctly
    refuses to rebuild from source (that would silently undo the edits), so the
    user got *"Edited point cloud unavailable"* and lost the work.

    macOS now mirrors Linux and uses the OS cache directory. Nothing needed
    migrating, because the old location could not survive a single relaunch.

The layout is pinned from both sides against a single written contract,
`src/shared/octreeCacheRoot.contract.json` — `src/main/octreeCacheRoot.test.ts`
(Vitest) and `backend-api/tests/test_octree_cache_root.py` (pytest) each assert
their own implementation against it, and a source-level chokepoint test asserts
the supervisor still passes the environment pin. Change one implementation
without the other and its test fails.

## Electron profile isolation (dev / E2E vs the desktop app)

`electron .` derives `app.getPath('userData')` from the app **name** — the same
name the installed `Phytograph.app` uses. So `npm run dev`, every E2E launch, and
the user's desktop app all resolved to one directory
(`~/Library/Application Support/phytograph`).

!!! danger "A dev or test launch could corrupt a live desktop session"

    Two things in that directory must not be shared:

    - **`phytograph-store.json`** — the user's real preferences (theme, point
      size, class palettes, rivlib path, synthetic-scan defaults). Any spec or
      dev session that changed a setting through the UI overwrote them for good.
    - **Chromium's profile**, including `<userData>/Cache`, which Chromium
      **empties** when it initialises its disk cache. Every dev/E2E launch wiped
      whatever the running desktop app had there — and since the octree cache
      used to live at `<userData>/cache/octrees` (the same directory on a
      case-insensitive volume), starting a dev session destroyed a live desktop
      session's octrees *while it was open*.

Both are fixed by passing Chromium's `--user-data-dir` at spawn, with
deliberately opposite lifetimes:

| | Directory | Why |
| --- | --- | --- |
| E2E (`launchApp.ts`) | fresh `mkdtemp` per launch, removed in `close()` | specs must not inherit each other's settings; the suite runs 2 workers |
| Dev (`scripts/dev.mjs`) | stable `tmpdir()/phytograph-dev-userdata` | dev settings should survive a restart. Override with `PHYTOGRAPH_DEV_USER_DATA_DIR` |

A fresh profile makes every E2E launch a "first run" (`ipc.ts` probes for the
store file), which only changes splash wording — no spec asserts on it.

`scripts/user-data-isolation.test.mjs` guards both at the source, because
dropping either switch reopens the collision **silently**: E2E on the shared
profile still passes every assertion, and the damage lands on whatever the
developer happens to have open.

## Octree cache eviction (and what must never be evicted)

The on-disk cache is trimmed to `PHYTOGRAPH_OCTREE_CACHE_MAX_BYTES` (default
20 GB) by `_evict_octree_cache`, oldest access time first. Callers pass `keep`
so a conversion never drops the dir it just wrote.

!!! danger "An edited cloud's octree is not a cache"

    A cloud's source file is read exactly **once**, at import. Every edit after
    that — bake, crop, erase, filter, split, segment — mutates the in-RAM
    session arrays, and nothing ever rewrites the file. The cloud has
    **diverged**, and octree recovery (`handleOctreeMissing`) correctly refuses
    to rebuild it from that stale file, because doing so would silently restore
    deleted points and undo baked transforms.

    So for a diverged cloud, deleting the octree dir is not reclaiming a cache —
    it is deleting rendered work that exists nowhere else. `keep` never covered
    this: it only names the dirs the *current* operation wrote, so baking cloud B
    was free to evict edited cloud A's octree sitting beside it in the scene.

    `_evict_octree_cache` now pins the octrees (hits **and** miss shell) of every
    live cloud session, snapshotted by `_live_session_octree_ids()` under
    `_cloud_session_lock` and released before the filesystem walk. The deliberate
    consequence: when the pinned set alone exceeds the cap, the cache stays over
    it and logs a warning. Overshooting a cap on regenerable disk is
    recoverable; deleting the only copy of an edit is not.

    Recovery closes the other half. A diverged cloud whose octree goes missing is
    rebuilt from its **session** (`POST /api/cloud/session/{id}/rebuild_octree`,
    which reconverts from the in-RAM arrays and reads no file). Only when there
    is no live session left does the user see *"Edited point cloud
    unavailable"* — and that remains a genuine dead end, so the session bound
    below is what ultimately limits how long an edited cloud survives.

## In-RAM session eviction

A cloud session (`CloudSession`) or plant session (`PlantSession`) is the
**source of truth in RAM** — a cloud session is ~30–60 bytes/point; a plant
session pins a live PyHelios context. They were previously reclaimed only by
an explicit `DELETE`, so a renderer reload/crash that never issued one leaked
them until the backend died.

`backend-api/main.py` now bounds them lazily (no background thread), mirroring
the LRU-by-timestamp policy of the on-disk `_evict_octree_cache`:

- Every session read/mutate bumps `last_accessed`; every create
  opportunistically sweeps (`_sweep_cloud_sessions` / `_sweep_plant_sessions`).
- A sweep drops sessions idle past `PHYTOGRAPH_SESSION_IDLE_TTL_SECONDS`
  (default 30 min), then evicts least-recently-accessed survivors down to
  `PHYTOGRAPH_MAX_CLOUD_SESSIONS` / `PHYTOGRAPH_MAX_PLANT_SESSIONS` (default 8
  each). Evicted plant sessions get their PyHelios context torn down.
- The per-session undo stack (`deleted_history`, one full point-mask per erase)
  is capped at `PHYTOGRAPH_MAX_DELETED_HISTORY` (default 50) snapshots.

All four limits are environment-overridable.

## Filesystem access (allowlist)

The `fs` bridge enforces "user-selected paths only" — it isn't a blanket
filesystem API. `src/main/fsAllowlist.ts` records every path the user actually
chose and the handlers reject anything else, so a renderer compromise can't read
`~/.ssh/id_rsa` or overwrite arbitrary files:

- An open/save **dialog** result is allowlisted when it's returned.
- A **drag-drop / `<input type=file>`** path is allowlisted by preload right
  after `webUtils.getPathForFile` resolves it (one-way `fs:allowPath` IPC).
- **Reads** are permitted for an explicitly-selected file *and its direct
  siblings* (companion-file allowance — selecting `scene.xml` lets the
  scan-import resolver find `scene.xyz` next to it). **Writes** are permitted to
  a save target and to direct children of a chosen export directory. Neither
  recurses into subdirectories.

## Custom protocols & data transport

Heavy data never crosses IPC as JSON:

- **Octree streaming.** `octreeProtocol.ts` serves Potree files over
  `app://octree/<sha1>/<file>`. `octree.bin` is hundreds of MB and potree-core
  fetches it in `Range` chunks, so the handler **streams** each range with
  `fs.createReadStream` → a web `ReadableStream` rather than reading it into a
  Buffer — no main-process memory spike, no event-loop block. `metadata.json`
  stays a small buffered read (it needs an inf/nan→null rewrite).
    - **One frame update for every octree.** potree's point budget and its node
      LRU are both global to the shared `Potree` manager, so
      `updatePointClouds` must be called **once per frame with the full array
      of visible octrees** — never once per cloud. Cloud components
      (`OctreePointCloud`, `MissOctree`) register with the frame registry in
      `viewer/potreeManager.ts`; the single `PotreeFrameDriver` inside the
      Canvas drives them together. Updating clouds individually makes each one
      claim the entire budget (N× the intended resident points) and makes each
      call's `lru.freeMemory()` evict whichever cloud was touched least
      recently — so with several scans loaded the clouds visibly flicker in and
      out every frame, worst during crop preview where the reduced budget puts
      demand above the `2 × pointBudget` eviction threshold.
- **Binary point-cloud frames.** Point-cloud import and compute responses use a
  packed binary layout (`PHX1` for import via `_pack_pointcloud_response`; `PHB1`
  for array responses) decoded straight into `Float32Array` views, bypassing
  V8's ~512 MB max-string ceiling. LAS/LAZ import (both `import_by_path` and the
  no-path multipart fallback) and text export (`_format_points_as_text`, now
  vectorised via `np.savetxt`) all go through these fast paths instead of
  per-point JSON / f-string loops.

## Compute caps

Several backend endpoints fail fast past a point cap instead of hanging on a
pathological cloud — `_WOOD_SEGMENT_MAX_POINTS` and `_SKELETON_MAX_POINTS`
(`PHYTOGRAPH_SKELETON_MAX_POINTS`, default 3 M; the skeleton neighbour graph is
built with a single batched KD-tree query rather than a per-point Python loop).
All are environment-overridable.

**Tree segmentation warns on voxels; it does not cap points.** TreeIso
voxel-decimates *first*, then runs cut-pursuit and its O(nGroups²) merge over the
decimated cloud only — so raw input size is the wrong cost proxy. A 13 M-point
cloud that collapses to ~600 k voxels is well inside TreeIso's intended regime,
while a 2.6 M-point ALS tile at the paper's 5 cm voxel decimates to 2.6 M nodes
(a 99 % no-op) and runs for 15–20 min.

The expensive case is a **confirmation prompt, not a refusal** — a user willing
to wait must always be able to run it, and Cancel works mid-run:

- `_treeiso_cost_warning` returns an advisory when the **exact** post-decimation
  voxel count (`_count_treeiso_nodes`, at the same auto-scaled voxel size the
  worker will use) exceeds `_TREEISO_MAX_NODES`
  (`PHYTOGRAPH_TREEISO_MAX_NODES`, default 2 M). It is exact rather than
  modelled: a `(res/spacing)³` density estimate ranged from 0.1× to 49× the true
  count depending on cloud shape.
- The inline endpoint returns `success: false` with a `cost_warning` (and **no**
  `error`); the session endpoint raises **409** with
  `{"cost_warning": …, "message": …}` — 409 so the renderer can distinguish
  "needs confirmation" from a genuine bad request. `CostWarningError` in
  `backendApi.ts` carries it to the panel, which shows an amber advisory and
  turns the run button into **Segment Anyway**.
- The retry sets `acknowledge_cost: true` and the run proceeds unconditionally.
  Non-UI callers (scripts, the eval harness) can set it up-front.
- `_TREEISO_MAX_POINTS` (`PHYTOGRAPH_TREEISO_MAX_POINTS`, default 50 M) is the
  only hard stop left — a loose backstop for the full-N work preceding
  decimation.

`_auto_treeiso_decimation` picks that voxel size from measured median spacing,
then *verifies* against the exact count and keeps coarsening until it is under
its ~1 M node target — the cube-law guess alone under-shoots at scale (a 13.5 M
plot landed on 4.3 M voxels), so most large clouds never trigger the advisory at
all.

## Sky/miss exclusion is a chokepoint, not a per-tool duty

A sky/miss point (`is_miss != 0`) is a ray that hit nothing, projected **~1 km
out** along the beam. On a real terrestrial scan they are routinely the
*majority* of the file — a measured vineyard scan is 21.06 M points, 61 % misses,
with the returns inside ±490 m and the miss shell reaching ±20 km.

Every tool that grids, triangulates, builds a KD-tree, or runs CSF over a cloud
scales off that cloud's extent, so leaving misses in inflates it ~1000× and the
algorithm **hangs rather than errors**. Where the extent only feeds a threshold
(cloud-to-mesh coverage, ICP pre-alignment) the failure is quieter and worse: a
confident wrong answer. Measured on that scan, misses inflated the robust
diagonal 2,192× (29 m → 64 km), so a 5 % correspondence distance became 3,210 m
instead of 1.47 m and the centroid sat 5 km out in Z.

Two payload shapes reach a compute endpoint, and only one was ever protected:

- **`source`** (session/octree clouds) — filtered **server-side** by
  `_read_points_from_source(include_misses=False)`, which honours the flag on
  both the session branch and the file-path branch (`_file_miss_mask` probes the
  file's own `is_miss` LAS extra-dim / ASCII column).
- **inline `points`** — passed through **verbatim**. The renderer is the only
  defense.

Filtering inline payloads used to be each call site's own job, which made it
something every new tool had to *remember* — and it was repeatedly forgotten. An
audit found eight tools shipping raw positions, six of them the unfiltered twin
of a correctly-filtered sibling in the same file (ground-seg vs tree-seg, QSM vs
skeleton, c2m vs c2c ICP, wood-aggregate vs wood-per-scan).

So the filter now lives at the chokepoint. `buildPointSource` calls
`collectHitPoints` once and returns `{ kind: 'inline', hits, data }`; `hits` is
the input for every compute path, and the payload type makes it **required**, so
a new call site cannot omit it without a compile error. Two rules follow:

- **Decimating? Use `collectHitPointsCapped`** — it filters *then* strides. The
  reverse order spends the budget on the miss shell: a 60 k budget over that
  61 %-miss scan kept ~37 k misses and thinned the actual tree to ~23 k.
- **Writing per-point results back? Use `scatterToFullLength`** — the backend
  labels the *hit subset*, so its result is shorter than `pointCount`. Writing it
  directly mislabels every point after the first miss.

`data` (misses included) stays available for the two paths that legitimately
need them: **export**, where a miss is real recorded information and dropping it
would break round-trip fidelity, and **LAD**, which needs misses as the
Beer's-law transmission denominator and reads them on its own path. Reach for it
only there, and say why at the site.

As defense in depth the inline branches of `/api/c2m/distance`,
`/api/c2m/icp`, `/api/triangulate/check-spacing` and the Helios triangulation
points-mode fallback also run `_drop_far_outliers`, which detects the *gap*
between the cloud and its shell rather than a multiple of the spread — a
percentile-based rule fails once misses are the majority, because they define the
percentile themselves.

Three further paths were **latent**: reachable, but protected only by a
coincidence of the current UI rather than by anything in the code. They are fixed
at the source rather than left to the coincidence:

- **`/api/triangulate/check-spacing`** — `_resolve_scan_positions` now excludes
  misses on all three of its branches (session `extras`, inline, file flags). A
  miss's nearest neighbour is another distant miss, so misses don't widen the
  spacing distribution, they *define* it: measured median nearest-neighbour
  distance was 35.65 m with misses versus 0.0143 m without, a ~2,500× error that
  inverts the bridging verdict. The caller's grid crop removed them incidentally
  and today's renderer always sends a grid — but the no-grid branch ("measure the
  whole cloud") had no protection, and the endpoint takes any client's request.
- **Helios triangulation, ASCII file-path branch** — the *binary* sub-branch
  decoded through `_read_points_from_source` and dropped misses; the ASCII `else`
  beside it did neither, streaming every row into the auto-grid bbox and handing
  the raw file to Helios. `_ascii_hits_only_copy` now rewrites the file with miss
  rows removed, **preserving every column** — a scan format may declare
  multi-return columns (`target_index`/`target_count`/`timestamp`) that the
  reconstruction consumes, so re-encoding to bare x-y-z would silently drop them.
  A file that declares no `is_miss` column is passed through untouched.
- **Flat-cloud parameter seeding** — CSF cloth resolution and DEM cell size are
  absolute distances seeded from "how big is this scene", and were reading
  `bounds.size`, which one ~1 km miss defines single-handedly. Use
  `extentForParameterSeeding()`, which prefers the backend's `robustExtent`
  (1st–99th percentile span) and otherwise computes a hits-only extent.
  `robustExtent` is only populated on session/octree clouds, so **flat clouds
  were the ones actually exposed** — the raw fallback gave defaults ~1000× too
  coarse: not a crash, just silently useless numbers.

The crop box is deliberately **not** filtered: it is an interactive box the user
drags, and it must enclose everything visible — including misses, or you could
never crop them away.

## Logging

All three processes feed **one log file per app session** owned by the main
process via [`electron-log`](https://github.com/megahertz/electron-log)
(configured in `src/main/logger.ts`):

| OS | Log directory |
|---|---|
| macOS | `~/Library/Logs/Phytograph/` |
| Windows | `%APPDATA%\Phytograph\logs\` |
| Linux | `~/.config/Phytograph/logs/` |

Each launch writes to its own `main-<timestamp>-pid<n>.log` (via the file
transport's `resolvePathFn`), so a bug report carries just that session instead
of weeks of interleaved runs. On startup `initLogging()` prunes all but the 10
newest sessions (skipped under E2E, where many app instances share the dir).
A single very long session still rotates at 5 MB into `…​.old.log`.

Each line is scope-tagged by origin:

- **`[main]`** — main-process `console.*` (patched onto the file transport in
  `logger.ts`), plus an `uncaughtException`/`unhandledRejection` handler.
- **`[backend]`** — the Python sidecar's stdout/stderr, teed line-by-line into
  the file by `backend.ts` (the passthrough to the terminal is kept too). The
  backend **also** writes its own `phytograph-backend-<session>.log` in the same
  directory (`backend_wrapper.py` adds a `RotatingFileHandler` at
  `PHYTOGRAPH_LOG_DIR`, which `main.ts` sets to the log dir; the `<session>` tag
  comes from `PHYTOGRAPH_LOG_SESSION`, matching the main file's tag so the pair
  is exported together). `main.py` registers an `@app.exception_handler` that
  logs unhandled 500s structurally.
- **`[renderer]`** — `console.error`/`console.warn` and `ErrorBoundary` catches,
  forwarded over the `log:write` IPC channel (`src/renderer/lib/logger.ts`).
- **`[updater]`** — auto-update events.

The feedback dialog's **Attach session logs** option calls `logs:export`, which
assembles the electron-log file + the backend's own file into one text file the
user saves and drags into a bug report (`copySessionLogTo` in `logger.ts`).

## Port wiring

**Ports are chosen at runtime, not fixed.** The constants in
`src/shared/constants.ts` are only *fallback defaults* for a bare
`electron .` or a standalone `backend_wrapper.py` launch:

| Constant | Fallback |
|---|---|
| `RENDERER_DEV_PORT` (Vite dev server) | **1427** |
| `BACKEND_PORT_PROD` (backend) | **8008** |

Whoever owns the instance picks the real port, so concurrent app instances,
a `npm run dev` session, and parallel E2E runs never collide:

- **`npm run dev`** — `scripts/dev.mjs` calls `findFreePort()` (bind `:0`) for
  both the backend and Vite, passes the backend port to `uvicorn --port` and to
  Electron via `PHYTOGRAPH_BACKEND_PORT`, and the renderer port via
  `PHYTOGRAPH_RENDERER_PORT`. It also sets `PHYTOGRAPH_DEV_BACKEND=1`, which
  makes the Electron supervisor stand down instead of spawning its own bundle —
  so in dev, **uvicorn** serves requests, not the PyInstaller sidecar.
- **Packaged app** — `resolvePort()` in `src/main/backend.ts` picks a free port
  (or honors `PHYTOGRAPH_BACKEND_PORT` if pinned) and spawns the bundled backend
  with it.
- **E2E** — `tests/e2e/helpers/launchApp.ts` picks a free port per launch and
  pins it via `PHYTOGRAPH_BACKEND_PORT`.

The renderer learns the port over the `backend.getInfo` IPC (see above), which
returns `getBackendPort()` from the main process.
