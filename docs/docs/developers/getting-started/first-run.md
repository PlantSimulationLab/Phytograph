# First Run

The simple case is one terminal:

```bash
npm run dev
```

This builds `main` + `preload` once, starts Vite on port **1427**, and launches
Electron. Electron's `backend.ts` supervises the bundled PyInstaller backend
on port **8008** — the same port the renderer always uses
(`getBackendUrl()` in `src/renderer/utils/backendApi.ts`).

The sidecar bundle at `resources/phytograph_backend/` **must already exist**
(step 4 of [Installation](installation.md)); if not, the renderer shows
"Backend failed to start" and only viewer features work. Re-run
`npm run build:backend` whenever you've changed backend code and want it
picked up by `npm run dev`.

## What you should see

- A native window opens with the Phytograph UI.
- The status indicator in the bottom-right shows the backend version
  (matching `EXPECTED_BACKEND_VERSION` in `src/shared/constants.ts`).
- DevTools open automatically in dev mode (Cmd/Ctrl-Shift-I to toggle).
- Importing any point cloud (LAS/LAZ/PLY/PCD/XYZ/TXT/CSV/PTS/ASC) via
  drag-and-drop should display it in the 3D viewer.

## Iterating on Python without rebuilding the sidecar

For tight Python iteration, run uvicorn directly so edits take effect on
uvicorn restart (or live with `--reload`). Because the renderer is
hard-coded to 8008, run uvicorn on 8008 too, and start `npm run dev` only
after killing any prior sidecar on that port:

```bash
kill $(lsof -ti :8008) 2>/dev/null
cd backend-api && source venv/bin/activate
uvicorn main:app --port 8008 --reload
```

Then in another terminal: `npm run dev`. The supervisor checks `/version`
on startup; if it sees a compatible backend already on 8008, it reuses it
instead of spawning its own.

## HMR scope

| Edits to | Picked up by |
|---|---|
| `src/renderer/` | Hot-reload (Vite) |
| `src/main/` or `src/preload/` | Restart `npm run dev` |
| `backend-api/` (Python) | Restart uvicorn (or `--reload`), OR `npm run build:backend` |
