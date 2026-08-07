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

- If `backend-api/venv` exists, `npm run dev` runs uvicorn itself — check the
  `[dev]` lines in the terminal for a uvicorn startup failure.
- Without a venv, the supervisor falls back to the bundled sidecar, so confirm
  `resources/phytograph_backend/` exists (if not, run `npm run build:backend`).

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
- An orphaned backend from a previous session (it won't block the new
  instance, which picks its own port, but it does consume memory):
  ```bash
  pkill -f phytograph_backend      # packaged bundle
  pkill -f 'uvicorn main:app'      # dev
  ```

## "Cannot remove quarantine" on macOS

The signed app's CodeSignature seal makes xattrs immutable. Either install
via Finder drag (which clears quarantine on first launch via Gatekeeper
approval), or use a signed+notarized CI build where this never comes up.

## Renderer can't reach the backend

The renderer does **not** hardcode the port. `initBackendUrl()` in
`src/renderer/utils/backendApi.ts` fetches the real port from the main process
over the `backend.getInfo` IPC before the first render, and `getBackendUrl()`
returns that cached value. If requests are going to the wrong place, the
resolution step is what to inspect — don't edit `getBackendUrl()`. To pin a
specific port for both ends, set `PHYTOGRAPH_BACKEND_PORT`.

## A tool fails with "… timed out. The backend did not respond within …"

Every request the renderer makes carries a client-side deadline (2 min for an
export, 5 min for a session op or a plant generate, 10 min for an import). When
one expires, `abortOnTimeout()` in `src/renderer/utils/backendApi.ts` aborts the
fetch with a `BackendTimeoutError` naming the endpoint and the budget, and that
message is what the toast shows.

The backend logs any request over 5 s, so start there:

```
[slow] POST /api/pointcloud/export took 143.2s, 2 other request(s) already in flight
```

Lower the threshold with `PHYTOGRAPH_SLOW_REQUEST_SECONDS` (in dev the line goes
to the `npm run dev` terminal alongside uvicorn's access log). If the request
isn't in the log at all it never arrived; if it's there and never finished, the
operation is stuck — restart the backend.

The trailing in-flight count should be **uncorrelated** with slowness. It wasn't
always: every handler used to be `async def` doing blocking work inline on the
single event loop, so one long operation starved every other request behind it —
a 7 M-point LAZ export (≈1–2 s of real work) died on its 2-minute deadline while
60 ms preview calls timed out at 60 s. Blocking handlers are now `def` and run in
the worker threadpool. If you see slow requests correlating with a high in-flight
count again, something has regressed — see
[Concurrency model](architecture/backend.md#concurrency-model).

A **user cancel** is deliberately different: it aborts with no reason, stays a
plain `AbortError`, and callers swallow it silently. Don't collapse the two, or
a real timeout goes back to being invisible.

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

## Stale backend processes

Since ports are resolved per instance, a leftover backend no longer blocks the
next launch — it lands on a different free port. (The supervisor only kills a
process on *its own* resolved port, and only when `/version` mismatches, so a
running dev backend is never killed by a test run or a second instance.)

To clean up orphans:

```bash
pkill -f phytograph_backend      # packaged bundle
pkill -f 'uvicorn main:app'      # dev
```

To see what holds a specific port: `lsof -ti :<port>`.
