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
  // Two projects so the memory-hungry specs never share the runner with a
  // second app instance.
  //
  // The problem: a handful of specs build million-point fixtures and assert on
  // absolute memory (crop-octree-100m holds a 500 MB usedJSHeapSize ceiling
  // through its apply window). With `workers: 2` a neighbour is driving its own
  // Electron + PyInstaller backend (~1-1.5 GB RSS) at the same time, so those
  // specs are measuring a machine they do not control. On 2026-08-21 that took
  // out crop-multi-scan, whose app was killed mid `File → New` — "Target page,
  // context or browser has been closed" — in the same window
  // crop-octree-100m was cropping its 1M-point cloud. It passed on a plain
  // re-run, which is the signature of contention rather than a defect.
  //
  // `heavy` runs alone (workers: 1) so its specs never share the runner with a
  // second app instance — not with each other, and not with a `main` spec.
  //
  // Deliberately NOT wired with `dependencies: ['heavy']`. That does serialise
  // the projects, but it also drags the whole heavy project into every targeted
  // run: `npx playwright test tests/e2e/some-other.spec.ts` would first run (and
  // could fail on) three unrelated million-point specs, and a failure there
  // blocks the spec you actually asked for. The scheduler already keeps a
  // `workers: 1` project's specs off each other, which is the property the
  // memory ceilings need; full cross-project isolation is not worth making
  // every one-spec debug loop pay for it.
  //
  // Cost: the `heavy` project measured 2.4 min on its own, and those specs used
  // to overlap other work, so the split adds roughly two minutes of serial
  // wall-clock. CI's `heavy` JOB ran 83-86 min of its 100 min cap before this,
  // so the headroom absorbs it — but that is the number to re-check if the cap
  // is ever hit again (see .github/workflows/ci.yml, which argues for sharding
  // rather than raising it further).
  projects: [
    {
      name: 'heavy',
      testMatch: [
        // Generates a 1M-point fixture and asserts a hard heap ceiling.
        '**/crop-octree-100m.spec.ts',
        // Writes a 1M-point file to exercise cancelling a big import.
        '**/import-cancel.spec.ts',
        // 13M-point cloud when example-datasets/ is present (skips otherwise).
        '**/zoom-large-cloud.spec.ts',
      ],
      workers: 1,
    },
    {
      name: 'main',
      testIgnore: [
        '**/crop-octree-100m.spec.ts',
        '**/import-cancel.spec.ts',
        '**/zoom-large-cloud.spec.ts',
      ],
    },
  ],
});
