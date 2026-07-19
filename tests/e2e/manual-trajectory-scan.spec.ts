import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launchApp';

// End-to-end MANUAL trajectory: instead of importing a trajectory file, the user
// builds a moving-platform trajectory by hand in the docked pose table (add /
// edit poses), saves it onto the scan, and runs a real synthetic scan against it.
// A spinning-multibeam scanner REQUIRES a trajectory, so a successful run proves
// the hand-built PoseStream flowed all the way to the live backend's addScanMoving.
// Drives the real DOM + live backend (no /api mocking).
test('builds a trajectory manually and runs a moving-platform scan', async () => {
  const { page, close } = await launchApp();

  try {
    // ── 1. Generate a plant to scan ──────────────────────────────────────
    await page.getByTestId('tool-plant-generate').click();
    const plantPopup = page.getByTestId('plant-generation-popup');
    await expect(plantPopup).toBeVisible();
    await page.getByTestId('plant-species-select').selectOption('bean');
    await page.getByTestId('plant-age-input').fill('20');
    await page.getByTestId('plant-generate-button').click();
    await expect(page.getByTestId('mesh-row').first()).toBeVisible({ timeout: 120_000 });

    // ── 2. Add a spinning-multibeam scanner (needs a trajectory) ─────────
    await page.getByTestId('tool-add-scan').click();
    const scanPopup = page.getByTestId('scan-parameters-popup');
    await expect(scanPopup).toBeVisible();
    await page.getByTestId('scan-label-input').fill('manual-traj');
    await page.getByTestId('scan-model-select').selectOption('velodyne_hdl32e');

    // A multibeam scan needs a trajectory; submit is blocked until one exists.
    await expect(page.getByTestId('scan-multibeam-needs-trajectory')).toBeVisible();
    await expect(page.getByTestId('scan-submit')).toBeDisabled();

    // ── 3. Build the trajectory manually ─────────────────────────────────
    await page.getByTestId('scan-trajectory-build').click();
    await expect(scanPopup).not.toBeVisible();

    const tablePanel = page.getByTestId('trajectory-table-panel');
    await expect(tablePanel).toBeVisible();
    // The starter trajectory has two poses.
    await expect(page.getByTestId('trajectory-row-0')).toBeVisible();
    await expect(page.getByTestId('trajectory-row-1')).toBeVisible();

    // Save is enabled straight away (two strictly-increasing poses).
    await expect(page.getByTestId('trajectory-save')).toBeEnabled();

    // Edit pose 1's X so the platform actually moves a few metres (commit on Enter).
    const p1x = page.getByTestId('trajectory-1-x');
    await p1x.fill('8');
    await p1x.press('Enter');
    await expect(p1x).toHaveValue('8');

    // Add a third pose — the table grows (kept time-ordered) and Save stays valid.
    await page.getByTestId('trajectory-add-pose').click();
    await expect(page.getByTestId('trajectory-row-2')).toBeVisible();
    await expect(page.getByTestId('trajectory-validation-error')).toHaveCount(0);

    // A duplicate timestamp disables Save; "Renumber t" repairs it. (Rows stay
    // time-sorted, so two equal times are the only way to break strict increase.)
    const p1t = page.getByTestId('trajectory-1-t');
    await p1t.fill('0'); // collide with pose 0's time (t=0)
    await p1t.press('Enter');
    await expect(page.getByTestId('trajectory-validation-error')).toBeVisible();
    await expect(page.getByTestId('trajectory-save')).toBeDisabled();
    await page.getByText('Renumber t').click();
    await expect(page.getByTestId('trajectory-save')).toBeEnabled();

    // Preview playback: the button toggles to Stop while the scanner animates
    // along the path, then auto-returns to Preview when the ~5 s run finishes.
    const preview = page.getByTestId('trajectory-preview');
    await preview.click();
    await expect(preview).toContainText('Stop');
    await expect(preview).toContainText('Preview', { timeout: 15_000 });

    // ── 4. Save the trajectory → return to the Add Scan popup ────────────
    // Saving a trajectory built mid-create hands it back to the Add Scan popup
    // (with the trajectory attached) rather than creating the scan immediately,
    // so the user can finish the scan setup.
    await page.getByTestId('trajectory-save').click();
    await expect(tablePanel).not.toBeVisible();
    await expect(scanPopup).toBeVisible();
    // The built trajectory is now attached; the submit is no longer blocked.
    await expect(page.getByTestId('scan-trajectory-label')).toBeVisible();
    await expect(page.getByTestId('scan-multibeam-needs-trajectory')).toHaveCount(0);
    await expect(page.getByTestId('scan-submit')).toBeEnabled();
    await page.getByTestId('scan-submit').click();
    await expect(scanPopup).not.toBeVisible();

    const scanRow = page.locator('[data-testid="scan-row"][data-scan-name="manual-traj"]');
    await expect(scanRow).toBeVisible();
    // The hand-built trajectory makes this a moving scan with no data yet.
    await expect(scanRow).toHaveAttribute('data-moving', 'true');
    await expect(scanRow).toHaveAttribute('data-has-data', 'false');

    // ── 5. Run the synthetic scan against the manual trajectory ──────────
    await page.getByTestId('run-synthetic-scan').click();
    const scanOptions = page.getByTestId('synthetic-scan-options-popup');
    await expect(scanOptions).toBeVisible();
    await page.getByTestId('scan-opt-run').click();
    await expect(scanOptions).not.toBeVisible();

    // ── 6. A real cloud lands on the scanner row ─────────────────────────
    await expect(scanRow).toHaveAttribute('data-has-data', 'true', { timeout: 120_000 });
    await expect(scanRow).toHaveAttribute('data-moving', 'true');
    const pointCount = parseInt((await scanRow.getAttribute('data-point-count'))!, 10);
    // A 32-beam spinning sensor flown along the path over the plant returns a
    // non-trivial cloud (correctness, not just "didn't throw").
    expect(pointCount).toBeGreaterThan(50);
  } finally {
    await close();
  }
});
