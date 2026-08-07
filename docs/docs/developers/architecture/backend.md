# Backend Sidecar

The Python backend is a normal FastAPI project in `backend-api/`. In
production it's bundled by PyInstaller into a self-contained directory
that ships with the Electron app.

## How it's built

`npm run build:backend` runs `scripts/build-backend.mjs`, which calls
PyInstaller in `--onedir` mode. The output lands in
`resources/phytograph_backend/`:

```
resources/phytograph_backend/
├── phytograph_backend          # the executable
└── _internal/                  # libs + data files
```

The script auto-discovers `backend-api/venv/bin/python`. You can override
with `PYTHON=/path/to/python` if needed.

!!! note "PyHelios is a source submodule"
    PyHelios is **not** a pip wheel — it's vendored as a git submodule at
    `pyhelios/` (with its own nested `helios-core` C++ submodule) so it can
    be co-developed alongside Phytograph. `scripts/build-pyhelios.mjs`
    compiles the native `libhelios` from source (the `plantarchitecture` and
    `lidar` plugins; `--nogpu` drops only the radiation/OptiX plugin, not the
    `lidar` CUDA ray-tracing path, which compiles when a CUDA toolkit is
    present — the release workflow installs one on Windows + Linux, so those
    builds are GPU-accelerated while macOS stays CPU-only) into
    `pyhelios/pyhelios_build/build/lib/` and installs the package editable.
    The `lidar` plugin pulls in the `visualizer` plugin at the C++ level, so
    OpenGL (glfw/glew/freetype) compiles too — no extra packages on macOS
    (Cocoa) or Windows (native GL); Linux would need `libgl1-mesa-dev` /
    `xorg-dev`. Prereqs: cmake + a C++ compiler (Xcode Command Line Tools on
    macOS, MSVC on Windows). Native libs + textures +
    xml asset trees still travel with the PyInstaller bundle via
    `--collect-all pyhelios` in `scripts/build-backend.mjs`.

    `backend-api/main.py` puts the submodule on `sys.path` at import time and
    **auto-rebuilds** `libhelios` when any `.cpp/.hpp/.h` under `helios-core/`
    or `native/` is newer than the compiled lib — so editing the Helios C++
    and restarting the backend recompiles automatically. The first
    `npm run dev` / `npm run build:backend` on a fresh clone compiles Helios
    (several minutes); both scripts pre-build it when the lib is missing.

The build is **idempotent**: re-running `npm run build:backend` replaces
the prior bundle in place.

## How it's supervised

`src/main/backend.ts` is the supervisor. On Electron startup it:

0. Resolves its port (`resolvePort()`): `PHYTOGRAPH_BACKEND_PORT` if pinned,
   otherwise a freshly chosen free port. `BACKEND_PORT_PROD` (8008) is only the
   standalone-launch default baked into `backend_wrapper.py`.
1. If `PHYTOGRAPH_DEV_BACKEND=1` (set by `scripts/dev.mjs` when it has spawned
   `uvicorn --reload`), it **stands down** immediately — killing the port would
   defeat hot-reload.
2. Otherwise it probes that port for an existing backend by hitting `/version`.
3. If a **compatible** backend is already there, it reuses it.
4. If one answers with a **mismatched** version, it's killed and the bundled
   binary respawned.
5. If nothing answers, it spawns `resources/phytograph_backend/phytograph_backend`
   fresh and waits for it to come up.

Because each instance picks its own port, a second app instance or a test run
never disturbs a developer's running dev backend — and the supervisor never
pre-emptively kills a port it couldn't version-probe. See
[Version Lock](version-lock.md) for the contract details.

## How it's addressed

The renderer resolves the port over the `backend.getInfo` IPC, so every row
below is `http://127.0.0.1:<resolved-port>`:

| Environment | Who serves it |
|---|---|
| Dev (`npm run dev`, venv present) | `uvicorn --reload`, spawned by `scripts/dev.mjs`; supervisor stands down |
| Dev (no venv) | Supervisor spawns `resources/phytograph_backend/phytograph_backend` |
| Packaged build | Bundled binary alongside the app |

## Concurrency model

One process, one asyncio event loop. What keeps it responsive is **how handlers
are declared**:

- **`def` (not `async def`) for anything that blocks.** FastAPI runs a sync
  handler in anyio's worker threadpool, so the loop stays free to accept and
  answer other requests while it works. numpy / open3d / laspy / laszip release
  the GIL in their heavy sections, so those genuinely run in parallel. This is
  the default for a Phytograph endpoint — the compute *is* the endpoint.
- **`async def` only when the handler actually awaits**: a streaming response, an
  `UploadFile` read, or `_run_killable`'s disconnect poll. Then every blocking
  section inside it must go through `await run_in_threadpool(...)` — an
  `async def` handler owns the loop between its awaits.

An `async def` handler with no `await` in its body is always a bug: it holds the
loop from first statement to last. `tests/test_event_loop_not_blocked.py` fails
the build on one, and measures the property directly against a live uvicorn
(a 1 s handler must not delay a concurrent `/health`).

This was learned the hard way. Every handler used to be `async def` with its
compute inline, so the backend served exactly one request at a time: a 7 M-point
LAZ export whose real cost is ~1–2 s died on its 2-minute client deadline, and
`/api/pointcloud/preview` calls that measure 3–70 ms timed out at 60 s, purely
from starvation. Nothing was slow; everything was queued.

Two consequences worth knowing:

- **Peak memory is no longer capped at one operation.** Serialization used to
  bound it implicitly. The worker threadpool is sized to
  `max(8, min(16, cpu_count))`, overridable with `PHYTOGRAPH_MAX_WORKER_THREADS`.
- **Shared state needs its lock.** `_cloud_sessions`, `_plant_sessions`,
  `_SEG_WORKERS`, `_CANCEL_REGISTRY` and the octree build locks each have a
  `threading.Lock`, and session read-modify-write runs entirely inside it. Never
  hold one across an `await` — a coroutine parked on a threadpool call while
  holding a lock that the threadpool's own threads need is a deadlock.
- **Response serialization still happens on the loop.** A multi-hundred-MB JSON
  body blocks it regardless of how the handler is declared; that is what the
  binary-frame transport below is for.

## Wire format: JSON vs binary frames

Most endpoints exchange JSON. The **large array responses** — Helios + Open3D
triangulation (`/api/triangulate*`) and synthetic LiDAR scans (`/api/lidar/scan`)
— instead return a compact **PHB1 binary frame** (`application/octet-stream`):

```
magic 'PHB1' | uint32 header_len | JSON header (space-padded to 4 bytes) | buffers…
```

The JSON header carries the scalar metadata (`meta`) plus a descriptor list for
the buffers (name, `f32`/`u32`, length); the buffers (vertices, indices,
points, scalars…) follow concatenated, 4-byte aligned. The renderer reads them
as **zero-copy `Float32Array`/`Uint32Array` views** — no `JSON.parse`, no
`.flat()`, and no V8 ~512 MB string-length ceiling (a full-resolution tree
triangulation is hundreds of MB). Long computations stream 4-byte whitespace
keepalives ahead of the frame so WebKit's stall timeout doesn't fire; the
decoder skips them. Helpers: `_bin_frame_bytes` / `_bin_frame_streaming_response`
(backend) and `decodeBinaryFrame` / `fetchBinaryFrame` (renderer). The older
point-cloud import path uses a similar fixed `PHX1` layout. Other endpoints
(LAD, plant, QSM) stay JSON — their payloads are small or texture-dominated.

`_bin_frame_streaming_response` also carries the **progress + cancellation**
contract, and endpoints whose payload is JSON use it too (they just return
`json.dumps(...).encode()` from their worker, so the body is PHP1 markers
followed by a JSON tail — `fetchJsonWithProgress` on the renderer side). Three
things come as a package, and a long-running endpoint wants all three:

- The worker runs via `run_in_executor`, i.e. **off the event loop**. A handler
  that blocks inline freezes the entire backend for its duration — which also
  makes it uncancellable, since `POST /api/cancel/{run_id}` can't be serviced.
- The `run_id` rides the first PHP1 marker, so the client can cancel; the stream
  loop also watches for client disconnect.
- Because the 200 is already out, an exception can only reach the client as a
  truncated body. Report in-flight failures as `error` in the JSON tail instead.

Native children that can't poll a cancel Event (PotreeConverter, the
segmentation workers) are spawned via `os.posix_spawn` into their own process
group and killed with `_kill_seg_worker` — `subprocess.Popen`'s fork path
crashes the child on macOS when libhelios/open3d GLFW are loaded.

## When to rebuild

- After any change to `backend-api/main.py` that you want reflected in `npm run dev` (unless you run uvicorn manually).
- After bumping `requirements.txt`.
- Before shipping a release — the CI workflow does this for you.
