# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Big picture

Phytograph is an Electron desktop app for LiDAR point clouds and plant architecture. The heavy compute is Python (open3d, scipy, pyhelios) wrapped in a FastAPI server that gets bundled as a PyInstaller sidecar; the UI is React + three.js. Same Python code runs in dev (via uvicorn) and in shipped builds (via the PyInstaller binary).

Three processes, three boundaries:

- **Renderer** (`src/renderer/`) — React + Vite, no Node access. Talks to Python over HTTP to `127.0.0.1:<backend-port>/api/*` (the port is dynamic per instance — see Port wiring) and to the OS via `window.electronAPI` (exposed by preload).
- **Main** (`src/main/`) — Electron lifecycle, spawns and supervises the Python sidecar (`backend.ts`), handles file dialogs / fs / persistent store (`ipc.ts`), and auto-updates (`updater.ts`).
- **Backend** (`backend-api/main.py`) — single FastAPI file containing all endpoints (`/api/fit`, `/api/triangulate`, `/api/plant/*`, `/api/c2m/*`, `/api/skeleton/extract`, etc.). `backend_wrapper.py` is the PyInstaller entrypoint.

The IPC bridge is intentionally narrow — only `dialog`, `fs`, `store`, `backend.getInfo`, and `webUtils.getPathForFile` are exposed. Anything compute-heavy goes over HTTP, not IPC.

### Port wiring (dynamic per instance)

**Ports are chosen at runtime, not fixed**, so concurrent app instances, a `npm run dev` session, parallel E2E runs, and other co-developed apps never collide. The `8008` / `1427` constants in `src/shared/constants.ts` are now only *fallback defaults* for a bare `electron .` or a standalone `backend_wrapper.py` launch.

- **Who picks the port:** whoever owns the instance.
  - `npm run dev` → `scripts/dev.mjs` calls `findFreePort()` (bind `:0`) for both the backend and the Vite renderer, passes the backend port to `uvicorn --port` and to Electron via `PHYTOGRAPH_BACKEND_PORT`, and the renderer port to Vite (`--port --strictPort`) and to Electron via `PHYTOGRAPH_RENDERER_PORT`.
  - Packaged app → the supervisor (`src/main/backend.ts` `resolvePort()`) picks a free port (or honors `PHYTOGRAPH_BACKEND_PORT` if pinned) and spawns the bundled backend with it.
  - E2E → `tests/e2e/helpers/launchApp.ts` picks a free port per launch and pins it via `PHYTOGRAPH_BACKEND_PORT`, then polls that port in `waitForBackend(port)`.
- **How the renderer learns the port:** it does **not** hardcode it. `initBackendUrl()` (called in `src/renderer/main.tsx` before first render) fetches `backend.getInfo()` over IPC, which returns the real port from `getBackendPort()` in the main process, and caches it for the synchronous `getBackendUrl()` callers.
- **`PHYTOGRAPH_DEV_BACKEND=1`** (set by `scripts/dev.mjs` when uvicorn is running) still makes the Electron supervisor stand down rather than spawn its own bundle.
- **Collision safety:** the supervisor reuses a *compatible* backend already on its port and only `kill`s an *incompatible* one. It never pre-emptively kills a port it couldn't version-probe — so a developer's running dev backend is never murdered by a test run or a second instance.

### Version-lock contract

The supervisor refuses to talk to a mismatched backend. When a backend change requires a new build, **all three must move together**:

1. `backend-api/main.py` — `BACKEND_VERSION`
2. `src/shared/constants.ts` — `EXPECTED_BACKEND_VERSION`
3. `package.json` — `version`

`backend.ts` hits `/version` on the instance's port at startup; if a backend is already there with a *matching* version it's reused, if it *mismatches* it's killed and the bundled binary respawned, and if nothing answers the bundled binary is started fresh.

## Common commands

### Setup (one time)

```bash
git submodule update --init --recursive     # PyHelios source + nested helios-core
cd backend-api
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt pyinstaller
deactivate && cd ..
node scripts/build-pyhelios.mjs             # compile libhelios from the submodule (minutes)
npm install
```

### Dev loop

```bash
npm run dev          # builds main+preload once, starts Vite on 1427, launches Electron
npm run typecheck    # tsc --noEmit
```

Edits to `src/renderer/` hot-reload. Edits to `src/main/` or `src/preload/` require restarting `npm run dev`. Edits to `backend-api/*.py` hot-reload via uvicorn's `--reload` (spawned automatically by `scripts/dev.mjs` when `backend-api/venv` exists). The PyInstaller sidecar is only rebuilt for packaged installers (`npm run build:backend`) — not part of the dev loop. Edits to the PyHelios/Helios C++ source (under `pyhelios/helios-core/` or `pyhelios/native/`) are recompiled automatically: the backend rebuilds `libhelios` on startup when the lib is stale (restart the backend to pick up C++ edits). Edits to other native libs (open3d shared objects, anything outside Python source) still require a venv rebuild.

### Build

```bash
npm run build:backend                         # PyInstaller --onedir → resources/phytograph_backend/
npm run build                                 # renderer + main + preload (Vite)
SKIP_NOTARIZATION=1 npm run package           # macOS unsigned local installer
npm run package:win                           # Windows installer
```

`build:backend` is idempotent — re-running it replaces `resources/phytograph_backend/`. It auto-discovers `backend-api/venv/bin/python`; override with `PYTHON=/path/to/python` if needed. **Do not** rely on `pyinstaller` from PATH on a dev machine with anaconda installed — it picks up anaconda's Python, which lacks the project's deps, and produces a broken bundle that crashes on launch. See the header comment of `scripts/build-backend.mjs`.

### Release

Push a tag (`git tag v0.2.0 && git push origin v0.2.0`); `.github/workflows/release.yml` handles signing/notarization and publishes a GitHub Release. The release is published (not a draft) because `build.publish.releaseType` in `package.json` is `release` — this is required for the in-app "Check for Updates" (electron-updater) to detect it. The **Help → Check for Updates…** menu item (macOS app menu) triggers a manual check; `src/main/updater.ts` also auto-checks once on launch.

## Things worth knowing before touching code

- **Build outputs** (`dist-main/`, `dist-preload/`, `dist-renderer/`, `release/`, `resources/phytograph_backend/`) are all gitignored and produced by the scripts above — don't hand-edit them.
- **TS path aliases**: `@renderer/*`, `@main/*`, `@shared/*` are defined in `tsconfig.json`.
- **Numeric input fields: use `DebouncedNumberInput`, never a raw `<input type="number">` bound to a parsed number.** The recurring bug: a controlled `<input type="number" value={someNumber} onChange={e => setX(parseFloat(e.target.value) || 0)}>` clobbers every intermediate keystroke that isn't a finite number — the empty string, a lone `-`, a partial `1.` — so the user can't clear the field or type a negative (the `-` snaps back to `0`/the default and the keystroke is eaten). `src/renderer/components/DebouncedNumberInput.tsx` is the fix: it owns a focus-guarded text *draft* (`type="text"` + `inputMode="decimal"`), only commits *finite* parsed values via `onCommit`, and clamps `min`/`max` on the committed value (not per-keystroke). Pass `debounceMs={0}` for cheap fields that should commit eagerly; use `parse={(s) => parseInt(s, 10)}` for integers. For a `number | undefined` field (e.g. an optional seed), a plain `type="text"` + `inputMode="numeric"` input that maps empty→`undefined` and only stores finite parses is fine. The only acceptable raw `<input type="number">` is one whose `value` is bound to a **raw string draft** (`useState<string>`) that's parsed separately at commit/submit — see `FilterPanel`/`AddLeavesPopup`. Sliders (`type="range"`), `<select>`, and checkboxes are immune (you can't type a partial value).
- **`backend-api/main.py` is a ~5000-line single file.** All endpoints live there. When grepping for routes use `^@app\.` to find them quickly.
- **Exclude sky/miss points before EVERY compute tool except LAD — forgetting hangs the backend, it does not error.** A sky/miss point (`is_miss != 0`) is a ray that hit nothing, projected **~1 km out** along the beam. Any reconstruction/segmentation tool (triangulate, skeleton, QSM, ground-segment, **DEM**, register, …) that grids/triangulates/CSF-segments a cloud with misses still in it inflates the XY/Z extent ~1000×, which makes the algorithm hang (CSF builds a multi-million-node cloth ×~500 iters; Delaunay/`griddata`/KD-tree blow up) — and the fast hits-only unit fixtures never catch it. This has been a **recurring** bug across nearly every tool. **Leaf Area Density (LAD) is the sole exception** — it *needs* misses (the Beer's-law transmission denominator) and reads them on its own path. When you add or touch any other tool, drop misses where you assemble the input: a session/octree source via `_read_points_from_source(include_misses=False)` (the default — safe); a **file-path source** does NOT honor that flag, so filter explicitly; renderer inline-`points` paths (e.g. flat-cloud DEM) must drop `is_miss != 0` when building the array and keep a `hitIndices` map to scatter any per-point result back to full length (filter aligned label arrays like `ground_class` in lockstep). `_auto_csf_params` has a defensive cloth-node floor as a backstop, but excluding misses upstream is the real fix.
- **PyHelios is a source submodule, not a wheel.** It lives at `pyhelios/` (with its own nested `helios-core` C++ submodule) so we can co-develop it; there is **no** `pyhelios3d` pip fallback. `scripts/build-pyhelios.mjs` compiles the native `libhelios` (plugins: `plantarchitecture` + `lidar`; `--nogpu` drops only the `gpu_required` plugins, i.e. radiation/OptiX, which we don't use) into `pyhelios/pyhelios_build/build/lib/` and `pip install -e`s the package. Note: the `lidar` plugin pulls in the `visualizer` plugin at the C++ level, so OpenGL (glfw/glew/freetype) gets compiled too — fine on macOS (Cocoa) and Windows (native GL) with no extra packages; on Linux it needs `libgl1-mesa-dev`/`xorg-dev` (the release workflow installs these). Prereqs: cmake + a C++ compiler (Xcode CLT on macOS, MSVC on Windows, gcc on Linux). The **release matrix is macOS + Windows + Linux** (`.github/workflows/release.yml`, packaged as dmg/zip, nsis, and deb). The native libs + textures + xml asset trees travel with the PyInstaller bundle via `--collect-all pyhelios` in `scripts/build-backend.mjs`. The first `npm run dev` / `build:backend` on a fresh clone compiles Helios (several minutes); `build-backend.mjs` and `dev.mjs` auto-build it if the lib is missing.
- **GPU (CUDA) acceleration for LiDAR ray tracing is a packaged-build feature, gated at *build* time, not runtime.** The `lidar`/`collisiondetection` plugin has a CUDA ray-tracing path that auto-compiles whenever CMake's `find_package(CUDAToolkit)` succeeds (it defines `HELIOS_CUDA_AVAILABLE` and builds `CollisionDetection.cu`); otherwise libhelios is CPU/OpenMP-only. `--nogpu` does **not** affect this — it only drops the separate radiation/OptiX plugin. The release workflow installs the CUDA toolkit on the **Windows + Linux** runners (a physical GPU isn't needed to build: `detect_GPU_compute.cmake` resolves target archs via `nvcc --list-gpu-code`), so those installers ship GPU-capable backends. **macOS is always CPU-only** (no CUDA on Apple hardware). cudart is linked **statically** (`CUDA::cudart_static`), so a GPU-enabled libhelios needs no CUDA install on the end user's machine and falls back to CPU automatically when `cudaGetDeviceCount()` finds no NVIDIA driver/GPU. A local `npm run dev`/`build:backend` is GPU-enabled only if you happen to have a CUDA toolkit installed. The release workflow passes `--require-gpu` to `scripts/build-pyhelios.mjs` on Windows/Linux, which reads the CMake cache and **fails the build** if the CUDA path didn't compile — so a botched toolkit install can never silently ship a CPU-only "GPU" installer. Because shipped Windows/Linux builds are therefore always GPU-capable (and macOS never is), the backend's `GET /api/device-info` decides the effective path purely from a runtime NVIDIA probe (`pyhelios.runtime.get_gpu_runtime_info`, mainly `nvidia-smi`): GPU when a usable GPU is present on a non-macOS host, else CPU. The renderer shows the result as a GPU/CPU pill (`ComputePathBadge`) in the Synthetic Scan Options dialog.
- **PyHelios auto-rebuild**: `backend-api/main.py` puts `pyhelios/` on `sys.path` at import time and rebuilds `libhelios` if any `.cpp/.hpp/.h` under `helios-core/` or `native/` is newer than the compiled lib. So editing the Helios C++ and restarting the backend recompiles automatically. After bumping the submodule, also bump the version-lock trio (`BACKEND_VERSION`, `EXPECTED_BACKEND_VERSION`, `package.json`) if the change requires a fresh packaged build.
- **macOS quarantine on fresh installs**: `xattr -dr com.apple.quarantine /Applications/Phytograph.app` (only works on unsigned builds; signed builds' CodeSignature seal makes xattrs immutable, so use Finder drag instead).
- **Stale backend process**: with dynamic ports a leftover backend no longer blocks the next launch (it picks a different free port), but to clean up orphans: `pkill -f phytograph_backend` (packaged bundle) or `pkill -f 'uvicorn main:app'` (dev). To find what's on a specific port: `lsof -ti :<port>`.

## Testing

Three layers, three frameworks:

- **Backend unit tests** — pytest, in `backend-api/tests/`. Run from `backend-api/` with venv active: `pytest`. Or from repo root: `npm run test:backend`.
- **Frontend unit tests** — Vitest, colocated next to source as `*.test.ts(x)`. Run: `npm run test:unit`.
- **E2E tests** — Playwright + `_electron`, in `tests/e2e/`. Run: `npm run test:e2e`. Prereq: `npm run build && npm run build:backend`.

### E2E rules (non-negotiable)

1. **Always run against the live backend.** No mocking the FastAPI server, no stubbing `/api/*` responses. If the supervised PyInstaller backend isn't built (`resources/phytograph_backend/`), run `npm run build:backend` first — don't skip the test. "Backend wasn't running" is not an acceptable reason to skip.
2. **Drive the real UI.** Seed data, set options, and read results through the rendered DOM. Use the file-picker / dropzone to import fixtures; click the actual buttons; read values from the actual viewer state — don't reach into `window` to short-circuit. Exercise non-default user options where the workflow supports them.
3. **Test correctness, not the absence of errors.** "Didn't throw" is not a pass. Assert on concrete outputs: vertex counts within a known range, exported file contents, persisted store values, visible numbers in the UI. Rubber-stamp tests that exist only to mark a box are worse than no test at all.
4. **Coverage target: 80%** for backend (`pytest-cov` over `main.py`) and frontend (Vitest coverage over `src/renderer/lib/`, `src/renderer/utils/`, `src/renderer/hooks/` — the pure-logic surface). React components (`src/renderer/components/`, `App.tsx`) are covered by E2E instead — unit-testing 9,000+ lines of three.js viewer code yields rubber stamps, not signal. E2E is judged by workflow coverage, not line coverage.
5. **Fixtures.** Fabricate minimal text fixtures (small CSV / XYZ point clouds, tiny OBJ meshes) that are safe to commit. If a workflow needs real LiDAR data too large to commit, ask the user — don't invent a synthetic substitute that won't exercise the real code paths.

## Documentation

User-facing docs live in `docs/` as an MkDocs Material site. They're built
on push to `main` by `.github/workflows/docs.yml` and published to
GitHub Pages at https://plantsimulationlab.github.io/phytograph/.

### Layout

- `docs/mkdocs.yml` — site config, nav structure, theme palette.
- `docs/docs/` — content (Markdown). Top-level sections:
  - `guide/` — install, first import, interface tour (end-user onboarding).
  - `concepts/` — point clouds, meshes, skeletons, plant models, scans.
  - `workflows/` — task-oriented walkthroughs (clean, triangulate, extract
    skeleton, generate plant, morph, register, simulate scan, import/export).
  - `reference/` — file formats, color modes, keyboard shortcuts.
  - `developers/` — architecture, dev loop, releasing, testing, backend API
    (this section, **not** the user guide, is where dev-facing details go).
- `docs/docs/assets/screenshots/` — captured from the running app via
  `docs/scripts/capture-screenshots.mjs` (Playwright `_electron` driver,
  same launch path as `tests/e2e/helpers/launchApp.ts` but with the window
  visible).
- `docs/docs/stylesheets/phytograph.css` — brand palette (forest green
  primary, lime accent, mustard highlights) derived from the app logo.
- `docs/requirements.txt` — pinned MkDocs deps. Separate from
  `backend-api/requirements.txt` on purpose (don't pollute the PyInstaller
  bundle with docs tooling).
- `docs/.venv/` — local docs venv. Gitignored and marked
  `com.dropbox.ignored=1`; per-machine, re-create on a fresh checkout.

### Preview locally

```bash
cd docs && .venv/bin/mkdocs serve     # http://127.0.0.1:8000
```

If the venv doesn't exist yet:

```bash
cd docs && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
xattr -w com.dropbox.ignored 1 .venv  # macOS only — keep Dropbox from syncing it
```

### After every task: check whether the docs need an update

When you finish a code change, before declaring the task done, ask:

- **Did this change anything a user sees or does?** Toolbar buttons, panel
  layout, file formats, shortcuts, default values, workflow steps,
  validation messages — anything visible. If yes, the relevant
  `guide/`, `workflows/`, or `reference/` page may need updating.
- **Did this change a concept?** New object type, new mode, new metric.
  Update `concepts/`.
- **Did this change the build, dev loop, release flow, API surface, or
  architecture?** Update `developers/`.
- **Did this add or rename a screenshot-worthy UI state?** Re-run
  `node docs/scripts/capture-screenshots.mjs` from the repo root to
  refresh captures (requires `npm run build && npm run build:backend`
  first). Delete obsolete screenshots; don't leave dead image links.

If the change is purely internal (refactor, test, build script tweak that
doesn't change observable behavior), the docs are usually fine — but skim
the relevant section anyway, since prior agents have occasionally written
claims that didn't match the code.

When a docs update is needed, make it in the **same commit** as the code
change. Do not leave docs drift for "later" — it accumulates fast in a
project that ships behavior changes frequently.

## Commit conventions

Do **not** sign commits with AI co-author trailers. No `Co-Authored-By: Claude …`, no "Generated with Claude Code" lines in PR descriptions, no model attribution of any kind. Commits should appear authored solely by the human committer.

When asked to commit, commit on the **current branch**. Do **not** create a new/separate branch unless explicitly told to "commit to a separate branch" (or similar). Creating a branch on your own initiative disrupts the user's workflow.

**Do not commit planning files.** Roadmap docs, gap analyses, scratch notes, task breakdowns, and similar planning artifacts (e.g. a `*_GAPS.md` / `*_PLAN.md` left in the repo root) are working aids, not deliverables — leave them untracked. When a "commit everything pending" request would sweep one in, exclude it and stage only the real code/doc changes by path.
