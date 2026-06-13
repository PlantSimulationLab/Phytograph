# Phytograph

Cross-platform desktop application for LiDAR point cloud and plant
architecture tools.

📖 **Full documentation**: <https://plantsimulationlab.github.io/phytograph/>

- **Frontend**: React + TypeScript + Vite + TailwindCSS
- **Desktop shell**: Electron 33 (ESM main process)
- **Backend**: Python + FastAPI, bundled as a sidecar via PyInstaller
- **3D**: three.js / @react-three/fiber
- **Plant simulation**: pyhelios (PyPI: `pyhelios3d`)

The Python backend lives in `backend-api/` as a normal Python project and is
also bundled into the shipped app via PyInstaller. Same code runs in dev
(via `uvicorn`) and in production (via PyInstaller-built binary).

---

## Repository layout

```
phytograph/                       # repo root — the Electron app lives here
├── .github/workflows/release.yml # tag-driven CI: signed/notarized release
├── package.json                  # npm scripts + electron-builder config
├── tsconfig.json
├── vite.main.config.ts           # bundles src/main/ -> dist-main/
├── vite.preload.config.ts        # bundles src/preload/ -> dist-preload/
├── vite.renderer.config.ts       # bundles src/renderer/ -> dist-renderer/
├── tailwind.config.js
├── postcss.config.js
│
├── src/
│   ├── main/        # Electron main process
│   │   ├── main.ts          # BrowserWindow + lifecycle
│   │   ├── backend.ts       # Python sidecar supervisor
│   │   ├── ipc.ts           # ipcMain handlers (dialog, fs, store)
│   │   └── updater.ts       # electron-updater wiring
│   ├── preload/
│   │   └── preload.ts       # exposes window.electronAPI to renderer
│   ├── shared/
│   │   ├── constants.ts     # EXPECTED_BACKEND_VERSION, ports
│   │   └── ipc.ts           # IPC channel names + payload types
│   └── renderer/    # React UI (no Node access; talks to backend via HTTP)
│       ├── App.tsx
│       ├── main.tsx
│       ├── components/
│       ├── lib/
│       ├── utils/
│       └── public/          # static assets served by Vite
│
├── backend-api/     # Python/FastAPI backend (source of truth)
│   ├── main.py              # FastAPI app + all endpoints
│   ├── backend_wrapper.py   # PyInstaller entrypoint
│   ├── requirements.txt
│   ├── run.sh
│   └── venv/                # local Python venv (gitignored)
│
├── scripts/
│   ├── dev.mjs              # dev runner (vite + electron)
│   ├── build-backend.mjs    # PyInstaller wrapper
│   └── notarize.cjs         # electron-builder afterSign hook
│
├── build/                   # build resources used by electron-builder
│   ├── icon.icns / icon.ico / icon.png
│   ├── entitlements.mac.plist     # main app entitlements (hardened runtime)
│   └── backend.entitlements       # extra entitlements for the Python sidecar
│
├── resources/               # PyInstaller output lands here (gitignored)
│   └── phytograph_backend/        # the bundled backend (directory bundle)
│       ├── phytograph_backend     # the executable
│       └── _internal/             # libs + data files
│
├── dist-main/               # built main process (gitignored)
├── dist-preload/            # built preload (gitignored)
├── dist-renderer/           # built renderer (gitignored)
└── release/                 # electron-builder output (gitignored)
```

---

## Prerequisites

- **Node.js 20+** (`node --version` should show v20 or later)
- **Python 3.11** (3.12 also works locally; CI uses 3.11)
- **Xcode Command Line Tools** on macOS (`xcode-select --install`)
- For signed macOS releases (CI): an Apple Developer ID Application certificate

---

## First-time setup

Three things to create: the Python venv, Node modules, and the bundled
PyInstaller sidecar that the Electron app spawns on port 8008.

```bash
# 1. Clone the repo and enter it
git clone https://github.com/PlantSimulationLab/phytograph.git
cd phytograph

# 2. Python backend — create venv and install deps
cd backend-api
python3 -m venv venv
source venv/bin/activate              # Windows: venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt pyinstaller   # pyinstaller needed for step 4
deactivate
cd ..

# 3. Node deps
npm install

# 4. Build the Python sidecar into resources/phytograph_backend/.
#    Required before `npm run dev` works — the supervisor in src/main/backend.ts
#    spawns this binary on port 8008 in dev as well as in packaged builds.
#    Takes a few minutes the first time; re-run only when backend code changes.
npm run build:backend
```

That's it. From here all the dev/build commands work.

---

## Run a dev instance

The simple case is one terminal:

```bash
npm run dev
```

This builds `main` + `preload` once, starts Vite on port 1427, and launches
Electron. Electron's `backend.ts` supervises the bundled PyInstaller backend
on port **8008** — same port the renderer always uses (`getBackendUrl()` in
`src/renderer/utils/backendApi.ts`). The sidecar bundle at
`resources/phytograph_backend/` must already exist (step 4 of first-time
setup); if not, the renderer shows "Backend failed to start" and only
viewer features work. Re-run `npm run build:backend` whenever you've
changed backend code and want it picked up by `npm run dev`.

**Iterating on Python without rebuilding the sidecar** — optional second
terminal that runs uvicorn directly so edits take effect on uvicorn restart
(or live with `--reload`). Because the renderer is hard-coded to 8008, run
uvicorn on 8008 too, and start `npm run dev` only after killing any prior
sidecar on that port:

```bash
kill $(lsof -ti :8008) 2>/dev/null
cd backend-api && source venv/bin/activate
uvicorn main:app --port 8008 --reload
```

Then in another terminal: `npm run dev`. The supervisor checks `/version`
on startup; if it sees a compatible backend already on 8008, it reuses it
instead of spawning its own.

**HMR scope**: the renderer hot-reloads on edit. Changes to `src/main/` or
`src/preload/` require restarting `npm run dev`. Changes to Python code in
`backend-api/` require restarting uvicorn (or `--reload`), OR rebuilding
the sidecar (`npm run build:backend`).

---

## Build a local installer (no CI)

This produces an unsigned `.dmg`/`.exe` you can install and test, without
needing Apple/Microsoft signing credentials.

```bash
# 1. Build the Python sidecar into a self-contained bundle.
#    The script auto-discovers backend-api/venv/bin/python and uses it,
#    so you do NOT need to activate the venv first.
npm run build:backend

# 2. Package the Electron app for the current OS.
SKIP_NOTARIZATION=1 npm run package          # macOS — skips notarization
npm run package:win                          # Windows
npm run package:linux                        # Linux (run on a Linux box)
```

Artifacts land in `release/` (filenames are intentionally **version-free** —
see "Stable download links" below):
- macOS: `Phytograph-arm64.dmg`, `Phytograph-x64.dmg`
- Windows: `Phytograph-Setup.exe`
- Linux: `Phytograph.AppImage`, `Phytograph-amd64.deb`

`package:linux` only works **on** Linux (electron-builder can't cross-build the
AppImage/deb from macOS or Windows). It needs the same native deps CI installs:
`sudo apt-get install -y libgl1-mesa-dev xorg-dev libtbb-dev`.

**To launch the unsigned macOS build for testing** (Gatekeeper will block by
default):

```bash
open release/mac-arm64/Phytograph.app
# If macOS refuses: right-click the .app in Finder → Open → "Open anyway".
```

---

## Release (CI)

Tag a version and push; the workflow at `.github/workflows/release.yml`
builds the backend and packages the app on three runners in parallel —
macOS (signed + notarized), Windows, and Linux — and uploads every
artifact to a single **draft** GitHub Release.

```bash
git tag v0.2.0
git push origin v0.2.0
```

Review the draft (confirm all five artifacts attached: two macOS `.dmg`,
one Windows `.exe`, one Linux `.AppImage`, one `.deb`), then click
**Publish**. Publishing is what flags the release "Latest" and activates
the stable download links below — drafts are never "Latest".

### Stable download links (for the lab website)

The electron-builder `artifactName` settings in `package.json` produce
**version-free** filenames, so these per-OS permalinks never change between
releases — wire them straight into download buttons on the lab site and
never touch them again:

```
# macOS (Apple Silicon)
https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph-arm64.dmg
# macOS (Intel)
https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph-x64.dmg
# Windows
https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph-Setup.exe
# Linux (AppImage)
https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph.AppImage
# Linux (Debian/Ubuntu)
https://github.com/PlantSimulationLab/Phytograph/releases/latest/download/Phytograph-amd64.deb
```

`…/releases/latest/…` resolves to whichever release is flagged "Latest", and
a release becomes "Latest" only once **published** (drafts never are) — so
the links activate the moment you publish a draft, and automatically point
at the newest release thereafter. A plain landing-page link
(`…/releases/latest`) also works if you'd rather let users pick their OS.

### Required GitHub Secrets

| Secret | Purpose |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` Developer ID cert |
| `APPLE_CERTIFICATE_PASSWORD` | password for the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_PASSWORD` | app-specific password for notarization |
| `APPLE_TEAM_ID` | 10-character Apple Team ID |
| `WIN_CSC_LINK` | (optional) base64 of Windows code-signing cert |
| `WIN_CSC_KEY_PASSWORD` | (optional) Windows cert password |

`APPLE_PASSWORD` should be an **app-specific password** generated at
appleid.apple.com (not your real Apple ID password).

---

## Version bumping

When backend changes require users to receive a new build, all three of
these must move together — the supervisor refuses to start mismatched
versions:

1. `backend-api/main.py` — bump `BACKEND_VERSION`
2. `src/shared/constants.ts` — bump `EXPECTED_BACKEND_VERSION` to match
3. `package.json` — bump `version`

Then tag and push:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

---

## Architecture overview

```
                            packaged .app / .exe
   ┌──────────────────────────────────────────────────────────────┐
   │                                                              │
   │   Electron main process (Node)                               │
   │   ┌─────────────────────────────────┐                        │
   │   │  main.ts                        │                        │
   │   │   └─ backend.ts                 │                        │
   │   │       └─ spawns ────────────────┼──► phytograph_backend  │
   │   │   └─ ipc.ts (handlers)          │     (PyInstaller bundle)│
   │   │   └─ updater.ts                 │     listens on :8008   │
   │   └─────────────────────────────────┘             ▲          │
   │            ▲                                      │ HTTP     │
   │            │ IPC (contextBridge)                  │ (fetch)  │
   │            ▼                                      │          │
   │   ┌─────────────────────────────────┐             │          │
   │   │  Preload (preload.ts)           │             │          │
   │   │   exposes window.electronAPI    │             │          │
   │   └─────────────────────────────────┘             │          │
   │            ▲                                      │          │
   │            │                                      │          │
   │   ┌─────────────────────────────────┐             │          │
   │   │  Renderer (React, Chromium)     ├─────────────┘          │
   │   │   - HTTP for data (triangulate, │                        │
   │   │     plant gen, ICP, etc.)       │                        │
   │   │   - electronAPI for OS stuff    │                        │
   │   │     (dialogs, fs, persistence)  │                        │
   │   └─────────────────────────────────┘                        │
   └──────────────────────────────────────────────────────────────┘
```

**Ports** (kept in `src/shared/constants.ts`):
- Renderer dev server: **1427**
- Backend: **8008** in both dev and packaged builds — the renderer always
  hits 8008 (`getBackendUrl()`), and `backend.ts` supervises the bundled
  PyInstaller binary on 8008 in dev too. `BACKEND_PORT_DEV` (8007) exists
  in `constants.ts` but no current code path uses it.

**Why a Python sidecar instead of native bindings**: the bulk of the
scientific stack (open3d, scipy, pyhelios) ships as Python wheels. Bundling
them via PyInstaller is the fastest path to a shippable cross-platform
build. Native Helios bindings are a future direction (would skip Python for
hot paths) but not on the current roadmap.

**Why Electron over Tauri**: this is the second-generation desktop shell;
the first was Tauri. The migration is complete and Tauri is retired (its
last codebase lives at `../phytograph-tauri/` on the original maintainer's
machine, not in this repo). Electron was chosen for richer renderer
debugging tools and to avoid Rust-side complexity in a project where the
heavy compute is in Python anyway.

---

## Troubleshooting

**`build:backend` fails with `ModuleNotFoundError: No module named 'fastapi'`**
PyInstaller is running against the wrong Python environment — almost
certainly anaconda's. Make sure `backend-api/venv/` exists and was created
with `python3 -m venv venv && pip install -r requirements.txt`. The build
script auto-prefers `backend-api/venv/bin/python` when present; if you see
the warning "using bare pyinstaller from PATH", the venv wasn't found.

**`build:backend` fails with `No such file or directory: …/venv/bin/python3`**
The venv has stale shebangs (usually from being copied or its parent dir
being renamed). Delete `backend-api/venv/` and recreate it:
```bash
cd backend-api && rm -rf venv && python3 -m venv venv && \
  source venv/bin/activate && pip install -r requirements.txt pyinstaller
```

**App launches but shows red "Backend failed to start" banner**
- In **dev**: confirm `resources/phytograph_backend/` exists (if not, run
  `npm run build:backend` once) — or, if iterating Python, confirm uvicorn
  is running on port 8008.
- In **packaged build**: open the macOS Console.app or Windows Event Viewer
  and search for `[Backend stderr]:` lines from the supervisor (note: most
  of these are not actually errors — Python's `logging` writes to stderr by
  default, so INFO and WARNING messages land there too). Common causes:
  - Quarantine bit on a fresh macOS install: `xattr -dr com.apple.quarantine /Applications/Phytograph.app`
  - First-launch cold start (~30s with onedir, longer on slower disks)
  - A previous backend on port 8008 from a stale process: `kill $(lsof -ti :8008)`

**"Cannot remove quarantine" on macOS**
The signed app's CodeSignature seal makes xattrs immutable. Either install
via Finder drag (which clears quarantine on first launch via Gatekeeper
approval), or use a signed+notarized CI build where this never comes up.

**Renderer can't reach the backend**
The renderer is hard-coded to `http://127.0.0.1:8008` via `getBackendUrl()`
in `src/renderer/utils/backendApi.ts`. There is no dev/prod auto-switching
— if you want to point at a different host or port (e.g. uvicorn on 8007),
edit that function.

**Plant generation / Helios features fail in dev only**
pyhelios's native lib (`libhelios.dylib`) must be importable from the
active Python env. If you replaced/recreated the venv, reinstall:
```bash
source backend-api/venv/bin/activate && pip install --force-reinstall pyhelios3d
```

---

## For agents picking this up

- The repo is self-contained: `backend-api/` lives inside the repo. No
  `../` sibling references in the build pipeline.
- `npm run build:backend` is **idempotent** and safe to re-run. It writes
  to `resources/phytograph_backend/`, replacing any prior bundle.
- `scripts/build-backend.mjs` documents its Python resolution logic at the
  top of the file. Prefer setting `PYTHON=/path/to/python` for explicit
  control rather than mutating PATH.
- The IPC bridge is intentionally narrow — only `dialog`, `fs`, `store`,
  `backend.getInfo`, and `webUtils.getPathForFile` are exposed to the
  renderer. Backend operations go over HTTP to `localhost:8008/api/*`.
- Memory of past pitfalls is captured inline in scripts and comments
  (anaconda PATH, pyhelios module name, onedir extraction, etc.). Skim
  `scripts/build-backend.mjs`'s header comment if any backend-build issue
  arises.
