# First Run

The simple case is one terminal:

```bash
npm run dev
```

This builds `main` + `preload` once, then picks a **free port** for both Vite
and the backend and launches Electron. When `backend-api/venv` exists,
`scripts/dev.mjs` starts `uvicorn --reload` itself and sets
`PHYTOGRAPH_DEV_BACKEND=1`, so Electron's supervisor stands down instead of
spawning the bundled sidecar.

The renderer doesn't hardcode the port: `initBackendUrl()` in
`src/renderer/utils/backendApi.ts` fetches it from the main process over the
`backend.getInfo` IPC before the first render.

That means the PyInstaller bundle at `resources/phytograph_backend/` is **not
required** for `npm run dev` — build it (`npm run build:backend`) when you want
to run the E2E suite or package an installer. If the venv is missing, the
supervisor falls back to the bundled sidecar; if that's absent too, the
renderer shows "Backend failed to start" and only viewer features work.

## What you should see

- A native window opens with the Phytograph UI.
- The status indicator in the bottom-right shows the backend version
  (matching `EXPECTED_BACKEND_VERSION` in `src/shared/constants.ts`).
- DevTools open automatically in dev mode (Cmd/Ctrl-Shift-I to toggle).
- Importing any point cloud (LAS/LAZ/PLY/PCD/XYZ/TXT/CSV/PTS/ASC) via
  drag-and-drop should display it in the 3D viewer.

## Iterating on Python

Nothing to set up — `npm run dev` already runs uvicorn with `--reload`
(watching `backend-api/`), so Python edits take effect in place without
rebuilding the sidecar.

## HMR scope

| Edits to | Picked up by |
|---|---|
| `src/renderer/` | Hot-reload (Vite) |
| `src/main/` or `src/preload/` | Restart `npm run dev` |
| `backend-api/` (Python) | uvicorn `--reload` — automatic |
| PyHelios/Helios C++ | Rebuilt on backend startup when stale — restart the backend |
