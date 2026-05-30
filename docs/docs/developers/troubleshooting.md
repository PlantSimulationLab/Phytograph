# Troubleshooting

## `build:backend` fails with `ModuleNotFoundError: No module named 'fastapi'`

PyInstaller is running against the wrong Python environment — almost
certainly anaconda's. Make sure `backend-api/venv/` exists and was created
with:

```bash
cd backend-api
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt pyinstaller
```

`scripts/build-backend.mjs` auto-prefers `backend-api/venv/bin/python` when
present. If you see the warning **"using bare pyinstaller from PATH"** in
the build output, the venv wasn't found.

## `build:backend` fails with `No such file or directory: …/venv/bin/python3`

The venv has stale shebangs (usually from being copied or its parent
directory being renamed). Delete and recreate:

```bash
cd backend-api && rm -rf venv && python3 -m venv venv && \
  source venv/bin/activate && pip install -r requirements.txt pyinstaller
```

## App launches but shows red "Backend failed to start" banner

**In dev:**

- Confirm `resources/phytograph_backend/` exists (if not, run `npm run build:backend` once).
- Or, if iterating Python, confirm uvicorn is running on port 8008.

**In packaged build:** open macOS Console.app or Windows Event Viewer and
search for `[Backend stderr]:` lines from the supervisor.

!!! note "Not every stderr line is an error"
    Python's `logging` writes to stderr by default, so INFO and WARNING
    messages land there too. Read the message before assuming a failure.

Common causes:

- Quarantine bit on a fresh macOS install:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Phytograph.app
  ```
- First-launch cold start (~30s with onedir, longer on slower disks)
- A previous backend on port 8008 from a stale process:
  ```bash
  kill $(lsof -ti :8008)
  ```

## "Cannot remove quarantine" on macOS

The signed app's CodeSignature seal makes xattrs immutable. Either install
via Finder drag (which clears quarantine on first launch via Gatekeeper
approval), or use a signed+notarized CI build where this never comes up.

## Renderer can't reach the backend

The renderer is hard-coded to `http://127.0.0.1:8008` via `getBackendUrl()`
in `src/renderer/utils/backendApi.ts`. There is no dev/prod auto-switching —
if you want to point at a different host or port (e.g. uvicorn on 8007),
edit that function.

## Plant generation / Helios features fail in dev only

PyHelios is built from the source submodule, not a pip wheel. Its native lib
(`libhelios.dylib`) lives at `pyhelios/pyhelios_build/build/lib/` and must be
importable from the active Python env. If you replaced or recreated the venv,
or the submodule isn't initialized, rebuild from source:

```bash
git submodule update --init --recursive   # if pyhelios/ is empty
source backend-api/venv/bin/activate
node scripts/build-pyhelios.mjs            # compiles libhelios + editable install
```

The backend also auto-rebuilds `libhelios` on startup when the C++ source is
newer than the compiled lib, so a stale lib usually fixes itself on the next
backend restart. A clean rebuild: `node scripts/build-pyhelios.mjs --clean`.

## Stale backend on port 8008

The single most common dev-time failure mode. The supervisor refuses to
spawn over an existing process unless `/version` matches. If the existing
process is unresponsive or mismatched:

```bash
kill $(lsof -ti :8008)
```

Then re-run `npm run dev`.
