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

let session: LaunchedApp;

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
});

// Playwright runs tests in declaration order within a file, and this one must go
// FIRST: it asserts the octree cache is empty after the cancel, which the second
// test (a full successful import of the same fixture) would populate.
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

  // Cancel for real.
  const cancel = page.getByTestId('bulk-import-cancel');
  await expect(cancel).toBeVisible();
  await cancel.click();

  // The modal goes away. No `toBeDisabled()` check on the button: the cancel
  // often lands fast enough that the whole modal unmounts first, which races.
  await expect(modal).toBeHidden({ timeout: 60_000 });

  // Give a NOT-actually-cancelled import ample time to finish and install its
  // octree. The uncancelled import of this fixture takes ~10 s end to end (see
  // the second test), so 45 s of quiet is decisive: work still running in the
  // background would have completed several times over by now.
  await page.waitForTimeout(45_000);

  // The octree cache is empty — the PotreeConverter run was really killed, not
  // merely detached. This is what separates a REAL cancel from one that just
  // hides the dialog: a background import would have installed a cache entry
  // (`<key>/metadata.json`) by now. It also pins the poisoned-cache invariant —
  // a killed build must leave the entry ABSENT, never half-written.
  const installed = existsSync(session.octreeCacheRoot)
    ? readdirSync(session.octreeCacheRoot).filter((d) =>
        existsSync(join(session.octreeCacheRoot, d, 'metadata.json')))
    : [];
  expect(installed,
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
