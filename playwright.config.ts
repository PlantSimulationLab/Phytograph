import { defineConfig, type ReporterDescription } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Opt-in test-span log for `npm run test:e2e:profile` — lets
// scripts/monitor-resources.mjs attribute CPU/memory peaks to a spec file.
// Absent env var → plain `npm run test:e2e` behaves exactly as before.
const timelineReporter: ReporterDescription[] = process.env.PHYTOGRAPH_E2E_TIMELINE
  ? [['./tests/e2e/helpers/timeline-reporter.ts']]
  : [];

// The cross-platform subset, read from its JSON contract so the list lives in
// exactly one reviewable place (and so scripts/platform-specs.test.mjs can pin
// it — every entry must still resolve to a real file, or a rename would drop a
// spec out of Windows/macOS coverage silently).
const platformSpecs: string[] = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('./tests/e2e/platform-specs.json', import.meta.url)), 'utf-8'),
  ) as { groups: { specs: string[] }[] }
).groups.flatMap((g) => g.specs);

// `PHYTOGRAPH_E2E_PLATFORM=1` swaps the project list for the platform subset
// alone, rather than adding a third project alongside heavy/main.
//
// It has to be a swap. Playwright runs EVERY project when none is named, and
// `npm run test:e2e` is exactly that bare invocation — so a permanently-defined
// `platform` project would make every local full run execute those 28 spec
// files twice. Gating on the env var keeps local runs and ci.yml (which names
// --project explicitly) byte-identical to before, while platform.yml opts in.
const platformOnly = process.env.PHYTOGRAPH_E2E_PLATFORM === '1';

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
  // wall-clock locally.
  //
  // In CI that cost is now zero. The single 86-minute `heavy` JOB this comment
  // used to reference is gone: .github/workflows/ci.yml took the sharding advice
  // and splits E2E into `e2e` (the `main` project, --shard'ed N ways) plus a
  // dedicated `e2e-heavy` job. So the heavy specs run on their own runner,
  // concurrently with the main shards rather than serially after them.
  //
  // That dedicated job is also the only placement that actually honours the
  // memory ceilings above. `workers: 1` keeps these specs off EACH OTHER but
  // cannot keep a `main` spec off the same machine — and sharding would have
  // scattered them among the main shards, putting exactly that neighbour back.
  // If you ever fold them into the sharded matrix, the ceilings become
  // measurements of a machine the spec does not control again.
  projects: platformOnly ? [
    {
      // Windows/macOS runners are smaller than the Linux CI box (the macOS
      // arm64 runner is 3 vCPU / 7 GB), and each worker drives its own Electron
      // plus PyInstaller backend at ~1-1.5 GB RSS. Two still fits, so keep the
      // default; drop to `workers: 1` if this project starts flaking on memory
      // rather than on a real defect.
      name: 'platform',
      testMatch: platformSpecs.map((s) => `**/${s}`),
    },
  ] : [
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
