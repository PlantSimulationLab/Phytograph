import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// Cancelling an in-flight import.
//
// The import progress modal used to be a hard-blocking overlay with no way out:
// if an import hung (or the user picked the wrong 800 MB file) the only escape
// was killing the app. The fix makes the backend's `/api/cloud/session/create`
// a streaming, cancellable endpoint — so the cancel actually STOPS the work
// (killing the PotreeConverter child) rather than dismissing the dialog and
// letting the import run to completion in the background.
//
// Per CLAUDE.md E2E rules:
//   1. Live backend — nothing about /api/cloud/session/create is mocked.
//   2. Real UI — import through the File→Import picker + wizard, click the real
//      Cancel button, read the real scan list.
//   3. Correctness, not absence-of-errors — assert the scan count is 0, that the
//      bar left 0% (only possible if stage progress really streams), that the
//      backend stayed responsive DURING the import, and that a later import of
//      the same file still yields the exact expected point count.
//   6. One app for the file, resetToFreshScene between tests.
//
// Fixture size: 1M points, matching crop-octree-100m.spec.ts's default. That
// spec's comment is the reason for the ceiling — PotreeConverter 2.1.1 segfaults
// while INDEXING uniformly-random synthetic clouds above ~3M points. 1M is
// comfortably under it while still taking long enough (seconds of conversion)
// to click Cancel mid-flight. Committed fixtures are all <150 KB and would
// import faster than Playwright can react, so the fixture is generated.
const FIXTURE_N = 1_000_000;
const FIXTURE_PATH = join(repoRoot, 'tmp', `import_cancel_${FIXTURE_N}.xyz`);

async function ensureFixture(): Promise<void> {
  if (existsSync(FIXTURE_PATH)) {
    // Guard against a truncated file left by a prior crash: ~50 chars/line for
    // `x y z r g b refl`, so anything under 20 bytes/point is corrupt.
    if (statSync(FIXTURE_PATH).size > FIXTURE_N * 20) return;
  }
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [join(repoRoot, 'scripts', 'make-big-xyz.mjs')],
      {
        env: {
          ...process.env,
          N: String(FIXTURE_N),
          OUT: FIXTURE_PATH.replace(repoRoot + '/', ''),
          RGB: '1',
        },
        stdio: 'inherit',
      },
    );
    proc.on('exit', (code) => {
      code === 0 ? resolve() : reject(new Error(`make-big-xyz exited with code ${code}`));
    });
  });
}

// Width of the modal's progress bar, as a percentage of its track. Read from the
// rendered geometry rather than the style string so it reflects what the user
// actually sees.
async function barWidthPct(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const modal = document.querySelector('[data-testid="bulk-import-progress"]');
    if (!modal) return -1;
    const track = modal.querySelector('.bg-neutral-700.rounded-full');
    const fill = track?.firstElementChild as HTMLElement | undefined;
    if (!track || !fill) return -1;
    const tw = track.getBoundingClientRect().width;
    return tw > 0 ? (fill.getBoundingClientRect().width / tw) * 100 : -1;
  });
}

// The cache entries currently installed under the launch's private octree cache
// root — a directory is "installed" once it holds a metadata.json (the atomic
// rename that promotes `<key>.staging` into `<key>` is the last step of a build,
// so this never sees a half-built entry).
function listInstalledOctrees(root: string): string[] {
  return existsSync(root)
    ? readdirSync(root).filter((d) => existsSync(join(root, d, 'metadata.json')))
    : [];
}

// Octree builds still in progress. `_build_octree_from_las` runs PotreeConverter
// into `<key>.staging/` and promotes it with one atomic rename, removing the
// staging dir on any failure — so a staging DIRECTORY existing means a build is
// live right now. (The sibling `<key>.staging.converter.log` is a file, not a
// directory, and is excluded.)
function listStagingOctrees(root: string): string[] {
  return existsSync(root)
    ? readdirSync(root).filter((d) =>
        d.endsWith('.staging') && statSync(join(root, d)).isDirectory())
    : [];
}

let session: LaunchedApp;
// Snapshot of the octree cache at the start of each test. The cache is on-disk
// state that File → New does NOT clear, so tests must diff against this rather
// than assume the root is empty.
let octreesBefore: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(300_000);   // fixture generation on a cold run
  await ensureFixture();
  session = await launchApp();
});

test.afterAll(async () => {
  await session?.close();
});

test.beforeEach(async () => {
  await resetToFreshScene(session.app, session.page);
  octreesBefore = listInstalledOctrees(session.octreeCacheRoot);
});

// Declaration order no longer matters to correctness: the cache assertion below
// diffs against the per-test snapshot instead of demanding a globally empty
// root, so the second test (a full successful import, which installs an entry)
// can no longer break this one by running first.
test('cancelling an import stops the backend work and adds no scan', async () => {
  test.setTimeout(240_000);
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE_PATH);
  await completeImportWizard(page);

  const modal = page.getByTestId('bulk-import-progress');
  await expect(modal).toBeVisible({ timeout: 60_000 });

  // The bar must leave 0% on a SINGLE-file import. This is impossible without
  // the backend streaming per-stage fractions: the old bar was
  // `(current - 1) / total`, i.e. structurally 0% for {current: 1, total: 1}
  // for the entire duration of every single-file import.
  await expect.poll(() => barWidthPct(page), {
    timeout: 60_000,
    message: 'progress bar never advanced past 0% — stage progress is not streaming',
  }).toBeGreaterThan(0);

  // The backend must still answer DURING the import. Before this change the
  // endpoint was an `async def` doing all its blocking work inline on the event
  // loop, so the whole server was frozen mid-import — which is precisely why a
  // cancel could not work: POST /api/cancel/{run_id} could not be serviced.
  const health = await page.evaluate(async () => {
    const info = await (window as any).electronAPI.backend.getInfo();
    const res = await fetch(`${info.url}/health`);
    return { ok: res.ok, status: res.status };
  });
  expect(health.ok, 'backend was unresponsive mid-import (event loop blocked)').toBe(true);

  // Cancel while the OCTREE BUILD IS ACTUALLY RUNNING, not merely while the
  // modal happens to be up.
  //
  // This is what makes the test mean anything, and it took a sabotage run to
  // find. Clicking as soon as the modal appears cancels ~200 ms in, during the
  // ASCII read — a moment when there is no converter to kill and nothing that
  // could be left behind, so every assertion below is satisfied by an import
  // that had barely started. With the backend's cancel delivery deliberately
  // broken, the spec still went green in under a second.
  //
  // Waiting for a `<key>.staging` directory pins the click to the one window
  // where a leak is possible: PotreeConverter has been spawned and is writing,
  // and only a cancel that genuinely reaches the worker can stop it before the
  // atomic rename installs the entry. Load-independent — it waits for a state,
  // not a duration.
  await expect.poll(
    () => listStagingOctrees(session.octreeCacheRoot).length,
    {
      timeout: 120_000,
      message: 'the octree build never started, so there was nothing to cancel',
    },
  ).toBeGreaterThan(0);

  // Cancel for real.
  const cancel = page.getByTestId('bulk-import-cancel');
  await expect(cancel).toBeVisible();
  await cancel.click();

  // The modal goes away. No `toBeDisabled()` check on the button: the cancel
  // often lands fast enough that the whole modal unmounts first, which races.
  await expect(modal).toBeHidden({ timeout: 60_000 });

  // Wait for the OCTREE BUILD to settle, rather than sleeping.
  //
  // This used to be `waitForTimeout(45_000)`, reasoning that an uncancelled
  // import takes ~10 s so 45 s of quiet proves nothing is still running. That
  // premise is load-dependent by construction — it measures the machine, not the
  // cancel — and it broke under `--workers=2`, where the `heavy` project runs
  // alongside a `main` spec (the two projects are deliberately NOT serialised;
  // see playwright.config.ts). It also cost 45 s on every green run.
  //
  // The load-independent signal is the cache directory itself. A build writes
  // into `<key>.staging/` and promotes it with a single atomic rename, so while
  // a staging dir exists the converter is still working; when none exists the
  // build has either been torn down or has finished (and installed). Polling for
  // "no staging dir" therefore waits exactly as long as the machine needs and
  // not a second more — and, critically, it keeps watching the work itself.
  //
  // Deliberately NOT the backend's cancel registry: a run is cleared from it in
  // the stream's `finally`, which fires when the CLIENT disconnects — while the
  // worker thread carries on in the executor. Measured during sabotage: the
  // registry emptied at t+3 s and the octree was installed at t+12 s. Polling
  // that would have declared the import over nine seconds before it leaked,
  // which is precisely the bug this test exists to catch.
  await expect.poll(
    () => listStagingOctrees(session.octreeCacheRoot).length,
    {
      timeout: 180_000,
      message: 'an octree build was still staging — the import never stopped',
    },
  ).toBe(0);

  // The octree cache holds nothing new — the PotreeConverter run was really
  // killed, not merely detached. This is what separates a REAL cancel from one
  // that just hides the dialog: a background import would have installed a cache
  // entry (`<key>/metadata.json`). It also pins the poisoned-cache invariant —
  // a killed build must leave the entry ABSENT, never half-written.
  //
  // Compared against a beforeEach snapshot rather than asserted empty: the
  // octree cache is on-disk state that `resetToFreshScene` (File → New) does not
  // clear, so "the root is empty" silently depends on this test running first
  // and on every earlier test having left nothing behind. Diffing against the
  // snapshot asserts what this test actually cares about — that THIS cancel
  // installed nothing — and keeps holding if the file is ever reordered.
  const installed = listInstalledOctrees(session.octreeCacheRoot);
  const added = installed.filter((d) => !octreesBefore.includes(d));
  expect(added,
    'an octree was installed after cancel — the import kept running').toEqual([]);

  // Nothing was imported into the scene...
  await expect(page.locator('[data-testid="scan-row"]')).toHaveCount(0);
  await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();
  // ...and a cancel is not a failure, so no error toast.
  await expect(page.locator('[data-testid="toast-error"]')).toHaveCount(0);
});

test('a fresh import of the same file succeeds after a cancel', async () => {
  test.setTimeout(240_000);
  const { app, page } = session;

  // Identical bytes derive the identical octree cache key, so a half-built entry
  // stranded by the killed converter would surface here — as a failed import, a
  // wrong point count, or a broken render.
  await importFiles(app, page, 'import-point-cloud', FIXTURE_PATH);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"]').first();
  await expect(row).toBeVisible({ timeout: 180_000 });
  await expect(row).toHaveAttribute('data-point-count', String(FIXTURE_N), {
    timeout: 120_000,
  });
  await expect(page.locator('[data-testid="toast-error"]')).toHaveCount(0);
});
