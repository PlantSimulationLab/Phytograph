# Backend API

The Phytograph backend is a single FastAPI application that serves all
compute-heavy operations to the renderer over HTTP. It lives in
`backend-api/main.py` (~5000 lines, single file by design).

- **Base URL** in dev and prod: `http://127.0.0.1:8008`
- **All routes** are prefixed with `/api/` except `/`, `/health`, `/version`.
- **Versioning**: `/version` returns `BACKEND_VERSION`. The supervisor refuses
  to run a backend whose version doesn't match the renderer's
  `EXPECTED_BACKEND_VERSION` — see [Version Lock](../architecture/version-lock.md).

Read on:

- **[HTTP Endpoints](endpoints.md)** — grouped list of every route.
- **[Python Reference](reference.md)** — auto-generated from docstrings via `mkdocstrings`.
