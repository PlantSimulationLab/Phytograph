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
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="ground_plants.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('tool-dem').click();
    const panel = page.getByTestId('dem-panel');
    await expect(panel).toBeVisible();

    const runButton = page.getByTestId('dem-run-button');
    const cancelButton = page.getByTestId('dem-cancel-button');

    // Start a run. The run button flips to the disabled spinner state and the
    // Cancel button appears beside it.
    await runButton.click();
    await expect(cancelButton).toBeVisible({ timeout: 5_000 });
    await expect(runButton).toBeDisabled();

    // Cancel it. (Best-effort — on a fast machine the tiny grid may finish first;
    // either way the UI must end up idle.)
    await cancelButton.click().catch(() => {});

    // The UI returns to idle: the Cancel button is gone, the run button is enabled
    // again, and NO error banner is shown (a user cancel is not a failure).
    await expect(cancelButton).toBeHidden({ timeout: 10_000 });
    await expect(runButton).toBeEnabled({ timeout: 10_000 });
    await expect(panel.locator('.bg-red-900\\/30')).toHaveCount(0);

    // Prove a new op can start and complete after the cancel: run again and let it
    // finish, asserting a real DEM surface mesh appears (concrete output).
    await runButton.click();
    const demRow = page.locator('[data-testid="mesh-row"][data-mesh-name="ground_plants.xyz DEM"]');
    await expect(demRow).toBeVisible({ timeout: 60_000 });
    expect(parseInt((await demRow.getAttribute('data-triangle-count')) ?? '0', 10)).toBeGreaterThan(0);
  } finally {
    await close();
  }
});
