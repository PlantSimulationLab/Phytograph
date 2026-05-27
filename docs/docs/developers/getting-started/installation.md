# Installation

## Prerequisites

- **Node.js 20+** (`node --version` should show v20 or later)
- **Python 3.11** (3.12 also works locally; CI uses 3.11)
- **Xcode Command Line Tools** on macOS (`xcode-select --install`)
- For signed macOS releases (CI): an Apple Developer ID Application certificate

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
npm run build:backend
```

!!! warning "Don't rely on a system-wide `pyinstaller`"
    On a dev machine with anaconda installed, a bare `pyinstaller` from PATH
    picks up anaconda's Python — which lacks the project's deps — and
    produces a broken bundle that crashes on launch. `npm run build:backend`
    auto-discovers `backend-api/venv/bin/python`; override with
    `PYTHON=/path/to/python` if needed. See the header comment of
    `scripts/build-backend.mjs` for the full resolution logic.

Step 4 is **required** before `npm run dev` works — the supervisor in
`src/main/backend.ts` spawns this binary on port 8008 in dev as well as in
packaged builds. It takes a few minutes the first time; re-run only when
backend code changes.

## Verifying the install

```bash
npm run typecheck         # tsc --noEmit, should succeed silently
npm run test:backend      # pytest in backend-api/, requires venv active
npm run test:unit         # vitest
```

If all three pass, you're ready to launch the app — see **[First Run](first-run.md)**.
