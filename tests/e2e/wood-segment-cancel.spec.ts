import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree_wood_leaf.xyz');

// Segmentation tools are killable: while running, the run button becomes a
// disabled spinner beside a red Cancel button that aborts the request, which the
// backend turns into a SIGKILL of its worker subprocess (the compute is a
// monolithic numpy/CSF/C-extension call that can't be interrupted in-thread).
//
// This drives the real DOM against the live backend: import → select → open the
// Wood/Leaf panel → run → assert the two-button running state appears → Cancel →
// assert the UI returns to idle with NO error banner → run again and let it
// finish, proving a new op can start after a cancel.
//
// Timing note: the synthetic fixture segments in well under a second, so the
// Cancel click may land after the op already finished on a fast machine. We
// therefore assert the cancel button is present + wired and that the UI ends up
// idle (either path), rather than asserting the op was provably interrupted —
// the deterministic interruption is covered by the backend test
// (backend-api/tests/test_seg_kill.py::test_disconnect_kills_worker_promptly).

test('wood/leaf segmentation shows a Cancel button and recovers after cancel', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('tool-wood-segment').click();
    const panel = page.getByTestId('wood-segment-panel');
    await expect(panel).toBeVisible();

    const runButton = page.getByTestId('wood-segment-run-button');
    const cancelButton = page.getByTestId('wood-segment-cancel-button');

    // Start a run. The run button flips to the disabled spinner state and the
    // Cancel button appears beside it.
    await runButton.click();
    await expect(cancelButton).toBeVisible({ timeout: 5_000 });
    await expect(runButton).toBeDisabled();

    // Cancel it. (Best-effort — on a fast machine the tiny synthetic cloud may
    // finish first; either way the UI must end up idle.)
    await cancelButton.click().catch(() => {});

    // The UI returns to idle: the Cancel button is gone and the run button is
    // enabled again — and critically, NO error banner is shown (a user cancel is
    // not a failure).
    await expect(cancelButton).toBeHidden({ timeout: 10_000 });
    await expect(runButton).toBeEnabled({ timeout: 10_000 });
    await expect(panel.locator('.bg-red-900\\/30')).toHaveCount(0);

    // Prove a new op can start and complete after the cancel: run again and let
    // it finish, asserting the cloud is coloured by the discrete wood_class
    // attribute (concrete correct output, per the E2E rules).
    await expect(runButton).toBeEnabled();
    await runButton.click();
    const legend = page.getByTestId('class-legend');
    await expect(legend).toBeVisible({ timeout: 60_000 });
    await expect(legend).toHaveAttribute('data-legend-attribute', 'wood_class');
    await expect(legend.getByText('Wood', { exact: true })).toBeVisible();
    await expect(legend.getByText('Leaf', { exact: true })).toBeVisible();
  } finally {
    await close();
  }
});
