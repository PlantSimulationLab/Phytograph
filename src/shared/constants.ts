// Keep BACKEND_VERSION in sync with backend-api/main.py BACKEND_VERSION.
// Bump when backend changes require users to receive a new build.
export const EXPECTED_BACKEND_VERSION = '0.13.1';

// Ports mirror the Tauri build:
//   dev:  backend on 8007 (uvicorn --reload)
//   prod: backend on 8008 (bundled PyInstaller binary, supervised by us)
export const BACKEND_PORT_DEV = 8007;
export const BACKEND_PORT_PROD = 8008;
export const RENDERER_DEV_PORT = 1427;

// GitHub repository — base for the "Phytograph on GitHub" link and the
// pre-filled new-issue URL used by the in-app feedback dialog.
export const REPO_URL = 'https://github.com/PlantSimulationLab/phytograph';

// Destination for the "Continue without a GitHub account" feedback path.
// TODO: placeholder — replace with the real feedback address before release.
export const FEEDBACK_EMAIL = 'feedback@example.com';
