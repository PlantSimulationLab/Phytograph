# Testing

Three layers, three frameworks:

| Layer | Framework | Location | Command |
|---|---|---|---|
| Backend unit | pytest | `backend-api/tests/` | `pytest` (in venv) or `npm run test:backend` |
| Frontend unit | Vitest | colocated `*.test.ts(x)` | `npm run test:unit` |
| End-to-end | Playwright + `_electron` | `tests/e2e/` | `npm run test:e2e` |

E2E prerequisites: `npm run build && npm run build:backend` must succeed
first — the tests drive the real packaged app.

## E2E rules (non-negotiable)

These rules exist because the alternative — mocking the backend or
short-circuiting the UI — produces tests that pass in CI while shipping
broken builds to users.

### 1. Always run against the live backend

No mocking the FastAPI server, no stubbing `/api/*` responses. If the
supervised PyInstaller backend isn't built (`resources/phytograph_backend/`),
run `npm run build:backend` first — don't skip the test.

> "Backend wasn't running" is **not** an acceptable reason to skip.

### 2. Drive the real UI

Seed data, set options, and read results through the rendered DOM:

- Use the file-picker / dropzone to import fixtures.
- Click the actual buttons.
- Read values from the actual viewer state — don't reach into `window`
  to short-circuit.
- Exercise non-default user options where the workflow supports them.

### 3. Test correctness, not the absence of errors

"Didn't throw" is **not** a pass. Assert on concrete outputs:

- Vertex counts within a known range.
- Exported file contents.
- Persisted store values.
- Visible numbers in the UI.

Rubber-stamp tests that exist only to mark a box are worse than no test
at all.

### 4. Coverage target: 80%

- **Backend** — `pytest-cov` over `main.py`.
- **Frontend** — Vitest coverage over `src/renderer/lib/`,
  `src/renderer/utils/`, `src/renderer/hooks/` (the pure-logic surface).

React components (`src/renderer/components/`, `App.tsx`) are **covered by
E2E instead** — unit-testing 9,000+ lines of three.js viewer code yields
rubber stamps, not signal. E2E is judged by workflow coverage, not line
coverage.

### 5. Fixtures

Fabricate minimal text fixtures (small CSV / XYZ point clouds, tiny OBJ
meshes) that are safe to commit. If a workflow needs real LiDAR data too
large to commit, ask the maintainer — don't invent a synthetic substitute
that won't exercise the real code paths.
