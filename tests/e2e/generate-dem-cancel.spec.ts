import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'ground_plants.xyz');

// DEM generation is killable, like the segmentation tools: while running, the
// Generate button becomes a disabled spinner beside a red Cancel button. DEM is a
// STREAMING op, so Cancel POSTs /api/cancel/{runId} (stops the backend gridding +
// frees memory) AND aborts the fetch — the renderer ignores the terminal
// `cancelled` marker rather than treating it as a failure.
//
// Drives the real DOM against the live backend: import → open the DEM panel → run
// → assert the two-button running state appears → Cancel → assert the UI returns
// to idle with NO error banner → run again and let it finish, proving a new op
// can start after a cancel.
//
// Timing note: the synthetic fixture grids in well under a second, so the Cancel
// click may land after the op already finished on a fast machine. We assert the
// cancel button is present + wired and that the UI ends up idle (either path).

test('DEM generation shows a Cancel button and recovers after cancel', async () => {
  // Two full DEM runs (~20-30 s each on CI) plus an import and a cancel unwind.
  // The 180 s default left no margin once the suite grew around it.
  test.setTimeout(300_000);
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="ground_plants"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Dismiss the import's success toast before touching the DEM panel. The
    // toast stack (components/Toast.tsx) is `fixed bottom-4 right-4 top-4` at
    // z-[110] — the FULL window height — and its cards are pointer-events-auto,
    // so a live toast sits on top of the DEM panel's Run button and swallows
    // the click. Verified by hit-testing the button's centre:
    // document.elementFromPoint there returns `toast-success` while a toast is
    // up and `dem-run-button` once it is gone. Success toasts auto-expire after
    // 4 s, so whether the click lands is a pure race against machine speed —
    // this spec failed 1 run in 3 locally, and Playwright's own error blames
    // whichever overlay it walked to rather than the toast.
    //
    // (Same hazard the crop tools handle via `data-blocks-viewport`; see
    // viewport-pick.spec.ts for the other spec that has to clear toasts.)
    //
    // Dismiss via a direct DOM click, NOT locator.click(): a toast can expire
    // between resolving the locator and the click, and Playwright then burns
    // its full actionability timeout. Firing the DOM event is immediate and a
    // no-op if the node already went away.
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('[data-testid="toast-close"]')
        .forEach((b) => b.click());
    });
    await expect(page.getByTestId('toast-close')).toHaveCount(0, { timeout: 15_000 });

    await page.getByTestId('tool-dem').click();
    const panel = page.getByTestId('dem-panel');
    await expect(panel).toBeVisible();

    const runButton = page.getByTestId('dem-run-button');
    const cancelButton = page.getByTestId('dem-cancel-button');

    // Start a run. The run button flips to the disabled spinner state and the
    // Cancel button appears beside it.
    //
    // Timeouts here are sized for CI, not for this laptop: the same grid costs
    // ~1.3 s locally and 20-30 s on the Linux runner (measured against the
    // sibling generate-dem specs), so every budget below has to cover a cancel
    // that lands mid-compute on a loaded, 2-worker runner.
    //
    // These were widened while chasing a CI failure that turned out NOT to be a
    // timing problem at all — the legend was swallowing the Run click (see
    // legend-does-not-block-panels.spec.ts). They are kept because the old
    // 5s/10s budgets were laptop-sized on their own merits, but note that a
    // failure here is far more likely to be something eating the click than the
    // op genuinely running long.
    await runButton.click();
    await expect(cancelButton).toBeVisible({ timeout: 30_000 });
    await expect(runButton).toBeDisabled();

    // Cancel it. (Best-effort — on a fast machine the tiny grid may finish first;
    // either way the UI must end up idle.)
    await cancelButton.click().catch(() => {});

    // The op ends one of two clean ways: cancelled (panel stays open, idle) or it
    // beat the cancel and finished (panel auto-closes on success). Both are a valid
    // recovery — the invariant is that the spinner/Cancel is gone and nothing errored.
    // Either path (cancelled, or finished first) has to unwind the whole
    // backend op, which on CI is the 20-30 s compute plus teardown.
    await expect(cancelButton).toBeHidden({ timeout: 60_000 });
    await expect(panel.locator('.bg-red-900\\/30')).toHaveCount(0);

    // Reopen the panel if the run finished and closed it, so we can drive a fresh
    // run either way.
    if (!(await panel.isVisible())) {
      await page.getByTestId('tool-dem').click();
      await expect(panel).toBeVisible();
    }
    await expect(runButton).toBeEnabled({ timeout: 30_000 });

    // Prove a new op can start and complete after the cancel: run again and let it
    // finish, asserting a real DEM surface mesh appears (concrete output).
    await runButton.click();
    const demRow = page.locator('[data-testid="mesh-row"][data-mesh-name="ground_plants DEM"]');
    await expect(demRow).toBeVisible({ timeout: 60_000 });
    expect(parseInt((await demRow.getAttribute('data-triangle-count')) ?? '0', 10)).toBeGreaterThan(0);
  } finally {
    await close();
  }
});
