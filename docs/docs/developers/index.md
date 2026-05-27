# For Developers

This section is for people building, modifying, or shipping Phytograph
itself — not end users of the desktop app. If you're trying to use
Phytograph to analyze a plant scan, you want the **[User Guide](../guide/index.md)**.

## What's here

<div class="grid cards" markdown>

- :material-rocket-launch: **[Getting started](getting-started/index.md)** — clone, install Python/Node deps, build the PyInstaller backend, run a dev instance.

- :material-sitemap: **[Architecture](architecture/index.md)** — three processes (renderer, main, Python sidecar), the narrow IPC bridge, the version-lock contract.

- :material-tools: **[Development](development/index.md)** — dev loop, building local installers, releasing via tag, the non-negotiable E2E testing rules.

- :material-api: **[Backend API](api/index.md)** — HTTP endpoints served by `backend-api/main.py` and a generated Python reference.

- :material-help-circle: **[Troubleshooting](troubleshooting.md)** — common build, sidecar, and dev-loop failures and their root causes.

</div>

## Quick orientation

Three processes, three boundaries:

- **Renderer** (React, no Node) talks to the backend over HTTP and to the OS via a narrow IPC bridge.
- **Main** (Electron) supervises the Python sidecar and exposes a handful of OS surfaces (dialogs, fs, persistent store).
- **Backend** (FastAPI, bundled by PyInstaller) does all heavy compute on `127.0.0.1:8008`.

The supervisor enforces a three-way version lock between
`backend-api/main.py` (`BACKEND_VERSION`), `src/shared/constants.ts`
(`EXPECTED_BACKEND_VERSION`), and `package.json` (`version`).
See **[Version Lock](architecture/version-lock.md)**.
