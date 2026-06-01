// Keep BACKEND_VERSION in sync with backend-api/main.py BACKEND_VERSION.
// Bump when backend changes require users to receive a new build.
export const EXPECTED_BACKEND_VERSION = '0.3.15';

// Ports mirror the Tauri build:
//   dev:  backend on 8007 (uvicorn --reload)
//   prod: backend on 8008 (bundled PyInstaller binary, supervised by us)
export const BACKEND_PORT_DEV = 8007;
export const BACKEND_PORT_PROD = 8008;
export const RENDERER_DEV_PORT = 1427;
