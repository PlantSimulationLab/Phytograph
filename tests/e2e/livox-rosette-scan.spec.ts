import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';

// End-to-end Livox non-repeating rosette (Risley-prism) scan. Selecting a Livox
// model switches the scan pattern to the rosette, loads its verified prism stack,
// and HIDES the angular-sweep fields (the FOV is emergent). A rosette is always
// trajectory-driven, so a stationary tripod capture is a two-identical-pose
// trajectory. Runs the live backend through the real DOM (no /api mocking).
test('runs a synthetic Livox rosette (Risley-prism) scan', async () => {
  const { app, page, close } = await launchApp();

  try {
    // ── 1. Generate a plant to scan ──────────────────────────────────────
    await page.getByTestId('tool-plant-generate').click();
    const plantPopup = page.getByTestId('plant-generation-popup');
    await expect(plantPopup).toBeVisible();
    await page.getByTestId('plant-species-select').selectOption('bean');
    await page.getByTestId('plant-age-input').fill('20');
    await page.getByTestId('plant-generate-button').click();
    await expect(page.getByTestId('mesh-row').first()).toBeVisible({ timeout: 120_000 });

    // ── 2. Add a scanner and pick the Livox Avia ─────────────────────────
    const traj = join(repoRoot, 'tests', 'e2e', 'fixtures', 'moving-scan', 'livox_stationary.csv');
    await stubOpenDialog(app, traj);

    await page.getByTestId('tool-add-scan').click();
    const scanPopup = page.getByTestId('scan-parameters-popup');
    await expect(scanPopup).toBeVisible();
    await page.getByTestId('scan-label-input').fill('rosette');

    // Selecting the Livox Avia switches the pattern to the rosette and loads its
    // prism stack — the pattern button becomes active and the prism summary shows.
    await page.getByTestId('scan-model-select').selectOption('livox_avia');
    await expect(page.getByTestId('scan-pattern-risley')).toHaveClass(/bg-blue-600/);

    // The prism stack summary is populated (the emergent-FOV panel), and the
    // angular-sweep + point-count fields are HIDDEN (they don't apply to a rosette).
    const prisms = page.getByTestId('scan-risley-prisms');
    await expect(prisms).toBeVisible();
    await expect(prisms).toContainText('Prism 3'); // the Avia has three wedges
    await expect(page.getByTestId('scan-zenith-points')).toHaveCount(0);
    await expect(page.getByTestId('scan-zenith-min')).toHaveCount(0);
    await expect(page.getByTestId('scan-azimuth-min')).toHaveCount(0);

    // A rosette needs a trajectory; submit is blocked until one is imported.
    await expect(page.getByTestId('scan-multibeam-needs-trajectory')).toBeVisible();
    await expect(page.getByTestId('scan-submit')).toBeDisabled();

    // Import the stationary (two-identical-pose) trajectory.
    await page.getByTestId('scan-trajectory-import').click();
    await expect(page.getByTestId('scan-trajectory-label')).toBeVisible();

    // The PRF field shows for a rosette; set a value that fires a healthy pulse
    // count over the 0.5 s capture while staying fast (≈50k pulses).
    const pulseRate = page.getByTestId('scan-pulse-rate');
    await expect(pulseRate).toBeVisible();
    await pulseRate.fill('100000');

    // The derived panel reports PRF × duration — proving the UI computes the
    // rosette pulse budget (Ntheta=1), not an Ntheta×Nphi grid.
    await expect(page.getByTestId('scan-risley-derived')).toBeVisible();
    const pulsesText = await page.getByTestId('scan-risley-pulses').textContent();
    expect(parseInt((pulsesText ?? '0').replace(/,/g, ''), 10)).toBeGreaterThan(1000);

    await page.getByTestId('scan-submit').click();
    await expect(scanPopup).not.toBeVisible();

    const scannerRow = page.locator('[data-testid="scan-row"][data-scan-name="rosette"]');
    await expect(scannerRow).toBeVisible();
    // A rosette is trajectory-driven, so the row reads as a moving scan.
    await expect(scannerRow).toHaveAttribute('data-moving', 'true');
    await expect(scannerRow).toHaveAttribute('data-has-data', 'false');

    // ── 3. Run the synthetic scan ────────────────────────────────────────
    await page.getByTestId('run-synthetic-scan').click();
    const scanOptions = page.getByTestId('synthetic-scan-options-popup');
    await expect(scanOptions).toBeVisible();
    await page.getByTestId('scan-opt-run').click();
    await expect(scanOptions).not.toBeVisible();

    // ── 4. Data lands on the scanner row ─────────────────────────────────
    await expect(scannerRow).toHaveAttribute('data-has-data', 'true', { timeout: 120_000 });
    await expect(scannerRow).toHaveAttribute('data-moving', 'true');
    // A real (if modest) cloud lands: the Avia's tight rosette imaging a small
    // bean plant from 3 m at 40 kHz over 0.5 s returns a few dozen hits.
    const pointCount = parseInt((await scannerRow.getAttribute('data-point-count'))!, 10);
    expect(pointCount).toBeGreaterThan(20);
  } finally {
    await close();
  }
});
