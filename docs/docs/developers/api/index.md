# Backend API

The Phytograph backend is a single FastAPI application that serves all
compute-heavy operations to the renderer over HTTP. It lives in
`backend-api/main.py` (~23,000 lines, single file by design).

- **Base URL**: `http://127.0.0.1:<backend-port>`. The port is chosen
  dynamically per app instance; the renderer resolves it over the
  `backend.getInfo` IPC. `8008` is only a standalone-launch fallback.
- **All routes** are prefixed with `/api/` except `/`, `/health`, `/version`.
- **Versioning**: `/version` returns `BACKEND_VERSION`. The supervisor refuses
  to run a backend whose version doesn't match the renderer's
  `EXPECTED_BACKEND_VERSION` — see [Version Lock](../architecture/version-lock.md).

Read on:

- **[HTTP Endpoints](endpoints.md)** — grouped list of every route.
- **[Python Reference](reference.md)** — auto-generated from docstrings via `mkdocstrings`.
