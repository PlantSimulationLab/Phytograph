// Keep BACKEND_VERSION in sync with backend-api/main.py BACKEND_VERSION.
// Bump when backend changes require users to receive a new build.
export const EXPECTED_BACKEND_VERSION = '0.15.0';

// Backend port. Historically fixed; now chosen dynamically per app instance by
// the main process (src/main/backend.ts findFreePort/resolvePort) so concurrent
// dev sessions, E2E runs, and co-developed apps never collide on one port. This
// constant is only the standalone-launch fallback (backend_wrapper.py default
// and the renderer's pre-getInfo default in backendApi.ts). The real port flows
// renderer←getInfo IPC←main, and main→backend via PHYTOGRAPH_BACKEND_PORT.
export const BACKEND_PORT_PROD = 8008;
// Renderer dev-server fallback. scripts/dev.mjs picks a free port per session
// and passes it via PHYTOGRAPH_RENDERER_PORT; this is the bare-`electron .` default.
export const RENDERER_DEV_PORT = 1427;

// GitHub repository — base for the "Phytograph on GitHub" link and the
// pre-filled new-issue URL used by the in-app feedback dialog.
export const REPO_URL = 'https://github.com/PlantSimulationLab/phytograph';

// Destination for the "Continue without a GitHub account" feedback path.
// TODO: placeholder — replace with the real feedback address before release.
export const FEEDBACK_EMAIL = 'feedback@example.com';
