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

1. Checks port 8008 for an existing backend by hitting `/version`.
2. If a compatible backend is already running, it reuses it.
3. Otherwise, it spawns the bundled binary from `resources/phytograph_backend/phytograph_backend` and waits for it to come up.
4. If the existing process returns a **mismatched** version, the supervisor kills the port and respawns its own bundled binary.

This means **dev sessions can iterate on Python by running uvicorn
manually on 8008** — the supervisor will defer to it as long as the
version matches `EXPECTED_BACKEND_VERSION`. See
[Version Lock](version-lock.md) for the contract details.

## How it's addressed

| Environment | Renderer hits | Supervisor spawns |
|---|---|---|
| Dev (`npm run dev`) | `http://127.0.0.1:8008` | `resources/phytograph_backend/phytograph_backend` |
| Dev (manual uvicorn) | `http://127.0.0.1:8008` | Reuses your uvicorn |
| Packaged build | `http://127.0.0.1:8008` | Bundled binary alongside the app |

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

## When to rebuild

- After any change to `backend-api/main.py` that you want reflected in `npm run dev` (unless you run uvicorn manually).
- After bumping `requirements.txt`.
- Before shipping a release — the CI workflow does this for you.
