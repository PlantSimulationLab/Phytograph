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

!!! note "pyhelios gotcha"
    The importable module is `pyhelios` but the PyPI distribution is
    `pyhelios3d`. Native libs + textures + xml asset trees must travel
    with the bundle — that's why `pyhelios` is in `collectAll` in
    `scripts/build-backend.mjs`.

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

## When to rebuild

- After any change to `backend-api/main.py` that you want reflected in `npm run dev` (unless you run uvicorn manually).
- After bumping `requirements.txt`.
- Before shipping a release — the CI workflow does this for you.
