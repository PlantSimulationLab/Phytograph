import { defineConfig, type ReporterDescription } from '@playwright/test';

// Opt-in test-span log for `npm run test:e2e:profile` — lets
// scripts/monitor-resources.mjs attribute CPU/memory peaks to a spec file.
// Absent env var → plain `npm run test:e2e` behaves exactly as before.
const timelineReporter: ReporterDescription[] = process.env.PHYTOGRAPH_E2E_TIMELINE
  ? [['./tests/e2e/helpers/timeline-reporter.ts']]
  : [];

// E2E drives the packaged Electron app via `_electron.launch`. There is no
// browser to install — Playwright reuses Phytograph's bundled Electron. Each
// launched app gets its own supervised PyInstaller backend on a free port
// picked per launch (tests/e2e/helpers/launchApp.ts), so parallel workers
// never collide. See CLAUDE.md "Testing" for the rules.
export default defineConfig({
  testDir: './tests/e2e',
  // Cold-start of the bundled backend is 10-40s (open3d + pyhelios + uvicorn).
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // Two spec files run side by side, each with its own app + backend on its
  // own port and its own octree cache dir. Tests WITHIN a file stay serial
  // (fullyParallel: false) — shared-session specs launch one app in beforeAll
  // and reset the scene between tests, which requires file-level scheduling.
  // Bounded at 2: each app instance is an Electron + open3d/pyhelios backend
  // (~1-1.5 GB RSS), and the compute-heavy tests already use several cores.
  fullyParallel: false,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }], ...timelineReporter],
  use: {
    trace: 'retain-on-failure',
  },
});
