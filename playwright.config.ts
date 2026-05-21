import { defineConfig } from '@playwright/test';

// E2E drives the packaged Electron app via `_electron.launch`. There is no
// browser to install — Playwright reuses Phytograph's bundled Electron. The
// app's supervised PyInstaller backend on :8008 is the real backend for
// every test. See CLAUDE.md "Testing" for the rules.
export default defineConfig({
  testDir: './tests/e2e',
  // Cold-start of the bundled backend is 10-40s (open3d + pyhelios + uvicorn).
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // One Electron app per run; the backend owns :8008.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
  },
});
