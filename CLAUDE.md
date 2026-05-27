# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Big picture

Phytograph is an Electron desktop app for LiDAR point clouds and plant architecture. The heavy compute is Python (open3d, scipy, pyhelios) wrapped in a FastAPI server that gets bundled as a PyInstaller sidecar; the UI is React + three.js. Same Python code runs in dev (via uvicorn) and in shipped builds (via the PyInstaller binary).

Three processes, three boundaries:

- **Renderer** (`src/renderer/`) — React + Vite, no Node access. Talks to Python over HTTP to `127.0.0.1:8008/api/*` and to the OS via `window.electronAPI` (exposed by preload).
- **Main** (`src/main/`) — Electron lifecycle, spawns and supervises the Python sidecar (`backend.ts`), handles file dialogs / fs / persistent store (`ipc.ts`), and auto-updates (`updater.ts`).
- **Backend** (`backend-api/main.py`) — single FastAPI file containing all endpoints (`/api/fit`, `/api/triangulate`, `/api/plant/*`, `/api/c2m/*`, `/api/skeleton/extract`, etc.). `backend_wrapper.py` is the PyInstaller entrypoint.

The IPC bridge is intentionally narrow — only `dialog`, `fs`, `store`, `backend.getInfo`, and `webUtils.getPathForFile` are exposed. Anything compute-heavy goes over HTTP, not IPC.

### Port wiring (kept in `src/shared/constants.ts`)

- Renderer dev server: **1427**
- Backend prod port: **8008** — the renderer **always** hits 8008 via `getBackendUrl()` in `src/renderer/utils/backendApi.ts`, in both dev and packaged builds. `main.ts` calls `startBackend()` in dev too, so the supervised PyInstaller binary on 8008 is what serves requests by default.
- Backend dev port: **8007** — only used if you want to iterate on Python code without rebuilding the sidecar. Run `uvicorn main:app --port 8007` manually; note the renderer won't automatically pick this up (you'd need to change `getBackendUrl()` to test against 8007).

### Version-lock contract

The supervisor refuses to talk to a mismatched backend. When a backend change requires a new build, **all three must move together**:

1. `backend-api/main.py` — `BACKEND_VERSION`
2. `src/shared/constants.ts` — `EXPECTED_BACKEND_VERSION`
3. `package.json` — `version`

`backend.ts` hits `/version` on startup; if the running backend's version doesn't match `EXPECTED_BACKEND_VERSION`, it kills the port and respawns its own bundled binary.

## Common commands

### Setup (one time)

```bash
cd backend-api
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt pyinstaller
deactivate && cd ..
npm install
```

### Dev loop

```bash
npm run dev          # builds main+preload once, starts Vite on 1427, launches Electron
npm run typecheck    # tsc --noEmit
```

Edits to `src/renderer/` hot-reload. Edits to `src/main/` or `src/preload/` require restarting `npm run dev`. Edits to Python require rebuilding the sidecar (`npm run build:backend`) OR running uvicorn separately and pointing the renderer at it.

### Build

```bash
npm run build:backend                         # PyInstaller --onedir → resources/phytograph_backend/
npm run build                                 # renderer + main + preload (Vite)
SKIP_NOTARIZATION=1 npm run package           # macOS unsigned local installer
npm run package:win                           # Windows installer
```

`build:backend` is idempotent — re-running it replaces `resources/phytograph_backend/`. It auto-discovers `backend-api/venv/bin/python`; override with `PYTHON=/path/to/python` if needed. **Do not** rely on `pyinstaller` from PATH on a dev machine with anaconda installed — it picks up anaconda's Python, which lacks the project's deps, and produces a broken bundle that crashes on launch. See the header comment of `scripts/build-backend.mjs`.

### Release

Push a tag (`git tag v0.2.0 && git push origin v0.2.0`); `.github/workflows/release.yml` handles signing/notarization and drafts a GitHub Release.

## Things worth knowing before touching code

- **Build outputs** (`dist-main/`, `dist-preload/`, `dist-renderer/`, `release/`, `resources/phytograph_backend/`) are all gitignored and produced by the scripts above — don't hand-edit them.
- **TS path aliases**: `@renderer/*`, `@main/*`, `@shared/*` are defined in `tsconfig.json`.
- **`backend-api/main.py` is a ~5000-line single file.** All endpoints live there. When grepping for routes use `^@app\.` to find them quickly.
- **pyhelios gotcha**: the importable module is `pyhelios` but the PyPI distribution is `pyhelios3d`. Native libs + textures + xml asset trees must travel with the bundle — that's why `pyhelios` is in `collectAll` in `scripts/build-backend.mjs`.
- **macOS quarantine on fresh installs**: `xattr -dr com.apple.quarantine /Applications/Phytograph.app` (only works on unsigned builds; signed builds' CodeSignature seal makes xattrs immutable, so use Finder drag instead).
- **Stale backend on 8008**: if the supervised backend won't start, check for a leftover process: `kill $(lsof -ti :8008)`.

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
