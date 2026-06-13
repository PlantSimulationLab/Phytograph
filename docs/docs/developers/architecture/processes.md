# Processes & IPC

Three processes, three boundaries:

## Renderer (`src/renderer/`)

React + Vite, **no Node access**. Talks to:

- Python over HTTP to `127.0.0.1:8008/api/*`
- The OS via `window.electronAPI` (exposed by the preload script)

The renderer is hard-coded to `http://127.0.0.1:8008` via `getBackendUrl()`
in `src/renderer/utils/backendApi.ts`. There is no dev/prod auto-switching —
if you want to point at a different host or port, edit that function.

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

A **single ~5000-line FastAPI file** containing all endpoints:
`/api/fit`, `/api/triangulate`, `/api/plant/*`, `/api/c2m/*`,
`/api/skeleton/extract`, and more.

`backend_wrapper.py` is the PyInstaller entrypoint.

!!! tip "Grep for routes"
    When grepping for routes, use `^@app\.` to find them quickly in
    `backend-api/main.py`.

## The IPC bridge is intentionally narrow

Only these surfaces are exposed to the renderer:

- `dialog` (open/save file dialogs)
- `fs` (limited filesystem operations the renderer can't do over HTTP)
- `store` (persistent settings via `electron-store`)
- `backend.getInfo` (version + port reporting)
- `shell.openExternal` (open https/mailto URLs)
- `logs` (forward renderer logs, get the log path, export a combined log file)
- `webUtils.getPathForFile` (drag-and-drop path resolution)
- `onBackendStatus` (one-way main → renderer push of backend crash/restart status)

**Anything compute-heavy goes over HTTP, not IPC.** This keeps the
Electron main process responsive and lets the backend be developed and
tested as a normal HTTP server.

## Backend supervision & recovery

`backend.ts` doesn't just spawn the sidecar — it keeps it alive:

- **Crash → respawn.** If the Python process dies and we didn't ask it to
  (a native open3d/PyHelios crash, an OOM kill), the supervisor respawns it
  on the **same port** with a capped backoff (3 attempts: 500 ms → 2 s → 5 s).
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

## Logging

All three processes feed **one rotating session log file** owned by the main
process via [`electron-log`](https://github.com/megahertz/electron-log)
(configured in `src/main/logger.ts`):

| OS | Log directory |
|---|---|
| macOS | `~/Library/Logs/Phytograph/` |
| Windows | `%APPDATA%\Phytograph\logs\` |
| Linux | `~/.config/Phytograph/logs/` |

Each line is scope-tagged by origin:

- **`[main]`** — main-process `console.*` (patched onto the file transport in
  `logger.ts`), plus an `uncaughtException`/`unhandledRejection` handler.
- **`[backend]`** — the Python sidecar's stdout/stderr, teed line-by-line into
  the file by `backend.ts` (the passthrough to the terminal is kept too). The
  backend **also** writes its own `phytograph-backend.log` in the same directory
  (`backend_wrapper.py` adds a `RotatingFileHandler` at `PHYTOGRAPH_LOG_DIR`,
  which `main.ts` sets to the log dir). `main.py` registers an
  `@app.exception_handler` that logs unhandled 500s structurally.
- **`[renderer]`** — `console.error`/`console.warn` and `ErrorBoundary` catches,
  forwarded over the `log:write` IPC channel (`src/renderer/lib/logger.ts`).
- **`[updater]`** — auto-update events.

The feedback dialog's **Attach session logs** option calls `logs:export`, which
assembles the electron-log file + the backend's own file into one text file the
user saves and drags into a bug report (`copySessionLogTo` in `logger.ts`).

## Port wiring

Constants live in `src/shared/constants.ts`:

| Purpose | Port |
|---|---|
| Renderer dev server (Vite) | **1427** |
| Backend (dev and prod) | **8008** |
| `BACKEND_PORT_DEV` (defined but unused) | 8007 |

The renderer **always** hits 8008 via `getBackendUrl()`. `main.ts` calls
`startBackend()` in dev too, so the supervised PyInstaller binary on 8008
is what serves requests by default.
