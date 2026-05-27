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
| `ipc.ts` | `ipcMain` handlers for dialog, fs, persistent store |
| `updater.ts` | `electron-updater` wiring |

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
- `webUtils.getPathForFile` (drag-and-drop path resolution)

**Anything compute-heavy goes over HTTP, not IPC.** This keeps the
Electron main process responsive and lets the backend be developed and
tested as a normal HTTP server.

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
